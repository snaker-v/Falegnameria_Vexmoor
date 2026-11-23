import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const seed = JSON.parse(readFileSync(new URL('seed.json', import.meta.url)));
const aliases = new Map(Object.entries({
  'asse di legno': 'assi di legno',
  'asse di legno pregiato': 'assi di legno pregiato',
  'lingotti di ferro': 'lingotto di ferro',
  'lingotti acciaio temperato': 'lingotto acciaio temperato',
  'lingotti di rame': 'lingotto di rame',
  "lingotti d'argento": "lingotto d'argento",
  'argento': 'argento grezzo',
  'chiodi': 'chiodo',
}));
export const key = name => aliases.get(name.toLowerCase()) ?? name.toLowerCase();

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function open(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  transaction(db, () => {
    if (db.prepare('PRAGMA user_version').get().user_version) return;
    db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'pending'
        CHECK(role IN ('pending','rejected','client','worker','manager','director','accountant')));
      CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), state TEXT,
        verifier TEXT, expires INTEGER NOT NULL);
      CREATE TABLE requests(user_id TEXT PRIMARY KEY REFERENCES users(id), name TEXT NOT NULL,
        note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE permissions(scope TEXT NOT NULL CHECK(scope IN ('role','user')), subject TEXT NOT NULL,
        permission TEXT NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), PRIMARY KEY(scope,subject,permission));
      CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0),
        reference_cents INTEGER CHECK(reference_cents>=0), sale_cents INTEGER CHECK(sale_cents>=0));
      CREATE TABLE recipes(item_id TEXT PRIMARY KEY REFERENCES items(id), yield_qty INTEGER NOT NULL CHECK(yield_qty>0));
      CREATE TABLE ingredients(recipe_id TEXT NOT NULL REFERENCES recipes(item_id), item_id TEXT NOT NULL REFERENCES items(id),
        label TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(recipe_id,item_id));
      CREATE TABLE competitors(id INTEGER PRIMARY KEY, business TEXT NOT NULL, city TEXT NOT NULL, name TEXT NOT NULL,
        cents INTEGER NOT NULL CHECK(cents>=0), observed TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE audit(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE moves(id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id), delta INTEGER NOT NULL,
        actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'received',
        note TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE order_lines(order_id INTEGER NOT NULL REFERENCES orders(id), item_id TEXT NOT NULL REFERENCES items(id),
        name TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>0), cents INTEGER NOT NULL CHECK(cents>=0), PRIMARY KEY(order_id,item_id));
      CREATE TABLE receipts(order_id INTEGER PRIMARY KEY REFERENCES orders(id), cents INTEGER NOT NULL CHECK(cents>=0),
        actor TEXT NOT NULL, verified_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE suppliers(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, terms TEXT NOT NULL);
      CREATE TABLE purchases(id INTEGER PRIMARY KEY, supplier INTEGER NOT NULL REFERENCES suppliers(id), item_id TEXT NOT NULL REFERENCES items(id),
        quantity INTEGER NOT NULL CHECK(quantity>0), cents INTEGER NOT NULL CHECK(cents>=0), note TEXT NOT NULL, actor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE tickets(id INTEGER PRIMARY KEY, customer TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE ticket_messages(id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id), actor TEXT NOT NULL REFERENCES users(id),
        text TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE production(id INTEGER PRIMARY KEY, recipe_id TEXT NOT NULL REFERENCES recipes(item_id),
        batches INTEGER NOT NULL, output INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    `);
    const putItem = db.prepare('INSERT OR IGNORE INTO items(id,name) VALUES(?,?)');
    for (const recipe of seed.recipes) {
      putItem.run(key(recipe.name),recipe.name);
      db.prepare('INSERT INTO recipes VALUES(?,?)').run(key(recipe.name),recipe.yieldQty);
    }
    for (const recipe of seed.recipes) {
      for (const ingredient of recipe.ingredients) {
        const id = key(ingredient.name);
        putItem.run(id,id[0].toUpperCase()+id.slice(1));
        db.prepare('INSERT INTO ingredients VALUES(?,?,?,?)').run(key(recipe.name),id,ingredient.name,ingredient.qty);
      }
    }
    for (const [id,cents] of Object.entries({
      legno:10,'legno pregiato':12,'argento grezzo':40,"lingotto d'argento":650,
      'lingotto di rame':180,'lingotto di ferro':250,chiodo:15,
    })) db.prepare('UPDATE items SET reference_cents=? WHERE id=?').run(cents,id);
    const putPrice = db.prepare('INSERT INTO competitors(business,city,name,cents,observed,note) VALUES(?,?,?,?,?,?)');
    for (const p of seed.prices) putPrice.run(p.business,p.city,p.name,p.cents,p.observed,p.note);
    const supplier = db.prepare('INSERT INTO suppliers(name,terms) VALUES(?,?)');
    supplier.run('Famiglia Ford','Forniture gratuite secondo disponibilità. Registrare il costo realmente sostenuto.');
    supplier.run('Fabbro di Saint Denis','Contatto potenziale per componenti. Accordi da concordare.');
    db.exec('PRAGMA user_version=1');
  });
  transaction(db,()=>{
    if(db.prepare('PRAGMA user_version').get().user_version!==1)return;
    db.exec(`
      ALTER TABLE items ADD COLUMN minimum INTEGER NOT NULL DEFAULT 0 CHECK(minimum>=0);
      ALTER TABLE orders ADD COLUMN assignee TEXT REFERENCES users(id);
      ALTER TABLE production ADD COLUMN order_id INTEGER REFERENCES orders(id);
      CREATE TABLE order_events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),actor TEXT NOT NULL,
        status TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE cash_entries(id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('sale','expense','refund','adjustment')),
        cents INTEGER NOT NULL, description TEXT NOT NULL, item_id TEXT REFERENCES items(id), quantity INTEGER,
        actor TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      PRAGMA user_version=2;
    `);
  });
  return db;
}

export function audit(db, actor, action, details) {
  db.prepare('INSERT INTO audit(actor,action,details) VALUES(?,?,?)').run(actor,action,JSON.stringify(details));
}

export function move(db, actor, item, delta, reason) {
  const state = db.prepare('UPDATE items SET stock=stock+? WHERE id=? AND stock+?>=0 RETURNING stock').get(delta,item,delta);
  if (!state) throw new Error('Articolo sconosciuto o scorte insufficienti');
  db.prepare('INSERT INTO moves(item_id,delta,actor,reason) VALUES(?,?,?,?)').run(item,delta,actor,reason);
}

export function plan(db, recipeId, batches, intermediate) {
  const stock = new Map(db.prepare('SELECT id,stock FROM items').all().map(row=>[row.id,row.stock]));
  const steps = [];
  const shortages = new Map();
  function produce(id, count) {
    const recipe = db.prepare('SELECT yield_qty FROM recipes WHERE item_id=?').get(id);
    if (!recipe) throw new Error('Ricetta non disponibile');
    const ingredients = db.prepare('SELECT item_id,qty FROM ingredients WHERE recipe_id=? ORDER BY item_id').all(id);
    for (const ingredient of ingredients) {
      const required = ingredient.qty*count;
      const available = stock.get(ingredient.item_id);
      const sub = db.prepare('SELECT yield_qty FROM recipes WHERE item_id=?').get(ingredient.item_id);
      if (available<required && intermediate && sub) produce(ingredient.item_id,Math.ceil((required-available)/sub.yield_qty));
      const current = stock.get(ingredient.item_id);
      if (current<required) shortages.set(ingredient.item_id,(shortages.get(ingredient.item_id)??0)+required-current);
      stock.set(ingredient.item_id,Math.max(0,current-required));
    }
    const output = count*recipe.yield_qty;
    stock.set(id,stock.get(id)+output);
    steps.push({id,batches:count,output,ingredients:ingredients.map(x=>({id:x.item_id,qty:x.qty*count}))});
  }
  if (!Number.isInteger(batches) || batches<1 || batches>10000) throw new Error('Inserisci da 1 a 10.000 craft interi');
  produce(recipeId,batches);
  return {steps,shortages:Object.fromEntries(shortages)};
}

export function craft(db, actor, id, batches, intermediate, orderId=null) {
  return transaction(db,()=>{
    if(orderId!==null && !db.prepare(`SELECT 1 FROM orders o JOIN order_lines l ON l.order_id=o.id
      WHERE o.id=? AND l.item_id=? AND o.status IN ('accepted','preparing','producing')`).get(orderId,id)) return null;
    const result = plan(db,id,batches,intermediate);
    if (Object.keys(result.shortages).length) throw new Error('Scorte insufficienti per la produzione');
    for (const [index,step] of result.steps.entries()) {
      const entry = db.prepare('INSERT INTO production(recipe_id,batches,output,actor,order_id) VALUES(?,?,?,?,?) RETURNING id').get(step.id,step.batches,step.output,actor,index===result.steps.length-1?orderId:null);
      for (const ingredient of step.ingredients) move(db,actor,ingredient.id,-ingredient.qty,'Produzione #'+entry.id);
      move(db,actor,step.id,step.output,'Produzione #'+entry.id);
    }
    audit(db,actor,'production',result.steps);
    return result;
  });
}

export function estimate(db, id, demand) {
  const totals = new Map();
  const remainder = new Map();
  const recipe = db.prepare('SELECT yield_qty FROM recipes WHERE item_id=?');
  const ingredients = db.prepare('SELECT item_id,qty FROM ingredients WHERE recipe_id=?');
  function consume(item, quantity) {
    const entry = recipe.get(item);
    if (!entry) {
      totals.set(item,(totals.get(item)??0)+quantity);
      return;
    }
    const available = remainder.get(item)??0;
    if (available>=quantity) {
      remainder.set(item,available-quantity);
      return;
    }
    const batches = Math.ceil((quantity-available)/entry.yield_qty);
    remainder.set(item,available+batches*entry.yield_qty-quantity);
    for (const component of ingredients.all(item)) consume(component.item_id,component.qty*batches);
  }
  consume(id,demand);
  const get = db.prepare('SELECT name,reference_cents FROM items WHERE id=?');
  const materials = [...totals].map(([key,quantity])=>{
    const {name,reference_cents:cents}=get.get(key);
    return {name,quantity,cents,total:cents===null?null:quantity*cents};
  });
  const unknown = materials.some(row=>row.total===null);
  const subtotal = materials.reduce((sum,row)=>sum+(row.total??0),0);
  return {materials,subtotal,total:unknown?null:subtotal};
}
