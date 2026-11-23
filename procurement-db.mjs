import { transaction, key } from './db.mjs';

export const ford = ['Boschi Ford','Miniere Ford','Fonderia Ford'];
export function migrateProcurement(db) {
  transaction(db,()=>{
    if(db.prepare('PRAGMA user_version').get().user_version!==2)return;
    db.exec(`
      CREATE TABLE account_controls(user_id TEXT PRIMARY KEY REFERENCES users(id),display_name TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked','suspended','disabled')));
      ALTER TABLE items ADD COLUMN kind TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
      ALTER TABLE moves ADD COLUMN previous_stock INTEGER;
      ALTER TABLE moves ADD COLUMN new_stock INTEGER;
      CREATE TABLE purchase_needs(item_id TEXT PRIMARY KEY REFERENCES items(id),quantity INTEGER NOT NULL CHECK(quantity>0));
      CREATE TABLE production_schedule(item_id TEXT PRIMARY KEY REFERENCES recipes(item_id),batches INTEGER NOT NULL CHECK(batches>0));
      CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), ford_source TEXT,
        state TEXT NOT NULL, notes TEXT NOT NULL, assignee TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE purchase_lines(order_id INTEGER NOT NULL REFERENCES purchase_orders(id),item_id TEXT NOT NULL REFERENCES items(id),
        quantity INTEGER NOT NULL CHECK(quantity>0), unit_cents INTEGER CHECK(unit_cents>=0), reference_cents INTEGER,
        received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=quantity), PRIMARY KEY(order_id,item_id));
      CREATE TABLE purchase_receipts(order_id INTEGER NOT NULL REFERENCES purchase_orders(id), request_id TEXT NOT NULL,
        actor TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(order_id,request_id));
      ALTER TABLE cash_entries ADD COLUMN purchase_order_id INTEGER REFERENCES purchase_orders(id);
      CREATE UNIQUE INDEX cash_purchase_request ON cash_entries(purchase_order_id,description) WHERE purchase_order_id IS NOT NULL;
      CREATE TABLE supplier_offers(item_id TEXT NOT NULL REFERENCES items(id),supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
        unit_cents INTEGER CHECK(unit_cents>=0), discount_bps INTEGER NOT NULL DEFAULT 0 CHECK(discount_bps BETWEEN 0 AND 10000),
        transport_cents INTEGER CHECK(transport_cents>=0), available INTEGER CHECK(available>=0),
        observed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(item_id,supplier_id));
      INSERT INTO suppliers(name,terms) VALUES
        ('Boschi Ford','Forniture su richiesta'),('Miniere Ford','Forniture su richiesta'),('Fonderia Ford','Forniture su richiesta')
        ON CONFLICT(name) DO NOTHING;
      PRAGMA user_version=3;
    `);
  });
}

function components(db) {
  const result=new Map(db.prepare('SELECT item_id,yield_qty FROM recipes').all().map(r=>[r.item_id,{yield:r.yield_qty,parts:[]}]));
  for(const row of db.prepare('SELECT * FROM ingredients').all()) result.get(row.recipe_id).parts.push(row);
  return result;
}

export function requirements(db) {
  const items=db.prepare('SELECT * FROM items ORDER BY name').all();
  const recipes=components(db),need=new Map(),minimum=new Map(),planned=new Map(),manual=new Map(),jobs=new Map();
  const add=(map,id,n)=>map.set(id,(map.get(id)??0)+n);
  for(const row of db.prepare(`SELECT l.item_id,SUM(l.quantity) quantity FROM order_lines l JOIN orders o ON o.id=l.order_id
    WHERE o.status IN ('accepted','preparing','producing') GROUP BY l.item_id`).all())add(need,row.item_id,row.quantity);
  for(const row of db.prepare('SELECT * FROM production_schedule').all()) {
    const recipe=recipes.get(row.item_id);
    add(jobs,row.item_id,row.batches*recipe.yield);
    for(const part of recipe.parts)add(need,part.item_id,part.qty*row.batches);
  }
  for(const row of db.prepare('SELECT * FROM purchase_needs').all()) manual.set(row.item_id,row.quantity);
  const order=[],seen=new Set();
  function visit(id) {
    if(seen.has(id))return;
    seen.add(id);
    for(const component of recipes.get(id)?.parts??[])visit(component.item_id);
    order.push(id);
  }
  for(const item of items)visit(item.id);
  const byId=new Map(items.map(i=>[i.id,i]));
  const inbound=new Map(db.prepare(`SELECT l.item_id,SUM(l.quantity-l.received) AS quantity FROM purchase_lines l JOIN purchase_orders p ON p.id=l.order_id
    WHERE p.state IN ('ordered','partial','confirmed','pickup') GROUP BY l.item_id`).all().map(r=>[r.item_id,r.quantity]));
  const shortages=[];
  for(const id of order.reverse()){
    const item=byId.get(id);
    const stock=item.stock+(jobs.get(id)??0);
    const demand=need.get(id)??0;
    const buffer=item.minimum+(minimum.get(id)??0);
    const fromOrders=Math.max(0,demand-stock);
    const fromMinimum=Math.max(0,buffer-Math.max(0,stock-demand));
    const recipe=recipes.get(id);
    let buy=fromOrders+fromMinimum;
    if(recipe&&buy){
      const forDemand=Math.ceil(fromOrders/recipe.yield);
      const total=Math.ceil(buy/recipe.yield);
      for(const part of recipe.parts){
        add(need,part.item_id,forDemand*part.qty);
        add(minimum,part.item_id,(total-forDemand)*part.qty);
      }
      planned.set(id,total);
      buy=0;
    }
    buy+=manual.get(id)??0;
    if(buy)shortages.push({id,name:item.name,stock:item.stock,needed:buy,fromOrders:recipe?0:fromOrders,
      fromMinimum:recipe?0:fromMinimum,manual:manual.get(id)??0,inbound:inbound.get(id)??0,
      toBuy:Math.max(0,buy-(inbound.get(id)??0)),reference_cents:item.reference_cents});
  }
  return {underMinimum:items.filter(i=>i.stock<i.minimum).length,shortages:shortages.sort((a,b)=>a.name.localeCompare(b.name,'it')),planned:[...planned].map(([id,batches])=>({id,batches,name:byId.get(id).name})),
    scheduled:[...jobs].map(([id,quantity])=>({id,name:byId.get(id).name,quantity}))};
}

export function comparisons(db, needs) {
  const market=db.prepare('SELECT * FROM competitors').all();
  const offers=db.prepare('SELECT o.*,s.name FROM supplier_offers o JOIN suppliers s ON s.id=o.supplier_id').all();
  const free=db.prepare(`SELECT l.item_id,p.ford_source,SUM(l.quantity-l.received) AS quantity FROM purchase_lines l JOIN purchase_orders p ON p.id=l.order_id
    WHERE p.ford_source IS NOT NULL AND p.state IN ('confirmed','pickup','partial') GROUP BY l.item_id,p.ford_source`).all();
  const normal=value=>key(value.trim());
  const supplierKey=value=>value.toLocaleLowerCase('it').replace(/\s+(?:di|da)\s+/g,' ').trim();
  return needs.map(item=>{
    const quantity=item.toBuy;
    const options=market.filter(m=>normal(m.name)===item.id).map(m=>({
      name:m.business,city:m.city,unit_cents:m.cents,transport_cents:null,available:null,observed:m.observed,kind:'listino',
    }));
    for(const offer of offers.filter(o=>o.item_id===item.id)){
      const listed=options.find(o=>supplierKey(o.name+' '+o.city)===supplierKey(offer.name));
      const merged={
        name:listed?.name??offer.name,city:listed?.city??'',unit_cents:offer.unit_cents??listed?.unit_cents??null,
        discount_bps:offer.discount_bps,transport_cents:offer.transport_cents,available:offer.available,
        observed:offer.unit_cents===null&&listed?listed.observed:offer.observed,kind:'accordo',
      };
      if(listed)options[options.indexOf(listed)]=merged;
      else options.push(merged);
    }
    const fordOptions=free.filter(f=>f.item_id===item.id);
    for(const o of options)o.materialTotal=o.unit_cents===null?null:Math.round(o.unit_cents*quantity*(10000-(o.discount_bps??0))/10000);
    const eligible=options.filter(o=>o.materialTotal!==null&&(o.available===null||o.available>=quantity));
    const freightKnown=eligible.length>0&&eligible.every(o=>o.transport_cents!==null);
    for(const o of options)o.total=o.materialTotal===null?null:o.materialTotal+(freightKnown?(o.transport_cents??0):0);
    const best=eligible.length&&quantity?Math.min(...eligible.map(o=>o.total)):null;
    return {...item,quantity,options,best,freightKnown,ford:fordOptions,
      winners:best===null?[]:eligible.filter(o=>o.total===best)};
  });
}
