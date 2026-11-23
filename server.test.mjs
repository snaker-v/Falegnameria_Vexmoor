import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash,randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open,craft,plan,move,transaction } from './db.mjs';

test('importazione idempotente, lavorazione multilivello e rollback',()=>{
  const dir=mkdtempSync(join(tmpdir(),'vexmoor-db-'));
  try {
    const file=join(dir,'test.sqlite');
    let db=open(file);
    assert.equal(db.prepare('SELECT count(*) AS n FROM recipes').get().n,36);
    assert.equal(db.prepare('SELECT count(*) AS n FROM competitors').get().n,129);
    assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE reference_cents IS NOT NULL').get().n,7);
    assert.throws(()=>craft(db,'test','ascia',1,true),/Scorte/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM moves').get().n,0);
    transaction(db,()=>{for(const [id,qty] of [['ferro',4],['acciaio',2],['legno',40]]) move(db,'test',id,qty,'Acquisto test');});
    assert.deepEqual(plan(db,'ascia',1,true).steps.map(s=>s.id),['assi di legno','ascia']);
    craft(db,'test','ascia',1,true);
    assert.equal(db.prepare("SELECT stock FROM items WHERE id='assi di legno'").get().stock,3);
    assert.equal(db.prepare("SELECT stock FROM items WHERE id='ascia'").get().stock,8);
    db.close();
    db=open(file);
    assert.equal(db.prepare('SELECT count(*) AS n FROM competitors').get().n,129);
    assert.equal(db.prepare("SELECT stock FROM items WHERE id='ascia'").get().stock,8);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('HTTP: ruoli, ordine multiarticolo, riserva atomica, incasso e verifica',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vexmoor-http-'));
  const owner='111111111111111111',client='222222222222222222',other='333333333333333333';
  const db=open(join(dir,'vexmoor.sqlite'));
  const makeSession=(id,role)=>{
    const token=randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO users VALUES(?,?,?)').run(id,role,role);
    db.prepare('INSERT INTO sessions(id,user_id,expires) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('base64url'),id,Date.now()+60000);
    return 'vexmoor.sid='+token;
  };
  const admin=makeSession(owner,'pending');
  const customer=makeSession(client,'client');
  const stranger=makeSession(other,'client');
  const child=spawn(process.execPath,['server.mjs'],{
    env:{...process.env,NODE_ENV:'test',DATA_DIR:dir,PORT:'0',BASE_URL:'http://localhost:3000',OWNER_DISCORD_ID:owner},
  });
  try {
    const [chunk]=await once(child.stdout,'data',{signal:AbortSignal.timeout(5000)});
    const origin=String(chunk).match(/porta (\d+)/);
    assert.ok(origin);
    const root='http://127.0.0.1:'+origin[1];
    const request=(path,cookie,input)=>{
      const headers=cookie?{Cookie:cookie}:{};
      if (input!==undefined) Object.assign(headers,{Origin:'http://localhost:3000','Content-Type':'application/json'});
      return fetch(root+path,{headers,...(input===undefined?{}:{method:'POST',body:JSON.stringify(input)})});
    };
    assert.equal((await request('/')).status,200);
    assert.equal((await request('/bottega.webp')).headers.get('content-type'),'image/webp');
    assert.equal((await request('/api/inventory')).status,403);
    assert.equal((await request('/auth/callback?code=123&state=123')).status,400);
    assert.equal((await request('/api/catalog',customer,{id:'ascia',cents:100})).status,403);
    for (const id of ['ascia','pala']) assert.equal((await request('/api/catalog',admin,{id,cents:100})).status,200);
    const order=await request('/api/orders',customer,{note:'',lines:[{id:'ascia',qty:2},{id:'pala',qty:1}]});
    assert.equal(order.status,200);
    const {id}=await order.json();
    assert.deepEqual(await (await request('/api/orders',stranger)).json(),[]);
    const advance=status=>request('/api/order-status',admin,{id,status});
    for (const status of ['accepted','preparing']) assert.equal((await advance(status)).status,200);
    await request('/api/inventory',admin,{id:'ascia',delta:2,reason:'Scorta test'});
    assert.equal((await advance('ready')).status,409);
    assert.equal(db.prepare("SELECT stock FROM items WHERE id='ascia'").get().stock,2);
    await request('/api/inventory',admin,{id:'pala',delta:1,reason:'Scorta test'});
    for (const status of ['ready','delivered','paid']) assert.equal((await advance(status)).status,200);
    assert.equal((await advance('paid')).status,409);
    assert.equal((await request('/api/receipts',customer)).status,403);
    assert.equal((await request('/api/receipts',admin,{id})).status,200);
    assert.equal((await request('/api/receipts',admin,{id})).status,409);
    assert.equal(db.prepare('SELECT cents FROM receipts').get().cents,300);
    const free=await request('/api/purchases',admin,{supplier:1,item:'legno',quantity:40,cents:0,note:'Disponibilità Ford'});
    assert.equal(free.status,200);
    assert.equal(db.prepare("SELECT stock FROM items WHERE id='legno'").get().stock,40);
    assert.equal(db.prepare("SELECT reference_cents FROM items WHERE id='legno'").get().reference_cents,10);
    const ticket=await request('/api/tickets',customer,{title:'Ritiro',message:'Vorrei concordare il ritiro.'});
    assert.equal(ticket.status,200);
    const ticketId=(await ticket.json()).id;
    assert.deepEqual(await (await request('/api/tickets',stranger)).json(),[]);
    assert.equal((await request('/api/ticket-message',stranger,{id:ticketId,message:'test'})).status,404);
    assert.equal((await request('/api/ticket-message',admin,{id:ticketId,close:true})).status,200);
    assert.equal((await request('/api/ticket-message',customer,{id:ticketId,message:'test'})).status,409);
  } finally {
    child.kill();await once(child,'exit');db.close();rmSync(dir,{recursive:true,force:true});
  }
});
