import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, audit, move, transaction, plan, craft, estimate } from './db.mjs';

const { NODE_ENV, BASE_URL, DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, OWNER_DISCORD_ID, PORT=3000, DATA_DIR='./data' } = process.env;
const production = NODE_ENV==='production';
const origin = new URL(BASE_URL || 'http://localhost:'+PORT).origin;
if (production && (!origin.startsWith('https://') || !DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !/^\d{17,20}$/.test(OWNER_DISCORD_ID||''))) {
  throw new Error('Impostare BASE_URL HTTPS, credenziali Discord e OWNER_DISCORD_ID');
}
mkdirSync(DATA_DIR,{recursive:true});
const db = open(join(DATA_DIR,'vexmoor.sqlite'));
const token = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const cookie = (res,id,age) => res.setHeader('Set-Cookie','vexmoor.sid='+id+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+age+(production?'; Secure':''));
const redirect = (res,url) => {res.writeHead(303,{Location:url});res.end();};
const answer = (res,status,value) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
const roles = ['client','worker','manager','director','accountant'];
const defaults = {
  client:['orders.create','tickets.use'], worker:['inventory.read','production.plan','production.write'],
  manager:['inventory.read','inventory.write','production.plan','production.write','orders.manage','tickets.manage','suppliers.read','suppliers.write','market.read'],
  director:['inventory.read','inventory.write','production.plan','production.write','orders.manage','tickets.manage','suppliers.read','suppliers.write','market.read','market.write','catalog.write','cash.read','cash.verify','audit.read'],
  accountant:['inventory.read','market.read','cash.read','cash.verify','suppliers.read'],
};
const actions = [...new Set(Object.values(defaults).flat())];
const files = new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']],['/bottega.webp',['bottega.webp','image/webp']]]);
class HttpError extends Error { constructor(status,message){ super(message); this.status=status; } }
const requireAccess = (condition,message='Accesso negato',status=403) => { if (!condition) throw new HttpError(status,message); };
const string = (value,max=400) => {
  requireAccess(typeof value==='string' && value.trim().length>0 && value.length<=max,'Testo obbligatorio o troppo lungo',400);
  return value.trim();
};
const integer = (value,min,max) => {
  requireAccess(Number.isSafeInteger(value) && value>=min && value<=max,'Numero fuori intervallo',400);
  return value;
};
async function body(req) {
  requireAccess(req.headers['content-type']?.split(';')[0]==='application/json','Inviare JSON',415);
  let size=0;
  const chunks=[];
  for await (const part of req) {
    size+=part.length;
    requireAccess(size<=16384,'Richiesta troppo grande',413);
    chunks.push(part);
  }
  try {
    const value=JSON.parse(Buffer.concat(chunks));
    if (!value || Array.isArray(value) || typeof value!=='object') throw new Error();
    return value;
  } catch { throw new HttpError(400,'JSON non valido'); }
}
async function discord(url,options) {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new HttpError(502,'Autenticazione Discord non riuscita');
  return response.json();
}
const routes = new Map();
const route = (method,url,permission,handler) => routes.set(method+' '+url,{permission,handler});

route('GET','/api/health',null,()=>({ok:true}));
route('GET','/api/me',null,({user,permissions})=>({user,permissions,roles,actions}));
route('GET','/api/catalog',null,()=>db.prepare('SELECT i.id,i.name,i.sale_cents,r.yield_qty FROM recipes r JOIN items i ON i.id=r.item_id ORDER BY i.name').all());
route('POST','/api/access',null,({user,input})=>{
  requireAccess(user?.role==='pending','Richiesta riservata agli account in attesa');
  db.prepare('INSERT INTO requests(user_id,name,note) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,note=excluded.note')
    .run(user.id,string(input.name,80),string(input.note,400));
  return {ok:true};
});
route('GET','/api/access','owner',()=>db.prepare('SELECT u.id,u.username,u.role,r.name,r.note FROM users u LEFT JOIN requests r ON u.id=r.user_id ORDER BY u.username').all());
route('POST','/api/role','owner',({user,input})=>{
  const id=string(input.id,20);
  requireAccess(id!==OWNER_DISCORD_ID && [...roles,'pending','rejected'].includes(input.role),'Ruolo o utente non modificabile',400);
  transaction(db,()=>{
    requireAccess(db.prepare('UPDATE users SET role=? WHERE id=?').run(input.role,id).changes===1,'Utente non trovato',404);
    audit(db,user.id,'role',{id,role:input.role});
  });
  return {ok:true};
});
route('GET','/api/permissions','owner',()=>db.prepare('SELECT * FROM permissions ORDER BY scope,subject,permission').all());
route('POST','/api/permissions','owner',({user,input})=>{
  const {scope,subject,permission,enabled}=input;
  requireAccess(actions.includes(permission) && [true,false,null].includes(enabled),'Permesso non valido',400);
  requireAccess((scope==='role' && roles.includes(subject)) ||
    (scope==='user' && typeof subject==='string' && subject!==OWNER_DISCORD_ID && !!db.prepare('SELECT id FROM users WHERE id=?').get(subject)),
    'Destinatario non valido',400);
  transaction(db,()=>{
    if (enabled===null) db.prepare('DELETE FROM permissions WHERE scope=? AND subject=? AND permission=?').run(scope,subject,permission);
    else db.prepare('INSERT INTO permissions VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET enabled=excluded.enabled').run(scope,subject,permission,Number(enabled));
    audit(db,user.id,'permission',input);
  });
  return {ok:true};
});
route('GET','/api/inventory','inventory.read',()=>db.prepare('SELECT * FROM items ORDER BY name').all());
route('POST','/api/inventory','inventory.write',({user,input})=>{
  const id=string(input.id,100);
  const delta=integer(input.delta,-100000,100000);
  requireAccess(delta!==0,'Indicare una quantità diversa da zero',400);
  const reason=string(input.reason,200);
  transaction(db,()=>{move(db,user.id,id,delta,reason);audit(db,user.id,'stock',{id,delta,reason});});
  return {ok:true};
});
route('GET','/api/moves','inventory.read',()=>db.prepare('SELECT * FROM moves ORDER BY id DESC LIMIT 200').all());
route('GET','/api/recipes','production.plan',()=>db.prepare('SELECT recipe_id,item_id,label,qty FROM ingredients ORDER BY recipe_id,item_id').all());
route('POST','/api/plan','production.plan',({input})=>plan(db,string(input.id,100),integer(input.batches,1,10000),input.intermediate===true));
route('POST','/api/production','production.write',({user,input})=>craft(db,user.id,string(input.id,100),integer(input.batches,1,10000),input.intermediate===true));
route('POST','/api/estimate','production.plan',({input})=>{
  const id=string(input.id,100);
  requireAccess(db.prepare('SELECT 1 FROM recipes WHERE item_id=?').get(id),'Ricetta non trovata',404);
  return estimate(db,id,integer(input.quantity,1,10000));
});
route('GET','/api/production','production.plan',()=>db.prepare('SELECT * FROM production ORDER BY id DESC LIMIT 200').all());
route('GET','/api/market','market.read',()=>db.prepare('SELECT * FROM competitors ORDER BY city,business,name').all());
route('POST','/api/market','market.write',({user,input})=>{
  const id=integer(input.id,1,999999);
  const cents=integer(input.cents,0,100000000);
  const note=string(input.note,250);
  transaction(db,()=>{
    const previous=db.prepare('SELECT * FROM competitors WHERE id=?').get(id);
    requireAccess(previous,'Rilevazione non trovata',404);
    db.prepare('UPDATE competitors SET cents=?,note=? WHERE id=?').run(cents,note,id);
    audit(db,user.id,'market',{previous,cents,note});
  });
  return {ok:true};
});
route('POST','/api/catalog','catalog.write',({user,input})=>{
  const id=string(input.id,100);
  const cents=input.cents===null?null:integer(input.cents,0,100000000);
  transaction(db,()=>{
    requireAccess(db.prepare('UPDATE items SET sale_cents=? WHERE id=? AND id IN (SELECT item_id FROM recipes)').run(cents,id).changes===1,'Articolo non trovato',404);
    audit(db,user.id,'catalog',{id,cents});
  });
  return {ok:true};
});
const orderLines=db.prepare('SELECT item_id,name,quantity,cents FROM order_lines WHERE order_id=? ORDER BY name');
const orderTotal = lines => lines.reduce((sum,line)=>sum+line.quantity*line.cents,0);
route('GET','/api/orders',null,({user,permissions})=>{
  requireAccess(permissions.includes('orders.create') || permissions.includes('orders.manage'));
  const list=permissions.includes('orders.manage')
    ? db.prepare('SELECT o.*,u.username FROM orders o JOIN users u ON u.id=o.customer ORDER BY o.id DESC').all()
    : db.prepare('SELECT * FROM orders WHERE customer=? ORDER BY id DESC').all(user.id);
  return list.map(order=>({...order,lines:orderLines.all(order.id)}));
});
route('POST','/api/orders','orders.create',({user,input})=>{
  requireAccess(Array.isArray(input.lines) && input.lines.length>0 && input.lines.length<=36,'Inserisci da 1 a 36 articoli',400);
  requireAccess(typeof input.note==='string' && input.note.length<=400,'Nota non valida',400);
  return transaction(db,()=>{
    const {id}=db.prepare('INSERT INTO orders(customer,note) VALUES(?,?) RETURNING id').get(user.id,input.note);
    const seen=new Set();
    for (const line of input.lines) {
      requireAccess(line && typeof line==='object','Riga ordine non valida',400);
      const item=string(line.id,100);
      requireAccess(!seen.has(item),'Un articolo compare più volte nell’ordine',400);
      seen.add(item);
      const qty=integer(line.qty,1,10000);
      const product=db.prepare('SELECT name,sale_cents FROM items JOIN recipes ON recipes.item_id=items.id WHERE id=?').get(item);
      requireAccess(product?.sale_cents!=null,'Articolo senza prezzo di vendita',409);
      db.prepare('INSERT INTO order_lines VALUES(?,?,?,?,?)').run(id,item,product.name,qty,product.sale_cents);
    }
    audit(db,user.id,'order.created',{id});
    return {id};
  });
});
const transitions={
  received:['accepted','rejected','cancelled'],
  accepted:['preparing','cancelled'],
  preparing:['producing','ready','cancelled'],
  producing:['ready','cancelled'],
  ready:['delivered','cancelled'],
  delivered:['paid'],
};
route('POST','/api/order-status','orders.manage',({user,input})=>transaction(db,()=>{
  const id=integer(input.id,1,Number.MAX_SAFE_INTEGER);
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  requireAccess(order,'Ordine non trovato',404);
  const next=input.status;
  requireAccess(transitions[order.status]?.includes(next),'Passaggio di stato non consentito',409);
  const lines=orderLines.all(id);
  if (next==='ready') for (const line of lines) move(db,user.id,line.item_id,-line.quantity,'Riserva ordine #'+id);
  if (next==='cancelled' && order.status==='ready') for (const line of lines) move(db,user.id,line.item_id,line.quantity,'Rilascio riserva ordine #'+id);
  if (next==='paid') db.prepare('INSERT INTO receipts(order_id,cents,actor) VALUES(?,?,?)').run(id,orderTotal(lines),user.id);
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(next,id);
  audit(db,user.id,'order.status',{id,previous:order.status,next});
  return {ok:true};
}));
route('GET','/api/receipts','cash.read',()=>db.prepare('SELECT * FROM receipts ORDER BY order_id DESC').all());
route('POST','/api/receipts','cash.verify',({user,input})=>transaction(db,()=>{
  const id=integer(input.id,1,Number.MAX_SAFE_INTEGER);
  requireAccess(db.prepare('UPDATE receipts SET verified_by=? WHERE order_id=? AND verified_by IS NULL').run(user.id,id).changes===1,
    'Incasso già verificato o inesistente',409);
  audit(db,user.id,'cash.verified',{id});
  return {ok:true};
}));
route('GET','/api/suppliers','suppliers.read',()=>db.prepare('SELECT * FROM suppliers ORDER BY name').all());
route('POST','/api/suppliers','suppliers.write',({user,input})=>transaction(db,()=>{
  const name=string(input.name,90), terms=string(input.terms,400);
  requireAccess(!db.prepare('SELECT 1 FROM suppliers WHERE name=?').get(name),'Fornitore già registrato',409);
  const {id}=db.prepare('INSERT INTO suppliers(name,terms) VALUES(?,?) RETURNING id').get(name,terms);
  audit(db,user.id,'supplier.created',{id});
  return {id};
}));
route('GET','/api/purchases','suppliers.read',()=>db.prepare(`SELECT p.*,s.name AS supplier_name,i.name AS item_name
  FROM purchases p JOIN suppliers s ON s.id=p.supplier JOIN items i ON i.id=p.item_id ORDER BY p.id DESC`).all());
route('POST','/api/purchases','suppliers.write',({user,input})=>transaction(db,()=>{
  const supplier=integer(input.supplier,1,Number.MAX_SAFE_INTEGER);
  const item=string(input.item,100), quantity=integer(input.quantity,1,100000);
  const cents=integer(input.cents,0,100000000), note=string(input.note,250);
  requireAccess(db.prepare('SELECT 1 FROM suppliers WHERE id=?').get(supplier),'Fornitore non trovato',404);
  requireAccess(db.prepare('SELECT 1 FROM items WHERE id=?').get(item),'Articolo non trovato',404);
  const {id}=db.prepare('INSERT INTO purchases(supplier,item_id,quantity,cents,note,actor) VALUES(?,?,?,?,?,?) RETURNING id')
    .get(supplier,item,quantity,cents,note,user.id);
  move(db,user.id,item,quantity,'Fornitura #'+id);
  audit(db,user.id,'purchase.created',{id});
  return {id};
}));
route('GET','/api/tickets',null,({user,permissions})=>{
  const manage=permissions.includes('tickets.manage');
  requireAccess(manage || permissions.includes('tickets.use'));
  const rows=manage?db.prepare('SELECT * FROM tickets ORDER BY id DESC').all()
    :db.prepare('SELECT * FROM tickets WHERE customer=? ORDER BY id DESC').all(user.id);
  const messages=db.prepare(`SELECT m.text,m.created_at,u.username FROM ticket_messages m
    JOIN users u ON u.id=m.actor WHERE m.ticket_id=? ORDER BY m.id`);
  return rows.map(row=>({...row,messages:messages.all(row.id)}));
});
route('POST','/api/tickets','tickets.use',({user,input})=>transaction(db,()=>{
  const title=string(input.title,100), message=string(input.message,1000);
  const {id}=db.prepare('INSERT INTO tickets(customer,title) VALUES(?,?) RETURNING id').get(user.id,title);
  db.prepare('INSERT INTO ticket_messages(ticket_id,actor,text) VALUES(?,?,?)').run(id,user.id,message);
  audit(db,user.id,'ticket.created',{id});
  return {id};
}));
route('POST','/api/ticket-message',null,({user,permissions,input})=>transaction(db,()=>{
  const manage=permissions.includes('tickets.manage');
  requireAccess(manage || permissions.includes('tickets.use'));
  const id=integer(input.id,1,Number.MAX_SAFE_INTEGER);
  const row=db.prepare('SELECT * FROM tickets WHERE id=?').get(id);
  requireAccess(row && (manage || row.customer===user.id),'Ticket non trovato',404);
  requireAccess(!row.closed,'Ticket già chiuso',409);
  if (input.close===true) {
    requireAccess(manage);
    db.prepare('UPDATE tickets SET closed=1 WHERE id=?').run(id);
    audit(db,user.id,'ticket.closed',{id});
  } else db.prepare('INSERT INTO ticket_messages(ticket_id,actor,text) VALUES(?,?,?)').run(id,user.id,string(input.message,1000));
  return {ok:true};
}));
route('GET','/api/audit','audit.read',()=>db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all());

createServer(async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url=new URL(req.url,origin);
    const sid=req.headers.cookie?.match(/(?:^|;\s*)vexmoor\.sid=([\w-]{43})(?:;|$)/)?.[1];
    const hash=sid?digest(sid):null;
    const session=hash?db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash,Date.now()):null;
    if (req.method==='GET' && url.pathname==='/auth/discord') {
      requireAccess(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET,'Discord OAuth non configurato',503);
      const sid=token(), state=token(), verifier=token();
      transaction(db,()=>{
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        db.prepare('DELETE FROM sessions WHERE id=?').run(hash);
        db.prepare('INSERT INTO sessions(id,state,verifier,expires) VALUES(?,?,?,?)').run(digest(sid),state,verifier,Date.now()+600000);
      });
      cookie(res,sid,600);
      const params=new URLSearchParams({client_id:DISCORD_CLIENT_ID,redirect_uri:origin+'/auth/callback',response_type:'code',scope:'identify',state,code_challenge:digest(verifier),code_challenge_method:'S256'});
      return redirect(res,'https://discord.com/oauth2/authorize?'+params);
    }
    if (req.method==='GET' && url.pathname==='/auth/callback') {
      const code=url.searchParams.get('code');
      requireAccess(session?.state && session.state===url.searchParams.get('state') && code,'Richiesta Discord scaduta o non valida',400);
      requireAccess(db.prepare('DELETE FROM sessions WHERE id=?').run(hash).changes===1,'Richiesta Discord già usata',400);
      const {access_token}=await discord('https://discord.com/api/oauth2/token',{method:'POST',body:new URLSearchParams({
        client_id:DISCORD_CLIENT_ID,client_secret:DISCORD_CLIENT_SECRET,grant_type:'authorization_code',
        code,redirect_uri:origin+'/auth/callback',code_verifier:session.verifier,
      })});
      const {id,username}=await discord('https://discord.com/api/users/@me',{headers:{Authorization:'Bearer '+access_token}});
      requireAccess(typeof id==='string' && /^\d{17,20}$/.test(id) && typeof username==='string','Profilo Discord non valido',502);
      const next=token();
      transaction(db,()=>{
        db.prepare('INSERT INTO users(id,username) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username').run(id,username);
        db.prepare('INSERT INTO sessions(id,user_id,expires) VALUES(?,?,?)').run(digest(next),id,Date.now()+604800000);
      });
      cookie(res,next,604800);
      return redirect(res,'/');
    }
    if (req.method==='POST') requireAccess(req.headers.origin===origin,'Origine della richiesta non valida');
    if (req.method==='POST' && url.pathname==='/api/logout') {
      if (session) db.prepare('DELETE FROM sessions WHERE id=?').run(hash);
      cookie(res,'',0);
      return answer(res,200,{ok:true});
    }
    const user=session?.user_id?db.prepare('SELECT * FROM users WHERE id=?').get(session.user_id):null;
    if (user && user.id===OWNER_DISCORD_ID) user.role='owner';
    const permissionSet=new Set(user?.role==='owner'?['owner',...actions]:defaults[user?.role]||[]);
    if (user && roles.includes(user.role)) {
      const overrides=db.prepare("SELECT permission,enabled FROM permissions WHERE (scope='role' AND subject=?) OR (scope='user' AND subject=?) ORDER BY scope").all(user.role,user.id);
      for (const permission of overrides) {
        if (permission.enabled) permissionSet.add(permission.permission);
        else permissionSet.delete(permission.permission);
      }
    }
    const route=routes.get(req.method+' '+url.pathname);
    if (route) {
      requireAccess(!route.permission || permissionSet.has(route.permission));
      const input=req.method==='POST'?await body(req):null;
      return answer(res,200,route.handler({user,permissions:[...permissionSet],input}));
    }
    if (req.method==='GET' && files.has(url.pathname)) {
      const [file,type]=files.get(url.pathname);
      res.writeHead(200,{'Content-Type':type.startsWith('text/')?type+'; charset=utf-8':type});
      return res.end(readFileSync(new URL('public/'+file,import.meta.url)));
    }
    return answer(res,404,{error:'Pagina non trovata'});
  } catch (error) {
    const status=error instanceof HttpError?error.status:/^(Scorte|Articolo sconosciuto|Ricetta non disponibile)/.test(error.message)?409:500;
    if (status===500) console.error(error);
    if (!res.headersSent) answer(res,status,{error:status===500?'Errore interno':error.message});
    else res.end();
  }
}).listen(Number(PORT),'0.0.0.0',function(){ console.log('Falegnameria Vexmoor in ascolto sulla porta '+this.address().port); });
