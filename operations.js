import { categories,category,photo } from './products.js';

export function operations(ctx) {
  const {el,api,button,form,input,pick,table,money,allowed,show,status,modal,drawer,me,inventoryTools}=ctx;
  const box=(cls,...children)=>{const node=el('div',null,{className:cls});node.append(...children);return node;};
  const title=(name,desc,action)=>box('page-heading',box('',el('h1',name),desc?el('p',desc):el('span','')),...(action?[action]:[]));
  const badge=(name,tone='neutral')=>el('span',name,{className:'badge '+tone});
  const empty=text=>box('empty',el('span','◇',{className:'empty-symbol'}),el('p',text));
  const panel=(name,...children)=>box('panel',el('h2',name),...children);
  const metrics=(...items)=>box('metrics',...items.map(([label,value,note])=>box('metric',el('span',label),el('strong',String(value)),el('small',note))));
  const pict=(name,cls='')=>el('img',null,{src:photo(name),alt:'Fotografia di categoria · '+categories[category(name)][0],className:cls,loading:'lazy'});
  const query=(label)=>{const e=input('search','search',false);e.placeholder=label;e.setAttribute('aria-label',label);return e;};
  const age=(date)=>date?new Intl.DateTimeFormat('it-IT',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Rome'}).format(new Date(date.replace(' ','T')+'Z')):'—';
  const match=(text,value)=>String(text).toLowerCase().includes(value.trim().toLowerCase());
  const categoryOptions=()=>[['','Tutte le categorie'],...Object.entries(categories).map(([k,v])=>[k,v[0]])];
  const named=rows=>rows.map(r=>[r.id,r.name]);
  const permits=(keys,path)=>keys.some(allowed)?api(path):Promise.resolve([]);
  const orderLabels={received:'Ricevuto',accepted:'Accettato',preparing:'In preparazione',producing:'In produzione',ready:'Pronto',delivered:'Consegnato',paid:'Incassato',cancelled:'Annullato',rejected:'Rifiutato'};
  const orderTone={received:'warn',accepted:'neutral',preparing:'warn',producing:'warn',ready:'good',delivered:'good',paid:'good',cancelled:'bad',rejected:'bad'};
  const next={received:['accepted','rejected','cancelled'],accepted:['preparing','cancelled'],preparing:['producing','ready','cancelled'],producing:['ready','cancelled'],ready:['delivered','cancelled'],delivered:['paid']};
  const orderTotal=o=>o.lines.reduce((sum,l)=>sum+l.cents*l.quantity,0);
  const open=o=>!['cancelled','rejected','paid'].includes(o.status);
  const label=o=>o.username||me.user.username;
  const recent=(rows,render,text)=>rows.length?box('feed',...rows.map(render)):empty(text);
  const record=(left,right,detail)=>box('feed-row',box('',el('strong',left),el('small',detail)),right);
  const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',dateStyle:'short'}).format(new Date());
  const day=date=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Rome',dateStyle:'short'}).format(new Date(date.replace(' ','T')+'Z'));

  function chart(income,expenses) {
    const ledger=new Map();
    const add=(date,amount,index)=>{
      const key=day(date);
      if(!ledger.has(key))ledger.set(key,[0,0]);
      ledger.get(key)[index]+=amount;
    };
    for(const r of income) if(r.verified_by)add(r.created_at,r.cents,0);
    for(const r of expenses)add(r.created_at,r.cents,1);
    const rows=[...ledger.entries()].sort(([a],[b])=>a.localeCompare(b)).slice(-7);
    if(!rows.length)return empty('Il grafico si popolerà con i movimenti di cassa.');
    const largest=Math.max(1,...rows.flatMap(([,v])=>v));
    const bars=rows.map(([date,[a,b]])=>{
      const bar=(amount,cls,name)=>{const e=el('progress',null,{max:largest,value:amount,className:cls});e.setAttribute('aria-label',name+' '+date+' '+money(amount));return e;};
      return box('chart-row',el('span',date.slice(5).split('-').reverse().join('/')),box('bar-pair',bar(a,'income','Entrate'),bar(b,'expense','Uscite')),el('small',money(a)+' / '+money(b)));
    });
    return box('chart',box('chart-key',badge('Entrate verificate','good'),badge('Uscite','warn')),...bars);
  }

  async function summary() {
    const [orders,runs,items,receipts,purchases,requests,tickets,audit,entries]=await Promise.all([
      permits(['orders.create','orders.manage'],'orders'),permits(['production.plan'],'production'),permits(['inventory.read'],'inventory'),
      permits(['cash.read'],'receipts'),permits(['suppliers.read'],'purchases'),permits(['owner'],'access'),
      permits(['tickets.use','tickets.manage'],'tickets'),permits(['audit.read'],'audit'),permits(['cash.read'],'cash-entries'),
    ]);
    return {orders,runs,items,receipts,purchases,requests:requests.filter(r=>r.role==='pending'&&r.name),tickets,audit,entries};
  }
  async function dashboard() {
    const {orders,runs,items,receipts,purchases,requests,tickets,audit,entries}=await summary();
    const critical=items.filter(i=>i.minimum>0&&i.stock<i.minimum);
    const openOrders=orders.filter(open);
    const tiles=[];
    if(allowed('orders.manage')||allowed('orders.create')) tiles.push(['Ordini aperti',openOrders.length,'In carico alla bottega']);
    if(allowed('orders.manage')) tiles.push(['Ordini in produzione',orders.filter(o=>o.status==='producing').length,'Ordini in lavorazione']);
    if(allowed('cash.read')) tiles.push(['Incassi di oggi',money([...receipts.filter(r=>r.verified_by),...entries.filter(r=>r.kind==='sale')].filter(r=>day(r.created_at)===today()).reduce((n,r)=>n+r.cents,0)),'Verificati in cassa'],['Margine lordo','—','Costo del venduto non registrato']);
    if(allowed('inventory.read')) tiles.push(['Scorte critiche',critical.length,'Sotto la soglia impostata']);
    if(allowed('owner')) tiles.push(['Richieste in attesa',requests.length,'Accessi da esaminare']);
    const quick=(name,page)=>button(name,()=>show(page));
    const actions=[];
    if(allowed('orders.manage')||allowed('orders.create'))actions.push(quick('Apri ordini','orders'));
    if(allowed('production.plan'))actions.push(quick('Apri laboratorio','production'));
    if(allowed('inventory.read'))actions.push(quick('Controlla magazzino','stock'));
    if(allowed('tickets.use')||allowed('tickets.manage'))actions.push(quick('Apri assistenza','tickets'));
    const content=[];
    if(allowed('cash.read'))content.push(panel('Entrate e uscite',chart(...cashFlow(receipts,purchases,entries))));
    if(allowed('orders.manage')||allowed('orders.create'))content.push(panel('Ordini recenti',recent(orders.slice(0,5),o=>record('#'+o.id+' · '+label(o),badge(orderLabels[o.status],orderTone[o.status]),money(orderTotal(o))), 'Nessun ordine registrato.')));
    if(allowed('production.plan'))content.push(panel('Ultime lavorazioni',recent(runs.slice(0,5),r=>record(r.recipe_id,badge(r.output+' pz'),age(r.created_at)),'Nessuna lavorazione registrata.')));
    if(allowed('inventory.read'))content.push(panel('Avvisi di magazzino',recent(critical.slice(0,5),r=>record(r.name,badge(r.stock===0?'Esaurito':'Scorta bassa',r.stock===0?'bad':'warn'),r.stock+' disponibili · soglia '+r.minimum),'Nessun materiale valorizzato esaurito.')));
    if(allowed('suppliers.read'))content.push(panel('Ultime forniture',recent(purchases.slice(0,4),r=>record(r.item_name,badge(money(r.cents)),r.supplier_name),'Nessuna fornitura registrata.')));
    if(allowed('cash.read'))content.push(panel('Ultimi incassi',recent(receipts.slice(0,4),r=>record('Ordine #'+r.order_id,badge(money(r.cents),r.verified_by?'good':'warn'),age(r.created_at)),'Nessun incasso registrato.')));
    if(allowed('tickets.use')||allowed('tickets.manage'))content.push(panel('Ticket',recent(tickets.slice(0,4),t=>record(t.title,badge(t.closed?'Chiuso':'Aperto',t.closed?'neutral':'warn'),age(t.created_at)),'Nessun ticket.')));
    if(allowed('audit.read'))content.push(panel('Attività recenti',recent(audit.slice(0,5),r=>record(r.action,badge('#'+r.id),age(r.created_at)),'Nessuna attività registrata.')));
    return [title(me.user.role==='owner'?'Direzione — Falegnameria Vexmoor':'Panoramica', 'Rhodes · 1900  /  '+new Intl.DateTimeFormat('it-IT',{dateStyle:'full',timeZone:'Europe/Rome'}).format(new Date())),
      box('quick-actions',...actions),metrics(...tiles),box('dashboard-grid',...content)];
  }
  async function notifications() {
    const s=await summary();
    const entries=[];
    for(const [count,name,page] of [[s.requests.length,'Richieste di accesso','owner'],[allowed('orders.manage')?s.orders.filter(o=>o.status==='received').length:0,'Ordini da esaminare','orders'],[s.receipts.filter(r=>!r.verified_by).length,'Incassi da verificare','cash'],[s.tickets.filter(t=>!t.closed).length,'Ticket aperti','tickets']])
      if(count) entries.push(record(name,button('Apri '+name.toLowerCase(),()=>{document.getElementById('modal').close();return show(page);}),String(count)));
    return [title('Notifiche','Operazioni che richiedono attenzione.'),entries.length?box('feed',...entries):empty('Non ci sono notifiche in sospeso.')];
  }
  async function stock() {
    const [items,suppliers]=await Promise.all([api('inventory'),permits(['owner'],'suppliers')]);
    const tools=allowed('owner')?inventoryTools(items,suppliers):null;
    const custom=[...new Set(items.filter(i=>i.category).map(i=>i.category))].filter(c=>!categories[c]);
    const filter=pick('category',[...categoryOptions(),...custom.map(c=>[c,c])]);
    filter.setAttribute('aria-label','Categoria materiali');
    const sort=pick('sort',[['name','Nome A–Z'],['stock','Quantità crescente'],['value','Valore decrescente']]);
    sort.setAttribute('aria-label','Ordina inventario');
    const search=query('Cerca materiale');
    const grid=box('inventory-results');
    let mode='table';
    async function details(item,editing=false) {
      const list=await api('item-moves',{item:item.id});
      const contents=[metrics(['Scorta disponibile',item.stock,'Unità registrate'],['Valore unitario',money(item.reference_cents),'Riferimento']),
        panel('Movimenti',list.length?table(['Data','Operatore','Prima','Dopo','Variazione','Causale'],list.map(m=>[age(m.created_at),m.actor,m.previous_stock,m.new_stock,m.delta,m.reason])):empty('Nessun movimento per questo articolo.'))];
      if(allowed('inventory.write')) {
        contents.push(panel('Soglia scorta',form([['Soglia minima',Object.assign(input('minimum','number'),{min:0,max:1000000,value:item.minimum})]],'Salva soglia',async d=>{
          await api('stock-minimum',{id:item.id,minimum:Number(d.minimum)});
          document.getElementById('drawer').close();await show('stock');status('Soglia aggiornata.');
        })));
        if(editing)contents.unshift(form([['Operazione',pick('op',[['add','Carico'],['subtract','Scarico'],['set','Rettifica a quantità']])],['Quantità',input('quantity','number')],['Causale',input('reason')]],'Registra',async d=>{
          const qty=Number(d.quantity);
          if(!Number.isInteger(qty)||qty<0)throw Error('Inserisci una quantità intera positiva o zero.');
          if(d.op==='set'&&!confirm('Confermi la rettifica della scorta?'))return;
          const payload={id:item.id,reason:d.reason};
          if(d.op==='set')payload.stock=qty;
          else payload.delta=d.op==='add'?qty:-qty;
          await api('inventory',payload);
          document.getElementById('drawer').close();await show('stock');status('Movimento registrato.');
        }));
        else contents.unshift(button('Carico, scarico o rettifica',()=>details(item,true)));
      }
      if(tools)contents.unshift(box('quick-actions',button('Modifica articolo',()=>{document.getElementById('drawer').close();tools.edit(item);}),
        button('Rettifica scorte',()=>{document.getElementById('drawer').close();tools.adjust(item);})));
      if(item.description)contents.unshift(el('p',item.description));
      drawer(item.name,...contents);
    }
    function draw() {
      const rows=items.filter(i=>match(i.name,search.value)&&(!filter.value||(i.category||category(i.name))===filter.value))
        .sort((a,b)=>sort.value==='stock'?a.stock-b.stock:sort.value==='value'?(b.reference_cents??-1)-(a.reference_cents??-1):a.name.localeCompare(b.name,'it'));
      if(!rows.length){grid.replaceChildren(empty('Nessun materiale corrisponde ai filtri.'));return;}
      const state=i=>i.stock===0?badge('Esaurito','bad'):i.stock<i.minimum?badge('Scorta bassa','warn'):badge('Disponibile','good');
      grid.replaceChildren(mode==='table'?table(['Materiale','Categoria','Quantità','Valore unitario','Stato'],rows.map(i=>[
        button(i.name,()=>details(i)),i.category||categories[category(i.name)][0],i.stock,money(i.reference_cents),state(i)
      ])):box('stock-grid',...rows.map(i=>box('panel stock-card',pict(i.name),button(i.name,()=>details(i)),box('split',el('strong',i.stock+' pz'),state(i)),el('small',money(i.reference_cents)+' / pz')))));
    }
    const modeSwitch=pick('mode',[['table','Vista operativa'],['cards','Vista visuale']]);
    modeSwitch.setAttribute('aria-label','Modalità inventario');
    modeSwitch.onchange=()=>{mode=modeSwitch.value;draw();};
    search.oninput=filter.onchange=sort.onchange=draw;draw();
    return [title('Magazzino','Scorte, valori di riferimento e movimenti dei materiali.'),metrics(['Articoli',items.length,'Anagrafica materiali'],['Con scorta',items.filter(i=>i.stock>0).length,'Articoli disponibili'],['Esauriti',items.filter(i=>i.stock===0).length,'Articoli a zero']),box('toolbar',search,filter,sort,modeSwitch,...(tools?[button('＋ Nuovo articolo',()=>tools.edit()),
      button('Rettifica scorte',()=>tools.adjust()),button('Carico e scarico multiplo',tools.bulk)]:[])),grid];
  }

  async function production() {
    const [catalog,ingredients,history,materials,orders]=await Promise.all([api('catalog'),api('recipes'),api('production'),permits(['inventory.read'],'inventory'),permits(['orders.manage'],'orders')]);
    const items=catalog.filter(i=>i.yield_qty!==null);
    const entries=new Map(materials.map(m=>[m.id,m]));
    const search=query('Cerca una ricetta');
    const filter=pick('category',categoryOptions());filter.setAttribute('aria-label','Categoria ricetta');
    const list=box('recipe-list');
    const center=box('lab-center');
    const aside=box('lab-aside');
    let active=items[0],request=0,timer;
    const quantity=input('quantity','number');quantity.min=1;quantity.max=10000;
    const intermediate=input('intermediate','checkbox',false);intermediate.checked=true;
    const batches=el('strong','');
    const job=pick('order',[['','Produzione per magazzino']]);
    const labelField=(name,field)=>{const label=el('label',name);label.append(field);return label;};
    const tree=(id,count,depth=0)=>{
      if(depth>4)return el('span','');
      const nodes=ingredients.filter(i=>i.recipe_id===id).map(i=>{
        const total=i.qty*count;
        const available=entries.get(i.item_id)?.stock;
        const sub=items.find(m=>m.id===i.item_id);
        const missing=available===undefined?0:Math.max(0,total-available);
        return box('ingredient-node',box('ingredient-row',el('span','◇',{className:'ingredient-icon'}),el('span',i.label),
          badge(String(total),available===undefined?'neutral':available===0?'bad':available<total?'warn':'good')),
          ...(sub&&intermediate.checked&&missing?[tree(sub.id,Math.ceil(missing/sub.yield_qty),depth+1)]:[]));
      });
      return box('ingredient-tree',...nodes);
    };
    async function recalc() {
      const seq=++request;
      const qty=Number(quantity.value);
      if(!Number.isInteger(qty)||qty<1||qty>10000){aside.replaceChildren(empty('Inserisci una quantità da 1 a 10.000.'));return;}
      const count=Math.ceil(qty/active.yield_qty);
      batches.textContent=count+' craft · '+count*active.yield_qty+' pezzi prodotti';
      const diagram=center.querySelector('.tree-slot');
      diagram.replaceChildren(tree(active.id,count));
      const p={id:active.id,batches:count,intermediate:intermediate.checked};
      aside.replaceChildren(panel('Fabbisogno',el('p','Calcolo in corso…')));
      try {
        const [result,cost]=await Promise.all([api('plan',p),api('estimate',{id:p.id,quantity:qty})]);
        if(seq!==request)return;
        const lacking=Object.entries(result.shortages);
        aside.replaceChildren(panel('Disponibilità',lacking.length?recent(lacking,([id,n])=>record(entries.get(id)?.name??id,badge('−'+n,'bad'),'Mancanti'),''):badge('Materiali sufficienti','good')),
          panel('Costo standard',el('strong',money(cost.total)),el('p',cost.total===null?'Subtotale noto: '+money(cost.subtotal):'Valore dei materiali per i craft previsti.')),
          panel('Sequenza di lavorazione',recent(result.steps,s=>record(entries.get(s.id)?.name??s.id,badge(s.output+' pz'),s.batches+' craft'),'')));
        if(!lacking.length&&allowed('production.write'))aside.append(button('Avvia e registra produzione',async()=>{
          if(!confirm('Confermi il consumo dei materiali e il carico dei prodotti finiti?'))return;
          await api('production',{...p,orderId:job.value?Number(job.value):null});await show('production');status('Produzione registrata e scorte aggiornate.');
        }));
      }catch(error){if(seq===request)aside.replaceChildren(empty(error.message));}
    }
    function schedule(){++request;clearTimeout(timer);aside.replaceChildren(panel('Fabbisogno',el('p','Calcolo in corso…')));timer=setTimeout(recalc,180);}
    quantity.oninput=intermediate.onchange=schedule;
    function select(item) {
      active=item;quantity.value=item.yield_qty;draw();
      job.replaceChildren(new Option('Produzione per magazzino',''));
      for(const o of orders.filter(o=>['accepted','preparing','producing'].includes(o.status)&&o.lines.some(l=>l.item_id===item.id)))job.add(new Option('Commessa #'+o.id+' · '+label(o),o.id));
      center.replaceChildren(box('lab-photo',pict(item.name),box('lab-caption',el('p',categories[category(item.name)][0],{className:'eyebrow'}),el('h2',item.name))),
        box('panel',box('toolbar',labelField('Pezzi desiderati',quantity),labelField('Produci intermedi',intermediate),...(allowed('orders.manage')?[labelField('Ordine associato',job)]:[])),batches),
        panel('Distinta dei materiali',box('tree-slot')));
      schedule();
    }
    function draw(){
      const rows=items.filter(i=>match(i.name,search.value)&&(!filter.value||(i.category||category(i.name))===filter.value));
      list.replaceChildren(...(rows.length?rows.map(item=>{
        const b=button('',()=>select(item));b.className='recipe-pick';b.setAttribute('aria-current',String(active?.id===item.id));
        b.append(pict(item.name),box('',el('strong',item.name),el('small',item.yield_qty+' pz / craft')));return b;
      }):[empty('Nessuna ricetta trovata.')]));
    }
    search.oninput=filter.onchange=draw;
    if(active)select(active);
    return [title('Laboratorio di produzione','Configura i craft e controlla la distinta prima di registrare la lavorazione.'),
      box('lab',box('panel recipe-browser',el('h2','Ricettario'),search,filter,list),center,aside),
      panel('Registro lavorazioni',history.length?table(['Numero','Prodotto','Craft','Pezzi','Data'],history.map(r=>['#'+r.id,r.recipe_id,r.batches,r.output,age(r.created_at)])):empty('Nessuna lavorazione registrata.'))];
  }
  async function orders() {
    const [rows,catalog,staff]=await Promise.all([api('orders'),api('catalog'),permits(['orders.manage'],'staff')]);
    const search=query('Cerca ordine, cliente o articolo');
    const filter=pick('status',[['','Tutti gli stati'],...Object.entries(orderLabels)]);filter.setAttribute('aria-label','Stato ordine');
    const mode=pick('mode',[['board','Bacheca'],['table','Registro']]);mode.setAttribute('aria-label','Vista ordini');
    const output=box('order-results');
    const currentItem=new URLSearchParams(location.hash.split('?')[1]).get('item');
    function details(o) {
      const list=next[o.status]??[];
      const tools=allowed('orders.manage')?list.map(state=>button(orderLabels[state],async()=>{
        if(['ready','paid','cancelled','rejected'].includes(state)&&!confirm('Confermi il passaggio a '+orderLabels[state]+'?'))return;
        await api('order-status',{id:o.id,status:state});document.getElementById('drawer').close();await show('orders');status('Ordine aggiornato.');
      })):[];
      const staffSelect=pick('assignee',[['','Nessun assegnatario'],...staff.map(u=>[u.id,u.username])]);
      staffSelect.required=false;staffSelect.value=o.assignee??'';
      const assignment=allowed('orders.manage')?form([['Responsabile',staffSelect]],'Assegna',async d=>{
        await api('order-assignee',{id:o.id,assignee:d.assignee||null});
        document.getElementById('drawer').close();await show('orders');status('Responsabile aggiornato.');
      }):el('p',o.assignee_name||'Responsabile da assegnare');
      drawer('Ordine #'+o.id,box('split',badge(orderLabels[o.status],orderTone[o.status]),el('strong',money(orderTotal(o)))),
        el('p',label(o)+' · '+age(o.created_at)),o.note?el('p',o.note):el('p','Nessuna nota.'),
        assignment,panel('Articoli',table(['Articolo','Quantità','Prezzo unitario'],o.lines.map(l=>[l.name,l.quantity,money(l.cents)]))),
        panel('Lavorazioni associate',o.production.length?table(['Ricetta','Pezzi','Data'],o.production.map(p=>[p.recipe_id,p.output,age(p.created_at)])):empty('Nessuna lavorazione associata.')),
        panel('Cronologia',o.timeline.length?table(['Stato','Data'],o.timeline.map(e=>[orderLabels[e.status],age(e.created_at)])):empty('Nessun cambio di stato registrato.')),
        panel('Consegna e incasso',el('p',o.status==='paid'?'Consegnato, incasso dichiarato.':o.status==='delivered'?'Consegnato, in attesa di incasso.':'Consegna da registrare.')),
        box('quick-actions',...tools));
    }
    function draw(){
      const list=rows.filter(o=>(!filter.value||o.status===filter.value)&&match(o.id+' '+label(o)+' '+o.lines.map(l=>l.name).join(' '),search.value));
      if(mode.value==='table'){
        output.replaceChildren(list.length?table(['Numero','Cliente','Articoli','Importo','Stato','Data'],list.map(o=>[
          button('#'+o.id,()=>details(o)),label(o),o.lines.length,money(orderTotal(o)),badge(orderLabels[o.status],orderTone[o.status]),age(o.created_at)
        ])):empty('Nessun ordine corrisponde ai filtri.'));return;
      }
      const lanes=[['Ricevuti',['received']],['Accettati',['accepted','preparing']],['In produzione',['producing']],['Pronti',['ready']],['Consegnati',['delivered','paid']]];
      if(list.some(o=>['cancelled','rejected'].includes(o.status)))lanes.push(['Chiusi',['cancelled','rejected']]);
      output.replaceChildren(box('board',...lanes.filter(([,states])=>!filter.value||states.includes(filter.value)).map(([name,states])=>{
        const cards=list.filter(o=>states.includes(o.status));
        return box('lane',box('split',el('h2',name),badge(String(cards.length))),...(cards.length?cards.map(o=>{
          const card=button('',()=>details(o));card.className='order-card';
          card.append(box('split',el('strong','#'+o.id),badge(orderLabels[o.status],orderTone[o.status])),el('span',label(o)),
            el('small',o.lines.map(l=>l.quantity+' × '+l.name).join(', ')),el('strong',money(orderTotal(o))),el('small',o.assignee_name??'Da assegnare'));return card;
        }):[el('p','Nessun ordine',{className:'muted'})]));
      })));
    }
    function create(){
      const sellable=catalog.filter(i=>i.sale_cents!==null);
      if(!sellable.length){modal('Nuovo ordine',empty('Il catalogo non contiene ancora articoli con un prezzo di vendita.'));return;}
      const lines=box('order-form-lines'),entries=[];
      function add(selected){
        const product=pick('article',sellable.map(i=>[i.id,i.name+' · '+money(i.sale_cents)]));
        product.setAttribute('aria-label','Articolo');if(selected&&sellable.some(i=>i.id===selected))product.value=selected;
        const quantity=input('quantity','number');quantity.min=1;quantity.max=10000;quantity.value=1;quantity.setAttribute('aria-label','Quantità');
        const entry={product,quantity};entries.push(entry);
        const row=box('order-line',product,quantity,button('Rimuovi',()=>{if(entries.length>1){entries.splice(entries.indexOf(entry),1);row.remove();}}));
        lines.append(row);
      }
      const orderForm=form([['Note',input('note','text',false)]],'Invia ordine',async d=>{
        const result=await api('orders',{note:d.note,lines:entries.map(e=>({id:e.product.value,qty:Number(e.quantity.value)}))});
        document.getElementById('modal').close();await show('orders');status('Ordine #'+result.id+' inviato.');
      });
      add(currentItem);orderForm.prepend(lines,button('Aggiungi articolo',()=>{if(entries.length<36)add();}));
      modal('Nuovo ordine',orderForm);
    }
    if(currentItem&&allowed('orders.create')){history.replaceState(null,'','#orders');create();}
    search.oninput=filter.onchange=mode.onchange=draw;draw();
    return [title('Ordini','Monitora le commesse, dalla richiesta all’incasso.',allowed('orders.create')?button('＋ Nuovo ordine',create):null),box('toolbar',search,filter,mode),output];
  }
  async function cash() {
    const [receipts,purchases,items,entries]=await Promise.all([api('receipts'),permits(['suppliers.read'],'purchases'),permits(['inventory.read'],'inventory'),api('cash-entries')]);
    const verified=receipts.filter(r=>r.verified_by),pending=receipts.filter(r=>!r.verified_by);
    const sum=rows=>rows.reduce((n,r)=>n+r.cents,0);
    const values=new Map();
    for(const item of purchases)values.set(item.supplier_name,(values.get(item.supplier_name)??0)+item.cents);
    const filter=pick('status',[['all','Tutti gli incassi'],['pending','Da verificare'],['verified','Verificati']]);filter.setAttribute('aria-label','Stato incassi');
    const output=box('');
    function draw(){
      const rows=filter.value==='pending'?pending:filter.value==='verified'?verified:receipts;
      output.replaceChildren(rows.length?table(['Ordine','Importo','Data','Stato','Azione'],rows.map(r=>[
        '#'+r.order_id,money(r.cents),age(r.created_at),badge(r.verified_by?'Verificato':'Da verificare',r.verified_by?'good':'warn'),
        !r.verified_by&&allowed('cash.verify')?button('Conferma in cassa',async()=>{
          if(!confirm('Confermi di aver riscontrato '+money(r.cents)+' in cassa?'))return;
          await api('receipts',{id:r.order_id});await show('cash');status('Incasso verificato.');
        }):'—'
      ])):empty('Nessun incasso per il filtro selezionato.'));
    }
    filter.onchange=draw;draw();
    const stats=[['Entrate verificate',money(sum(verified)+sum(entries.filter(r=>r.cents>0))),verified.length+' incassi verificati'],['Incassi da verificare',money(sum(pending)),pending.length+' registrazioni'],['Margine lordo','—','Costo del venduto non registrato']];
    stats.splice(1,0,['Uscite registrate',money(sum(purchases)-sum(entries.filter(r=>r.cents<0))),'Acquisti, spese e rimborsi visibili']);
    if(allowed('inventory.read'))stats.push(['Valore stock noto',money(items.reduce((n,i)=>n+i.stock*(i.reference_cents??0),0)),'Valori di riferimento disponibili']);
    const columns=[panel('Andamento di cassa',chart(...cashFlow(receipts,purchases,entries)))];
    if(allowed('suppliers.read'))columns.push(panel('Costi per fornitore',values.size?table(['Fornitore','Importo'],[...values].sort((a,b)=>b[1]-a[1]).map(([s,n])=>[s,money(n)])):empty('Nessuna fornitura registrata.')));
    const entryForm=form([['Tipo',pick('kind',[['expense','Spesa'],['refund','Rimborso'],['adjustment','Rettifica con segno']])],
      ['Importo in centesimi RP',input('cents','number')],['Descrizione',input('description')]],'Registra movimento',async d=>{
      if(!confirm('Confermi la registrazione del movimento di cassa?'))return;
      await api('cash-entries',{...d,cents:Number(d.cents)});document.getElementById('modal').close();await show('cash');status('Movimento registrato.');
    });
    return [title('Contabilità','Segui gli incassi verificati, i movimenti da riscontrare e i costi delle forniture.',allowed('cash.write')?button('＋ Movimento',()=>modal('Registra movimento',entryForm)):null),metrics(...stats),box('dashboard-grid',...columns),
      panel('Registro incassi',box('toolbar',filter),output),
      panel('Vendite, rimborsi e rettifiche',entries.length?table(['Data','Tipo','Descrizione','Importo'],entries.map(r=>[age(r.created_at),entryLabels[r.kind],r.description,money(r.cents)])):empty('Nessun movimento registrato.')),
      ...(allowed('suppliers.read')?[panel('Registro acquisti',purchases.length?table(['Data','Fornitore','Materiale','Totale'],purchases.map(p=>[age(p.created_at),p.supplier_name,p.item_name,money(p.cents)])):empty('Nessun acquisto registrato.'))]:[])];
  }

  const entryLabels={sale:'Vendita diretta',expense:'Spesa',refund:'Rimborso',adjustment:'Rettifica'};
  const cashFlow=(receipts,purchases,entries)=>[
    [...receipts,...entries.filter(r=>r.cents>0).map(r=>({...r,verified_by:true}))],
    [...purchases,...entries.filter(r=>r.cents<0).map(r=>({...r,cents:-r.cents}))],
  ];
  async function sales(){
    const [catalog,rows]=await Promise.all([api('catalog'),api('sales')]);
    const priced=catalog.filter(p=>p.sale_cents!==null);
    const newSale=()=>modal('Vendita diretta',form([['Articolo',pick('item',priced.map(p=>[p.id,p.name+' · '+money(p.sale_cents)]))],
      ['Pezzi',Object.assign(input('quantity','number'),{min:1,max:10000,value:1})]],'Registra vendita',async d=>{
      if(!confirm('Confermi incasso e scarico dal magazzino?'))return;
      await api('sales',{item:d.item,quantity:Number(d.quantity)});document.getElementById('modal').close();await show('sales');status('Vendita registrata.');
    }));
    return [title('Vendite dirette','Registro delle vendite al banco.',priced.length?button('＋ Nuova vendita',newSale):null),
      rows.length?table(['Data','Articolo','Quantità','Incasso'],rows.map(r=>[age(r.created_at),r.description,r.quantity,money(r.cents)]))
        :empty(priced.length?'Nessuna vendita registrata.':'Imposta i prezzi in Catalogo e prezzi prima di registrare una vendita.')];
  }
  async function people(staff){
    const rows=await api(staff?'staff':'customers');
    return [title(staff?'Personale':'Clienti',staff?'Utenti abilitati per le operazioni della bottega.':'Anagrafica e attività dei clienti.'),
      rows.length?table(staff?['Utente','Ruolo']:['Cliente','Ordini','Ultimo ordine'],
        rows.map(r=>staff?[r.username,r.role==='pending'?'Owner':({worker:'Dipendente',manager:'Responsabile',director:'Direttore',accountant:'Contabile'}[r.role]??r.role)]:[r.username,r.orders,age(r.latest)])):empty('Nessun nominativo registrato.')];
  }
  async function reports(){
    const [receipts,purchases,entries]=await Promise.all([api('receipts'),permits(['suppliers.read'],'purchases'),api('cash-entries')]);
    const [income,expenses]=cashFlow(receipts,purchases,entries);
    function download(){
      const quote=value=>{const text=String(value??'');return '"'+(/^[=+@\-]/.test(text)&&typeof value!=='number'?"'"+text:text).replaceAll('"','""')+'"';};
      const rows=[['Data UTC','Tipo','Riferimento','Importo in centesimi RP'],
        ...receipts.map(r=>[r.created_at,r.verified_by?'Incasso verificato':'Incasso da verificare','Ordine #'+r.order_id,r.cents]),
        ...purchases.map(r=>[r.created_at,'Acquisto',r.supplier_name,-r.cents]),
        ...entries.map(r=>[r.created_at,entryLabels[r.kind],r.description,r.cents])];
      const url=URL.createObjectURL(new Blob(['\uFEFF',rows.map(r=>r.map(quote).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const link=el('a',null,{href:url,download:'Registro_Vexmoor.csv'});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    return [title('Report','Andamento di cassa ed esportazione dei registri disponibili.',button('Esporta CSV',download)),panel('Entrate e uscite',chart(income,expenses))];
  }

  return {dashboard,notifications,stock,production,orders,cash,sales,reports,staff:()=>people(true),customers:()=>people(false)};

}
