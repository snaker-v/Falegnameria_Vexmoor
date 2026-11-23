import { economics } from './economy-ui.js';
import { extension } from './procurement-ui.js';
import { operations } from './operations.js';
const el = (tag,text,props={}) => Object.assign(document.createElement(tag),text===null?props:{textContent:text,...props});
const get = id => document.getElementById(id);
const view = get('view');
const status = message => {
  const notice=document.querySelector('dialog[open] .dialog-status')??get('status');
  notice.textContent=message;
};
const money = cents => cents==null?'Da definire':(cents/100).toLocaleString('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2})+' $';
const roleLabels = {owner:'Owner',director:'Direttore',manager:'Responsabile',worker:'Dipendente',accountant:'Contabile',client:'Cliente',pending:'In attesa',rejected:'Rifiutato',revoked:'Whitelist revocata',suspended:'Sospeso',disabled:'Disattivato'};
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
    if(!control.hasAttribute('aria-label'))control.setAttribute('aria-label',title);
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
async function market() {
  const list=await api('market');
  const children=[heading('Listini concorrenti')];
  if (allowed('market.write')) children.push(form([['Rilevazione',pick('id',list.map(r=>[r.id,r.city+' · '+r.business+' · '+r.name]))],['Prezzo in centesimi RP',input('cents','number')],['Motivo della correzione',input('note')]],'Correggi listino',async d=>{
    await api('market',{id:Number(d.id),cents:Number(d.cents),note:d.note});await show('market');status('Correzione registrata.');
  }));
  return [...children,table(['Città','Attività','Articolo','Prezzo','Rilevazione','Nota'],list.map(r=>[r.city,r.business,r.name,money(r.cents),r.observed,r.note]))];
}
async function access() {
  if (me.user.role!=='pending') return [heading(roleLabels[me.user.role]),el('p','Contatta il titolare per informazioni sul tuo accesso.')];
  return [heading('Richiedi accesso'),form([['Nome RP',input('name')],['Motivazione',input('note')]],'Invia richiesta',async d=>{await api('access',d);status('Richiesta registrata.');})];
}
async function auditLog() {
  const rows=await api('audit');
  return [heading('Registro operazioni'),table(['Data UTC','Operatore','Operazione','Dettagli'],rows.map(r=>[r.created_at,r.actor,r.action,r.details]))];
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
  const editable=allowed('suppliers.write')&&items.length>0;
  function editSupply(record){
    const supplier=pick('supplier',names(directory));
    supplier.value=String(record.supplier);
    const item=pick('item',names(items));
    item.value=record.item_id;
    const quantity=Object.assign(input('quantity','number'),{value:record.quantity,min:1,max:100000});
    const cents=Object.assign(input('cents','number'),{value:record.cents,min:0,max:100000000});
    const note=Object.assign(input('note','text',false),{value:record.note,maxLength:250});
    const reason=Object.assign(input('reason'),{maxLength:200});
    const previous=Object.fromEntries(['supplier','item_id','quantity','cents','note'].map(key=>[key,record[key]]));
    modal('Modifica fornitura #'+record.id,
      el('p','Se cambi articolo o quantità, lo scarico e il carico di rettifica vengono registrati in magazzino. Il costo resta il totale della fornitura.'),
      form([['Fornitore',supplier],['Materiale',item],['Quantità',quantity],['Costo totale pagato in centesimi RP',cents],
        ['Nota',note],['Motivo della rettifica',reason]],'Salva rettifica',async d=>{
        const result=await api('purchases/correct',{...d,id:record.id,previous,supplier:Number(d.supplier),
          quantity:Number(d.quantity),cents:Number(d.cents)});
        document.getElementById('modal').close();
        await show('suppliers');
        status(result.changed?'Fornitura rettificata.':'Nessuna modifica alla fornitura.');
      }));
  }
  return [...content,table(['Fornitore','Condizioni'],directory.map(r=>[r.name,r.terms])),
    el('h3','Forniture ricevute'),table(['Data UTC','Fornitore','Materiale','Quantità','Costo totale','Nota',...(editable?['Azioni']:[])],
      history.map(r=>[r.created_at,r.supplier_name,r.item_name,r.quantity,money(r.cents),r.note,
        ...(editable?[button('Modifica',()=>editSupply(r))]:[])]))];
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
function settings(){
  const density=pick('density',[['regular','Normale'],['compact','Compatta']]);
  density.value=localStorage.getItem('vexmoor-density')==='compact'?'compact':'regular';
  return [heading('Impostazioni'),el('p','Le preferenze sono salvate in questo browser.'),form([['Densità delle tabelle',density]],'Salva preferenze',data=>{
    localStorage.setItem('vexmoor-density',data.density);
    document.body.classList.toggle('compact',data.density==='compact');
    status('Preferenze salvate.');
  })];
}
let pages, navigation, ops;
function dialog(id,title,...children){
  const root=get(id), content=root.querySelector('.dialog-content');
  const head=el('header',null,{className:'dialog-heading'});
  const heading=el('h2',title,{id:id+'-title'});root.setAttribute('aria-labelledby',heading.id);
  const close=button('×',()=>root.close());close.setAttribute('aria-label','Chiudi');
  head.append(heading,close);
  const feedback=el('p',null,{className:'dialog-status'});feedback.setAttribute('role','status');
  content.replaceChildren(head,feedback,...children);
  if(!root.open)root.showModal();
}
async function render(page) {
  const current=++revision;
  const entry=navigation.find(x=>x[1]===page);
  get('crumb').textContent=entry?entry[0]+' / '+entry[2]:'Gestionale';
  view.dataset.page=page;
  status('');
  for (const b of get('nav').querySelectorAll('a')) b.setAttribute('aria-current',b.dataset.page===page?'page':'false');
  view.setAttribute('aria-busy','true');
  view.replaceChildren(el('p','Caricamento…',{className:'muted'}));
  try {
    const children=await pages[page]();
    if (current===revision) view.replaceChildren(...children);
  } catch (error) {
    if (current===revision) view.replaceChildren(el('p',error.message,{className:'error'}),button('Riprova',()=>render(page)));
  } finally { if(current===revision)view.setAttribute('aria-busy','false'); }
}
async function show(page){
  if(!pages[page])return;
  if(location.hash!=='#'+page)history.pushState(null,'','#'+page);
  await render(page);
  if(matchMedia('(max-width: 760px)').matches){
    document.body.classList.remove('menu-open');
    get('menu').setAttribute('aria-expanded','false');
  }
}
function routePage(){
  const name=location.hash.slice(1).split('?')[0];
  return pages[name]?name:pages.access?'access':'dashboard';
}
function searchDialog(){
  const q=input('q','search',false);q.placeholder='Cerca sezioni, articoli o ordini…';q.setAttribute('aria-label','Cerca nel gestionale');
  const results=el('div',null,{className:'search-results'});
  modal('Ricerca globale',q,results);
  const orderAccess=allowed('orders.create')||allowed('orders.manage');
  let catalog=[],orders=[];
  function draw(){
    const value=q.value.trim().toLowerCase();
    const matches=(title)=>title.toLowerCase().includes(value);
    const sections=navigation.filter(([, ,label])=>matches(label)).map(([,page,label])=>[label,page]);
    const products=value?catalog.filter(p=>matches(p.name)).slice(0,8).map(p=>[p.name,allowed('production.plan')?'production':allowed('catalog.write')?'catalog':null,p.name]):[];
    const found=value?orders.filter(o=>matches('#'+o.id+' '+(o.username??'')+' '+o.lines.map(l=>l.name).join(' '))).slice(0,8).map(o=>['Ordine #'+o.id,'orders','#'+o.id]):[];
    results.replaceChildren(...[...sections,...products,...found].map(([label,page,term])=>button(label,async()=>{
      get('modal').close();
      if(!page){location.assign('/catalogo?q='+encodeURIComponent(term));return;}
      await show(page);
      if(term){
        const search=view.querySelector('input[type=search]');
        if(search){search.value=term;search.dispatchEvent(new Event('input'));}
      }
    })));
    if(!results.childElementCount)results.append(el('p','Nessun risultato.'));
  }
  q.oninput=draw;draw();q.focus();
  return Promise.all([api('catalog'),orderAccess?api('orders'):[]]).then(([p,o])=>{catalog=p;orders=o;draw();});
}
const modal=(title,...children)=>dialog('modal',title,...children);
const drawer=(title,...children)=>dialog('drawer',title,...children);
try {
  me=await api('me');
  if(!me.user){location.replace('/auth/discord');}
  else {
    const pending=['pending','rejected','revoked','suspended','disabled'].includes(me.user.role);
    const all=[
      ['Panoramica','dashboard','Dashboard',!pending],['Panoramica','notifications','Notifiche',!pending],['Panoramica','activity','Attività recenti',allowed('audit.read')],
      ['Operazioni','orders','Ordini',allowed('orders.create')||allowed('orders.manage')],['Operazioni','production','Produzione',allowed('production.plan')],['Operazioni','stock','Magazzino',allowed('inventory.read')],
      ['Operazioni','sales','Vendite dirette',allowed('sales.write')],['Commercio','customers','Clienti',allowed('orders.manage')],['Commercio','catalog','Catalogo e prezzi',allowed('catalog.write')],['Commercio','suppliers','Fornitori',allowed('suppliers.read')],['Commercio','purchases','Acquisti',allowed('purchasing.read')],['Commercio','market','Analisi concorrenza',allowed('market.read')],
      ['Amministrazione','cash','Contabilità',allowed('cash.read')],['Amministrazione','staff','Personale',allowed('orders.manage')],['Amministrazione','reports','Report',allowed('cash.read')],['Amministrazione','audit','Registro operazioni',allowed('audit.read')],
      ['Sistema','tickets','Ticket',allowed('tickets.use')||allowed('tickets.manage')],['Sistema','owner','Gestione utenti',allowed('owner')],
      ['Sistema','permissions','Ruoli e permessi',allowed('owner')],['Sistema','settings','Impostazioni',!pending],['Sistema','access','Richiesta accesso',pending],
    ];
    navigation=all.filter(x=>x[3]);
    const ctx={el,api,button,form,input,pick,table,money,allowed,show,status,modal,drawer,me,roles:roleLabels};
    const extra=extension(ctx);
    const economy=economics(ctx);
    ops=operations({...ctx,inventoryTools:extra.inventoryTools});
    const registry={...ops,activity:auditLog,tickets,suppliers,catalog:economy.catalog,market,purchases:extra.purchases,owner:()=>extra.owner('users'),permissions:()=>extra.owner('permissions'),settings,access,audit:auditLog};
    pages=Object.fromEntries(navigation.map(([,id])=>[id,registry[id]]));
    const grouped=new Map();
    for(const [group,id,label] of navigation){
      if(!grouped.has(group)){
        const area=el('section',null,{className:'nav-group'});
        area.append(el('h2',group));get('nav').append(area);grouped.set(group,area);
      }
      const link=el('a',label,{href:'#'+id});
      link.dataset.page=id;link.onclick=e=>{if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();void show(id);}};
      grouped.get(group).append(link);
    }
    get('account').textContent=me.user.username+' · '+roleLabels[me.user.role];
    get('profile-actions').append(button('Esci',async()=>{await api('logout',{});location.assign('/');}));
    get('search').onclick=()=>searchDialog().catch(e=>status(e.message));
    get('alerts').hidden=pending;get('alerts').onclick=async()=>{
      try{const [, ...content]=await ops.notifications();modal('Notifiche',...content);}catch(error){status(error.message);}
    };
    const item=sessionStorage.getItem('vexmoor-order-item');
    if(item&&!location.hash){
      sessionStorage.removeItem('vexmoor-order-item');
      if(allowed('orders.create'))history.replaceState(null,'','#orders?item='+encodeURIComponent(item));
    }
    document.body.classList.toggle('compact',localStorage.getItem('vexmoor-density')==='compact');
    const menu=get('menu'), mobile=matchMedia('(max-width: 760px)');
    const updateMenu=()=>{menu.setAttribute('aria-expanded',String(mobile.matches?document.body.classList.contains('menu-open'):!document.body.classList.contains('menu-closed')));};
    menu.onclick=()=>{document.body.classList.toggle(mobile.matches?'menu-open':'menu-closed');updateMenu();};
    mobile.onchange=updateMenu;updateMenu();
    window.addEventListener('hashchange',()=>void render(routePage()));
    await render(routePage());
  }
} catch (error) { status(error.message); }
