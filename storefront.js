import { categories,category,photo,euro } from './products.js';
const root=document.querySelector('main');
const make=(tag,text,props={})=>Object.assign(document.createElement(tag),text==null?props:{textContent:text,...props});
const link=(text,href,cls='button')=>make('a',text,{href,className:cls});
const section=(cls,...nodes)=>{const s=make('section',null,{className:cls});s.append(...nodes);return s;};
const image=(src,alt)=>make('img',null,{src,alt,loading:'lazy'});
let me={user:null,permissions:[]};
function heading(title,description) {
  return section('store-intro',make('h1',title),make('p',description));
}
function card(item) {
  const id=category(item.name);
  const detail=section('product-copy',make('p',item.category||categories[id][0],{className:'eyebrow'}),make('h2',item.name),make('p',item.description||categories[id][1]));
  const footer=section('product-foot',make('strong',euro(item.sale_cents)),make('small',item.available?'Disponibile in bottega':'Su lavorazione'));
  const order=item.sale_cents!==null;
  const action=order&&me.permissions.includes('orders.create')?'/gestionale#orders?item='+encodeURIComponent(item.id)
    :order&&!me.user?'/auth/discord':'/preventivo?articolo='+encodeURIComponent(item.name);
  const cta=link(order&&(me.permissions.includes('orders.create')||!me.user)?'Ordina':'Chiedi un preventivo',action,'button outline');
  if(order&&!me.user)cta.addEventListener('click',()=>sessionStorage.setItem('vexmoor-order-item',item.id));
  detail.append(footer,cta);
  return section('product-card',image(photo(item.name),categories[id][0]+' · fotografia di categoria'),detail);
}
function catalog(items) {
  const query=make('input',null,{type:'search',placeholder:'Cerca un prodotto…'});
  query.setAttribute('aria-label','Cerca nel catalogo');query.value=new URLSearchParams(location.search).get('q')??'';
  const filter=make('select');filter.setAttribute('aria-label','Filtra per categoria');
  filter.add(new Option('Tutte le categorie',''));
  for(const [id,[name]] of Object.entries(categories))filter.add(new Option(name,id));
  const grid=section('product-grid');
  const count=make('p',null,{className:'muted'});count.setAttribute('aria-live','polite');
  function draw(){
    const rows=items.filter(x=>(!filter.value||category(x.name)===filter.value)&&x.name.toLocaleLowerCase('it').includes(query.value.trim().toLocaleLowerCase('it')));
    count.textContent=rows.length+' articoli';
    grid.replaceChildren(...(rows.length?rows.map(card):[make('p','Nessun articolo corrisponde alla ricerca.')]));
  }
  query.oninput=filter.onchange=draw;draw();
  root.append(heading('Catalogo della bottega','Casse, utensili e manufatti disponibili a Rhodes.'),section('store-wrap',section('store-filters',query,filter,count),grid));
}
function home(items) {
  const hero=section('store-hero',section('store-hero-copy',make('p','RHODES · 1900',{className:'eyebrow'}),
    make('h1','Falegnameria Vexmoor'),make('p','Casse, attrezzi e manufatti per il lavoro e il viaggio.'),link('Esplora il catalogo','/catalogo')));
  const banner=section('editorial',image('/bottega.webp','Interno della falegnameria'),section('editorial-copy',
    make('p','LA BOTTEGA',{className:'eyebrow'}),make('h2','Lavorazioni su commessa'),make('p','La bottega di Marcus Vexmoor a Rhodes realizza manufatti e prepara forniture per privati e attività locali.'),
    link('Conosci la falegnameria','/bottega','button outline')));
  const featured=['Cassa grande chiusa','Ascia migliorata','Banco da lavoro'].map(n=>items.find(i=>i.name===n)).filter(Boolean);
  root.append(hero,section('store-wrap home-featured',make('h2','Dalla bottega'),section('product-grid',...featured.map(card))),banner);
}
function contact(quote) {
  const item=new URLSearchParams(location.search).get('articolo');
  const label=quote?'Richiedi un preventivo':'Assistenza';
  root.append(heading(label,quote?'Indica gli articoli e le quantità. La bottega ti risponderà nel gestionale.':'Apri una richiesta per informazioni, ordini o ritiri.'));
  const box=section('contact-box');
  if (me.permissions.includes('tickets.use')) {
    const form=make('form');
    const subject=make('input',null,{required:true,maxLength:100,value:quote?'Preventivo'+(item?' · '+item:''):''});
    const msg=make('textarea',null,{required:true,maxLength:1000,rows:6});
    for(const [name,field] of [['Oggetto',subject],['Messaggio',msg]]){const label=make('label',name);label.append(field);form.append(label);}
    const result=make('p');result.setAttribute('role','status');
    const submit=make('button','Invia richiesta',{type:'submit'});form.append(submit,result);
    form.onsubmit=async e=>{
      e.preventDefault();submit.disabled=true;
      try{
        const res=await fetch('/api/tickets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:subject.value,message:msg.value})});
        const data=await res.json();
        if(!res.ok)throw Error(data.error);
        form.reset();result.replaceChildren(document.createTextNode('Richiesta #'+data.id+' inviata. '),link('Apri i tuoi ticket','/gestionale#tickets',''));
      }catch(error){result.textContent=error.message;}finally{submit.disabled=false;}
    };
    box.append(form);
  }else box.append(make('p',me.user?'Accedi al gestionale per consultare i ticket o lo stato della tua richiesta di accesso.':'Accedi con Discord per inviare una richiesta e seguire le risposte della bottega.'),
    link(me.user?'Apri il gestionale':'Accedi con Discord',me.user?'/gestionale':'/auth/discord'));
  root.append(box);
}
try {
  me=await fetch('/api/me').then(r=>r.json());
  if(me.user){const access=document.getElementById('account');access.textContent='Gestionale';access.href='/gestionale';}
  const page=location.pathname;
  document.querySelectorAll('.store-header nav a').forEach(a=>{if(a.pathname===page)a.setAttribute('aria-current','page');});
  if(page==='/'||page==='/catalogo'){
    const response=await fetch('/api/catalog');
    if(!response.ok)throw Error('Il catalogo è temporaneamente indisponibile.');
    const items=await response.json();if(page==='/')home(items);else catalog(items);
  }else if(page==='/bottega'){
    root.append(heading('La Falegnameria','La bottega di Marcus Vexmoor a Rhodes.'),section('editorial',image('/bottega.webp','Banco da lavoro della falegnameria'),
      section('editorial-copy',make('h2','Dal banco alla consegna'),make('p','Forniamo legname lavorato, attrezzature e manufatti per privati e attività di Wild Lands. Per ordinativi su misura, inviaci una richiesta con il materiale e le quantità desiderate.'),link('Richiedi un preventivo','/preventivo'))));
  }else contact(page==='/preventivo');
}catch(error){root.append(heading('Bottega temporaneamente indisponibile',error.message));}
