import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const enabled = existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/runtime.cjs'));
// Actual preserved VCP/Rust indexing and DreamWave orchestration. The localhost
// 64-vector protocol is deterministic transport coverage, not a relevance score
// or an acceptance of the production EmbeddingGemma768 semantic quality.
it.skipIf(!enabled)('uses original native VCP dream associations, source CAS and recoverable archive index receipts', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-maintenance-native-')); let embeddings = 0, unsupported = 0;
  if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(home).startsWith('bot-maintenance-native-')) throw new Error('Unexpected owned native root');
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unsupported++; response.writeHead(404).end(); return; }
    embeddings++; const input = JSON.parse(text).input, values = Array.isArray(input) ? input : [input];
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: values.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_, part) => part === 0 ? 1 : (part + 1) / 1000) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing localhost native protocol port');
  const base = `http://127.0.0.1:${address.port}`;
  const script = `
    const Module=require('node:module'), localRequire=Module.createRequire(process.cwd()+'/package.json');
    const Database=localRequire('better-sqlite3'), originalLoad=Module._load;
    Module._load=function(id,parent,...rest){if(id==='better-sqlite3'&&parent?.filename.startsWith(process.argv[3]))return Database;return originalLoad.call(this,id,parent,...rest)};
    const w=require('./lib/workspace.cjs'),{MemoryRuntime}=require('./lib/runtime.cjs'),{BotHost}=require(process.argv[3]+'/lib/bot-host.cjs');
    const home=process.argv[1],base=process.argv[2],cfg={VECTORDB_DIMENSION:64,WhitelistEmbeddingModel:'fixture64',EmbeddingModelSig:'maintenance-native64',LOCAL_EMBEDDING_ENABLED:false,
      DEFAULT_TIMEZONE:'Asia/Shanghai',TDB_KNOWLEDGE_ENABLED:false,KNOWLEDGEBASE_BATCH_WINDOW_MS:25,KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS:100,
      API_URL:base,API_Key:'localhost-protocol',EMBEDDING_API_URL:base+'/document',EMBEDDING_QUERY_API_URL:base+'/query',EMBEDDING_API_KEY:'localhost-protocol',
      CHAT_API_URL:base,CHAT_API_KEY:'localhost-protocol',CHAT_MODEL:'not-a-paid-model',ONERING_RECORD_ONLY:true,ONERING_ASYNC_ONLY_MODE:false};
    (async()=>{w.initHome(home,cfg);const runtimeDir=w.stageRuntime(home);w.applyEnvironment(home,cfg,runtimeDir);const runtime=new MemoryRuntime({home,runtimeDir,config:cfg}),host=new BotHost(home);
      try{
        const seed=async(key,content)=>{const result=await host.remember(runtime,{sourceEventId:key,sourceMessageIds:[],content,tags:'计划,未决'});await host.sync(runtime,{id:result.id,timeoutMs:60000});return host.readNote({id:result.id})};
        const a=await seed('a','本地测试：周六博物馆计划，尚未订票。'),b=await seed('b','本地测试：讨论了博物馆南门集合。');
        const wave=await host.maintenance.dreamRecall(runtime,{sources:[a,b].map(n=>({id:n.id,expectedChecksum:n.checksum})),expectedSourceRevision:'0'});
        const hits=Object.values(wave.groups).flat();if(!hits.length||hits.some(hit=>![a.id,b.id].includes(hit.id)))throw new Error('DreamWave did not retain owned stable IDs');
        const insightInput={operationId:'insight-cas',sources:[{id:a.id,expectedChecksum:a.checksum}],content:'也许象征探索，非用户事实。',sourceEventId:'insight-cas',expectedSourceRevision:'0'};
        const originalSync=host.sync.bind(host);let loseSync=true;host.sync=async(...args)=>{if(loseSync){loseSync=false;throw Object.assign(new Error('Simulated loss before actual index receipt'),{code:'TEST_RECEIPT_LOSS'})}return originalSync(...args)};
        const unknown=await host.maintenance.insight(runtime,insightInput);if(unknown.state!=='unknown')throw new Error('Unconfirmed insight falsely succeeded');
        const updated=await host.update(runtime,{operationId:'correct-parent',id:a.id,expectedChecksum:a.checksum,content:'本地测试：博物馆计划已经取消，仍未订票。',sourceEventId:'correction',expectedSourceRevision:'0'});
        let cas=false;try{await host.maintenance.insight(runtime,insightInput)}catch(error){cas=error.code==='MEMORY_CONFLICT'}if(!cas)throw new Error('A stale prepared insight resumed after parent correction');
        const originalMutation=runtime.kb.runExternalFileMutation.bind(runtime.kb);let loseArchive=true;
        runtime.kb.runExternalFileMutation=async(name,...args)=>{const receipt=await originalMutation(name,...args);if(loseArchive&&name.startsWith('WorldlineBoxMaintenanceArchive:')){loseArchive=false;throw Object.assign(new Error('Simulated lost native archive receipt'),{code:'TEST_RECEIPT_LOSS'})}return receipt};
        const archiveInput={operationId:'archive-b',id:b.id,expectedChecksum:b.checksum,expectedSourceRevision:'0'},oldPath=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(b.id).note_path;
        const partial=await host.maintenance.archive(runtime,archiveInput);if(partial.state!=='partial')throw new Error('Lost archive receipt falsely succeeded');
        const archived=await host.maintenance.archive(runtime,archiveInput),[absent]=await runtime.kb.probeIngestionFiles([oldPath]);
        if(archived.state!=='archived'||!archived.retained||absent.exists)throw new Error('Archive has no real native absence receipt');
        const retained=await host.readNote({id:b.id});if(retained.checksum!==b.checksum||retained.indexState!=='archived')throw new Error('Original archive was not retained');
        if((await host.readNote({id:a.id})).checksum!==updated.checksum)throw new Error('Unrelated corrected source was changed');
        const a2=await host.readNote({id:a.id});let afterCommit=true;host.sync=async(...args)=>{const r=await originalSync(...args);if(afterCommit){afterCommit=false;throw Object.assign(new Error('Lost real commit receipt'),{code:'TEST_RECEIPT_LOSS'})}return r};
        const expired=await host.update(runtime,{operationId:'expired-indexed',id:a.id,expectedChecksum:a2.checksum,content:'本地测试：取消安排，仍未订票，原生索引已写。',sourceEventId:'correction-2',expectedSourceRevision:'0'});
        if(expired.state!=='pending')throw new Error('Lost index acknowledgement falsely succeeded');
        host.stageWithdrawal({sourceEventIds:['unrelated-source']});await host.repairWithdrawals(runtime,'native-owner');host.completeWithdrawal();
        if(host.managed.operation('expired-indexed').state!=='indexed')throw new Error('Reconcile-only failed to observe actual committed bytes/index');
        const a3=await host.readNote({id:a.id});loseArchive=true;
        const pendingArchive=await host.maintenance.archive(runtime,{operationId:'archive-then-withdraw',id:a.id,expectedChecksum:a3.checksum,expectedSourceRevision:host.tombstones().revision});
        if(pendingArchive.state!=='partial')throw new Error('Archive receipt-loss fixture did not stay partial');
        host.stageWithdrawal({noteIds:[a.id]});await host.repairWithdrawals(runtime,'native-owner');host.completeWithdrawal();
        host.maintenance.assertReadable();host.managed.assertReadable();
        if(host.db.prepare('SELECT state FROM maintenance_operations WHERE operation_id=?').get('archive-then-withdraw').state!=='withdrawn')throw new Error('Real withdrawn cleanup did not release archive recall fence');
        if((await host.readNote({id:b.id})).indexState!=='archived')throw new Error('Withdrawal walked backwards to independent sibling');
        process.stdout.write('WLB_MAINTENANCE_NATIVE:'+JSON.stringify({passed:true,waveRoles:Object.keys(wave.groups),hits:hits.length,scoreProvided:hits.some(hit=>typeof hit.score==='number'),cas:true,unknown:unknown.state,partial:partial.state,archived:archived.state,absent:!absent.exists,retained:true,expiredReconciled:true,withdrawnFenceReleased:true,independentSiblingPreserved:true})+'\\n');
      }finally{host.close();await runtime.close()}
    })().catch(error=>{console.error(error);process.exitCode=1});
  `;
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(nodePath, ['-e', script, home, base, path.resolve('resources/vcp-memory')], { cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Maintenance native test timed out')); }, 180000);
      child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-24000); }); child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-24000); });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const line = result.stdout.split('\n').find(line => line.startsWith('WLB_MAINTENANCE_NATIVE:'));
    expect(line, result.stderr + result.stdout).toBeDefined();
    expect(JSON.parse(line!.slice('WLB_MAINTENANCE_NATIVE:'.length))).toMatchObject({ passed: true, cas: true, unknown: 'unknown', partial: 'partial', archived: 'archived', absent: true, retained: true, expiredReconciled: true, withdrawnFenceReleased: true, independentSiblingPreserved: true });
    expect(embeddings).toBeGreaterThan(0); expect(unsupported).toBe(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); }
}, 190000);
