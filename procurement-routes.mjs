import { agreementRates, purchaseRate } from './trade.mjs';
import { costs } from './economy.mjs';
import { audit, move, transaction, key } from './db.mjs';
import { comparisons, ford, requirements } from './procurement-db.mjs';

export const accountStates=['active','revoked','suspended','disabled'];
export const purchasePermissions=['purchasing.read','purchasing.create','purchasing.edit','purchasing.approve','purchasing.cancel','purchasing.receive','purchasing.pay','purchasing.export'];
const allowedFlow={draft:['queued'],queued:['ordered'],request:['requested'],requested:['confirmed'],confirmed:['pickup']};
const cancellation=['draft','queued','ordered','request','requested','confirmed','pickup','partial'];

export function registerProcurement({route,db,requireAccess:check,string,integer,roles,actions,ownerId}) {
  const exists=(sql,...params)=>db.prepare(sql).get(...params);
  const id=value=>integer(value,1,Number.MAX_SAFE_INTEGER);
  const optional=(value,max)=>value==null||value===''?'':string(value,max);
  const amount=value=>integer(value,0,100000000);
  const quantity=value=>integer(value,0,1000000);
  const itemId=value=>string(value,100);
  const supplier=value=>{
    const found=exists('SELECT * FROM suppliers WHERE id=?',id(value));
    check(found,'Fornitore non trovato',404);return found;
  };
  const rows=(value,max=30)=>{
    check(Array.isArray(value)&&value.length>0&&value.length<=max&&value.every(x=>x&&typeof x==='object'&&!Array.isArray(x)),
      'Inserisci da 1 a '+max+' righe valide',400);
    const seen=new Set();
    for(const row of value){const k=itemId(row.item);check(!seen.has(k),'La stessa voce compare più volte',400);seen.add(k);}
    return value;
  };
  const getOrder=id=>exists('SELECT * FROM purchase_orders WHERE id=?',id);
  const getLines=db.prepare('SELECT l.*,i.name FROM purchase_lines l JOIN items i ON i.id=l.item_id WHERE order_id=? ORDER BY i.name');
  const getPayments=db.prepare('SELECT id,kind,cents,description,created_at FROM cash_entries WHERE purchase_order_id=? ORDER BY id DESC');
  const outstanding=(line)=>line.quantity-line.received;

  route('GET','/api/procurement','purchasing.read',()=>{
    const plan=requirements(db), pricing=costs(db).pricing;
    for(const row of plan.shortages){
      const rate=pricing.get(row.id);
      row.reference_source=db.prepare('SELECT supplier FROM material_sources WHERE item_id=?').get(row.id)?.supplier??null;
      row.standard_cents=rate.cents;row.standard_source=rate.source;row.standard_date=rate.observed??db.prepare(
        "SELECT created_at FROM price_history WHERE item_id=? AND kind='material' ORDER BY id DESC LIMIT 1").get(row.id)?.created_at??null;
    }
    const orders=db.prepare(`SELECT p.*,s.name AS supplier_name,rp.name AS assignee_name
      FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id JOIN users u ON u.id=p.assignee
      JOIN rp_profiles rp ON rp.id=u.id ORDER BY p.id DESC`).all();
    const listing=db.prepare('SELECT name,cents FROM competitors').all();
    const benchmark=new Map();
    for(const row of listing){const item=key(row.name.trim());benchmark.set(item,Math.min(benchmark.get(item)??Infinity,row.cents));}
    return {benchmarks:Object.fromEntries(benchmark),plan,comparison:comparisons(db,plan.shortages),orders:orders.map(o=>({...o,lines:getLines.all(o.id), payments:getPayments.all(o.id),
      receipts:db.prepare('SELECT request_id,details,created_at FROM purchase_receipts WHERE order_id=? ORDER BY created_at DESC').all(o.id)})),
      items:db.prepare('SELECT i.id,i.name,i.reference_cents,(r.item_id IS NOT NULL) AS craft FROM items i LEFT JOIN recipes r ON i.id=r.item_id ORDER BY i.name').all(),
      suppliers:db.prepare('SELECT id,name FROM suppliers ORDER BY name').all(),
      staff:db.prepare(`SELECT u.id,rp.name FROM users u JOIN rp_profiles rp ON rp.id=u.id LEFT JOIN account_controls a ON a.user_id=u.id
        WHERE (u.role IN ('worker','manager','director','accountant') AND COALESCE(a.state,'active')='active') OR u.id=? ORDER BY name`).all(ownerId??''),
      legacy:db.prepare('SELECT p.created_at,p.item_id,p.quantity,p.cents,s.name AS supplier_name,i.name FROM purchases p JOIN suppliers s ON s.id=p.supplier JOIN items i ON i.id=p.item_id').all(),
    };
  });
  route('POST','/api/procurement-need','purchasing.edit',({user,input})=>transaction(db,()=>{
    const item=itemId(input.item),n=quantity(input.quantity);
    check(exists('SELECT id FROM items WHERE id=?',item),'Articolo non trovato',404);
    if(n)db.prepare('INSERT INTO purchase_needs VALUES(?,?) ON CONFLICT DO UPDATE SET quantity=excluded.quantity').run(item,n);
    else db.prepare('DELETE FROM purchase_needs WHERE item_id=?').run(item);
    audit(db,user.id,'purchase.need',{item,quantity:n});return {ok:true};
  }));
  route('POST','/api/procurement-schedule','purchasing.edit',({user,input})=>transaction(db,()=>{
    const item=itemId(input.item),batches=integer(input.batches,0,10000);
    check(exists('SELECT item_id FROM recipes WHERE item_id=?',item),'Ricetta non trovata',404);
    if(batches)db.prepare('INSERT INTO production_schedule VALUES(?,?) ON CONFLICT DO UPDATE SET batches=excluded.batches').run(item,batches);
    else db.prepare('DELETE FROM production_schedule WHERE item_id=?').run(item);
    audit(db,user.id,'production.schedule',{item,batches});return {ok:true};
  }));
  route('POST','/api/procurement-offer','purchasing.edit',({user,input})=>transaction(db,()=>{
    const item=itemId(input.item),s=supplier(input.supplier);
    const unit=input.unit_cents===null?null:amount(input.unit_cents);
    const discount=integer(input.discount_bps,0,10000);
    const transport=input.transport_cents===null?null:amount(input.transport_cents);
    const available=input.available===null?null:quantity(input.available);
    check(exists('SELECT id FROM items WHERE id=?',item),'Articolo non trovato',404);
    db.prepare(`INSERT INTO supplier_offers(item_id,supplier_id,unit_cents,discount_bps,transport_cents,available) VALUES(?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET unit_cents=excluded.unit_cents,discount_bps=excluded.discount_bps,transport_cents=excluded.transport_cents,
      available=excluded.available,observed=CURRENT_TIMESTAMP`).run(item,s.id,unit,discount,transport,available);
    audit(db,user.id,'purchase.offer',{item,supplier:s.id,unit,discount,transport,available});return {ok:true};
  }));
  route('POST','/api/procurement-order','purchasing.create',({user,input})=>transaction(db,()=>{
    const s=supplier(input.supplier),source=ford.includes(s.name)?s.name:null;
    const assignee=input.assignee?string(input.assignee,20):user.id;
    check(assignee===user.id||assignee===ownerId||exists(`SELECT u.id FROM users u LEFT JOIN account_controls a ON a.user_id=u.id
      WHERE u.id=? AND u.role IN ('worker','manager','director','accountant') AND COALESCE(a.state,'active')='active'`,assignee),'Responsabile non valido',400);
    const {id:order}=db.prepare('INSERT INTO purchase_orders(supplier_id,ford_source,state,notes,assignee) VALUES(?,?,?,?,?) RETURNING id')
      .get(s.id,source,source?'request':'draft',optional(input.notes,500),assignee);
    const rates=agreementRates(db).filter(r=>r.supplier_id===s.id);
    for(const line of rows(input.lines)){
      const item=exists('SELECT id,reference_cents FROM items WHERE id=?',itemId(line.item));
      check(item,'Articolo non trovato',404);
      const n=integer(line.quantity,1,100000),rate=rates.find(r=>r.item_id===item.id);
      const price=source?0:rate?purchaseRate(rate,n):line.unit_cents===null?null:amount(line.unit_cents);
      db.prepare('INSERT INTO purchase_lines(order_id,item_id,quantity,unit_cents,reference_cents) VALUES(?,?,?,?,?)').run(order,item.id,n,price,item.reference_cents);
    }
    audit(db,user.id,'purchase.created',{order,source,assignee});return {id:order};
  }));
  route('POST','/api/procurement-terms','purchasing.edit',({user,input})=>transaction(db,()=>{
    const order=getOrder(id(input.id));
    check(order&&!['received','cancelled'].includes(order.state),'Ordine non modificabile',409);
    const assignee=input.assignee?string(input.assignee,20):order.assignee;
    check(assignee===order.assignee||assignee===user.id||assignee===ownerId||exists(`SELECT u.id FROM users u LEFT JOIN account_controls a ON a.user_id=u.id
      WHERE u.id=? AND u.role IN ('worker','manager','director','accountant') AND COALESCE(a.state,'active')='active'`,assignee),
      'Responsabile non valido',400);
    const notes=optional(input.notes,500),lines=getLines.all(order.id);
    const byItem=new Map(lines.map(l=>[l.item_id,l]));
    if(!order.ford_source){
      for(const row of rows(input.lines)){
        const line=byItem.get(itemId(row.item));
        check(line,'Riga non trovata',404);
        const value=row.unit_cents===null?null:amount(row.unit_cents);
        if(value===line.unit_cents)continue;
        check(!line.received||line.unit_cents===null,'Il prezzo di una riga già ricevuta è storico',409);
        line.unit_cents=value;
        db.prepare('UPDATE purchase_lines SET unit_cents=? WHERE order_id=? AND item_id=?').run(value,order.id,line.item_id);
      }
      const known=lines.every(l=>l.unit_cents!==null);
      const paid=-getPayments.all(order.id).reduce((n,r)=>n+r.cents,0);
      check(!known||paid<=lines.reduce((n,l)=>n+l.unit_cents*l.quantity,0),'Il totale sarebbe inferiore al pagato',409);
    }
    db.prepare('UPDATE purchase_orders SET assignee=?,notes=? WHERE id=?').run(assignee,notes,order.id);
    audit(db,user.id,'purchase.terms',{id:order.id,assignee,lines:lines.map(l=>[l.item_id,l.unit_cents])});return {ok:true};
  }));
  route('GET','/api/procurement-export','purchasing.export',()=>db.prepare(`SELECT o.id,o.state,o.created_at,s.name AS supplier_name,
    i.name,l.quantity,l.received,l.unit_cents FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id
    JOIN purchase_lines l ON l.order_id=o.id JOIN items i ON i.id=l.item_id ORDER BY o.id DESC,i.name`).all());
  route('POST','/api/procurement-state',null,({user,input,permissions})=>transaction(db,()=>{
    const order=getOrder(id(input.id)), next=string(input.state,24);
    check(permissions.includes(next==='cancelled'?'purchasing.cancel':'purchasing.approve'));
    check(order,'Ordine non trovato',404);
    check(next==='cancelled'?cancellation.includes(order.state):allowedFlow[order.state]?.includes(next),'Passaggio di stato non valido',409);
    db.prepare('UPDATE purchase_orders SET state=? WHERE id=?').run(next,order.id);
    audit(db,user.id,'purchase.state',{id:order.id,from:order.state,to:next});return {ok:true};
  }));
  route('POST','/api/procurement-receive','purchasing.receive',({user,input})=>transaction(db,()=>{
    const order=getOrder(id(input.id)),request=string(input.request,80);
    check(order,'Ordine non trovato',404);
    const submitted=rows(input.lines).map(row=>({item:itemId(row.item),quantity:integer(row.quantity,1,100000)})).sort((a,b)=>a.item.localeCompare(b.item));
    const replay=exists('SELECT details FROM purchase_receipts WHERE order_id=? AND request_id=?',order.id,request);
    if(replay){
      check(replay.details===JSON.stringify(submitted),'Questo riferimento di ricezione è già usato con quantità diverse',409);
      return {ok:true,duplicate:true};
    }
    check((order.ford_source?['confirmed','pickup','partial']:['ordered','partial']).includes(order.state),'Ordine non ricevibile',409);
    const delivered=[];
    for(const {item,quantity:n} of submitted){
      const line=exists('SELECT * FROM purchase_lines WHERE order_id=? AND item_id=?',order.id,item);
      check(line&&n<=outstanding(line),'Quantità superiore al residuo da ricevere',409);
      db.prepare('UPDATE purchase_lines SET received=received+? WHERE order_id=? AND item_id=?').run(n,order.id,item);
      move(db,user.id,item,n,'Ricezione acquisto #'+order.id);
      db.prepare('UPDATE purchase_needs SET quantity=quantity-? WHERE item_id=? AND quantity>?').run(n,item,n);
      if(!db.prepare('SELECT changes() AS n').get().n)db.prepare('DELETE FROM purchase_needs WHERE item_id=? AND quantity<=?').run(item,n);
      delivered.push({item,quantity:n});
    }
    db.prepare('INSERT INTO purchase_receipts(order_id,request_id,actor,details) VALUES(?,?,?,?)').run(order.id,request,user.id,JSON.stringify(delivered));
    const complete=getLines.all(order.id).every(l=>outstanding(l)===0);
    db.prepare('UPDATE purchase_orders SET state=? WHERE id=?').run(complete?'received':'partial',order.id);
    audit(db,user.id,'purchase.received',{id:order.id,delivered});return {ok:true};
  }));
  route('POST','/api/procurement-payment','purchasing.pay',({user,input})=>transaction(db,()=>{
    const order=getOrder(id(input.id)),count=integer(input.cents,1,100000000),request=string(input.request,80);
    check(order&&!order.ford_source,'Ordine a pagamento non trovato',404);
    const prior=getPayments.all(order.id);
    const kind=input.refund===true?'refund':'expense';
    const description=(kind==='refund'?'Rimborso':'Pagamento')+' acquisto #'+order.id+' · '+request;
    const replay=prior.find(p=>p.description===description);
    if(replay){check(Math.abs(replay.cents)===count,'Questo riferimento è già usato con un altro importo',409);return {ok:true,duplicate:true};}
    check(input.refund===true||['ordered','partial','received'].includes(order.state),'L’ordine deve essere inoltrato prima di registrare un pagamento',409);
    const paid=-prior.reduce((sum,p)=>sum+p.cents,0);
    const lines=getLines.all(order.id);
    const total=lines.every(l=>l.unit_cents!==null)?lines.reduce((sum,l)=>sum+l.unit_cents*l.quantity,0):null;
    check(input.refund===true?count<=paid:total===null||count+paid<=total,'Importo superiore al saldo disponibile',409);
    const {id:entry}=db.prepare('INSERT INTO cash_entries(kind,cents,description,actor,purchase_order_id) VALUES(?,?,?,?,?) RETURNING id')
      .get(kind,input.refund===true?count:-count,description,user.id,order.id);
    audit(db,user.id,'purchase.payment',{id:order.id,entry,cents:count,kind});return {ok:true};
  }));
  registerOwner({route,db,check,string,integer,roles,actions,ownerId,rows,amount,itemId,optional,quantity,supplier});
}

function registerOwner({route,db,check,string,integer,roles,actions,ownerId,rows,amount,itemId,optional,quantity,supplier}) {
  const userRow=db.prepare('SELECT id,username,role FROM users WHERE id=?');
  route('GET','/api/owner-users','owner',()=>db.prepare(`SELECT u.*,a.display_name,a.notes,a.rp_name,a.missiva,rp.name AS visible_name,COALESCE(a.state,'active') AS state,
    r.name,r.note FROM users u JOIN rp_profiles rp ON rp.id=u.id LEFT JOIN account_controls a ON a.user_id=u.id LEFT JOIN requests r ON r.user_id=u.id ORDER BY u.username`)
    .all().map(u=>({...u,role:u.id===ownerId?'owner':u.role})));
  route('POST','/api/owner-user','owner',({user,input})=>transaction(db,()=>{
    const target=string(input.id,20), before=userRow.get(target);
    check(before,'Utente non trovato',404);
    const display=optional(input.display_name,80),notes=optional(input.notes,1500);
    const previous=db.prepare('SELECT rp_name,missiva FROM account_controls WHERE user_id=?').get(target);
    const rpName=input.rp_name===undefined?previous?.rp_name??'':optional(input.rp_name,80);
    const missiva=input.missiva===undefined?previous?.missiva??'':optional(input.missiva,250);
    const state=input.state, role=input.role;
    check(accountStates.includes(state)&&[...roles,'pending','rejected','owner'].includes(role),'Ruolo o stato non valido',400);
    check(target===ownerId?(role==='owner'&&state==='active'):role!=='owner','Owner principale protetto',403);
    if(target!==ownerId)db.prepare('UPDATE users SET role=? WHERE id=?').run(role,target);
    db.prepare(`INSERT INTO account_controls(user_id,display_name,notes,state,rp_name,missiva) VALUES(?,?,?,?,?,?)
      ON CONFLICT DO UPDATE SET display_name=excluded.display_name,notes=excluded.notes,state=excluded.state,rp_name=excluded.rp_name,missiva=excluded.missiva`).run(target,display,notes,state,rpName,missiva);
    if(state!=='active')db.prepare('DELETE FROM sessions WHERE user_id=?').run(target);
    audit(db,user.id,'account.updated',{target,role,state,display,rpName,missivaChanged:missiva!==(previous?.missiva??''),hasNotes:!!notes});return {ok:true};
  }));
  route('POST','/api/owner-activity','owner',({input})=>{
    const target=string(input.id,20);
    check(userRow.get(target),'Utente non trovato',404);
    return db.prepare("SELECT * FROM audit WHERE actor=? OR json_extract(details,'$.target')=? ORDER BY id DESC LIMIT 150").all(target,target);
  });
  route('POST','/api/owner-permissions','owner',({user,input})=>transaction(db,()=>{
    const scope=input.scope,subject=string(input.subject,35),rules=input.rules;
    check((scope==='role'&&roles.includes(subject))||(scope==='user'&&subject!==ownerId&&userRow.get(subject)),'Destinatario non valido',400);
    check(rules&&typeof rules==='object'&&!Array.isArray(rules)&&Object.keys(rules).every(k=>actions.includes(k)&&[true,false,null].includes(rules[k])),'Permessi non validi',400);
    for(const [permission,enabled] of Object.entries(rules)){
      if(enabled===null)db.prepare('DELETE FROM permissions WHERE scope=? AND subject=? AND permission=?').run(scope,subject,permission);
      else db.prepare('INSERT INTO permissions VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET enabled=excluded.enabled').run(scope,subject,permission,Number(enabled));
    }
    audit(db,user.id,'permissions.matrix',{scope,subject,rules});return {ok:true};
  }));
  route('POST','/api/stock-item','owner',({user,input})=>transaction(db,()=>{
    const name=string(input.name,90),kind=input.kind;
    check(['material','finished'].includes(kind),'Tipo di articolo non valido',400);
    const article=input.id?itemId(input.id):key(name.normalize('NFC'));
    const category=optional(input.category,80),description=optional(input.description,900);
    const reference=input.reference_cents===null?null:amount(input.reference_cents);

    const minimum=quantity(input.minimum);
    const supplierId=input.supplier_id===null?null:supplier(input.supplier_id).id;
    const existing=db.prepare('SELECT * FROM items WHERE id=?').get(article);
    check(input.id?existing:!existing,input.id?'Articolo non trovato':'Esiste già un articolo con questo identificativo',input.id?404:409);
    const before=existing??null;
    const sale=existing?.sale_cents??null;
    if(reference!== (existing?.reference_cents??null))db.prepare(
      "INSERT INTO price_history(item_id,kind,old_cents,new_cents,actor) SELECT id,'material',reference_cents,?,? FROM items WHERE id=?"
    ).run(reference,user.id,article);
    if(input.id)db.prepare('UPDATE items SET name=?,kind=?,category=?,description=?,reference_cents=?,sale_cents=?,minimum=?,supplier_id=? WHERE id=?')
      .run(name,kind,category,description,reference,sale,minimum,supplierId,article);
    else db.prepare('INSERT INTO items(id,name,kind,category,description,reference_cents,sale_cents,minimum,supplier_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(article,name,kind,category,description,reference,sale,minimum,supplierId);
    if(!existing&&reference!==null)db.prepare("INSERT INTO price_history(item_id,kind,old_cents,new_cents,actor) VALUES(?,'material',NULL,?,?)").run(article,reference,user.id);
    audit(db,user.id,'stock.item',{item:article,before,after:{name,kind,category,description,reference,sale,minimum,supplierId}});
    return {id:article};
  }));
  route('POST','/api/stock-batch','owner',({user,input})=>transaction(db,()=>{
    const reason=string(input.reason,200), changes=[];
    for(const row of rows(input.lines,54)){
      const item=itemId(row.item);
      const before=db.prepare('SELECT stock FROM items WHERE id=?').get(item);
      check(before,'Articolo non trovato',404);
      const delta=row.stock===undefined?integer(row.delta,-1000000,1000000):quantity(row.stock)-before.stock;
      if(row.expected!==undefined)check(before.stock===quantity(row.expected),'La scorta è cambiata. Riapri la rettifica.',409);
      check(delta!==0,'Una quantità indicata non cambia la scorta',400);
      move(db,user.id,item,delta,reason);
      changes.push({item,previous:before.stock,next:before.stock+delta});
    }
    audit(db,user.id,'stock.batch',{reason,changes});return {changes};
  }));
  route('POST','/api/item-moves','inventory.read',({input})=>db.prepare('SELECT * FROM moves WHERE item_id=? ORDER BY id DESC').all(itemId(input.item)));
}
