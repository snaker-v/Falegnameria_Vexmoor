const states={
  draft:'Bozza',queued:'Da ordinare',ordered:'Ordinato',partial:'Parzialmente ricevuto',received:'Ricevuto',
  cancelled:'Annullato',request:'Da richiedere',requested:'Richiesto',confirmed:'Confermato',pickup:'Disponibile per il ritiro',
};
const flow={draft:'queued',queued:'ordered',request:'requested',requested:'confirmed',confirmed:'pickup'};
const statuses={active:'Attivo',revoked:'Whitelist revocata',suspended:'Sospeso',disabled:'Disattivato'};
const fordSources=['Boschi Ford','Miniere Ford','Fonderia Ford'];
const date=value=>value?.slice(0,16).replace('T',' ')??'—';
const sum=(rows,value)=>rows.reduce((n,row)=>n+value(row),0);
const matches=(text,query)=>String(text).toLocaleLowerCase('it').includes(query.trim().toLocaleLowerCase('it'));
const nullable=value=>value===''?null:Number(value);

export function extension(ctx) {
  const {el,api,button,form,input,pick,table,money,allowed,show,status,modal,drawer,me,roles}=ctx;
  function box(className,...content){const e=el('div',null,{className});e.append(...content);return e;}
  const label=(name,control)=>{const e=el('label',name);e.append(control);return e;};
  const title=(name,text,...actions)=>box('page-heading',box('',el('h1',name),el('p',text)),box('quick-actions',...actions));
  const panel=(name,...children)=>box('panel',el('h2',name),...children);
  const badge=(text,tone='neutral')=>el('span',text,{className:'badge '+tone});
  const empty=text=>box('empty',el('span','◇',{className:'empty-symbol'}),el('p',text));
  const metric=(name,value,sub)=>box('metric',el('span',name),el('strong',String(value)),el('small',sub));
  const search=(text)=>{const e=input('search','search',false);e.placeholder=text;e.setAttribute('aria-label',text);return e;};
  const choices=rows=>rows.map(r=>[r.id,r.name]);
  const field=(name,value,type='text',required=false)=>Object.assign(input(name,type,required),{value:value??''});
  const close=id=>document.getElementById(id).close();
  async function changed(page,message,dialog='modal'){close(dialog);await show(page);status(message);}
  const idempotent=()=>crypto.randomUUID();
  const num=(name,value,required=true)=>Object.assign(field(name,value,'number',required),{step:1});
  const filteredSelect=(name,options)=>{const e=pick(name,options);e.required=false;return e;};

  function lineEditor(options,fields,initial=[]) {
    const area=box('order-form-lines');
    const rows=[];
    function add(values={}){
      if(rows.length>=30)return;
      const item=pick('item',options);if(values.item)item.value=values.item;
      item.setAttribute('aria-label','Articolo');
      const controls=Object.fromEntries(fields.map(([name,title,base,required])=>[name,num(name,values[name]??base,required)]));
      const entry={item,controls};
      const row=box('order-line',label('Articolo',item),...fields.map(([name,title])=>label(title,controls[name])),
        button('Rimuovi',()=>{if(rows.length>1){row.remove();rows.splice(rows.indexOf(entry),1);}}));
      rows.push(entry);area.append(row);
    }
    (initial.length?initial:[{}]).forEach(add);
    return {ui:box('order-form-lines',area,button('Aggiungi riga',()=>add())),data:()=>rows.map(r=>({
      item:r.item.value,...Object.fromEntries(Object.entries(r.controls).map(([k,c])=>[k,nullable(c.value)])),
    }))};
  }
  function graph(rows,aria){
    if(!rows.length)return empty('Nessun movimento registrato.');
    const max=Math.max(...rows.map(([,n])=>n),1);
    return box('chart',...rows.map(([name,amount])=>{
      const bar=el('progress',null,{value:Math.max(0,amount),max,className:'expense'});
      bar.setAttribute('aria-label',aria+' · '+name+' · '+money(amount));
      return box('procurement-bar',el('span',name),box('bar-pair',bar),el('strong',money(amount)));
    }));
  }
  async function exportOrders(){
    const orders=await api('procurement-export');
    const quote=v=>'"'+(/^[=+@\-\t\r]/.test(String(v))&&typeof v!=='number'?"'"+v:String(v??'')).replaceAll('"','""')+'"';
    const records=[['Ordine','Fornitore','Stato','Data','Materiale','Ordinato','Ricevuto','Prezzo unitario (centesimi)'],
      ...orders.map(o=>[o.id,o.supplier_name,states[o.state],o.created_at,o.name,o.quantity,o.received,o.unit_cents])];
    const url=URL.createObjectURL(new Blob(['\ufeff',records.map(r=>r.map(quote).join(';')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    el('a',null,{href:url,download:'Acquisti_Vexmoor.csv'}).click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function purchases(){
    const data=await api('procurement');
    const {plan,orders,comparison,items,suppliers,staff,legacy,benchmarks}=data;
    const itemOptions=choices(items),supplierOptions=choices(suppliers);
    const pending=orders.filter(o=>!['received','cancelled'].includes(o.state));
    const gross=o=>-sum(o.payments,p=>p.cents);
    const purchased=orders.filter(o=>o.lines.some(l=>l.received));
    const fordValue=sum(purchased.filter(o=>o.ford_source),o=>sum(o.lines,l=>l.received*(l.reference_cents??0)));
    const fordUnknown=purchased.filter(o=>o.ford_source).some(o=>o.lines.some(l=>l.received&&l.reference_cents===null));
    const priceTotal=o=>o.lines.some(l=>l.unit_cents===null)?null:sum(o.lines,l=>l.quantity*l.unit_cents);
    const pricePlan=sum(comparison,r=>r.best??0);
    const unmatched=comparison.filter(r=>r.quantity&&r.best===null).length;
    function create(initial){
      const selection=pick('supplier',supplierOptions);
      const responsibility=filteredSelect('assignee',[['','Utente corrente'],...choices(staff)]);
      const editor=lineEditor(itemOptions,[['quantity','Quantità',1,true],['unit_cents','Prezzo unitario in centesimi RP','',false]], initial);
      const hint=el('p','Per una fornitura Ford, il prezzo monetario è zero.');
      const event=form([['Fornitore',selection],['Responsabile',responsibility],['Note',field('notes','')]],'Crea ordine',async d=>{
        await api('procurement-order',{...d,supplier:Number(d.supplier),lines:editor.data()});await changed('purchases','Ordine creato.');
      });
      event.prepend(editor.ui,hint);modal('Nuovo ordine di acquisto',event);
    }
    function compare(row){
      const best=row.winners.map(o=>[o.name,o.city].filter(Boolean).join(' · '));
      const others=row.options.filter(o=>o.total!==null&&(o.available===null||o.available>=row.quantity));
      const alternatives=others.filter(o=>o.total>row.best);
      const next=alternatives.length?Math.min(...alternatives.map(o=>o.total)):null;
      let rationale=row.quantity===0?'Il fabbisogno è coperto dalle consegne attese. Le unità in arrivo non sono ancora in magazzino.':
        best.length?best.join(' e ')+' offrono il miglior totale noto per '+row.quantity+' pezzi ('+money(row.best)+'). '+(row.freightKnown?'Trasporto incluso.':'Confronto sul prezzo dei materiali. Trasporto escluso dove non verificabile.'):
        'Nessuna offerta nota copre la quantità residua.';
      if(next!==null&&best.length)rationale+=' Risparmio sul successivo totale noto '+money(next-row.best)+'.';
      const local=alternatives.find(o=>o.city==='Rhodes');
      if(local&&row.best!==null)rationale+=' Risparmio rispetto a '+local.name+' di Rhodes '+money(local.total-row.best)+'.';
      if(row.winners.some(o=>o.available===null))rationale+=' Verifica la disponibilità prima di ordinare.';
      const pricing=[el('p','Costo standard '+money(row.standard_cents)+' / pz · '+(row.standard_source??'Fonte non indicata')+
        ' · ultimo aggiornamento '+date(row.standard_date))];
      if(allowed('owner'))pricing.push(button('Modifica riferimento economico',()=>{
        close('drawer');
        modal('Riferimento · '+row.name,form([
          ['Riferimento (centesimi RP)',num('cents',row.reference_cents,false)],
          ['Fornitore o fonte del riferimento',field('source',row.reference_source)],
        ],'Salva riferimento',async d=>{
          await api('economy-material',{id:row.id,cents:nullable(d.cents),source:d.source});
          await changed('purchases','Riferimento aggiornato.');
        }));
      }));
      const header=panel('Suggerimento di acquisto',el('p',rationale),...pricing,
        ...(row.ford.length?[el('p',row.ford.map(f=>f.quantity+' pz da '+f.ford_source).join(', ')+' confermati e ancora da ricevere.')]:[]));
      const list=row.options.length?table(['Fornitore','Città','Unitario','Sconto','Trasporto','Totale comparabile','Differenza','Disponibilità','Rilevazione'],
        row.options.map(o=>[o.name,o.city,money(o.unit_cents),o.discount_bps?(o.discount_bps/100)+'%':'—',money(o.transport_cents),money(o.total),
          row.best===null||o.total===null||(o.available!==null&&o.available<row.quantity)?'—':money(o.total-row.best),
          o.available===null?'Da verificare':o.available+' pz',date(o.observed)])):empty('Nessuna rilevazione confrontabile per questo materiale.');
      drawer(row.name,header,list,...(row.quantity&&allowed('purchasing.create')?[button('Prepara ordine',()=>{
        close('drawer');create([{item:row.id,quantity:row.quantity}]);
      })]:[]));
    }
    function orderDetail(o){
      const next=flow[o.state],actions=[];
      if(next&&allowed('purchasing.approve'))actions.push(button('Segna '+states[next].toLowerCase(),async()=>{
        if(!confirm('Confermi il nuovo stato dell’ordine?'))return;
        await api('procurement-state',{id:o.id,state:next});await changed('purchases','Stato aggiornato.','drawer');
      }));
      if(!['received','cancelled'].includes(o.state)&&allowed('purchasing.cancel'))actions.push(button('Annulla residuo',async()=>{
        if(!confirm('Confermi l’annullamento? Ricezioni e pagamenti già registrati restano nello storico.'))return;
        await api('procurement-state',{id:o.id,state:'cancelled'});await changed('purchases','Ordine annullato.','drawer');
      }));
      if(!['received','cancelled'].includes(o.state)&&allowed('purchasing.edit'))actions.push(button('Modifica condizioni',()=>{
        close('drawer');
        const staffOptions=[['','Responsabile attuale'],...choices(staff)];
        const prices=o.ford_source?[]:o.lines.map((l,i)=>[l.name+' · prezzo unitario in centesimi RP',num('price'+i,l.unit_cents,false)]);
        modal('Condizioni acquisto #'+o.id,form([['Responsabile',filteredSelect('assignee',staffOptions)],['Note',field('notes',o.notes)],...prices],
          'Salva condizioni',async d=>{
            await api('procurement-terms',{id:o.id,notes:d.notes,assignee:d.assignee,lines:o.lines.map((l,i)=>({item:l.item_id,unit_cents:nullable(d['price'+i]??'')}))});
            await changed('purchases','Condizioni aggiornate.');
          }));
      }));
      const content=[el('p',o.supplier_name+' · '+o.assignee_name+' · '+date(o.created_at)),
        box('split',badge(states[o.state],o.state==='received'?'good':'warn'),el('strong',money(priceTotal(o)))),el('p',o.notes),
        table(['Articolo','Ordinato','Ricevuto','Unitario','Riferimento'],o.lines.map(l=>[l.name,l.quantity,l.received,money(l.unit_cents),money(l.reference_cents)])),
        box('quick-actions',...actions)];
      if((o.ford_source?['confirmed','pickup','partial']:['ordered','partial']).includes(o.state)&&allowed('purchasing.receive')){
        const lines=o.lines.filter(l=>l.received<l.quantity);
        const request=idempotent();
        content.push(panel('Ricezione',form([['Riferimento ricezione o bolla',field('request',request,'text',true)],
          ...lines.map((l,i)=>[l.name+' · residuo '+(l.quantity-l.received),Object.assign(num('line'+i,0),{min:0,max:l.quantity-l.received})])],
          'Conferma ricezione',async d=>{
            const received=lines.map((l,i)=>({item:l.item_id,quantity:Number(d['line'+i])})).filter(l=>l.quantity>0);
            if(!received.length)throw Error('Indica le quantità ricevute.');
            if(!confirm('Confermi il carico delle quantità effettivamente ricevute?'))return;
            const response=await api('procurement-receive',{id:o.id,request:d.request,lines:received});
            await changed('purchases',response.duplicate?'Ricezione già registrata.':'Ricezione registrata e scorte aggiornate.','drawer');
          })));
      }
      if(!o.ford_source){
        const total=priceTotal(o),due=total===null?null:Math.max(0,total-gross(o));
        content.push(panel('Pagamenti e rimborsi',el('p','Pagato netto '+money(gross(o))+' · Residuo '+money(due)),
          o.payments.length?table(['Data','Tipo','Importo'],o.payments.map(p=>[date(p.created_at),p.kind==='refund'?'Rimborso':'Pagamento',money(Math.abs(p.cents))])):empty('Nessun pagamento registrato.')));
        const canPay=['ordered','partial','received'].includes(o.state)&&(due===null||due>0);
        if(allowed('purchasing.pay')&&(canPay||gross(o)>0)){
          const request=idempotent();
          const paymentOptions=[...(canPay?[['pay','Pagamento']]:[]),...(gross(o)>0?[['refund','Rimborso']]:[])];
          content.push(form([['Movimento',pick('kind',paymentOptions)],['Riferimento pagamento',field('request',request,'text',true)],['Importo in centesimi RP',Object.assign(num('cents',''),{min:1})]],'Registra in contabilità',async d=>{
            if(!confirm('Confermi la registrazione in contabilità?'))return;
            await api('procurement-payment',{id:o.id,request:d.request,cents:Number(d.cents),refund:d.kind==='refund'});
            await changed('purchases','Movimento contabile registrato.','drawer');
          }));
        }
      }
      const history=o.receipts.flatMap(r=>JSON.parse(r.details).map(l=>[date(r.created_at),r.request_id,o.lines.find(x=>x.item_id===l.item)?.name??l.item,l.quantity]));
      if(history.length)content.push(panel('Storico ricezioni',table(['Data','Riferimento','Materiale','Quantità'],history)));
      drawer('Acquisto #'+o.id,...content);
    }
    function manual(){
      modal('Fabbisogno manuale',form([['Articolo',pick('item',itemOptions)],['Quantità da acquistare (0 per rimuovere)',Object.assign(num('quantity',0),{min:0})]],'Salva',async d=>{
        await api('procurement-need',{item:d.item,quantity:Number(d.quantity)});await changed('purchases','Lista aggiornata.');
      }));
    }
    function schedule(){
      modal('Produzione programmata',form([['Ricetta',pick('item',choices(items.filter(i=>i.craft)))],
        ['Craft programmati (0 per rimuovere)',Object.assign(num('batches',1),{min:0})]],'Salva piano',async d=>{
        await api('procurement-schedule',{item:d.item,batches:Number(d.batches)});await changed('purchases','Piano aggiornato.');
      }));
    }
    function offer(){
      modal('Accordo e disponibilità',form([['Materiale',pick('item',itemOptions)],['Fornitore',pick('supplier',supplierOptions)],
        ['Prezzo unitario in centesimi RP',num('unit_cents','',false)],['Sconto %',num('discount',0)],
        ['Trasporto in centesimi RP',num('transport_cents','',false)],['Pezzi disponibili verificati',num('available','',false)]],'Salva offerta',async d=>{
        await api('procurement-offer',{item:d.item,supplier:Number(d.supplier),unit_cents:nullable(d.unit_cents),
          discount_bps:Number(d.discount)*100,transport_cents:nullable(d.transport_cents),available:nullable(d.available)});
        await changed('purchases','Offerta aggiornata.');
      }));
    }
    const q=search('Cerca materiale'), needBody=box('');
    function drawNeeds(){
      const rows=comparison.filter(r=>matches(r.name,q.value));
      needBody.replaceChildren(rows.length?table(['Materiale','In scorta','Da ordini e craft','Soglia','Manuale','In arrivo','Da acquistare','Miglior prezzo totale'],
        rows.map(r=>[button(r.name,()=>compare(r)),r.stock,r.fromOrders,r.fromMinimum,r.manual,r.inbound,badge(String(r.toBuy),r.toBuy?'warn':'good'),money(r.best)])):
        empty('Nessun fabbisogno corrisponde ai filtri.'));
    }
    q.oninput=drawNeeds;drawNeeds();
    const oq=search('Cerca ordine o fornitore'), state=filteredSelect('state',[['','Tutti gli stati'],...Object.entries(states)]),orderBody=box('');
    state.setAttribute('aria-label','Stato ordine di acquisto');
    function drawOrders(){
      const rows=orders.filter(o=>(!state.value||o.state===state.value)&&matches('#'+o.id+' '+o.supplier_name+' '+o.lines.map(l=>l.name).join(' '),oq.value));
      orderBody.replaceChildren(rows.length?table(['Ordine','Fornitore','Data','Stato','Totale','Pagato netto','Responsabile'],
        rows.map(o=>[button('#'+o.id,()=>orderDetail(o)),o.supplier_name,date(o.created_at),badge(states[o.state]),money(priceTotal(o)),money(gross(o)),o.assignee_name])):
        empty('Nessun ordine di acquisto corrisponde ai filtri.'));
    }
    oq.oninput=state.onchange=drawOrders;drawOrders();
    const totals=new Map(),byMaterial=new Map(),time=new Map(),priceHistory=[];
    for(const o of orders){
      totals.set(o.supplier_name,(totals.get(o.supplier_name)??0)+gross(o));
      for(const p of o.payments)time.set(p.created_at.slice(0,10),(time.get(p.created_at.slice(0,10))??0)-p.cents);
      for(const l of o.lines.filter(l=>l.received&&l.unit_cents!==null)){
        const r=byMaterial.get(l.name)??{n:0,cents:0};
        r.n+=l.received;r.cents+=l.received*l.unit_cents;byMaterial.set(l.name,r);
        priceHistory.push([o.created_at,l.name,o.supplier_name,l.unit_cents]);
      }
    }
    for(const l of legacy){
      priceHistory.push([l.created_at,l.name,l.supplier_name,Math.round(l.cents/l.quantity)]);
      totals.set(l.supplier_name,(totals.get(l.supplier_name)??0)+l.cents);
      const r=byMaterial.get(l.name)??{n:0,cents:0};r.n+=l.quantity;r.cents+=l.cents;byMaterial.set(l.name,r);
      time.set(l.created_at.slice(0,10),(time.get(l.created_at.slice(0,10))??0)+l.cents);
    }
    const saving=sum(purchased,o=>sum(o.lines,l=>l.reference_cents===null||l.unit_cents===null?0:l.received*(l.reference_cents-l.unit_cents)));
    const documented=purchased.flatMap(o=>o.lines).filter(l=>l.received&&l.unit_cents!==null&&Object.hasOwn(benchmarks,l.item_id));
    const listSaving=sum(documented,l=>l.received*(benchmarks[l.item_id]-l.unit_cents));
    const verifiedFord=pending.filter(o=>o.ford_source&&['confirmed','pickup','partial'].includes(o.state));
    return [title('Acquisti e approvvigionamenti','Pianifica il fabbisogno e segui ordini, forniture Ford, ricezioni e pagamenti.',
      ...(allowed('purchasing.create')?[button('＋ Ordine di acquisto',()=>create())]:[]),
      ...(allowed('purchasing.export')?[button('Esporta registro CSV',exportOrders)]:[])),
      box('metrics',metric('Materiali da acquistare',comparison.filter(r=>r.toBuy).length,'Dopo le consegne attese'),
        metric('Per ordini e produzione',comparison.filter(r=>r.fromOrders).length,'Fabbisogno per ricette e commesse'),
        metric('Sotto scorta',plan.underMinimum,'Articoli sotto la soglia impostata'),
        metric('In attesa',pending.length,'Ordini e richieste aperti'),
        metric('Acquisti ricevuti',purchased.length+legacy.length,'Include ricezioni parziali e forniture storiche'),
        metric('Spesa prevista nota',money(pricePlan),unmatched+' materiali senza preventivo noto'),
        metric('Spesa effettiva netta',money(sum(orders,gross)+sum(legacy,l=>l.cents)),'Pagamenti meno rimborsi'),
        metric('Differenza da riferimento',money(saving),'Solo ricezioni con valore unitario noto'),
        metric('Risparmio sui listini',documented.length?money(listSaving):'—','Rispetto al minimo nei listini attuali'),
        metric('Ford confermate',verifiedFord.length,'Di cui '+verifiedFord.filter(o=>o.state==='pickup').length+' disponibili per il ritiro')),
      panel('Lista acquisti',box('toolbar',q,...(allowed('purchasing.edit')?[button('Aggiungi fabbisogno',manual),button('Programma produzione',schedule),button('Registra offerta',offer)]:[])),needBody),
      box('dashboard-grid',panel('Produzione necessaria',plan.planned.length?table(['Ricetta','Craft suggeriti'],plan.planned.map(p=>[p.name,p.batches])):empty('Nessun craft aggiuntivo necessario.'),
        ...(plan.scheduled.length?[table(['Produzione programmata','Pezzi attesi'],plan.scheduled.map(p=>[p.name,p.quantity]))]:[])),
        panel('Forniture Ford',el('p','Valore di riferimento già ricevuto '+money(fordValue)+(fordUnknown?' · valori mancanti esclusi':'')),
          table(['Fonte','Richieste confermate / ritiro'],fordSources.map(f=>[f,verifiedFord.filter(o=>o.ford_source===f).length])))),
      panel('Ordini e storico',box('toolbar',oq,state),orderBody),
      box('dashboard-grid',panel('Spesa per fornitore',graph([...totals].filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]),'Spesa')),
        panel('Evoluzione dei pagamenti',graph([...time].filter(([,n])=>n>0).sort(([a],[b])=>a.localeCompare(b)).slice(-10),'Spesa netta'))),
      panel('Storico dei prezzi unitari',priceHistory.length?table(['Data ordine','Materiale','Fornitore','Prezzo unitario'],
        priceHistory.sort((a,b)=>b[0].localeCompare(a[0])).map(([d,m,s,p])=>[date(d),m,s,money(p)])):empty('Nessuna ricezione valorizzata.')),
      panel('Costi e prezzi medi per materiale',byMaterial.size?table(['Materiale','Pezzi ricevuti','Costo pattuito totale','Prezzo medio unitario'],
        [...byMaterial].map(([name,r])=>[name,r.n,money(r.cents),money(Math.round(r.cents/r.n))])):empty('Nessun prezzo d’acquisto documentato.'))];
  }
  async function matrix(overrides,scope,subject,onDone){
    const list=overrides.filter(p=>p.scope===scope&&p.subject===subject);
    const changes={};
    const root=el('form',null,{className:'permission-editor'});
    const categories={read:'Visualizza',plan:'Visualizza e calcola',create:'Crea',write:'Registra / modifica',edit:'Modifica',
      manage:'Gestisce',approve:'Approva',verify:'Conferma',cancel:'Annulla',receive:'Riceve',pay:'Paga e rimborsa',export:'Esporta',use:'Usa'};
    const moduleNames={orders:'Ordini',purchasing:'Acquisti',inventory:'Magazzino',catalog:'Catalogo',market:'Listini',sales:'Vendite',
      production:'Produzione',tickets:'Ticket',cash:'Contabilità',suppliers:'Fornitori',audit:'Registro'};
    const rows=me.actions.map(key=>{
      const prior=list.find(x=>x.permission===key);
      const name=key.split('.'), labelText=(moduleNames[name[0]]??name[0])+' · '+(categories[name[1]]??name[1]);
      const allow=input(key,'checkbox',false),inherit=input(key+'-inherit','checkbox',false);
      allow.checked=prior?.enabled===1;inherit.checked=!prior;allow.disabled=inherit.checked;
      allow.setAttribute('aria-label','Consenti '+labelText);inherit.setAttribute('aria-label','Eredita '+labelText);
      const update=()=>{allow.disabled=inherit.checked;changes[key]=inherit.checked?null:allow.checked;};
      allow.onchange=inherit.onchange=update;
      return [moduleNames[name[0]]??name[0],categories[name[1]]??name[1],allow,inherit];
    });
    const save=el('button','Salva permessi',{type:'submit'});
    root.append(table(['Modulo','Azione','Consenti','Eredita'],rows),save);
    root.onsubmit=async event=>{
      event.preventDefault();save.disabled=true;
      try{if(Object.keys(changes).length){await api('owner-permissions',{scope,subject,rules:changes});await onDone();}else status('Nessuna modifica da salvare.');}
      catch(error){status(error.message);}finally{save.disabled=false;}
    };
    return root;
  }
  async function owner(mode){
    const [users,overrides]=await Promise.all([api('owner-users'),api('permissions')]);
    const subjects=users.filter(r=>r.role!=='owner');
    const target=pick('target',[...me.roles.map(r=>['role:'+r,roles[r]]),...subjects.map(u=>['user:'+u.id,(u.visible_name)+' · utente'])]);
    if(mode==='permissions'){
      const out=box('');
      async function draw(){
        const [scope,subject]=target.value.split(':');
        out.replaceChildren(await matrix(overrides,scope,subject,async()=>{
          const refreshed=await api('permissions');overrides.splice(0,overrides.length,...refreshed);
          await draw();status('Permessi aggiornati.');
        }));
      }
      target.onchange=()=>void draw();await draw();
      return [title('Ruoli e permessi','Configura ruoli e deroghe individuali. La colonna Eredita ripristina la regola applicabile.'),label('Destinatario',target),out];
    }
    const q=search('Cerca nome Discord, interno o RP');
    const state=filteredSelect('state',[['','Tutti gli stati'],...Object.entries(statuses)]);
    state.setAttribute('aria-label','Stato account');
    const out=box('');
    async function person(u){
      const main=u.role==='owner';
      const activity=await api('owner-activity',{id:u.id});
      const edit=form([
        ['Nome RP',field('rp_name',u.rp_name||u.name)],['Missiva',field('missiva',u.missiva)],['Note amministrative',Object.assign(el('textarea',null,{name:'notes',rows:3,maxLength:1500}),{value:u.notes??''})],
        ...(!main?[
          ['Ruolo',Object.assign(pick('role',[...me.roles,'pending','rejected'].map(x=>[x,roles[x]])),{value:u.role})],
          ['Stato',Object.assign(pick('state',Object.entries(statuses)),{value:u.state})],
        ]:[]),
      ],'Salva account',async d=>{
        if((d.state&&d.state!==u.state||d.role&&d.role!==u.role)&&!confirm('Confermi la modifica di ruolo o stato dell’account?'))return;
        await api('owner-user',{...d,display_name:u.display_name??'',id:u.id,role:d.role??u.role,state:d.state??u.state});
        await changed('owner','Account aggiornato.','drawer');
      });
      const permissionPanel=!main?el('details',null):null;
      if(permissionPanel)permissionPanel.append(el('summary','Permessi individuali'),await matrix(overrides,'user',u.id,()=>changed('owner','Permessi aggiornati.','drawer')));
      drawer(u.visible_name,el('p','Discord · '+u.username+' · '+u.id),badge(main?'Owner principale':statuses[u.state]),
        ...(u.name?[panel('Richiesta di accesso',el('p',u.name),el('p',u.note||''),
          ...(!main&&u.state==='active'&&u.role==='pending'?[el('p','Per approvare la whitelist, assegna un ruolo e salva. Per rifiutare, seleziona Rifiutato.')]:[]))]:[]),
        edit,...(permissionPanel?[permissionPanel]:[]),
        panel('Attività e modifiche',activity.length?table(['Data','Operazione','Operatore'],activity.map(a=>[date(a.created_at),a.action,a.actor])):empty('Nessuna attività registrata.')));
    }
    function draw(){
      const result=users.filter(u=>(!state.value||state.value===u.state)&&matches([u.username,u.visible_name,u.name,u.missiva,u.id].join(' '),q.value));
      out.replaceChildren(result.length?table(['Nome RP / Utente','Identità Discord','Missiva','Ruolo','Stato'],
        result.map(u=>[button(u.visible_name,()=>person(u)),u.username,u.missiva||'—',roles[u.role],badge(statuses[u.state],u.state==='active'?'good':'warn')])):
        empty('Nessun utente corrisponde ai filtri.'));
    }
    q.oninput=state.onchange=draw;draw();
    return [title('Gestione utenti','Whitelist, ruoli, stato degli account e attività.'),box('toolbar',q,state),out];
  }

  function inventoryTools(items,suppliers){
    const options=choices(items);
    function edit(item){
      const types=pick('kind',[['material','Materiale'],['finished','Prodotto finito']]);
      types.value=item?.kind||(item?.craft?'finished':'material');
      const vendor=filteredSelect('supplier_id',[['','Nessun fornitore'],...choices(suppliers)]);
      vendor.value=item?.supplier_id??'';
      modal(item?'Modifica anagrafica':'Nuovo articolo',form([
        ['Nome',field('name',item?.name,'text',true)],['Tipo',types],['Categoria',field('category',item?.category)],
        ['Descrizione',Object.assign(el('textarea',null,{name:'description',rows:3}),{value:item?.description??''})],
        ['Valore unitario di riferimento (centesimi RP)',num('reference_cents',item?.reference_cents,false)],
        ['Scorta minima',Object.assign(num('minimum',item?.minimum??0),{min:0})],['Fornitore associato',vendor],
      ],'Salva articolo',async d=>{
        await api('stock-item',{...d,id:item?.id,reference_cents:nullable(d.reference_cents),
          minimum:Number(d.minimum),supplier_id:nullable(d.supplier_id)});
        close('drawer');await changed('stock','Anagrafica salvata.');
      }));
    }
    function adjust(item){
      const select=pick('item',options);
      if(item)select.value=item.id;
      const target=Object.assign(num('stock',0),{min:0});
      const actual=el('strong',''),difference=el('strong','');
      function sync(){
        const record=items.find(i=>i.id===select.value);
        actual.textContent=String(record?.stock??0);target.value=record?.stock??0;delta();
      }
      function delta(){
        const diff=Number(target.value)-Number(actual.textContent);
        difference.textContent=diff>0?'+'+diff:String(diff);
      }
      target.oninput=delta;select.onchange=sync;sync();
      const root=form([['Materiale o prodotto',select],['Nuova quantità',target],['Motivazione',input('reason')]],'Conferma rettifica',async d=>{
        if(!confirm('Confermi la nuova quantità di magazzino?'))return;
        await api('stock-batch',{reason:d.reason,lines:[{item:d.item,stock:Number(d.stock),expected:Number(actual.textContent)}]});
        close('drawer');await changed('stock','Rettifica registrata.');
      });
      root.prepend(box('order-form-lines',box('toolbar',label('Quantità attuale',actual),label('Differenza',difference))));
      modal('Rettifica scorte',root);
    }
    function bulk(){
      const editor=lineEditor(options,[['delta','Variazione con segno',1,true]]);
      const root=form([['Motivazione',input('reason')]],'Registra movimenti',async d=>{
        if(!confirm('Confermi il carico e lo scarico di tutte le righe?'))return;
        await api('stock-batch',{reason:d.reason,lines:editor.data()});await changed('stock','Movimenti registrati.');
      });
      root.prepend(editor.ui);modal('Carico e scarico multiplo',root);
    }
    return {edit,adjust,bulk};
  }
  return {purchases,owner,inventoryTools};
}
