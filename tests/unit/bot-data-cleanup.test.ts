import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTopics } from '../../src/main/companion-bot/topics';
import { BotDataCleanupService } from '../../src/main/companion-bot/data-cleanup';
import { BotMaintenanceStore, maintenanceOwner } from '../../src/main/companion-bot/memory-maintenance-store';
import BetterSqlite3 from 'better-sqlite3';
const Database = BetterSqlite3 as { new(file: string): {
  exec(sql: string): void; close(): void;
  prepare(sql: string): { get(...args: unknown[]): unknown };
} };

const owned: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of owned.splice(0).reverse()) await cleanup(); });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function until(check: () => Promise<boolean>, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!await check()) { if (Date.now() > end) throw Error('Cleanup timed out'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-clear-')), root = path.join(temporary,'companion-bot-v2');
  const store = new BotStore(path.join(root,'bot.sqlite'));
  for (const id of ['alice','bob']) store.createCompanion({id,name:id,persona:`PRIVATE_PERSONA_${id}`});
  const a = store.openDirect('alice'), b = store.openDirect('bob'), group = store.createGroup({title:'shared',memberIds:['alice','bob']});
  for (const room of [a,b,group]) store.enqueue({conversationId:room.id,senderId:'user',content:'OLD_HISTORY_' + room.id,sourceMessageId:room.id});
  const maintenance=new BotMaintenanceStore(store);
  for (const room of [a,b,group]) for (const companionId of room.memberIds.filter(id=>id!=='user')) {
    const scope={companionId,conversationId:room.id,securityDomainId:room.securityDomainId}, home=path.join(root,'memory',digest([companionId,room.securityDomainId]));
    await mkdir(home,{recursive:true}); await writeFile(path.join(home,'worldlinebox-scope.json'),JSON.stringify(scope)); await writeFile(path.join(home,'diary.txt'),'OLD_DIARY');
    store.enqueueMemoryJob({key:'old-'+room.id+companionId,kind:'projection',payload:{scope}});
    maintenance.updateSettings(scope,{minNotes:24});maintenance.activity(scope,'old-'+room.id);
  }
  await mkdir(path.join(root,'workspaces','alice'),{recursive:true}); await writeFile(path.join(root,'workspaces','alice','KEEP-DSH.txt'),'KEEP_DSH_WORKSPACE');
  let cleaner: BotDataCleanupService;
  const create = () => cleaner = new BotDataCleanupService({root,quiesce:async()=>undefined,resume:()=>undefined,changed:()=>undefined});
  store.close(); create(); await cleaner!.ready();
  owned.push(async()=>{await cleaner.close();await rm(temporary,{recursive:true,force:true});});
  return {root,a,b,group,get cleaner(){return cleaner;},create};
}
it('clears the selected companion and shared room history and VCP stores, retaining other private history, personas and DSH files',async()=>{
  const f=await fixture(), before=new BotStore(path.join(f.root,'bot.sqlite'));
  const event=before.taskTransaction(sql=>sql.prepare('SELECT id FROM bot_inbox WHERE conversation_id=? LIMIT 1').get(f.a.id)) as {id:string};
  const topics=new BotTopics(before),topic=topics.create(f.a.id,'old-topic','旧话题');topics.bind([before.getEvent(event.id)!],topic);
  before.taskTransaction(sql=>{
    sql.prepare("INSERT INTO bot_topic_title_sync(topic_id,conversation_id,native_lane_id,companion_id,revision,title,status) VALUES(?,?,?,?,1,'待同步旧话题','pending')").run(topic.id,f.a.id,'old-lane','alice');
    sql.prepare('INSERT INTO bot_reply_parts(message_id,event_id,conversation_id,id,sequence,payload_json) VALUES(?,?,?,?,1,?)').run(before.getEvent(event.id)!.replyMessageId,event.id,f.a.id,'old-native-part',JSON.stringify({id:'old-native-part',kind:'text',sequence:1,text:'OLD_REPLY_PART'}));
  });
  before.taskTransaction(sql=>sql.prepare("INSERT INTO bot_guidance VALUES(?,?,?,?,'pending',NULL)").run('old-guidance',event.id,f.a.id,'OLD_GUIDANCE_DATA'));
  before.setMetadata('native-context:'+f.a.id+':session','{"tokens":123}');
  before.setMetadata('browser-context:' + event.id, 'OLD_BROWSER_CONTEXT');
  before.setMetadata('browser-context-ingress:' + f.a.id + ':old-request', 'OLD_BROWSER_INGRESS');
  before.setMetadata('native-interrupted:' + event.id, '1');
  before.setMetadata('native-continue-command:opaque-request',event.id);before.setMetadata('native-continue-command:other-request','unrelated-event');before.close();
  const request=await f.cleaner.begin('alice','single');
  expect((await f.cleaner.begin('alice','single')).id).toBe(request.id);
  await until(async()=> (await f.cleaner.status('alice'))?.status==='completed');
  const store=new BotStore(path.join(f.root,'bot.sqlite'));
  try {
    expect(store.messagesPage(f.a.id).items).toEqual([]); expect(store.messagesPage(f.group.id).items).toEqual([]);
    expect(store.getMetadata('native-context:'+f.a.id+':session')).toBeUndefined();
    expect(store.getMetadata('browser-context:' + event.id)).toBeUndefined(); expect(store.getMetadata('browser-context-ingress:' + f.a.id + ':old-request')).toBeUndefined(); expect(store.getMetadata('native-interrupted:' + event.id)).toBeUndefined();
    for(const table of ['bot_native_topics','bot_topic_bindings','bot_topic_events','bot_guidance','bot_topic_title_sync','bot_reply_parts'])expect(store.taskTransaction(sql=>sql.prepare(`SELECT count(*) AS count FROM ${table} WHERE conversation_id=?`).get(f.a.id))).toMatchObject({count:0});
    expect(store.messagesPage(f.b.id).items.some(message=>message.content.startsWith('OLD_HISTORY_'))).toBe(true);
    expect(store.getCompanion('alice')?.persona).toBe('PRIVATE_PERSONA_alice');
    expect(store.getMetadata('native-continue-command:opaque-request')).toBeUndefined();expect(store.getMetadata('native-continue-command:other-request')).toBe('unrelated-event');
    const scope={companionId:'alice',conversationId:f.a.id,securityDomainId:f.a.securityDomainId};
    expect(new BotMaintenanceStore(store).settings(scope).minNotes).toBe(24);
    expect(store.taskTransaction(sql=>sql.prepare('SELECT dirty,planned FROM bot_maintenance_settings WHERE owner_key=?').get(maintenanceOwner(scope)))).toEqual({dirty:0,planned:0});
  } finally {store.close();}
  await expect(readFile(path.join(f.root,'memory',digest(['alice',f.a.securityDomainId]),'diary.txt'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(path.join(f.root,'memory',digest(['bob',f.b.securityDomainId]),'diary.txt'),'utf8')).toBe('OLD_DIARY');
  expect(await readFile(path.join(f.root,'workspaces','alice','KEEP-DSH.txt'),'utf8')).toBe('KEEP_DSH_WORKSPACE');
});
it('resumes a saved pending erasure after restart and never resumes old memory jobs',async()=>{
  const f=await fixture(); await f.cleaner.close();
  const id=crypto.randomUUID();
  await writeFile(path.join(f.root,'data-cleanup',id+'.json'),JSON.stringify({id,companionId:'alice',requestId:'restart',status:'running',phase:'records',removed:0,createdAt:new Date().toISOString()}));
  f.create(); await f.cleaner.ready(); expect(f.cleaner.busy).toBe(true);
  await until(async()=> (await f.cleaner.status('alice'))?.status==='completed');
  const store=new BotStore(path.join(f.root,'bot.sqlite'));
  try {expect(store.listPendingMemory().every(job=>(job.payload.scope as {companionId:string;conversationId:string}).companionId==='bob'&&(job.payload.scope as {conversationId:string}).conversationId===f.b.id)).toBe(true);}finally{store.close();}
});
it('erases a large history on the worker while the main event loop remains responsive',async()=>{
  const f=await fixture(),store=new BotStore(path.join(f.root,'bot.sqlite'));
  store.taskTransaction(sql=>{
    const insert=sql.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES(?,?,?,'user','User','user',?,'sent','message','bulk',?)");
    for(let i=0;i<50000;i++)insert.run('bulk-'+i,'event-'+i,f.a.id,'Message '+i+' searchable history',new Date(0).toISOString());
  }); store.close();
  let ticks=0,last=performance.now(),maxDelay=0;
  const timer=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last);last=now;ticks++;},5);
  try {
    await f.cleaner.begin('alice','large');
    await until(async()=> (await f.cleaner.status('alice'))!.removed>200);
    await f.cleaner.close(); f.create(); await f.cleaner.ready();
    await until(async()=> (await f.cleaner.status('alice'))?.status==='completed',60000);
  }finally{clearInterval(timer);}
  expect(ticks).toBeGreaterThan(20);expect(maxDelay).toBeLessThan(500);
  const clean=new BotStore(path.join(f.root,'bot.sqlite'));try{expect(clean.messagesPage(f.a.id).items).toEqual([]);}finally{clean.close();}
},90000);
it('retries a database held by another process without blocking the main loop and completes after release',async()=>{
  const f=await fixture(), blocker=new Database(path.join(f.root,'bot.sqlite'));
  blocker.exec('BEGIN IMMEDIATE');
  let ticks=0;const timer=setInterval(()=>ticks++,10);
  try {
    await f.cleaner.begin('alice','locked');
    await until(async()=> (await f.cleaner.status('alice'))?.status==='retrying');
    expect(f.cleaner.busy).toBe(true);expect(ticks).toBeGreaterThan(20);
  }finally{blocker.exec('ROLLBACK');blocker.close();clearInterval(timer);}
  await until(async()=> (await f.cleaner.status('alice'))?.status==='completed');
  expect(f.cleaner.busy).toBe(false);
});
it('clears legacy local brain state in an all-companion reset, preserving sticker collections and external originals',async()=>{
  const f=await fixture(),store=new BotStore(path.join(f.root,'bot.sqlite'));
  store.taskTransaction(sql=>{
    sql.prepare('CREATE TABLE bot_brains(companion_id TEXT PRIMARY KEY,sequence INTEGER,updated_at TEXT)').run();
    sql.prepare("INSERT INTO bot_brains VALUES('alice',5,'old')").run();
    sql.prepare('CREATE TABLE bot_brain_messages(brain_id TEXT,content TEXT)').run();
    sql.prepare("INSERT INTO bot_brain_messages VALUES('alice','OLD_LOCAL_AGENT_CONTEXT')").run();
  });store.close();
  const home=path.join(f.root,'media','conversations',createHash('sha256').update(f.a.id).digest('hex'));
  await mkdir(path.join(home,'objects'),{recursive:true});
  for(const name of ['keep-sticker.png','old-attachment.txt'])await writeFile(path.join(home,'objects',name),name);
  const manifest={packs:[{id:'my-pack',name:'My stickers'}],media:[{id:'keep',kind:'sticker',object:'objects/keep-sticker.png'},{id:'remove',kind:'file',object:'objects/old-attachment.txt'}]};
  await writeFile(path.join(home,'manifest.json'),JSON.stringify(manifest));
  const original=path.join(path.dirname(f.root),'ORIGINAL.txt');await writeFile(original,'KEEP_ORIGINAL');
  await f.cleaner.begin('*','all',true);await until(async()=> (await f.cleaner.status('*'))?.status==='completed');
  const db=new Database(path.join(f.root,'bot.sqlite'));
  try{for(const table of ['bot_messages','bot_message_search','bot_inbox','bot_memory_jobs','bot_brains','bot_brain_messages'])expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({n:0});}finally{db.close();}
  expect(JSON.parse(await readFile(path.join(home,'manifest.json'),'utf8'))).toEqual({...manifest,media:[manifest.media[0]]});
  expect(await readFile(path.join(home,'objects','keep-sticker.png'),'utf8')).toBe('keep-sticker.png');
  await expect(readFile(path.join(home,'objects','old-attachment.txt'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(original,'utf8')).toBe('KEEP_ORIGINAL');
});
it('admits only one cleanup when IPC requests arrive concurrently',async()=>{
  const f=await fixture();
  const results=await Promise.allSettled([f.cleaner.begin('alice','race-a'),f.cleaner.begin('bob','race-b')]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  await until(async()=> (await f.cleaner.status('alice'))?.status==='completed');
});
