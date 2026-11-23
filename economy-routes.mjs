import { agreementRates, agreementDiscount } from './trade.mjs';
import { audit,transaction } from './db.mjs';
import { costs,marketPrices,customerQuote } from './economy.mjs';

export function registerEconomy({route,db,requireAccess:check,string,integer}){
  const price=value=>value===null?null:integer(value,0,100000000);
  const product=db.prepare(`SELECT i.* FROM items i WHERE i.id=? AND (i.kind='finished' OR EXISTS
    (SELECT 1 FROM recipes WHERE item_id=i.id))`);
  const allProducts=db.prepare(`SELECT i.* FROM items i WHERE i.kind='finished' OR EXISTS
    (SELECT 1 FROM recipes WHERE item_id=i.id) ORDER BY i.name`);
  const history=db.prepare('INSERT INTO price_history(item_id,kind,old_cents,new_cents,actor) VALUES(?,?,?,?,?)');
  const getDraft=db.prepare('SELECT * FROM draft_prices WHERE item_id=?');
  const saveDraft=db.prepare(`INSERT INTO draft_prices(item_id,cents) VALUES(?,?)
    ON CONFLICT DO UPDATE SET cents=excluded.cents,updated_at=CURRENT_TIMESTAMP`);
  const readSource=db.prepare('SELECT supplier FROM material_sources WHERE item_id=?');
  function saveMaterial(id,cents,source,actor){
    const item=db.prepare('SELECT reference_cents FROM items WHERE id=?').get(id);
    check(item,'Materiale non trovato',404);
    db.prepare('UPDATE items SET reference_cents=? WHERE id=?').run(cents,id);
    if(source)db.prepare('INSERT INTO material_sources VALUES(?,?) ON CONFLICT DO UPDATE SET supplier=excluded.supplier').run(id,source);
    else db.prepare('DELETE FROM material_sources WHERE item_id=?').run(id);
    history.run(id,'material',item.reference_cents,cents,actor);
    audit(db,actor,'price.material',{id,before:item.reference_cents,after:cents,source});
  }
  function draft(id,cents,actor){
    check(product.get(id),'Prodotto non trovato',404);
    const previous=getDraft.get(id);
    saveDraft.run(id,cents);
    history.run(id,'draft',previous?.cents??null,cents,actor);
    audit(db,actor,'price.draft',{id,cents});
  }
  route('POST','/api/catalog','catalog.write',({user,input})=>transaction(db,()=>{
    draft(string(input.id,100),price(input.cents),user.id);return {ok:true};
  }));
  route('POST','/api/economy-material','owner',({user,input})=>transaction(db,()=>{
    saveMaterial(string(input.id,100),price(input.cents),input.source?string(input.source,150):null,user.id);
    return {ok:true};
  }));
  route('POST','/api/economy-publish','owner',({user,input})=>transaction(db,()=>{
    check(Array.isArray(input.items)&&input.items.length&&input.items.length<=500,'Seleziona i prezzi da pubblicare',400);
    const ids=new Set(input.items.map(x=>string(x,100)));
    for(const id of ids){
      const item=product.get(id),pending=getDraft.get(id);
      check(item&&pending,'Bozza non trovata',409);
      db.prepare('UPDATE items SET sale_cents=? WHERE id=?').run(pending.cents,id);
      history.run(id,'published',item.sale_cents,pending.cents,user.id);
      db.prepare('DELETE FROM draft_prices WHERE item_id=?').run(id);
    }
    audit(db,user.id,'price.published',{items:[...ids]});return {count:ids.size};
  }));
  route('POST','/api/economy-restore','owner',({user,input})=>transaction(db,()=>{
    const row=db.prepare('SELECT * FROM price_history WHERE id=?').get(integer(input.id,1,Number.MAX_SAFE_INTEGER));
    check(row,'Modifica non trovata',404);
    if(row.kind==='material')saveMaterial(row.item_id,row.old_cents,readSource.get(row.item_id)?.supplier??null,user.id);
    else draft(row.item_id,row.old_cents,user.id);
    audit(db,user.id,'price.restored',{history:row.id,item:row.item_id});return {ok:true};
  }));
  route('GET','/api/economy','catalog.write',()=>{
    const model=costs(db), market=marketPrices(db);
    const agreement=db.prepare("SELECT * FROM commercial_agreements WHERE active=1").get();
    const products=allProducts.all().map(p=>{
      const pending=getDraft.get(p.id), quote=pending?pending.cents:p.sale_cents;
      const calc=model.estimate(p.id,model.recipes.get(p.id)?.yield??1,quote);
      const offers=market.get(p.id)??[];
      const min=offers.length?Math.min(...offers.map(o=>o.cents)):null;
      const avg=offers.length?offers.reduce((n,r)=>n+r.cents,0)/offers.length:null;
      return {id:p.id,name:p.name,stock:p.stock,reserved:agreement&&quote!==null?Math.round(quote*(10000-agreementDiscount(agreement,p.id))/10000):null,published:p.sale_cents,draft:pending??null,cost:calc,
        market:{min,max:offers.length?Math.max(...offers.map(o=>o.cents)):null,avg,best:offers.filter(o=>o.cents===min).map(o=>({business:o.business,city:o.city})),
          deltaMin:quote===null||min===null?null:quote-min,deltaAvg:quote===null||avg===null?null:quote-avg}};
    });
    const actual=db.prepare(`SELECT item_id,SUM(received) quantity,SUM(received*unit_cents) cost FROM purchase_lines WHERE received>0 AND unit_cents IS NOT NULL GROUP BY item_id
      UNION ALL SELECT item_id,SUM(quantity),SUM(cents) FROM purchases GROUP BY item_id`).all();
    const materials=db.prepare(`SELECT i.id,i.name,i.reference_cents,i.stock,s.name AS supplier FROM items i LEFT JOIN suppliers s ON s.id=i.supplier_id ORDER BY i.name`).all().map(m=>{
      const price=model.pricing.get(m.id), received=actual.filter(r=>r.item_id===m.id);
      const derived=model.recipes.has(m.id)?model.estimate(m.id,1).unit:price.cents;
      const last=db.prepare("SELECT created_at FROM price_history WHERE item_id=? AND kind='material' ORDER BY id DESC LIMIT 1").get(m.id);
      return {...m,standard:derived,source:price.source??m.supplier,reference_source:readSource.get(m.id)?.supplier??null,
        observed:price.observed??last?.created_at??null,actual:received.length?received.reduce((n,r)=>n+r.cost,0)/received.reduce((n,r)=>n+r.quantity,0):null};
    });
    return {products,materials};
  });
  route('GET','/api/economy-dashboard','owner',()=>{
    const model=costs(db), finished=new Set(allProducts.all().map(i=>i.id));
    const stock=db.prepare('SELECT id,stock,sale_cents,reference_cents FROM items').all();
    let raw=0,standard=0,potential=0,missingStock=0,incomplete=0,low=0;
    const margins=[];
    for(const item of stock){
      const pending=getDraft.get(item.id);
      const price=pending?pending.cents:item.sale_cents;
      const calc=model.estimate(item.id,1,price);
      if(item.stock&&calc.unit===null)missingStock++;
      if(calc.unit!==null)standard+=item.stock*calc.unit;
      if(finished.has(item.id)){
        potential+=item.stock*(item.sale_cents??0);
        if(calc.unit===null)incomplete++;
        if(calc.percent!==null){margins.push(calc.percent);if(calc.percent<20)low++;}
      }else if(calc.unit!==null)raw+=item.stock*calc.unit;
    }
    return {raw,standard,potential,missingStock,incomplete,low,
      margin:margins.length?margins.reduce((n,p)=>n+p,0)/margins.length:null};
  });
  route('GET','/api/economy-history','owner',()=>db.prepare(`SELECT h.*,i.name FROM price_history h JOIN items i ON i.id=h.item_id ORDER BY h.id DESC`).all());
  route('GET','/api/commercial-agreements','suppliers.read',()=>({
    agreements:db.prepare('SELECT a.*,s.name FROM commercial_agreements a JOIN suppliers s ON s.id=a.supplier_id').all(),
    rates:agreementRates(db),
  }));
  route('POST','/api/commercial-agreement','owner',({input,user})=>transaction(db,()=>{
    const id=integer(input.supplier,1,Number.MAX_SAFE_INTEGER);
    const target=input.customer?client(string(input.customer,20)).id:null;
    const before=db.prepare('SELECT * FROM commercial_agreements WHERE supplier_id=?').get(id);
    check(before,'Convenzione non trovata',404);
    const active=integer(input.active,0,1),containers=integer(input.containers,0,10000);
    const boards=integer(input.boards,0,10000),standard=integer(input.standard,0,10000);
    db.prepare('UPDATE commercial_agreements SET customer_id=?,active=?,containers_bps=?,boards_bps=?,standard_bps=? WHERE supplier_id=?')
      .run(target,active,containers,boards,standard,id);
    audit(db,user.id,'commercial.agreement.edit',{before,after:{target,active,containers,boards,standard}});return {ok:true};
  }));
  route('POST','/api/commercial-rate','owner',({input,user})=>transaction(db,()=>{
    const supplier=integer(input.supplier,1,Number.MAX_SAFE_INTEGER),item=string(input.item,100);
    const ordinary=integer(input.ordinary,0,100000000),bulk=integer(input.bulk,0,ordinary),threshold=integer(input.threshold,1,100000);
    const before=db.prepare('SELECT * FROM agreement_rates WHERE supplier_id=? AND item_id=?').get(supplier,item);
    check(before,'Tariffa non trovata',404);
    db.prepare('UPDATE agreement_rates SET ordinary=?,bulk=?,threshold=? WHERE supplier_id=? AND item_id=?').run(ordinary,bulk,threshold,supplier,item);
    audit(db,user.id,'commercial.rate.edit',{before,after:{ordinary,bulk,threshold}});return {ok:true};
  }));
  route('GET','/api/economy-customers','owner',()=>({
    agreements:db.prepare('SELECT a.*,s.name FROM commercial_agreements a JOIN suppliers s ON s.id=a.supplier_id').all(),
    tiers:db.prepare('SELECT * FROM price_tiers').all(),
    customers:db.prepare(`SELECT u.id,rp.name,c.tier
      FROM users u JOIN rp_profiles rp ON rp.id=u.id LEFT JOIN account_controls a ON a.user_id=u.id LEFT JOIN customer_tiers c ON c.user_id=u.id
      WHERE u.role='client' ORDER BY name`).all(),
    overrides:db.prepare('SELECT * FROM customer_prices ORDER BY user_id,item_id').all(),
  }));
  route('POST','/api/economy-tier','owner',({user,input})=>transaction(db,()=>{
    const tier=string(input.tier,20);
    const discount=integer(input.discount,0,10000);
    check(tier!=='normal'&&tier!=='special'&&db.prepare('SELECT 1 FROM price_tiers WHERE id=?').get(tier),'Listino non modificabile',400);
    db.prepare('UPDATE price_tiers SET discount=? WHERE id=?').run(discount,tier);
    audit(db,user.id,'price.tier',{tier,discount});return {ok:true};
  }));
  function client(id){
    const u=db.prepare("SELECT id FROM users WHERE id=? AND role='client'").get(id);
    check(u,'Cliente non trovato',404);return u;
  }
  route('POST','/api/economy-customer','owner',({user,input})=>transaction(db,()=>{
    const target=client(string(input.user,20)).id;
    const tier=string(input.tier,20);
    check(db.prepare('SELECT 1 FROM price_tiers WHERE id=?').get(tier),'Listino non valido',400);
    db.prepare('INSERT INTO customer_tiers VALUES(?,?) ON CONFLICT DO UPDATE SET tier=excluded.tier').run(target,tier);
    audit(db,user.id,'price.customer',{target,tier});return {ok:true};
  }));
  route('POST','/api/economy-special','owner',({user,input})=>transaction(db,()=>{
    const target=client(string(input.user,20)).id,id=string(input.item,100),cents=price(input.cents);
    const item=product.get(id);
    check(item,'Prodotto non trovato',404);
    if(cents===null)db.prepare('DELETE FROM customer_prices WHERE user_id=? AND item_id=?').run(target,id);
    else{
      const calc=costs(db).estimate(id,1,cents);
      const under=calc.unit!==null&&cents+1e-9<calc.unit;
      const low=Boolean(db.prepare('SELECT 1 FROM commercial_agreements WHERE customer_id=? AND active=1').get(target))
        && calc.percent!==null&&calc.percent<20;
      const incomplete=calc.unit===null;
      check(!(under||low||incomplete)||input.approve===true,incomplete?'Costo incompleto: occorre l’autorizzazione esplicita dell’Owner':'Margine insufficiente: occorre l’autorizzazione esplicita dell’Owner',409);
      db.prepare(`INSERT INTO customer_prices VALUES(?,?,?,?,?) ON CONFLICT DO UPDATE SET cents=excluded.cents,
        approved_cost=excluded.approved_cost,incomplete=excluded.incomplete`)
        .run(target,id,cents,under||low?calc.unit:null,Number(incomplete));
    }
    audit(db,user.id,'price.special',{target,id,cents,approved:input.approve===true});return {ok:true};
  }));
  route('GET','/api/customer-catalog','orders.create',({user})=>{
    const model=costs(db);
    return allProducts.all().filter(p=>p.sale_cents!==null).map(p=>({id:p.id,name:p.name,sale_cents:p.sale_cents,
      ...customerQuote(db,user.id,p.id,p.sale_cents,model)}));
  });
  route('GET','/api/sale-customers','sales.write',()=>db.prepare(`SELECT u.id,rp.name
    FROM users u JOIN rp_profiles rp ON rp.id=u.id LEFT JOIN account_controls a ON a.user_id=u.id WHERE u.role='client' AND COALESCE(a.state,'active')='active' ORDER BY name`).all());
  route('POST','/api/sale-quote','sales.write',({input})=>{
    const id=string(input.item,100),item=product.get(id);
    check(item?.sale_cents!=null,'Prezzo di vendita non definito',409);
    return customerQuote(db,input.customer?client(string(input.customer,20)).id:'',id,item.sale_cents,costs(db));
  });
}
