export const materialPrices={
  legno:10,'legno pregiato':12,ferro:7,acciaio:7,'argento grezzo':40,fibra:5,'diamanti grezzi':84,
  'pirite grezza':22,'quarzo grezzo':28,'lana lavorata':65,"pepite d'oro":100,chiodo:15,'lingotto di rame':180,
  'lingotto di ferro':250,'lingotto acciaio temperato':250,"lingotto d'argento":650,pelliccia:null,'legno di mogano':null,
};
export const draftPrices={
  ascia:90,'ascia migliorata':350,'ascia di ferro':450,'ascia di acciaio':800,'assi di legno':160,'assi di legno pregiato':200,
  carbone:18,pala:200,'coltello da intaglio':450,'secchio acqua':400,'secchio pepite':150,mortaio:500,'tagliatore di gemme':450,
  portachiavi:200,torcia:200,'cassa sotterrabile':1000,'cassa piccola chiusa':2000,'cassa media chiusa':5000,'cassa grande chiusa':11500,
  'cassa piccola treno smontata':9000,'cassa media treno smontata':18000,'cassa grande treno smontata':32000,'baule grande':16000,
  freezer:5500,'cassaforte 160 kg':37500,'cassaforte grande 500 kg':80000,'zaino piccolo':2500,'zaino medio':3800,'zaino grande':5500,
  'carriola smontata':800,'canaletta piccola':1400,'canaletta grande':2800,'tenda piccola':3000,'tenda grande':5500,
  staccionata:800,'banco da lavoro':6500,
};

export function migrateEconomy(db){
  if(db.prepare('PRAGMA user_version').get().user_version!==3)return;
  db.exec(`
    CREATE TABLE draft_prices(item_id TEXT PRIMARY KEY REFERENCES items(id),cents INTEGER CHECK(cents>=0),updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE material_sources(item_id TEXT PRIMARY KEY REFERENCES items(id),supplier TEXT NOT NULL);
    CREATE TABLE price_history(id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), kind TEXT NOT NULL,
      old_cents INTEGER,new_cents INTEGER, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE price_tiers(id TEXT PRIMARY KEY, discount INTEGER NOT NULL CHECK(discount BETWEEN 0 AND 10000));
    INSERT INTO price_tiers VALUES('normal',0),('regular',500),('partner',1000),('special',0);
    CREATE TABLE customer_tiers(user_id TEXT PRIMARY KEY REFERENCES users(id),tier TEXT NOT NULL REFERENCES price_tiers(id));
    CREATE TABLE customer_prices(user_id TEXT NOT NULL REFERENCES users(id),item_id TEXT NOT NULL REFERENCES items(id),cents INTEGER NOT NULL CHECK(cents>=0),
      approved_cost REAL, incomplete INTEGER NOT NULL DEFAULT 0 CHECK(incomplete IN (0,1)), PRIMARY KEY(user_id,item_id));
  `);
  const history=db.prepare('INSERT INTO price_history(item_id,kind,old_cents,new_cents,actor) VALUES(?,?,?,?,?)');
  for(const [id,cents] of Object.entries(materialPrices)){
    const row=db.prepare('SELECT reference_cents FROM items WHERE id=?').get(id);
    if(!row)throw Error('Materiale iniziale non trovato: '+id);
    db.prepare('UPDATE items SET reference_cents=? WHERE id=?').run(cents,id);
    if(row.reference_cents!==cents)history.run(id,'material',row.reference_cents,cents,'migrazione-0.4');
  }
  const source=db.prepare('INSERT INTO material_sources VALUES(?,?)');
  source.run("lingotto d'argento",'Fonderia Ford · riferimento storico');
  source.run('lingotto di rame','Fabbro di Strawberry · listino');
  source.run('lingotto di ferro','Fabbro di Blackwater · listino');
  source.run('chiodo','Fabbri di Saint Denis e Blackwater · listini');
  for(const [id,cents] of Object.entries(draftPrices)){
    if(!db.prepare('SELECT 1 FROM recipes WHERE item_id=?').get(id))throw Error('Ricetta iniziale non trovata: '+id);
    db.prepare('INSERT INTO draft_prices(item_id,cents) VALUES(?,?)').run(id,cents);
    history.run(id,'draft',null,cents,'migrazione-0.4');
  }
  db.exec('PRAGMA user_version=4');
}

export function costs(db){
  const items=new Map(db.prepare('SELECT id,name,reference_cents,sale_cents FROM items').all().map(r=>[r.id,r]));
  const recipes=new Map(db.prepare('SELECT item_id,yield_qty FROM recipes').all().map(r=>[r.item_id,{yield:r.yield_qty,parts:[]}]));
  for(const r of db.prepare('SELECT recipe_id,item_id,qty FROM ingredients ORDER BY item_id').all())recipes.get(r.recipe_id).parts.push(r);
  const offers=db.prepare(`SELECT o.*,s.name FROM supplier_offers o JOIN suppliers s ON s.id=o.supplier_id
    WHERE o.unit_cents IS NOT NULL AND o.unit_cents>0 AND (o.available IS NULL OR o.available>0) AND s.name NOT IN ('Boschi Ford','Miniere Ford','Fonderia Ford','Famiglia Ford')`).all();
  const listed=db.prepare('SELECT name,cents,business,city,observed FROM competitors WHERE cents>0').all();
  const identity=name=>name.toLocaleLowerCase('it').replace(/\s+(?:di|da)\s+/g,' ').trim();
  const allOffers=db.prepare('SELECT o.item_id,s.name FROM supplier_offers o JOIN suppliers s ON s.id=o.supplier_id').all();
  const sources=new Map(db.prepare('SELECT * FROM material_sources').all().map(r=>[r.item_id,r.supplier]));
  const pricing=new Map();
  for(const row of items.values()){
    const official=allOffers.filter(o=>o.item_id===row.id).map(o=>identity(o.name));
    const catalogue=listed.filter(o=>o.name.trim().toLocaleLowerCase('it')===row.id&&!official.includes(identity(o.business+' '+o.city)))
      .map(o=>({cents:o.cents,source:o.business+' · '+o.city,observed:o.observed}));
    const options=offers.filter(o=>o.item_id===row.id).map(o=>({cents:o.unit_cents*(10000-o.discount_bps)/10000,source:o.name,observed:o.observed}))
      .concat(catalogue).filter(o=>o.cents>0).sort((a,b)=>a.cents-b.cents);
    const best=options[0];
    pricing.set(row.id,row.reference_cents!==null&&(!best||row.reference_cents<=best.cents)
      ?{cents:row.reference_cents,source:sources.get(row.id)??null,observed:null}:best??{cents:null,source:null,observed:null});
  }
  const breakdown=new Map();
  function inputs(id){
    if(breakdown.has(id))return breakdown.get(id);
    const recipe=recipes.get(id), out=new Map();
    if(!recipe)out.set(id,1);
    else for(const part of recipe.parts)for(const [raw,n] of inputs(part.item_id))out.set(raw,(out.get(raw)??0)+n*part.qty/recipe.yield);
    breakdown.set(id,out);return out;
  }
  function estimate(id,demand,price=items.get(id)?.sale_cents??null){
    const recipe=recipes.get(id);
    const batches=recipe?Math.ceil(demand/recipe.yield):null, output=recipe?batches*recipe.yield:demand;
    const materials=[...inputs(id)].map(([raw,n])=>{
      const money=pricing.get(raw),quantity=n*output;
      return {id:raw,name:items.get(raw).name,quantity,...money,total:money.cents===null?null:quantity*money.cents};
    });
    const missing=materials.filter(m=>m.cents===null).map(m=>m.name);
    const subtotal=materials.reduce((n,m)=>n+(m.total??0),0),total=missing.length?null:subtotal;
    const unit=total===null?null:total/output;
    const margin=price===null||unit===null?null:price-unit;
    const residual=new Map(),gross=new Map();
    function consume(item,n){
      const step=recipes.get(item);
      if(!step){gross.set(item,(gross.get(item)??0)+n);return;}
      const available=residual.get(item)??0;
      const count=Math.ceil(Math.max(0,n-available)/step.yield);
      residual.set(item,available+count*step.yield-n);
      for(const part of step.parts)if(count)consume(part.item_id,count*part.qty);
    }
    consume(id,output);
    const whole=[...gross].map(([raw,quantity])=>({name:items.get(raw).name,quantity,...pricing.get(raw)}));
    const wholeSubtotal=whole.reduce((n,r)=>n+r.quantity*(r.cents??0),0);
    return {materials,missing,subtotal,total,unit,batches,yield:recipe?.yield??null,output,price,margin,
      percent:margin===null||!price?null:margin/price*100,revenue:price===null?null:demand*price,
      whole,wholeSubtotal,wholeTotal:whole.some(r=>r.cents===null)?null:wholeSubtotal,
      residual:[...residual].filter(([,n])=>n>0).map(([item,quantity])=>({name:items.get(item).name,quantity}))};
  }
  return {estimate,items,recipes,pricing};
}

const productAliases=new Map(Object.entries({
  'ascia ferro':'ascia di ferro','ascia acciaio':'ascia di acciaio','tagliatore gemme':'tagliatore di gemme','banco lavoro':'banco da lavoro',
}));
export function marketPrices(db){
  const byProduct=new Map();
  for(const entry of db.prepare('SELECT * FROM competitors').all()){
    const name=entry.name.trim().toLocaleLowerCase('it');
    const id=productAliases.get(name)??name;
    if(!byProduct.has(id))byProduct.set(id,[]);
    byProduct.get(id).push(entry);
  }
  return byProduct;
}

export function customerQuote(db,customer,item,publicCents,model){
  const tier=db.prepare(`SELECT p.id,p.discount FROM customer_tiers c JOIN price_tiers p ON p.id=c.tier WHERE c.user_id=?`).get(customer);
  const override=db.prepare('SELECT * FROM customer_prices WHERE user_id=? AND item_id=?').get(customer,item);
  const cents=override?.cents??Math.round(publicCents*(10000-(tier?.discount??0))/10000);
  const value=model.estimate(item,1,cents);
  const discounted=cents<publicCents;
  const under=discounted&&value.unit!==null&&cents+1e-9<value.unit;
  const incomplete=discounted&&value.unit===null;
  return {cents,tier:tier?.id??'normal',under,incomplete,blocked:under&&!(override?.approved_cost!==null&&override?.approved_cost>=value.unit)
    ||incomplete&&!override?.incomplete};
}
