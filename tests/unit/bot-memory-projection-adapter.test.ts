import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import {createHash} from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Host lifecycle assertions only. Native query/ranking and semantic quality are
// covered separately; these receipts must not be called quality measurements.
const require = createRequire(path.resolve('resources/vcp-memory/package.json'));
const { ChatMemory } = require('./lib/chat-memory.cjs');
const { BotHost } = require('./lib/bot-host.cjs');
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-projection-adapter-')); roots.push(home);
  const chat = new ChatMemory({home,logger:{info(){}}});
  const client = { status:vi.fn(async()=>({messages:100000,pending_ingest:0,pending_index:0})),
    reconcile:vi.fn(async()=>({ok:true})),flush:vi.fn(async()=>({ok:true})),
    ingestHistoryPath:vi.fn<(filename:string,origin:string)=>Promise<{accepted:boolean;changed:boolean}>>(async()=>({accepted:true,changed:true})) };
  // Telemetry decorates the transport's methods; retain the underlying spies.
  const spies={...client};chat.lifecycle.client = client;
  await chat.mirrorSessions();
  async function source(topic: string, count = 1) {
    const directory = path.join(home,'sessions/agent/id-owner','id-'+topic); await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,'history.json'),JSON.stringify(Array.from({length:count},(_,i)=>({id:topic+'-'+i,role:'user',content:'原文-'+i,timestamp:1793610000000+i}))));
    chat.markTopicsDirty('owner',[topic]);
  }
  return {home,chat,client,spies,source};
}
it('does no full-table status/reconcile or catalog rewrite for an unchanged hot query',async()=>{
  const {chat,spies:client,source}=await fixture(); await source('first'); await chat.sync();
  expect(client.reconcile).toHaveBeenCalledTimes(1); expect(client.status).toHaveBeenCalledTimes(1);
  await chat.sync();await chat.sync();
  expect(client.reconcile).toHaveBeenCalledTimes(1); expect(client.status).toHaveBeenCalledTimes(1);expect(client.flush).toHaveBeenCalledTimes(1);
  await source('first',2);await chat.sync();
  expect(client.ingestHistoryPath).toHaveBeenCalledTimes(1);expect(client.reconcile).toHaveBeenCalledTimes(1);
  expect(client.ingestHistoryPath.mock.calls[0]![0]).toContain('id-first');
});
it('uses the original batched reconcile once for a large dirty backlog and on a new native generation',async()=>{
  const {chat,spies:client,source}=await fixture();await chat.sync();
  for(let i=0;i<16;i++)await source('topic-'+i);
  await chat.sync();expect(client.reconcile).toHaveBeenCalledTimes(2);expect(client.ingestHistoryPath).not.toHaveBeenCalled();
  chat.lifecycle.client={...client};await chat.sync();expect(client.reconcile).toHaveBeenCalledTimes(3);
});
it('retains failed catalog writes and unacknowledged native ingestion for a real retry',async()=>{
  const {home,chat,spies:client,source}=await fixture();await chat.sync();await source('new');
  const fsp=require('node:fs').promises,rename=fsp.rename.bind(fsp);let fail=true;
  vi.spyOn(fsp,'rename').mockImplementation(async(...values:unknown[])=>{const [from,to]=values as [string,string];if(fail&&to.endsWith('config.json')){fail=false;throw Object.assign(new Error('injected catalog I/O'),{code:'EIO'});}await rename(from,to);});
  await expect(chat.sync()).rejects.toThrow('injected catalog I/O');expect(client.ingestHistoryPath).not.toHaveBeenCalled();
  client.ingestHistoryPath.mockResolvedValueOnce({accepted:false,changed:false});
  await expect(chat.sync()).rejects.toThrow('did not accept');
  await chat.sync();expect(client.ingestHistoryPath).toHaveBeenCalledTimes(2);
  const config=JSON.parse(await readFile(path.join(home,'chat/AppData/Agents/agent-id-owner/config.json'),'utf8'));
  expect(config.topics).toEqual([expect.objectContaining({memoryOriginalTopicId:'new'})]);
  expect(JSON.parse(await readFile(path.join(home,'chat/session-mirror.json'),'utf8')).owners[0].topics).toHaveLength(1);
});
it('recovers a batch whose original JSON append committed before its SQLite acknowledgements',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'bot-memory-batch-recovery-'));roots.push(home);
  let host=new BotHost(home);
  const messages=Array.from({length:101},(_,i)=>({id:'batch-'+i,role:'user',content:'不可重复的原文-'+i,timestamp:1793610000000+i}));
  try{
    await host.appendHistory({companionId:'owner',messages});
    // This is the exact durable state after JSON rename and before ledger ack.
    host.db.prepare("UPDATE history_receipts SET state='pending'").run();host.db.close();host=new BotHost(home);
    expect((await host.appendHistory({companionId:'owner',messages})).appended).toHaveLength(101);
    const a=JSON.parse(await readFile(path.join(home,'sessions/agent/id-owner/id-episode-00000000/history.json'),'utf8'));
    const b=JSON.parse(await readFile(path.join(home,'sessions/agent/id-owner/id-episode-00000001/history.json'),'utf8'));
    expect(a).toHaveLength(100);expect(b).toHaveLength(1);expect([...a,...b].map(message=>message.id)).toEqual(messages.map(message=>message.id));
    expect((await host.appendHistory({companionId:'owner',messages})).appended).toEqual([]);
    await expect(host.appendHistory({companionId:'owner',messages:[{...messages[0],content:'冲突'}]})).rejects.toMatchObject({code:'MEMORY_CONFLICT'});
  }finally{host.db.close();}
});
it('does not acknowledge a source withdrawal when native deletion returns no path receipt',async()=>{
  const home=await mkdtemp(path.join(os.tmpdir(),'bot-memory-withdraw-receipt-'));roots.push(home);const host=new BotHost(home);
  const id=createHash('sha256').update('receipt-note').digest('hex'),body='必须有原生删除回执。',relative='Companion/note.txt',absolute=path.join(home,'dailynote',relative);
  await mkdir(path.dirname(absolute),{recursive:true});await writeFile(absolute,body);
  try{
    host.db.prepare('INSERT INTO mutations(id,hash,state,note_path,checksum,created_at,content) VALUES(?,?,?,?,?,?,?)').run(id,createHash('sha256').update(body).digest('hex'),'indexed',relative,createHash('md5').update(body).digest('hex'),new Date().toISOString(),body);
    host.stageWithdrawal({noteIds:[id]});
    const runtime={start:async()=>undefined,config:{},kb:{runExternalFileMutation:async(_name:string,operation:()=>Promise<unknown>)=>operation(),probeIngestionFiles:async()=>[]}};
    await expect(host.cleanupWithdrawals(runtime,'owner')).rejects.toThrow('native storage receipt');
    expect(host.db.prepare('SELECT state FROM mutations WHERE id=?').get(id).state).toBe('withdrawing');expect(host.withdrawalPending()).toBe(true);expect(()=>host.assertWithdrawalsSettled()).toThrow('queries are blocked');
  }finally{host.close();}
});
