import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import { BotMemoryService, type BotMemoryScope, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';

async function main() {
const root = process.env.WORLDLINEBOX_MEMORY_SCALE_ROOT!, project = process.env.WORLDLINEBOX_MEMORY_SCALE_PROJECT!;
const packageRoot = process.env.WORLDLINEBOX_MEMORY_SCALE_PACKAGE!, nodePath = process.env.WORLDLINEBOX_BOT_NODE!;
const levels = (JSON.parse(process.env.WORLDLINEBOX_MEMORY_SCALE_LEVELS!) as number[]).sort((a,b) => a-b);
const notes = Number(process.env.WORLDLINEBOX_MEMORY_SCALE_NOTES), queryCount = Number(process.env.WORLDLINEBOX_MEMORY_SCALE_QUERIES);
if (!root || !project || !packageRoot || !nodePath) throw new Error('Explicit isolated scale fixture inputs required');
const progress = (phase: string, detail: object = {}) => process.send?.({ kind: 'memory-scale-progress', phase, ...detail });
const require = createRequire(path.join(packageRoot, 'package.json'));
const client = require('./lib/client.cjs') as { createSession(options: object): { pid: number; closed: Promise<void>; request(operation: string,payload?: object,options?: object): Promise<unknown>; close(): Promise<void> } };
const quantiles = (samples: number[]) => {
  const values = samples.slice().sort((a,b) => a-b), at = (q: number) => values[Math.min(values.length-1,Math.max(0,Math.ceil(values.length*q)-1))] ?? null;
  return { samples: values.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), minMs: values[0] ?? null, maxMs: values.at(-1) ?? null };
};
type ProcessMetric = { ProcessId: number; ParentProcessId: number; Name: string; WorkingSetSize: number; ReadTransferCount: number; WriteTransferCount: number; ReadOperationCount: number; WriteOperationCount: number };
const transports: Array<{ raw: ReturnType<typeof client.createSession>; probe: string }> = [];
const embeddingTimes: Array<{ operation: string; durationMs: number }> = [];
let phase = 'setup', deniedChatRequests = 0;
const rpcTimes: Array<{ phase: string; operation: string; durationMs: number }> = [];
const phases: Array<Record<string, unknown>> = [];
async function snapshot() {
  const fsJs: Record<string, number> = {};
  for (const { raw, probe } of transports) {
    try { await raw.request('bot.status'); } catch { /* A closed prior worker keeps its last completed counter snapshot. */ }
    try { const values = JSON.parse(await readFile(probe,'utf8')) as Record<string, number>;
      for (const [key,value] of Object.entries(values)) if (!['pid','at'].includes(key)) fsJs[key] = (fsJs[key] || 0) + value;
    } catch { /* No worker existed yet at a cold phase boundary. */ }
  }
  let processes: ProcessMetric[] = [];
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      '$observerPid=$PID; $all=@(Get-CimInstance Win32_Process); $all | Where-Object { $_.ProcessId -ne $observerPid -and $_.ParentProcessId -ne $observerPid } | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,ReadTransferCount,WriteTransferCount,ReadOperationCount,WriteOperationCount | ConvertTo-Json -Compress'],
      { windowsHide: true, maxBuffer: 4*1024*1024 });
    const all = JSON.parse(stdout || '[]') as ProcessMetric[], owned = new Set([process.pid]);
    for (let previous = -1; previous !== owned.size;) { previous = owned.size; for (const item of all) if (owned.has(Number(item.ParentProcessId))) owned.add(Number(item.ProcessId)); }
    processes = all.filter(item => owned.has(Number(item.ProcessId)) && !/^(?:powershell|pwsh)\.exe$/i.test(item.Name));
  }
  return { fsJs, processes, rootRss: process.memoryUsage().rss };
}
function difference(a: Record<string, number>, b: Record<string, number>) {
  return Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(key => [key,(b[key] || 0)-(a[key] || 0)]));
}
async function measured(name: string, run: () => Promise<Record<string, unknown>>) {
  phase = name; progress(name);
  const before = await snapshot(), rpcStart = rpcTimes.length, embeddingStart = embeddingTimes.length, start = performance.now();
  const detail = await run(), wallMs = performance.now()-start, after = await snapshot();
  const processIo: Record<string, number> = {};
  for (const key of ['ReadTransferCount','WriteTransferCount','ReadOperationCount','WriteOperationCount'] as const) {
    processIo[key] = after.processes.reduce((sum,item) => sum+Number(item[key] || 0),0)-before.processes.reduce((sum,item) => sum+Number(item[key] || 0),0);
  }
  const point = { phase:name,wallMs,...detail,fsJs:difference(before.fsJs,after.fsJs),processIo,
    processCountAfter:after.processes.length,processRolesAfter:after.processes.map(item=>({pid:item.ProcessId,name:item.Name,parentPid:item.ParentProcessId})),rssBytesAfter:after.processes.reduce((sum,item)=>sum+Number(item.WorkingSetSize||0),0),rootRssBytesAfter:after.rootRss,
    rpc:quantiles(rpcTimes.slice(rpcStart).map(item=>item.durationMs)),rpcCalls:rpcTimes.length-rpcStart,
    embedding:embeddingTimes.slice(embeddingStart).reduce<Record<string,{calls:number;milliseconds:number}>>((out,item)=>{ const value=out[item.operation] ||= {calls:0,milliseconds:0};value.calls++;value.milliseconds+=item.durationMs;return out; },{}) };
  phases.push(point); progress(name+'-done',{wallMs,...detail}); return point;
}
const deny = createServer((_request,response) => { deniedChatRequests++; response.writeHead(503,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'LLM disabled for performance fixture'}})); });
await new Promise<void>(resolve=>deny.listen(0,'127.0.0.1',resolve));
const address = deny.address(); if (!address || typeof address === 'string') throw new Error('No isolated rejecting chat endpoint');
const embedding = new GlobalEmbeddingService({userDataPath:path.join(root,'embedding-state'),bundleDirectory:path.join(project,'resources/embedding-models'),
  koffiPath:require.resolve('koffi'),devicePreference:()=>({backend:'cpu'}),onTiming:event=>embeddingTimes.push(event)});
const gateway = new VcpEmbeddingGateway(embedding);
const memoryOptions:BotMemoryOptions={root:path.join(root,'memory'),runtime:async()=>({nodePath,packageRoot}),
  embedding:async()=>{ const profile=await embedding.resolveProfile();return gateway.configuration(profile.selectionId,profile); },
  chat:async()=>({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:'disabled-no-billable-key',model:'disabled',apiType:'openai-completions'}),
  requestTimeoutMs:120000,createSession:options=>{
    // A restarted worker must never overwrite its predecessor's counters.
    // Both generations remain in the cumulative phase baseline.
    const probe=path.join(options.home,`js-fs-probe-${randomUUID()}.json`);
    const raw=client.createSession({...options,env:{...options.env,NODE_OPTIONS:`--require=${JSON.stringify(path.join(project,'tests/fixtures/bot-memory-fs-probe.cjs'))}`,
      WORLDLINEBOX_MEMORY_FS_PROBE_FILE:probe}});transports.push({raw,probe});process.send?.({kind:'memory-scale-child',pid:raw.pid});
    return {...raw,request:async(operation,payload,config)=>{const name=phase,start=performance.now();try{return await raw.request(operation,payload,config);}finally{rpcTimes.push({phase:name,operation,durationMs:performance.now()-start});}}};
  }};
let memory = new BotMemoryService(memoryOptions);
const store = new BotStore(path.join(root,'bot.sqlite'));
const owner = store.createCompanion({id:'scale-owner',name:'性能伙伴',persona:'隔离性能夹具，不运行模型。'}), conversation=store.openDirect(owner.id);
const historyScope:BotMemoryScope={companionId:owner.id,conversationId:conversation.id,securityDomainId:conversation.securityDomainId};
const projector = new BotHistoryProjector({store,memory});
const report:Record<string,unknown>={kind:'memory-scale-result',passed:false,phases,usesPaidLlm:false,usesRealEmbedding:notes===720,
  hardware:{platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemory:os.totalmem()},
  observability:{latency:'Host wall time around actual calls, outside process snapshots',fsJs:'Public Node JS read/write/readdir counters in VCP worker; excludes native Rust/CDS/llama reads',
    processIo:'Windows process cumulative I/O; includes pipes/network/device I/O, not a count of filesystem files',rss:'Sampled owned process working set after phase; not a peak claim',
    dbQueue:null,dbQueueReason:'No authoritative native database queue timing hook; omitted rather than inferred',history:'Synthetic original user/companion messages admitted through BotStore with no reply recipient; no LLM/inbox throughput claim'}};
let sourceCount=0;
const appendSource=()=>{const index=sourceCount++;return store.enqueue({conversationId:conversation.id,senderId:index%2?'scale-owner':'user',recipientIds:[],
  sourceMessageId:`history-${index}`,content:`历史事件${index}。索引锚点 HM${String(index).padStart(8,'0')}。原文校验 VALUE-${index}-HISTORY；状态为已登记，尚未发生任何外部行动。`});};
try {
  for (const target of levels) {
    await measured(`history-${target}-seed`,async()=>{const samples:number[]=[];while(sourceCount<target){const start=performance.now();appendSource();samples.push(performance.now()-start);if(sourceCount%5000===0)progress('history-seeding',{messages:sourceCount,target});}
      return {sourceMessages:sourceCount,enqueue:quantiles(samples)};});
    await measured(`history-${target}-projection`,async()=>({...await projector.project(historyScope),sourceMessages:sourceCount}));
    const topic=`episode-${String(Math.floor((sourceCount-1)/100)).padStart(8,'0')}`;
    await measured(`history-${target}-cold-topic-read`,async()=>{const value=await memory.tool(historyScope,'TopicMemo',{topic_id:topic});
      if(!JSON.stringify(value).includes(`VALUE-${sourceCount-1}-HISTORY`))throw new Error('Exact archived topic probe missing');return {outputBytes:Buffer.byteLength(JSON.stringify(value))};});
    await measured(`history-${target}-hot-topic-read`,async()=>{const samples:number[]=[];for(let i=0;i<queryCount;i++){const start=performance.now();await memory.tool(historyScope,'TopicMemo',{topic_id:topic});samples.push(performance.now()-start);}return {latency:quantiles(samples)};});
    await measured(`history-${target}-deepmemo-index-warmup`,async()=>{const value=await memory.tool(historyScope,'DeepMemo',{keyword:'HM00000000'});if(!JSON.stringify(value).includes('VALUE-0-HISTORY'))throw new Error('Original DeepMemo warmup source missing');return {exactOriginalHit:true};});
    await measured(`history-${target}-hot-deepmemo`,async()=>{const samples:number[]=[];let exact=0;for(let i=0;i<queryCount;i++){const index=Math.floor((target-1)*i/Math.max(1,queryCount-1)),start=performance.now();
      const value=await memory.tool(historyScope,'DeepMemo',{keyword:`HM${String(index).padStart(8,'0')}`});samples.push(performance.now()-start);if(JSON.stringify(value).includes(`VALUE-${index}-HISTORY`))exact++;}return {latency:quantiles(samples),exactOriginalHits:exact,queries:queryCount};});
    for(const boundary of ['new-topic','within-topic'])await measured(`history-${target}-${boundary}-increment`,async()=>{appendSource();const archive=await projector.project(historyScope);
      const value=await memory.tool(historyScope,'TopicMemo',{topic_id:`episode-${String(Math.floor((sourceCount-1)/100)).padStart(8,'0')}`});
      if(!JSON.stringify(value).includes(`VALUE-${sourceCount-1}-HISTORY`))throw new Error('Incremental original source missing');return {...archive,sourceMessages:sourceCount};});
  }
  if((levels.at(-1) || 0)>=10000){
    await memory.close();memory=new BotMemoryService(memoryOptions);
    await measured('history-indexed-native-restart',async()=>{const value=await memory.tool(historyScope,'TopicMemo',{topic_id:'episode-00000000'});
      if(!JSON.stringify(value).includes('VALUE-0-HISTORY'))throw new Error('Previously indexed original missing after cold restart');return {sourceMessages:sourceCount,exactOriginalHit:true};});
    await measured('history-indexed-native-restart-hot-query',async()=>{const samples:number[]=[];for(let i=0;i<queryCount;i++){const start=performance.now();const value=await memory.tool(historyScope,'DeepMemo',{keyword:'HM00000000'});samples.push(performance.now()-start);
      if(!JSON.stringify(value).includes('VALUE-0-HISTORY'))throw new Error('Previously indexed original missing after native restart');}return {latency:quantiles(samples),exactOriginalHits:queryCount};});
  }
  if(notes===720){
    const semanticScope={companionId:'semantic-owner',conversationId:'semantic',securityDomainId:'semantic'};
    await measured('embedding-cold-warmup',async()=>{const result=await embedding.embed(['独立VCP性能验收预热'],{purpose:'query'});if(result.vectors[0]?.length!==768)throw new Error('Real built-in embedding dimension mismatch');return {dimension:768,model:result.profile.modelName};});
    await measured('semantic-720-ingestion',async()=>{const samples:number[]=[];for(let i=0;i<720;i++){const start=performance.now();await memory.remember(semanticScope,{sourceEventId:`scale-note-${i}`,
      content:`性能验收第${i}号项目，代号 WX${String(i).padStart(5,'0')}。负责人为成员${i%37}。正式决定是在本地保存收件记录，当前状态为待检查，计划在2027年${1+i%12}月复核。`,tags:`性能验收,项目组${i%12}`});samples.push(performance.now()-start);if((i+1)%20===0)progress('semantic-ingestion',{notes:i+1,total:720});}
      return {notes:720,writeToIndexed:quantiles(samples),status:await memory.status(semanticScope)};});
    for(const repeat of [false,true])await measured(`semantic-720-${repeat?'repeat':'first-pass'}-query`,async()=>{const samples:number[]=[];let hits=0;for(let i=0;i<queryCount;i++){const index=(i*29)%720,start=performance.now();
      const value=await memory.tool(semanticScope,'LightMemo',{query:`代号 WX${String(index).padStart(5,'0')} 项目的负责人和当前状态是什么？`});samples.push(performance.now()-start);if(JSON.stringify(value).includes(`WX${String(index).padStart(5,'0')}`))hits++;}return {latency:quantiles(samples),targetCodeMentionHits:hits,queries:queryCount,qualityClaim:'Synthetic single-fact probe only, not a natural-chat quality score'};});
    await measured('semantic-720-automatic-rag',async()=>{const samples:number[]=[];for(let i=0;i<queryCount;i++){const start=performance.now(),prepared=await memory.prepareTurn({scope:semanticScope,requestId:`scale-rag-${i}`,
      messages:[{id:`scale-query-${i}`,role:'user',content:`请回查WX${String((i*29)%720).padStart(5,'0')}项目的决定与状态。`,timestamp:1793610000000+i}]});samples.push(performance.now()-start);await memory.finishTurn(prepared,'这是没有模型输出的性能记录回执。',true);}return {prepareLatency:quantiles(samples),queries:queryCount};});
  }
  report.deniedChatRequests=deniedChatRequests;if(deniedChatRequests)throw new Error('An LLM route was attempted and locally denied; benchmark must not silently rely on it');report.passed=true;
}catch(error){report.failure=error instanceof Error?{name:error.name,message:error.message,code:(error as {code?:string}).code}:String(error);report.deniedChatRequests=deniedChatRequests;}
finally{
  await memory.close().catch(()=>undefined);store.close();await gateway.close().catch(()=>undefined);await embedding.close().catch(()=>undefined);
  deny.closeAllConnections();await new Promise<void>(resolve=>deny.close(()=>resolve()));
  report.workerCount=transports.length;report.credentialsInherited=false;process.send?.(report);process.disconnect?.();
}
}
void main().catch(error => { process.send?.({kind:'memory-scale-result',passed:false,failure:error instanceof Error?error.stack:String(error)}); process.disconnect?.(); process.exitCode=1; });
