export const rhodesDraft={
  ascia:85,'ascia migliorata':275,'ascia di ferro':375,'ascia di acciaio':750,'assi di legno':140,'assi di legno pregiato':175,
  carbone:14,pala:150,'coltello da intaglio':350,'secchio acqua':350,'secchio pepite':100,mortaio:375,'tagliatore di gemme':300,
  portachiavi:150,torcia:150,'cassa sotterrabile':800,'cassa piccola chiusa':1500,'cassa media chiusa':4200,'cassa grande chiusa':10000,
  'cassa piccola treno smontata':7500,'cassa media treno smontata':14000,'cassa grande treno smontata':27500,'baule grande':14500,
  freezer:4800,'cassaforte 160 kg':35000,'cassaforte grande 500 kg':75000,'zaino piccolo':2200,'zaino medio':3400,'zaino grande':4900,
  'carriola smontata':600,'canaletta piccola':1200,'canaletta grande':2500,'tenda piccola':2500,'tenda grande':4500,
  staccionata:500,'banco da lavoro':4500,
};
export function migrateTrade(db,materialPrices){
  db.exec(`
    CREATE TABLE commercial_agreements(supplier_id INTEGER PRIMARY KEY REFERENCES suppliers(id),active INTEGER NOT NULL CHECK(active IN(0,1)),
      customer_id TEXT UNIQUE REFERENCES users(id),containers_bps INTEGER NOT NULL,boards_bps INTEGER NOT NULL,standard_bps INTEGER NOT NULL);
    CREATE TABLE agreement_rates(supplier_id INTEGER NOT NULL REFERENCES commercial_agreements(supplier_id),item_id TEXT NOT NULL REFERENCES items(id),
      ordinary INTEGER NOT NULL,bulk INTEGER NOT NULL,threshold INTEGER NOT NULL,PRIMARY KEY(supplier_id,item_id));
  `);
  const supplier=db.prepare("SELECT id FROM suppliers WHERE lower(trim(name)) IN ('fabbro di saint denis','fabbri di saint denis','fabbro saint denis','fabbri saint denis') ORDER BY CASE WHEN lower(trim(name))='fabbro di saint denis' THEN 0 ELSE 1 END,id LIMIT 1").get();
  const supplierId=supplier?.id??db.prepare("INSERT INTO suppliers(name,terms) VALUES('Fabbri di Saint Denis','Convenzione Saint Denis') RETURNING id").get().id;
  db.prepare('INSERT INTO commercial_agreements VALUES(?,1,NULL,1000,500,1000)').run(supplierId);
  for(const [id,ordinary,bulk,threshold] of [['chiodo',12,10,500],['lingotto di ferro',220,200,50],['lingotto acciaio temperato',220,200,50]])
    db.prepare('INSERT INTO agreement_rates VALUES(?,?,?,?,?)').run(supplierId,id,ordinary,bulk,threshold);
  const history=db.prepare("INSERT INTO price_history(item_id,kind,old_cents,new_cents,actor) VALUES(?,?,?,?, 'migrazione-0.5')");
  for(const [id,cents] of Object.entries(rhodesDraft)){
    if(!db.prepare('SELECT 1 FROM recipes WHERE item_id=?').get(id))throw Error('Ricetta mancante: '+id);
    const before=db.prepare('SELECT cents FROM draft_prices WHERE item_id=?').get(id);
    db.prepare('INSERT INTO draft_prices(item_id,cents) VALUES(?,?) ON CONFLICT DO UPDATE SET cents=excluded.cents,updated_at=CURRENT_TIMESTAMP').run(id,cents);
    history.run(id,'draft',before?.cents??null,cents);
  }
  for(const [id,cents] of Object.entries(materialPrices)){
    if(['chiodo','lingotto di ferro','lingotto acciaio temperato'].includes(id))continue;
    const before=db.prepare('SELECT reference_cents FROM items WHERE id=?').get(id);
    if(!before)throw Error('Materiale mancante: '+id);
    if(before.reference_cents===cents)continue;
    db.prepare('UPDATE items SET reference_cents=? WHERE id=?').run(cents,id);
    db.prepare('DELETE FROM material_sources WHERE item_id=?').run(id);
    history.run(id,'material',before.reference_cents,cents);
  }
  db.prepare("INSERT INTO audit(actor,action,details) VALUES('migrazione-0.5','commercial.agreement',?)")
    .run(JSON.stringify({supplier:supplierId,drafts:Object.keys(rhodesDraft).length}));
  db.exec('PRAGMA user_version=7');
}
export function agreementRates(db){
  return db.prepare(`SELECT r.*,s.name FROM agreement_rates r JOIN commercial_agreements a USING(supplier_id)
    JOIN suppliers s ON s.id=a.supplier_id WHERE a.active=1`).all();
}
export const purchaseRate=(rate,quantity)=>quantity>=rate.threshold?rate.bulk:rate.ordinary;
export function agreementDiscount(agreement,item){
  if(item==='assi di legno'||item==='assi di legno pregiato')return agreement.boards_bps;
  if(/^(cassa|baule|freezer|secchio)/.test(item))return agreement.containers_bps;
  return Object.hasOwn(rhodesDraft,item)?agreement.standard_bps:0;
}
