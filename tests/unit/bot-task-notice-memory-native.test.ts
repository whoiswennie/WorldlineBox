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

it.skipIf(!enabled)('repairs a real VCP process crash after targeted staging, deleting contaminated notes while preserving public original history and ordinary forget semantics', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'wlb-notice-native-')); let embeddings = 0, unsupported = 0;
  if (path.dirname(path.resolve(home)) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('wlb-notice-native-')) throw new Error('Invalid owned native test root');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { unsupported++; response.writeHead(404).end(); return; }
    embeddings++; const input = JSON.parse(body).input, texts = Array.isArray(input) ? input : [input];
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: texts.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_, part) => part === 0 ? 1 : (part + 1) / 1000) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local fixture port');
  const base = `http://127.0.0.1:${address.port}`;
  const script = `
    const Module=require('node:module'), stagedRequire=Module.createRequire(process.cwd()+'/package.json');
    const Database=stagedRequire('better-sqlite3'), originalLoad=Module._load;
    Module._load=function(id,parent,...rest){if(id==='better-sqlite3'&&parent?.filename.startsWith(process.argv[3]))return Database;return originalLoad.call(this,id,parent,...rest)};
    const fs=require('node:fs/promises'),path=require('node:path');
    const w=require('./lib/workspace.cjs'),{MemoryRuntime}=require('./lib/runtime.cjs'),{BotHost}=require(process.argv[3]+'/lib/bot-host.cjs');
    const home=process.argv[1],base=process.argv[2],phase=process.argv[4],companionId='notice-owner';
    const cfg={VECTORDB_DIMENSION:64,WhitelistEmbeddingModel:'fixture64',EmbeddingModelSig:'notice-native64',LOCAL_EMBEDDING_ENABLED:false,
      DEFAULT_TIMEZONE:'Asia/Shanghai',TDB_KNOWLEDGE_ENABLED:false,KNOWLEDGEBASE_BATCH_WINDOW_MS:25,KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS:100,
      API_URL:base,API_Key:'local-protocol',EMBEDDING_API_URL:base+'/document',EMBEDDING_QUERY_API_URL:base+'/query',EMBEDDING_API_KEY:'local-protocol',
      CHAT_API_URL:base,CHAT_API_KEY:'local-protocol',CHAT_MODEL:'local-no-billing',ONERING_RECORD_ONLY:true,ONERING_ASYNC_ONLY_MODE:false};
    (async()=>{if(phase==='stage')w.initHome(home,cfg);const runtimeDir=w.stageRuntime(home);w.applyEnvironment(home,cfg,runtimeDir);
      const runtime=new MemoryRuntime({home,runtimeDir,config:cfg}),host=new BotHost(home);
      const seed=async(key,content,sourceMessageIds)=>{const r=await host.remember(runtime,{sourceEventId:key,sourceMessageIds,content,tags:'受众迁移验收'});
        await host.sync(runtime,{id:r.id,timeoutMs:60000});const row=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(r.id);return{id:r.id,path:row.note_path}};
      if(phase==='stage'){
        await host.appendHistory({companionId,messages:[{id:'public-original',role:'user',content:'PUBLIC_ORIGINAL_KEEP_85279',timestamp:1793610000000},
          {id:'private-notice',role:'user',content:'PRIVATE_NOTICE_REMOVE_967321',timestamp:1793610000001}]});
        const keep=await seed('public-note','PUBLIC_NOTE_KEEP_85279',['public-original']);
        const mixed=await seed('mixed-note','混合了公开事实和PRIVATE_NOTICE_REMOVE_967321',['public-original','private-notice']);
        const child=await seed('derived-note','从混合笔记派生的PRIVATE_NOTICE_REMOVE_967321',['child-original']);
        host.db.prepare('INSERT INTO note_dependencies(parent_id,child_id,operation_id) VALUES(?,?,?)').run(mixed.id,child.id,'test-verified-note-lineage');
        await fs.writeFile(path.join(home,'proof-ids.json'),JSON.stringify({keep,mixed,child}));
        const staged=host.stageWithdrawal({sourceMessageIds:['private-notice'],mode:'isolated-task-notices'});
        if(staged.sourceMessageIds.length!==1||staged.sourceMessageIds[0]!=='private-notice'||host.blocked('message','public-original'))throw Error('TARGETED_STAGE_EXPANDED_PUBLIC_SOURCE');
        process.exit(74);
      }
      try{
        const ids=JSON.parse(await fs.readFile(path.join(home,'proof-ids.json'),'utf8'));
        await host.repairWithdrawals(runtime,companionId);host.completeWithdrawal();
        if(host.blocked('message','public-original')||host.blocked('event','public-note'))throw Error('REPAIR_REVOKED_PUBLIC_SOURCE');
        if(!host.blocked('message','private-notice')||!host.blocked('note',ids.mixed.id)||!host.blocked('note',ids.child.id))throw Error('PRIVATE_NOTE_OR_DESCENDANT_SURVIVED');
        const probes=await runtime.kb.probeIngestionFiles([ids.keep.path,ids.mixed.path,ids.child.path]);
        if(!probes[0].exists||!probes[0].completeVectors||probes[1].exists||probes[2].exists)throw Error('NATIVE_INDEX_WITHDRAWAL_RECEIPTS_INCORRECT:'+JSON.stringify(probes));
        const original=await fs.readFile(path.join(home,'sessions/agent/id-notice-owner/id-episode-00000000/history.json'),'utf8');
        if(!original.includes('PUBLIC_ORIGINAL_KEEP_85279')||original.includes('PRIVATE_NOTICE_REMOVE_967321'))throw Error('RAW_PUBLIC_HISTORY_NOT_PRESERVED');
        if(!(await host.readNote({id:ids.keep.id})).content.includes('PUBLIC_NOTE_KEEP_85279'))throw Error('PUBLIC_NOTE_NOT_READABLE');
        const repeated=await host.withdrawSources(runtime,{companionId,sourceMessageIds:['private-notice'],mode:'isolated-task-notices'});host.completeWithdrawal();
        if(repeated.sourceMessageIds.includes('public-original')||host.blocked('message','public-original'))throw Error('REPEATED_TARGETED_WITHDRAWAL_EXPANDED');
        const ordinary=await seed('ordinary-mixed','用户明确忘记的整份资料。',['ordinary-public','ordinary-private']);
        const forgotten=await host.forget(runtime,{id:ordinary.id,companionId});host.completeWithdrawal();
        if(!forgotten.sourceMessageIds.includes('ordinary-public')||!forgotten.sourceMessageIds.includes('ordinary-private'))throw Error('ORDINARY_FORGET_LOST_RECURSIVE_SEMANTICS');
        if(host.blocked('message','public-original'))throw Error('ORDINARY_UNRELATED_FORGET_TOUCHED_PUBLIC_SOURCE');
        process.stdout.write('WLB_NOTICE_NATIVE:'+JSON.stringify({passed:true,publicSourcePreserved:true,privateAndDerivedNotesRemoved:true,ordinaryForgetRecursive:true,probes})+'\\n');
      }finally{host.close();await runtime.close()}
    })().catch(error=>{console.error(error);process.exit(1)});
  `;
  const run = (phase: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(nodePath, ['-e', script, home, base, path.resolve('resources/vcp-memory'), phase], { cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Native audience withdrawal timed out (' + phase + '): ' + stderr + stdout)); }, 160000);
    child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-20000); }); child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-20000); });
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try {
    const crash = await run('stage'); expect(crash.code, crash.stderr + crash.stdout).toBe(74);
    const recovered = await run('recover'); expect(recovered.code, recovered.stderr + recovered.stdout).toBe(0);
    const proof = recovered.stdout.split('\n').find(line => line.startsWith('WLB_NOTICE_NATIVE:'));
    expect(proof, recovered.stderr + recovered.stdout).toBeDefined();
    expect(JSON.parse(proof!.slice('WLB_NOTICE_NATIVE:'.length))).toMatchObject({ passed: true, publicSourcePreserved: true, privateAndDerivedNotesRemoved: true, ordinaryForgetRecursive: true });
    expect(embeddings).toBeGreaterThan(0); expect(unsupported).toBe(0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true });
  }
}, 190000);
