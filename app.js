const el = (tag,text,props={}) => Object.assign(document.createElement(tag),text===null?props:{textContent:text,...props});
const get = id => document.getElementById(id);
const view = get('view');
const status = message => {get('status').textContent=message;};
const money = cents => cents==null?'Da definire':(cents/100).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const roleLabels = {owner:'Owner',director:'Direttore',manager:'Responsabile',worker:'Dipendente',accountant:'Contabile',client:'Cliente',pending:'In attesa',rejected:'Rifiutato'};
let me;
let revision=0;
const allowed = permission => me.permissions.includes(permission);
async function api(path,input) {
  const response=await fetch('/api/'+path,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const data=await response.json();
  if (!response.ok) throw Error(data.error);
  return data;
}
function button(label,action) {
  const b=el('button',label,{type:'button'});
  b.onclick=async()=>{
    b.disabled=true;
    try { await action(); } catch(error) { status(error.message); } finally { b.disabled=false; }
  };
  return b;
}
function input(name,type='text',required=true) { return el('input',null,{name,type,required}); }
function pick(name,options) {
  const select=el('select',null,{name,required:true});
  for (const [id,title] of options) select.add(new Option(title,id));
  return select;
}
function form(fields,label,submit) {
  const root=el('form',null);
  for (const [title,control] of fields) {
    const label=el('label',title);
    label.append(control);
    root.append(label);
  }
  const b=el('button',label,{type:'submit'});
  root.append(b);
  root.onsubmit=async event=>{
    event.preventDefault();
    b.disabled=true;
    try {await submit(Object.fromEntries(new FormData(root)));} catch(error) {status(error.message);} finally {b.disabled=false;}
  };
  return root;
}
function table(headers,rows) {
  const wrap=el('div',null,{className:'table'});
  const t=el('table',null), head=t.createTHead().insertRow();
  for (const title of headers) head.append(el('th',title,{scope:'col'}));
  const body=t.createTBody();
  for (const row of rows) {
    const tr=body.insertRow();
    for (const cell of row) tr.insertCell().append(cell instanceof Node?cell:String(cell??'—'));
  }
  wrap.append(t);
  return wrap;
}
const names = rows => rows.map(r=>[r.id,r.name]);
const heading = text => el('h2',text);
async function catalog() {
  const list=await api('catalog');
  const children=[heading('Catalogo della bottega')];
  if (allowed('catalog.write')) children.push(form([['Articolo',pick('id',names(list))],['Prezzo in centesimi RP',input('price','number',false)]],'Salva prezzo',async d=>{
    await api('catalog',{id:d.id,cents:d.price===''?null:Number(d.price)});
    await show('catalog');status('Prezzo aggiornato.');
  }));
  return [...children,table(['Articolo','Prezzo unitario'],list.map(r=>[r.name,money(r.sale_cents)]))];
}
async function stock() {
  const [rows,moves]=await Promise.all([api('inventory'),api('moves')]);
  const children=[heading('Magazzino')];
  if (allowed('inventory.write')) children.push(form([['Articolo',pick('id',names(rows))],['Quantità (+ carico, − scarico)',input('delta','number')],['Causale',input('reason')]],'Registra movimento',async d=>{
    await api('inventory',{...d,delta:Number(d.delta)});
    await show('stock');status('Movimento registrato.');
  }));
  return [...children,table(['Articolo','Disponibili','Valore unitario di riferimento'],rows.map(r=>[r.name,r.stock,money(r.reference_cents)])),
    el('h3','Ultimi movimenti'),table(['Data UTC','Articolo','Quantità','Causale'],moves.map(r=>[r.created_at,r.item_id,r.delta,r.reason]))];
}
async function production() {
  const [list,ingredients,history]=await Promise.all([api('catalog'),api('recipes'),api('production')]);
  const result=el('div',null);
  const picker=form([['Ricetta',pick('id',names(list))],['Numero di craft',input('batches','number')],['Produci intermedi se mancanti',input('intermediate','checkbox',false)]],'Calcola fabbisogno',async d=>{
    const payload={id:d.id,batches:Number(d.batches),intermediate:d.intermediate==='on'};
    const plan=await api('plan',payload);
    const missing=Object.entries(plan.shortages);
    result.replaceChildren(el('h3','Piano di lavorazione'),
      table(['Articolo','Craft','Pezzi prodotti'],plan.steps.map(s=>[s.id,s.batches,s.output])),
      ...(missing.length?[table(['Materiale mancante','Quantità'],missing)]:[]));
    if (!missing.length && allowed('production.write')) result.append(button('Conferma produzione',async()=>{
      await api('production',payload);await show('production');status('Produzione registrata e scorte aggiornate.');
    }));
  });
  picker.oninput=()=>result.replaceChildren();
  const costs=el('div',null);
  const costForm=form([['Prodotto',pick('id',names(list))],['Pezzi desiderati',input('quantity','number')]],'Calcola costo standard',async d=>{
    const estimate=await api('estimate',{id:d.id,quantity:Number(d.quantity)});
    costs.replaceChildren(table(['Materia prima','Unità','Valore unitario','Costo'],estimate.materials.map(r=>[r.name,r.quantity,money(r.cents),money(r.total)])),
      el('p',estimate.total===null?'Subtotale dei soli materiali valorizzati · '+money(estimate.subtotal):'Costo standard dei craft necessari · '+money(estimate.total)));
  });
  costForm.oninput=()=>costs.replaceChildren();
  return [heading('Banco di produzione'),picker,result,el('h3','Calcolatore del costo standard'),costForm,costs,el('h3','Ricettario'),
    table(['Articolo','Pezzi per craft','Ingredienti'],list.map(r=>[r.name,r.yield_qty,ingredients.filter(i=>i.recipe_id===r.id).map(i=>i.qty+' '+i.label).join(', ')])),
    el('h3','Ultime lavorazioni'),table(['Numero','Data UTC','Articolo','Pezzi'],history.map(r=>[r.id,r.created_at,r.recipe_id,r.output]))];
}
async function market() {
  const list=await api('market');
  const children=[heading('Listini concorrenti')];
  if (allowed('market.write')) children.push(form([['Rilevazione',pick('id',list.map(r=>[r.id,r.city+' · '+r.business+' · '+r.name]))],['Prezzo in centesimi RP',input('cents','number')],['Motivo della correzione',input('note')]],'Correggi listino',async d=>{
    await api('market',{id:Number(d.id),cents:Number(d.cents),note:d.note});await show('market');status('Correzione registrata.');
  }));
  return [...children,table(['Città','Attività','Articolo','Prezzo','Rilevazione','Nota'],list.map(r=>[r.city,r.business,r.name,money(r.cents),r.observed,r.note]))];
}
async function access() {
  if (me.user.role==='rejected') return [heading('Richiesta respinta')];
  return [heading('Richiedi accesso'),form([['Nome RP',input('name')],['Motivazione',input('note')]],'Invia richiesta',async d=>{await api('access',d);status('Richiesta registrata.');})];
}
async function owner() {
  const [users,overrides]=await Promise.all([api('access'),api('permissions')]);
  const subjects=users.filter(r=>r.id!==me.user.id);
  const options=[...me.roles.map(r=>['role:'+r,roleLabels[r]]),...subjects.map(u=>['user:'+u.id,u.username+' · '+u.id])];
  const permissions=form([['Destinatario',pick('subject',options)],['Permesso',pick('permission',me.actions.map(p=>[p,p]))],
    ['Regola',pick('value',[['true','Consenti'],['false','Nega'],['null','Eredita']])]],'Salva permesso',async d=>{
    const [scope,subject]=d.subject.split(':');await api('permissions',{scope,subject,permission:d.permission,enabled:JSON.parse(d.value)});
    await show('owner');status('Permesso aggiornato.');
  });
  return [heading('Ufficio del titolare'),
    ...(subjects.length?[form([['Utente',pick('id',subjects.map(r=>[r.id,r.username]))],['Ruolo',pick('role',[...me.roles,'pending','rejected'].map(r=>[r,roleLabels[r]]))]],'Assegna ruolo',async d=>{
      await api('role',d);await show('owner');status('Ruolo aggiornato.');
    })]:[]),
    table(['Utente Discord','Ruolo','Nome RP','Richiesta'],users.map(r=>[r.username,r.id===me.user.id?'Owner':roleLabels[r.role],r.name,r.note])),
    el('h3','Permessi personalizzati'),permissions,
    table(['Tipo','Destinatario','Permesso','Regola'],overrides.map(r=>[r.scope,r.subject,r.permission,r.enabled?'Consenti':'Nega']))];
}
async function auditLog() {
  const rows=await api('audit');
  return [heading('Registro operazioni'),table(['Data UTC','Operatore','Operazione','Dettagli'],rows.map(r=>[r.created_at,r.actor,r.action,r.details]))];
}
const orderLabels={received:'Ricevuto',accepted:'Accettato',preparing:'In preparazione',producing:'In produzione',ready:'Pronto',
  delivered:'Consegnato',paid:'Incassato',cancelled:'Annullato',rejected:'Rifiutato'};
const nextStatuses={received:['accepted','rejected','cancelled'],accepted:['preparing','cancelled'],preparing:['producing','ready','cancelled'],
  producing:['ready','cancelled'],ready:['delivered','cancelled'],delivered:['paid']};
async function orders() {
  const [list,catalog]=await Promise.all([api('orders'),api('catalog')]);
  const content=[heading('Registro ordini')];
  const sellable=catalog.filter(item=>item.sale_cents!==null);
  if (allowed('orders.create') && sellable.length) {
    const lines=el('div',null);
    const selectors=[];
    function addLine() {
      const group=el('div',null,{className:'order-line'});
      const item=pick('article',sellable.map(x=>[x.id,x.name+' · '+money(x.sale_cents)]));
      item.setAttribute('aria-label','Articolo');
      const quantity=input('quantity','number');
      quantity.setAttribute('aria-label','Quantità');
      quantity.min=1;quantity.max=10000;quantity.value=1;
      const entry={item,quantity};
      selectors.push(entry);
      group.append(item,quantity,button('Rimuovi',()=>{
        if (selectors.length>1) { selectors.splice(selectors.indexOf(entry),1);group.remove(); }
      }));
      lines.append(group);
    }
    addLine();
    const orderForm=form([['Note',input('note','text',false)]],'Invia ordine',async d=>{
      const created=await api('orders',{note:d.note,lines:selectors.map(x=>({id:x.item.value,qty:Number(x.quantity.value)}))});
      await show('orders');status('Ordine #'+created.id+' ricevuto.');
    });
    orderForm.prepend(lines,button('Aggiungi articolo',()=>{if(selectors.length<36)addLine();}));
    content.push(orderForm);
  }
  content.push(table(['Ordine','Cliente','Articoli','Totale','Stato','Data UTC','Note','Azioni'],list.map(row=>{
    const controls=el('div',null,{className:'order-line'});
    if (allowed('orders.manage')) for (const next of nextStatuses[row.status]??[]) controls.append(button(orderLabels[next],async()=>{
      await api('order-status',{id:row.id,status:next});await show('orders');status('Ordine aggiornato.');
    }));
    return ['#'+row.id,row.username??me.user.username,row.lines.map(l=>l.quantity+' × '+l.name).join(', '),
      money(row.lines.reduce((total,l)=>total+l.quantity*l.cents,0)),orderLabels[row.status],row.created_at,row.note,controls];
  })));
  return content;
}
async function cash() {
  const [rows,purchases]=await Promise.all([api('receipts'),allowed('suppliers.read')?api('purchases'):Promise.resolve([])]);
  return [heading('Ufficio contabile'),el('p','Incassi verificati · '+money(rows.filter(r=>r.verified_by).reduce((sum,r)=>sum+r.cents,0))),
    table(['Ordine','Importo','Data UTC','Verifica'],rows.map(row=>['#'+row.order_id,money(row.cents),row.created_at,
      row.verified_by?'Verificato':allowed('cash.verify')?button('Conferma in cassa',async()=>{
        await api('receipts',{id:row.order_id});await show('cash');status('Incasso verificato.');
      }):'Da verificare'])),el('h3','Costi sostenuti per forniture · '+money(purchases.reduce((sum,p)=>sum+p.cents,0))),
    table(['Fornitore','Materiale','Totale'],purchases.map(r=>[r.supplier_name,r.item_name,money(r.cents)]))];
}
async function suppliers() {
  const [directory,history,items]=await Promise.all([api('suppliers'),api('purchases'),
    allowed('inventory.read')?api('inventory'):Promise.resolve([])]);
  const content=[heading('Fornitori')];
  if (allowed('suppliers.write')) {
    content.push(form([['Fornitore',input('name')],['Condizioni',input('terms')]],'Aggiungi fornitore',async d=>{
      await api('suppliers',d);await show('suppliers');status('Fornitore registrato.');
    }));
    if (items.length) content.push(form([['Fornitore',pick('supplier',names(directory))],['Materiale',pick('item',names(items))],
      ['Quantità',input('quantity','number')],['Costo totale pagato in centesimi RP',input('cents','number')],['Nota',input('note')]],
      'Ricevi fornitura',async d=>{
        await api('purchases',{...d,supplier:Number(d.supplier),quantity:Number(d.quantity),cents:Number(d.cents)});
        await show('suppliers');status('Fornitura ricevuta e scorte aggiornate.');
      }));
  }
  return [...content,table(['Fornitore','Condizioni'],directory.map(r=>[r.name,r.terms])),
    el('h3','Forniture ricevute'),table(['Data UTC','Fornitore','Materiale','Quantità','Costo totale','Nota'],
      history.map(r=>[r.created_at,r.supplier_name,r.item_name,r.quantity,money(r.cents),r.note]))];
}
async function tickets() {
  const list=await api('tickets');
  const content=[heading('Assistenza')];
  if (allowed('tickets.use')) content.push(form([['Oggetto',input('title')],['Messaggio',el('textarea',null,{name:'message',required:true,maxLength:1000})]],
    'Apri ticket',async d=>{await api('tickets',d);await show('tickets');status('Ticket aperto.');}));
  for (const ticket of list) {
    const detail=el('details',null);
    detail.append(el('summary','#'+ticket.id+' · '+ticket.title+(ticket.closed?' · Chiuso':' · Aperto')));
    for (const message of ticket.messages) {
      const text=el('p',null);
      text.append(el('strong',message.username+' · '),document.createTextNode(message.text));
      detail.append(text);
    }
    if (!ticket.closed) {
      detail.append(form([['Risposta',el('textarea',null,{name:'message',required:true,maxLength:1000})]],'Invia',async d=>{
        await api('ticket-message',{id:ticket.id,message:d.message});await show('tickets');status('Risposta inviata.');
      }));
      if (allowed('tickets.manage')) detail.append(button('Chiudi ticket',async()=>{
        await api('ticket-message',{id:ticket.id,close:true});await show('tickets');status('Ticket chiuso.');
      }));
    }
    content.push(detail);
  }
  return content;
}
const pages={tickets,suppliers,orders,cash,catalog,stock,production,market,owner,access,audit:auditLog};
async function show(page) {
  const current=++revision;
  document.body.classList.toggle('internal',page!=='catalog');
  view.dataset.page=page;
  status('');
  for (const b of get('nav').children) b.setAttribute('aria-current',String(b.dataset.page===page));
  view.replaceChildren();
  try {
    const children=await pages[page]();
    if (current===revision) view.replaceChildren(...children);
  } catch (error) { if (current===revision) status(error.message); }
}
try {
  me=await api('me');
  if (me.user) get('account').append(el('span',me.user.username+' · '+roleLabels[me.user.role]),button('Esci',async()=>{
    await api('logout',{});location.assign('/');
  }));
  else get('account').append(el('a','Accedi con Discord',{href:'/auth/discord',className:'button'}));
  const tabs=[['catalog','Vetrina',true],['stock','Magazzino',allowed('inventory.read')],['production','Produzione',allowed('production.plan')],
    ['market','Concorrenti',allowed('market.read')],['owner','Owner',allowed('owner')],['audit','Registro',allowed('audit.read')],
    ['orders','Ordini',allowed('orders.create')||allowed('orders.manage')],['cash','Contabilità',allowed('cash.read')],
    ['suppliers','Fornitori',allowed('suppliers.read')],['tickets','Assistenza',allowed('tickets.use')||allowed('tickets.manage')],
    ['access','Richiesta accesso',['pending','rejected'].includes(me.user?.role)]];
  for (const [id,label,visible] of tabs) if (visible) {
    const b=button(label,()=>show(id));b.dataset.page=id;get('nav').append(b);
  }
  await show('catalog');
} catch (error) { status(error.message); }
