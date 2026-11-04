import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const enabled = existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/runtime.cjs'));

// Real preserved VCP ingestion scheduler/Rust index + source-owned Host wrapper.
// The HTTP encoder is a deliberate 64-dimension protocol boundary, not a model
// quality/performance test; no production memory or paid provider is accessed.
it.skipIf(!enabled)('keeps failed native indexing pending without forced-flush hot loops, aborts its observer and later accepts only a real complete receipt', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bot-sync-backoff-'));
  if (path.dirname(home) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('bot-sync-backoff-')) throw Error('Unexpected owned sync fixture.');
  let ready = false, failedRequests = 0, successfulRequests = 0, phase = 'startup';
  const windows: Record<string, { startedAt: number; endedAt?: number; failedRequests: number }> = { startup: { startedAt: Date.now(), failedRequests: 0 } };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (['/fixture/sync', '/fixture/abort', '/fixture/ready'].includes(request.url ?? '')) {
      windows[phase]!.endedAt = Date.now(); phase = request.url!.split('/').at(-1)!;
      windows[phase] = { startedAt: Date.now(), failedRequests: 0 };
      if (phase === 'ready') ready = true;
      response.writeHead(204).end(); return;
    }
    if (!request.url?.endsWith('/v1/embeddings')) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'application/json');
    if (!ready) { failedRequests++; windows[phase]!.failedRequests++; response.writeHead(503).end(JSON.stringify({ error: { message: 'Deliberately unavailable local encoder fixture.' } })); return; }
    successfulRequests++; const value = JSON.parse(body).input, texts = Array.isArray(value) ? value : [value];
    response.end(JSON.stringify({ data: texts.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_, part) => part === 0 ? 1 : (part + 1) / 1000) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No sync fixture port.');
  const script = `
    const Module=require('node:module'), source=process.argv[3], dep=Module.createRequire(process.cwd()+'/package.json');
    const Database=dep('better-sqlite3'), original=Module._load;
    Module._load=function(id,parent,...rest){if(id==='better-sqlite3'&&parent?.filename.startsWith(source))return Database;return original.call(this,id,parent,...rest)};
    const w=require('./lib/workspace.cjs'), {MemoryRuntime}=require(source+'/lib/runtime.cjs'),{BotHost}=require(source+'/lib/bot-host.cjs');
    const home=process.argv[1],base=process.argv[2],cfg={VECTORDB_DIMENSION:64,WhitelistEmbeddingModel:'fixture64',EmbeddingModelSig:'sync-backoff64',LOCAL_EMBEDDING_ENABLED:false,
      DEFAULT_TIMEZONE:'Asia/Shanghai',TDB_KNOWLEDGE_ENABLED:false,KNOWLEDGEBASE_BATCH_WINDOW_MS:25,KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS:100,
      API_URL:base,API_Key:'local-protocol',EMBEDDING_API_URL:base+'/document',EMBEDDING_QUERY_API_URL:base+'/query',EMBEDDING_API_KEY:'local-protocol',
      CHAT_API_URL:base,CHAT_API_KEY:'local-protocol',CHAT_MODEL:'local-no-billing',ONERING_RECORD_ONLY:true,ONERING_ASYNC_ONLY_MODE:false};
    (async()=>{w.initHome(home,cfg);const runtimeDir=w.stageRuntime(home);w.applyEnvironment(home,cfg,runtimeDir);const runtime=new MemoryRuntime({home,runtimeDir,config:cfg}),host=new BotHost(home);
    try{
      await runtime.start({vectors:true});
      const flushes=[],flush=runtime.kb._flushBatch.bind(runtime.kb);
      runtime.kb._flushBatch=async(...args)=>{flushes.push(Date.now());return flush(...args)};
      const note=await host.remember(runtime,{sourceEventId:'backoff-source',sourceMessageIds:['backoff-message'],content:'唯一隔离事实：保持原始日记待索引。',tags:'事实'});
      await fetch(base+'/fixture/sync',{method:'POST'});const failureAt=Date.now(),beforeFlush=flushes.length;
      let failure;try{await host.sync(runtime,{id:note.id,timeoutMs:2200})}catch(error){failure={code:error.code,diagnostics:error.diagnostics}};
      if(failure?.code!=='MEMORY_SYNC_TIMEOUT'||failure.diagnostics?.forcedFlushes!==1)throw Error('Missing explicit pending timeout: '+JSON.stringify(failure));
      const failureWindow={elapsedMs:Date.now()-failureAt,flushAttempts:flushes.length-beforeFlush,probes:failure.diagnostics.probes};
      const pending=await host.readNote({id:note.id});if(pending.indexState!=='pending'||pending.checksum!==note.checksum)throw Error('Failed index was falsely marked ready');
      await fetch(base+'/fixture/abort',{method:'POST'});
      let abortIssuedAt;const controller=new AbortController(),at=Date.now(),timer=setTimeout(()=>{abortIssuedAt=Date.now();controller.abort(Error('Fixture observer cancelled'))},75);
      let aborted=false;try{await host.sync(runtime,{id:note.id,timeoutMs:10000,signal:controller.signal})}catch(error){aborted=error.message==='Fixture observer cancelled'||error.name==='AbortError'}finally{clearTimeout(timer)};
      const abortMs=Date.now()-at,abortLatencyMs=Date.now()-abortIssuedAt;if(!aborted||abortLatencyMs>600)throw Error('Pending observer did not abort promptly after its signal: '+abortLatencyMs);
      if((await host.readNote({id:note.id})).indexState!=='pending')throw Error('Abort fabricated an index receipt');
      await fetch(base+'/fixture/ready',{method:'POST'});
      await host.sync(runtime,{id:note.id,timeoutMs:30000});
      const indexed=await host.readNote({id:note.id}),relative=host.db.prepare('SELECT note_path FROM mutations WHERE id=?').get(note.id).note_path;
      const [probe]=await runtime.kb.probeIngestionFiles([relative]);
      if(indexed.indexState!=='indexed'||!probe.completeVectors||!probe.completeTags||probe.checksum!==note.checksum)throw Error('No real complete repaired receipt');
      process.stdout.write('WLB_SYNC_BACKOFF:'+JSON.stringify({failure,failureWindow,pendingState:pending.indexState,abortMs,abortLatencyMs,aborted,repairedState:indexed.indexState,probe})+'\\n');
    }finally{host.close();await runtime.close()}})().catch(error=>{console.error(error);process.exitCode=1});
  `;
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(nodePath, ['-e', script, home, `http://127.0.0.1:${address.port}`, path.resolve('resources/vcp-memory')], { cwd: packageRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Native backoff fixture exceeded its deadline.')); }, 60000);
      child.stdout.on('data', value => { stdout = (stdout + String(value)).slice(-12000); }); child.stderr.on('data', value => { stderr = (stderr + String(value)).slice(-12000); });
      child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result.code, result.stderr + result.stdout).toBe(0);
    const proof = result.stdout.split('\n').find(line => line.startsWith('WLB_SYNC_BACKOFF:'));
    expect(proof, result.stderr + result.stdout).toBeDefined();
    const evidence = JSON.parse(proof!.slice('WLB_SYNC_BACKOFF:'.length));
    expect(evidence).toMatchObject({ pendingState: 'pending', aborted: true, repairedState: 'indexed' });
    // Startup, timed sync and the second abort observer are separate windows.
    // Under parallel build load the actual elapsed interval can exceed the
    // requested 2.2s, so a fixed *global* HTTP count is not a valid rate limit.
    // Count real KB flush invocations instead: one kick, at most one watcher
    // admission, then the preserved upstream >=1s repair retry schedule.
    const flushBudget = 2 + Math.ceil(evidence.failureWindow.elapsedMs / 1000);
    const directory = path.resolve('artifacts/superagent-bot-development'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'memory-sync-backoff-native.json'), JSON.stringify({ actualVcpIngestion: true, actualRustIndex: true,
      embeddingModelInference: false, protocolVectorDimension: 64, requestedIndexTimeoutMs: 2200, windows, failedRequests, successfulRequests,
      upstreamSourceChanged: false, actualFailureWindowFlushBudget: flushBudget, ...evidence }, null, 2) + '\n');
    expect(windows.sync!.failedRequests).toBeGreaterThan(0);
    expect(evidence.failureWindow.flushAttempts).toBeLessThanOrEqual(flushBudget);
    expect(evidence.failureWindow.probes).toBeLessThanOrEqual(8 + Math.ceil(evidence.failureWindow.elapsedMs / 1000));
    expect(failedRequests).toBeGreaterThan(0); expect(successfulRequests).toBeGreaterThan(0);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 70000);
