const tiers={normal:'Cliente normale',regular:'Cliente abituale',partner:'Azienda convenzionata',special:'Fornitura straordinaria'};
const num=v=>v===''?null:Number(v);
const lookup=rows=>rows.map(r=>[r.id,r.name]);
const local=value=>value==null?'—':new Intl.NumberFormat('it-IT',{maximumFractionDigits:2}).format(value);
const money=value=>value==null?'—':new Intl.NumberFormat('it-IT',{minimumFractionDigits:2,maximumFractionDigits:4}).format(value/100)+' $';
const statusOf=p=>p.cost.unit===null?'Costo incompleto':p.cost.margin===null?'Prezzo da definire':p.cost.margin<0?'Sotto costo':p.cost.percent<20?'Margine < 20%':'Margine adeguato';

export function economics(ctx){
  const {el,api,button,form,input,pick,table,allowed,show,status,modal,drawer}=ctx;
  const field=(name,value,type='text')=>Object.assign(input(name,type,false),{value:value??''});
  const close=id=>document.getElementById(id).close();
  function box(className,...nodes){const div=el('div',null,{className});div.append(...nodes);return div;}
  const panel=(name,...nodes)=>box('panel',el('h2',name),...nodes);
  const badge=(text,kind='neutral')=>el('span',text,{className:'badge '+kind});
  const heading=(name,desc)=>box('page-heading',box('',el('h1',name),el('p',desc)));
  const metric=(name,value,note)=>box('metric',el('span',name),el('strong',String(value)),el('small',note));
  const search=name=>{const node=field('search','','search');node.setAttribute('aria-label',name);node.placeholder=name;return node;};
  const contains=(name,query)=>name.toLocaleLowerCase('it').includes(query.trim().toLocaleLowerCase('it'));
  async function done(message){close('drawer');close('modal');await show('catalog');status(message);}
  async function publish(ids){
    if(!confirm('Pubblicare '+ids.length+' prezzi nella vetrina e renderli applicabili ai nuovi ordini?'))return;
    const result=await api('economy-publish',{items:ids});
    await done(result.count+' prezzi pubblicati.');
  }
  function productDetail(p){
    const market=p.market,c=p.cost;
    const edit=form([['Prezzo in bozza (centesimi RP)',field('cents',(p.draft?p.draft.cents:p.published),'number')]],'Salva bozza',async d=>{
      await api('catalog',{id:p.id,cents:num(d.cents)});await done('Bozza salvata.');
    });
    drawer(p.name,
      box('metrics',metric('Costo unitario',money(c.unit),statusOf(p)),metric('Bozza',p.draft?money(p.draft.cents):'—','Solo area riservata'),
        metric('Prezzo pubblicato',money(p.published),'Applicabile in vetrina'),metric('Costo convenzionato / pz',money(c.agreementUnit),'Tariffe ordinarie'),metric('Prezzo riservato',money(p.reserved),'Solo cliente convenzionato')),
      edit,...(allowed('owner')&&p.draft?[button('Pubblica questo prezzo',()=>publish([p.id]))]:[]),
      panel('Costo e ricavo del lotto',table(['Craft','Pezzi','Costo teorico','Costo craft interi','Ricavo','Margine unitario','Margine %'],[
        [c.batches,c.output,money(c.total),money(c.wholeTotal),money(c.revenue),money(c.margin),c.percent===null?'—':local(c.percent)+'%']])),
      panel('Distinta teorica',table(['Materiale','Quantità imputata','Costo unitario','Costo imputato'],
        c.materials.map(m=>[m.name,local(m.quantity),money(m.cents),money(m.total)])),
        ...(c.missing.length?[el('p','Costo incompleto: '+c.missing.join(', ')+'. Subtotale noto '+money(c.subtotal)+'.')]:[]),
        ...(c.residual.length?[el('p','Residui dei craft interi: '+c.residual.map(r=>r.quantity+' × '+r.name).join(', '))]:[])),
      panel('Concorrenza',table(['Minimo','Massimo','Media','Differenza dal minimo','Differenza dalla media'],
        [[money(market.min),money(market.max),money(market.avg),money(market.deltaMin),money(market.deltaAvg)]]),
        el('p',market.best.length?market.best.map(x=>x.business+' · '+x.city).join(' / '):'Nessuna rilevazione confrontabile.')));
  }
  function materialDetail(m){
    const children=[box('metrics',metric('Riferimento',money(m.reference_cents),m.reference_source??'Fonte non documentata'),
      metric('Standard',money(m.standard),m.source??'Costo di riferimento o derivato'),
      metric('Costo documentato',money(m.actual),'Media delle quantità già ricevute')),el('p','Ultimo aggiornamento disponibile '+(m.observed??'—'))];
    if(allowed('owner'))children.push(form([['Valore di riferimento (centesimi RP)',field('cents',m.reference_cents,'number')],
      ['Fornitore o fonte del riferimento',field('source',m.reference_source)]],'Aggiorna riferimento',async d=>{
      await api('economy-material',{id:m.id,cents:num(d.cents),source:d.source});await done('Riferimento aggiornato.');
    }));
    drawer(m.name,...children);
  }
  async function customers(products){
    const data=await api('economy-customers');
    const users=lookup(data.customers);
    const forms=[
      form([['Listino',pick('tier',data.tiers.filter(t=>['regular','partner'].includes(t.id)).map(t=>[t.id,tiers[t.id]]))],
        ['Sconto (%)',Object.assign(input('discount','number'),{min:0,max:100,step:.01})]],'Salva sconto',async d=>{
          await api('economy-tier',{tier:d.tier,discount:Math.round(Number(d.discount)*100)});await done('Sconto aggiornato.');
        }),
    ];
    if(users.length){
      forms.push(form([['Cliente',pick('user',users)],['Listino',pick('tier',Object.entries(tiers))]],'Assegna listino',async d=>{
        if(!confirm('Confermi l’assegnazione del listino a questo cliente?'))return;
        await api('economy-customer',d);await done('Listino assegnato.');
      }));
      forms.push(form([['Cliente',pick('user',users)],['Prodotto',pick('item',lookup(products))],
        ['Prezzo speciale (centesimi RP, vuoto per rimuovere)',field('cents','','number')],
        ['Autorizza margine insufficiente o costo incompleto',input('approve','checkbox',false)]],'Salva prezzo speciale',async d=>{
        if(d.approve&&!confirm('Confermi l’eccezione Owner per questo prezzo e prodotto?'))return;
        await api('economy-special',{...d,cents:num(d.cents),approve:d.approve==='on'});await done('Prezzo speciale aggiornato.');
      }));
    }
    for(const a of data.agreements){
      const customer=pick('customer',[['','Nessun cliente collegato'],...users]);customer.required=false;customer.value=a.customer_id??'';
      const active=pick('active',[[1,'Attiva'],[0,'Sospesa']]);active.value=String(a.active);
      forms.push(panel(a.name,el('p','Casse e contenitori, assi e attrezzature hanno una sola aliquota. Grandi forniture e lavorazioni speciali: preventivo su misura.'),
        form([['Cliente commerciale',customer],['Stato',active],['Casse e contenitori (%)',field('containers',a.containers_bps/100,'number')],
          ['Assi (%)',field('boards',a.boards_bps/100,'number')],['Attrezzature standard (%)',field('standard',a.standard_bps/100,'number')]],
          'Salva convenzione',async d=>{
            await api('commercial-agreement',{supplier:a.supplier_id,customer:d.customer,active:Number(d.active),
              containers:Math.round(Number(d.containers)*100),boards:Math.round(Number(d.boards)*100),standard:Math.round(Number(d.standard)*100)});
            await done('Convenzione aggiornata.');
          })));
    }
    drawer('Listini clienti',table(['Listino','Sconto'],data.tiers.map(t=>[tiers[t.id],local(t.discount/100)+'%'])),...forms,
      panel('Clienti',table(['Cliente','Listino assegnato'],data.customers.map(c=>[c.name,tiers[c.tier??'normal']]))),
      panel('Prezzi personalizzati',table(['Cliente','Prodotto','Prezzo'],data.overrides.map(r=>[
        data.customers.find(c=>c.id===r.user_id)?.name??r.user_id,products.find(p=>p.id===r.item_id)?.name??r.item_id,money(r.cents)]))));
  }
  async function history(){
    const rows=await api('economy-history');
    const kinds={draft:'Bozza',material:'Riferimento',published:'Pubblicazione'};
    drawer('Cronologia prezzi',table(['Data UTC','Articolo','Tipo','Prima','Dopo','Ripristino'],
      rows.map(r=>[r.created_at,r.name,kinds[r.kind],money(r.old_cents),money(r.new_cents),button('Ripristina',async()=>{
        if(!confirm(r.kind==='material'?'Ripristinare il precedente valore di riferimento?':'Riportare il prezzo precedente in bozza?'))return;
        await api('economy-restore',{id:r.id});await done('Valore precedente ripristinato.');
      })])));
  }
  async function catalog(){
    const {products,materials}=await api('economy');
    const pending=products.filter(p=>p.draft);
    const q=search('Cerca prodotto o materiale');
    const mode=pick('mode',[['products','Prezzi e margini'],['materials','Materiali e costi']]);
    mode.setAttribute('aria-label','Vista economica');
    const filter=pick('filter',[['all','Tutti gli stati'],['missing','Costo incompleto'],['low','Margine inferiore al 20%'],['draft','In bozza']]);
    filter.setAttribute('aria-label','Filtra per stato');
    const out=box('');
    function render(){
      if(mode.value==='materials'){
        filter.hidden=true;
        const rows=materials.filter(m=>contains(m.name,q.value));
        out.replaceChildren(table(['Articolo','Riferimento','Standard','Costo documentato medio','Fonte','Ultimo aggiornamento'],
          rows.map(m=>[button(m.name,()=>materialDetail(m)),money(m.reference_cents),money(m.standard),money(m.actual),m.source,m.observed])));
        return;
      }
      filter.hidden=false;
      const rows=products.filter(p=>contains(p.name,q.value)&&(filter.value==='all'
        ||filter.value==='missing'&&p.cost.unit===null||filter.value==='low'&&p.cost.percent!==null&&p.cost.percent<20||filter.value==='draft'&&p.draft));
      out.replaceChildren(table(['Prodotto','Costo / pz','Prezzo pubblicato','Bozza','Margine / pz','Margine %','Minimo concorrenti','Media concorrenti','Differenza dal minimo','Indicatore'],
        rows.map(p=>{
          const state=statusOf(p), tone=p.cost.margin<0?'bad':p.cost.unit===null||p.cost.percent!==null&&p.cost.percent<20?'warn':'good';
          const position=p.market.deltaMin===null?null:p.market.deltaMin>0?'Sopra il minimo concorrente':p.market.deltaMin<0?'Sotto il minimo concorrente':'Allineato al minimo';
          return [button(p.name,()=>productDetail(p)),money(p.cost.unit),money(p.published),p.draft?money(p.draft.cents):'—',money(p.cost.margin),
            p.cost.percent===null?'—':local(p.cost.percent)+'%',money(p.market.min),money(p.market.avg),money(p.market.deltaMin),box('quick-actions',badge(state,tone),...(position?[badge(position,p.market.deltaMin>0?'warn':'good')]:[]))];
        })));
    }
    q.oninput=mode.onchange=filter.onchange=render;render();
    return [heading('Catalogo e prezzi','Revisiona i costi, confronta i concorrenti e pubblica i prezzi approvati.'),
      box('metrics',metric('Prodotti',products.length,'Anagrafica vendibile'),metric('In bozza',pending.length,'Visibili solo internamente'),
        metric('Costi incompleti',products.filter(p=>p.cost.unit===null).length,'Valori da completare'),
        metric('Margine sotto il 20%',products.filter(p=>p.cost.percent!==null&&p.cost.percent<20).length,'Solo costi completi')),
      box('toolbar',q,mode,filter,...(allowed('owner')?[button('Listini clienti',()=>customers(products)),button('Cronologia prezzi',history),
        ...(pending.length?[button('Pubblica tutte le bozze',()=>publish(pending.map(p=>p.id)))]:[])]:[])),out];
  }
  return {catalog};
}

export function costDetails(el,cost,moneyFn){
  const summary=el('div','');
  const material=el('p',cost.missing.length?'Costo incompleto · '+cost.missing.join(', '):'Costo teorico dei materiali consumati nel lotto.');
  summary.append(el('strong',moneyFn(cost.total)),material);
  if(cost.total===null)summary.append(el('p','Subtotale noto '+moneyFn(cost.subtotal)));
  if(cost.batches!==null)summary.append(el('p',cost.batches+' craft · '+cost.output+' pezzi · '+moneyFn(cost.unit)+' / pezzo'));
  summary.append(el('p','Materie prime per craft interi '+moneyFn(cost.wholeTotal)));
  if(cost.residual.length)summary.append(el('p','Residui: '+cost.residual.map(r=>r.quantity+' × '+r.name).join(', ')));
  if(cost.price!==null)summary.append(el('p','Ricavo previsto '+moneyFn(cost.revenue)+' · Margine unitario '+moneyFn(cost.margin)));
  return summary;
}
