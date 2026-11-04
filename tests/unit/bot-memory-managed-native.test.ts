import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const enabled = existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/runtime.cjs'));
it.skipIf(!enabled)('uses the actual pinned VCP/Rust index for managed update, archive deletion receipts and derivative withdrawal', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-managed-native-')); let embeddings = 0, unsupportedRequests = 0;
  if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(home).startsWith('bot-managed-native-')) throw new Error('Unexpected owned native test root');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unsupportedRequests++; response.writeHead(404).end(); return; }
    embeddings++; const input = JSON.parse(body).input, values = Array.isArray(input) ? input : [input];
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: values.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_, part) => part === 0 ? 1 : (part + 1) / 1000) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local embedding protocol port');
  const base = `http://127.0.0.1:${address.port}`;
  const script = `
    const Module=require('node:module'), stagedRequire=Module.createRequire(process.cwd()+'/package.json');
    const Database=stagedRequire('better-sqlite3'), originalLoad=Module._load;
    // Execute new source with the already verified Node-24 native dependency,
    // without changing the installed release or Electron's native addon.
    Module._load=function(id,parent,...rest){if(id==='better-sqlite3'&&parent?.filename.startsWith(process.argv[3]))return Database;return originalLoad.call(this,id,parent,...rest)};
    const w=require('./lib/workspace.cjs'), {MemoryRuntime}=require('./lib/runtime.cjs'),{BotHost}=require(process.argv[3]+'/lib/bot-host.cjs');
    const home=process.argv[1],base=process.argv[2],cfg={VECTORDB_DIMENSION:64,WhitelistEmbeddingModel:'fixture64',EmbeddingModelSig:'managed-native64',LOCAL_EMBEDDING_ENABLED:false,
      DEFAULT_TIMEZONE:'Asia/Shanghai',TDB_KNOWLEDGE_ENABLED:false,KNOWLEDGEBASE_BATCH_WINDOW_MS:25,KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS:100,
      API_URL:base,API_Key:'local-protocol',EMBEDDING_API_URL:base+'/document',EMBEDDING_QUERY_API_URL:base+'/query',EMBEDDING_API_KEY:'local-protocol',
      CHAT_API_URL:base,CHAT_API_KEY:'local-protocol',CHAT_MODEL:'local-no-billing',ONERING_RECORD_ONLY:true,ONERING_ASYNC_ONLY_MODE:false};
    (async()=>{w.initHome(home,cfg);const runtimeDir=w.stageRuntime(home);w.applyEnvironment(home,cfg,runtimeDir);const runtime=new MemoryRuntime({home,runtimeDir,config:cfg}),host=new BotHost(home);
    try{
      const seed=async(key,content)=>{const r=await host.remember(runtime,{sourceEventId:key,sourceMessageIds:[],content,tags:'受管验收,事实'});await host.sync(runtime,{id:r.id,timeoutMs:60000});return host.readNote({id:r.id})};
      const a=await seed('native-a','当前单次上限20分钟。'),b=await seed('native-b','固定使用蓝色收纳盒。');
      const update=await host.update(runtime,{operationId:'native-update',id:a.id,expectedChecksum:a.checksum,content:'当前单次上限更正为12分钟。',sourceEventId:'native-correction'});
      if(update.state!=='indexed')throw new Error('Update did not receive an actual index receipt: '+JSON.stringify(update));
      const aPath=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(a.id).note_path,bPath=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(b.id).note_path;
      const [updatedProbe]=await runtime.kb.probeIngestionFiles([aPath]);if(updatedProbe.checksum!==update.checksum||!updatedProbe.completeVectors||!updatedProbe.completeTags)throw new Error('Real updated vectors/tags are incomplete');
      const organize=await host.organize(runtime,{operationId:'native-organize',sources:[{id:a.id,expectedChecksum:update.checksum},{id:b.id,expectedChecksum:b.checksum}],
        content:'使用蓝色收纳盒，每次只整理12分钟。',tags:'整理,方案',sourceEventId:'native-organized'});
      if(organize.state!=='indexed')throw new Error('Organization did not finish real native receipts: '+JSON.stringify(organize));
      const [oldA,oldB]=await runtime.kb.probeIngestionFiles([aPath,bPath]);if(oldA.exists||oldB.exists)throw new Error('Archived source index survived');
      const child=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(organize.id),[childProbe]=await runtime.kb.probeIngestionFiles([child.note_path]);
      if(!childProbe.exists||!childProbe.completeVectors||!childProbe.completeTags||childProbe.checksum!==organize.checksum)throw new Error('Organized child has no complete native index');
      const forget=await host.forget(runtime,{id:a.id,companionId:'native-owner'}),[withdrawn]=await runtime.kb.probeIngestionFiles([child.note_path]);
      if(withdrawn.exists||!forget.relatedIds.includes(organize.id))throw new Error('Derived organized content survived parent withdrawal');
      const independent=await host.readNote({id:b.id});if(independent.indexState!=='archived')throw new Error('Withdrawal propagated backwards into independent source');
      process.stdout.write('WLB_MANAGED_NATIVE:'+JSON.stringify({passed:true,update,organize,updatedProbe,oldA,oldB,childProbe,withdrawn,independentSourcePreserved:true})+'\\n');
    }finally{host.close();await runtime.close()}})().catch(error=>{console.error(error);process.exitCode=1});
  `;
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(nodePath, ['-e', script, home, base, path.resolve('resources/vcp-memory')], { cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Managed native receipt test timed out')); }, 180000);
      child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-20000); }); child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-20000); });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const proof = result.stdout.split('\n').find(line => line.startsWith('WLB_MANAGED_NATIVE:'));
    expect(proof, result.stderr + result.stdout).toBeDefined(); expect(JSON.parse(proof!.slice('WLB_MANAGED_NATIVE:'.length))).toMatchObject({ passed: true, independentSourcePreserved: true });
    expect(embeddings).toBeGreaterThan(0); expect(unsupportedRequests).toBe(0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 190000);
