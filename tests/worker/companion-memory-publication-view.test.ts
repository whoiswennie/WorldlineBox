import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryProjectionCache } from '../../src/main/companions/memory-projection-cache';
import { CompanionMemoryFileReadiness } from '../../src/main/companions/memory-file-readiness';
import { canonicalProjectionInputs } from '../../src/main/companions/canonical-projection-inputs';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryMessage, VcpMemoryNote, VcpMemoryPluginName, VcpMemoryScope, VcpMemoryTimelineArtifacts } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

vi.mock('electron',()=>({utilityProcess:{fork:vi.fn()}}));
const close: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const dispose of close.splice(0).reverse())await dispose();vi.restoreAllMocks();});

/** Only the Native boundary is controlled. SQL, source ACL, publication jobs,
 * Registry, files, projection cache and service orchestration are production.
 * These tests make no ranking, encoder or actual-model quality claim. */
class ObservedNative extends VcpMemoryClient {
  override readonly supportsDetachedRecall=false;
  readonly graphs=new Map<string,Map<string,VcpMemoryNote>>();
  beforeFocus?:()=>Promise<void>;
  constructor(root:string){super({dataRoot:path.join(root,'controlled-native'),vendorRoot:'unused',workerPath:'unused',embedding:{baseUrl:'http://127.0.0.1',model:'controlled',dimension:4,apiKey:'fixture'}});}
  override hasOpenScope(scope:VcpMemoryScope){return this.graphs.has(scope.scopeId);}
  override remember=vi.fn(async(scope:VcpMemoryScope,note:VcpMemoryNote)=>{const graph=this.graphs.get(scope.scopeId)??new Map();graph.set(note.id,structuredClone(note));this.graphs.set(scope.scopeId,graph);return{id:note.id,indexed:true as const};});
  override replace=vi.fn(async(scope:VcpMemoryScope,notes:VcpMemoryNote[])=>{this.graphs.set(scope.scopeId,new Map(notes.map(note=>[note.id,structuredClone(note)])));return{replaced:true as const,count:notes.length};});
  override applyProjectionDelta=vi.fn(async(scope:VcpMemoryScope,notes:VcpMemoryNote[],removedIds:string[])=>{const graph=this.graphs.get(scope.scopeId)??new Map();for(const id of removedIds)graph.delete(id);for(const note of notes)graph.set(note.id,structuredClone(note));this.graphs.set(scope.scopeId,graph);return{changed:notes.length,removed:removedIds.length};});
  override search=vi.fn(async(scope:VcpMemoryScope,query:{text:string;topK?:number})=>({results:[...(this.graphs.get(scope.scopeId)?.values()??[])].slice(0,query.topK??100).map(note=>({...structuredClone(note),score:.9,sourceFile:'controlled/'+note.id+'.md',engine:'river' as const})),diagnostics:{},degraded:false}));
  override preprocess=vi.fn(async(scope:VcpMemoryScope,messages:VcpMemoryMessage[])=>{const content=[...(this.graphs.get(scope.scopeId)?.values()??[])].map(note=>note.content).join('\n');await this.beforeFocus?.();return{messages:messages.map(message=>({...message,content:message.role==='system'?content:message.content})),events:[]};});
  override pluginCall=vi.fn(async(scope:VcpMemoryScope,plugin:VcpMemoryPluginName)=>{if(plugin!=='LightMemo')throw new Error('Unexpected Native plugin');return{result:[...(this.graphs.get(scope.scopeId)?.values()??[])].map(note=>note.content).join('\n'),indexed:true};});
  override forget=vi.fn(async(scope:VcpMemoryScope,id:string)=>{this.graphs.get(scope.scopeId)?.delete(id);return{id,deleted:true as const};});
  override interruptScope=vi.fn(async()=>undefined);
  override purgeScope=vi.fn(async(scope:VcpMemoryScope)=>{this.graphs.delete(scope.scopeId);});
  override exportTimelineArtifacts=vi.fn(async(_scope:VcpMemoryScope,sourceRevision:string):Promise<VcpMemoryTimelineArtifacts>=>({schema:'worldlinebox.vcp-timeline-artifacts',sourceRevision,agents:[]}));
  override importTimelineArtifacts=vi.fn(async()=>({acceptedMonths:0,skippedMonths:0}));
  override close=vi.fn(async()=>undefined);
}
function fixture(){
  const f=managedMemoryFiles();close.push(()=>f.close());const client=new ObservedNative(f.root),commands:CompanionStorageCommand[]=[],reports:unknown[]=[];
  const request=async(command:CompanionStorageCommand)=>{commands.push(command);const response=await f.request(command);
    if(command.type==='memory.snapshot'&&response.memorySnapshot){const actual=await f.live.materialize(command.companionId,response.memorySnapshot.notes);response.memorySnapshot={...response.memorySnapshot,notes:actual.notes,fileReceipts:actual.receipts};}
    return response;};
  // This client controls the full canonical graph boundary, not detached
  // candidate packets. Projection-cache behavior is exercised independently.
  const runtime={...controlledMemoryRuntime({get:async()=>({client,profileKey:'publication-view-fixture'}),close:()=>client.close()}),supportsProjectionDelta:false};
  const ready=new CompanionMemoryFileReadiness({request,library:f.library,sources:f.sources,history:f.history});
  const memory=new CompanionMemoryService({request,runtime,cacheRoot:path.join(f.root,'views'),publishedFilesOnly:true,
    configFor:async()=>({apiFormat:'openai_chat',model:'controlled',apiKey:'fixture'}),fetchFn:async()=>{throw new Error('No external provider allowed');},busy:()=>false,changed:()=>undefined,report:error=>reports.push(error),
    prepareFiles:owner=>f.library.prepareOwnerFiles(owner),
    materializeNotes:(owner,notes)=>f.live.projectionNotes(owner,notes),canonicalInputs:(scope,notes)=>canonicalProjectionInputs(f.history,scope,notes,f.library),
    validateFiles:(owner,receipts)=>f.live.validate(owner,receipts),canonicalDelivery:note=>ready.ensure({...f.scope,companionId:note.companionId,conversationId:note.sourceConversationId},note.id,note.contentRevision!)});
  memory.schedule=()=>undefined;close.push(()=>memory.close());
  const record=(content:string,indexed=true)=>{const source=f.source(content+' ORIGINAL');const note=f.store.request({type:'memory.record',...f.scope,candidate:f.candidate(content,[source.id])}).memories![0]!;if(indexed)f.index();return note;};
  const projection=new CompanionMemoryProjectionCache(request);close.push(async()=>projection.clear());
  return{...f,client,memory,projection,ready,commands,storageCommands:f.commands,reports,record,search:(query:string)=>memory.search({...f.scope,query},'active')};
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

it('keeps a captured published A view while file-only publication makes indexed B visible to the next cached query',async()=>{
  const f=fixture(),a=f.record('PUBLISHED_A');await f.publish();const b=f.record('INDEXED_B_NOT_PUBLISHED');
  const scope={...f.scope,publishedOnly:true,contentKinds:['episode_memory'] as const};
  const first=await f.projection.acquire({...scope,contentKinds:[...scope.contentKinds]});expect(first).toBeDefined();
  try{
    expect(first!.value.notes.map(note=>note.id)).toEqual([a.id]);
    const before=f.store.request({type:'memory.library.read',companionId:'alice',id:b.id}).memoryRead!.memory;
    expect(before.status).toBe('indexed');await f.publish();
    const after=f.store.request({type:'memory.library.read',companionId:'alice',id:b.id}).memoryRead!.memory;
    expect(after).toEqual(before);
    const next=await f.projection.acquire({...scope,contentKinds:[...scope.contentKinds]});
    try{expect(next!.value.notes.map(note=>note.id).sort()).toEqual([a.id,b.id].sort());first!.assertCurrent();expect(first!.value.notes.map(note=>note.id)).toEqual([a.id]);}finally{next?.release();}
  }finally{first?.release();}
});

it('feeds Native only canonical published A and reports pending B without calling the corpus authorized-empty',async()=>{
  const f=fixture(),a=f.record('CANONICAL_READY_A');await f.publish();const b=f.record('MUST_NOT_ENTER_NATIVE_B');
  const result=await f.search('A while B awaits publication');expect(result.ok,result.error).toBe(true);
  const native=f.client.replace.mock.calls.flatMap(([,notes])=>notes).concat(f.client.applyProjectionDelta.mock.calls.flatMap(([,notes])=>notes));
  expect(native.map(note=>note.id)).toEqual([a.id]);expect(native.some(note=>note.id===b.id||note.content.includes(b.content))).toBe(false);
  expect(result.memoryFilesPending).toBe(true);expect(result.memoryRetrieval?.authorizedCorpusEmpty).not.toBe(true);
  expect(result.memoryRetrieval?.publicationView).toMatchObject({basis:'committed_indexed',pendingFiles:true});
});

it('does not remember a queued SQL-only body and admits the same queued identity after formal file publication',async()=>{
  const f=fixture(),b=f.record('QUEUED_PENDING_BODY',false);await f.memory.drainDeliveries();
  expect(f.client.remember).not.toHaveBeenCalled();expect(f.store.request({type:'memory.outbox.pending',companionId:'alice'}).memoryOutboxPending).toBe(true);
  await f.publish();await f.memory.drainDeliveries();expect(f.client.remember).toHaveBeenCalledTimes(1);
  expect(f.client.remember.mock.calls[0]![1]).toMatchObject({id:b.id,content:b.content});
  const current=f.store.request({type:'memory.library.read',companionId:'alice',id:b.id}).memoryRead!.memory;expect(current.id).toBe(b.id);expect(current.contentRevision).toBe(b.contentRevision);
});

it('keeps an all-pending corpus explicitly incomplete without initializing a Native graph',async()=>{
  const f=fixture();f.record('ONLY_PENDING_BODY');const result=await f.search('no published notes yet');
  expect(result.ok,result.error).toBe(true);expect(result.memoryFilesPending).toBe(true);expect(result.memoryRetrieval?.authorizedCorpusEmpty).not.toBe(true);
  expect(f.client.replace).not.toHaveBeenCalled();expect(f.client.remember).not.toHaveBeenCalled();expect(f.client.preprocess).not.toHaveBeenCalled();
});

it('serves published indexed A while a published B is still queued for native indexing',async()=>{
  const f=fixture(),a=f.record('INDEXED_PUBLISHED_A');await f.publish();
  const b=f.record('PUBLISHED_B_INDEX_STILL_PENDING',false);await f.publish();
  expect(f.store.request({type:'memory.outbox.pending',companionId:'alice'}).memoryOutboxPending).toBe(true);
  const result=await f.search('keep reading A during background native indexing');
  expect(result.ok,result.error).toBe(true);expect(result.memoryOutboxPending).toBe(true);
  expect(result.memoryRetrieval?.publicationView).toMatchObject({basis:'committed_indexed',pendingIndex:true});
  expect(f.client.replace.mock.calls.flatMap(([,notes])=>notes.map(note=>note.id))).toEqual([a.id]);
  expect(result.memoryPage?.items.map(item=>item.memory.id)).toEqual([a.id]);
  expect(f.client.remember).not.toHaveBeenCalled();
  expect(f.store.request({type:'memory.library.read',companionId:'alice',id:b.id}).memoryRead?.memory.status).toBe('queued');
});

it('reads an authorized old published revision without claiming the same note’s later pending publication',async()=>{
  const f=fixture(),a=f.record('FORMAL_OLD_A_REVISION');await f.publish();
  const revised=f.store.request({type:'memory.revise',...f.scope,id:a.id,expectedVersion:a.version,candidate:f.candidate('LATER_PENDING_REVISION',[a.sources[0]!.messageId])}).memories![0]!;
  expect(revised.contentRevision).toBeGreaterThan(a.contentRevision!);const commandCount=f.storageCommands.length;
  const old=await f.ready.ensure(f.scope,a.id,a.contentRevision!);expect(old.content).toBe(a.content);expect(old.contentRevision).toBe(a.contentRevision);
  expect(f.storageCommands.slice(commandCount).some(command=>command.type==='memory.sources.outbox.claim'||command.type==='memory.history.outbox.claim')).toBe(false);
  expect(f.store.request({type:'memory.files.inspect',...f.scope,id:revised.id,contentRevision:revised.contentRevision!}).memoryFileReadiness?.state).toBe('pending');
});

it.each(['missing','tamper'] as const)('hard-rejects %s committed body/history bytes for explicit reads/search, with no SQL or pending substitution',async damage=>{
  const f=fixture(),a=f.record('COMMITTED_BODY_MUST_REMAIN_EXACT');await f.publish();const file=f.historyFile(a.id,a.contentRevision!),original=readFileSync(file,'utf8');
  if(damage==='missing'){unlinkSync(file);unlinkSync(f.noteFile(a));}else{writeFileSync(file,'UNKNOWN_EXTERNAL_EDIT');writeFileSync(f.noteFile(a),'UNKNOWN_EXTERNAL_CURRENT_EDIT');}
  await expect(f.ready.ensure(f.scope,a.id,a.contentRevision!)).rejects.not.toMatchObject({reason:'files_pending'});
  await expect(f.search('explicit search may not consume damaged history')).rejects.toThrow();
  expect(f.client.replace).not.toHaveBeenCalled();expect(f.client.remember).not.toHaveBeenCalled();
  if(damage==='missing')expect(()=>readFileSync(file)).toThrow();else expect(readFileSync(file,'utf8')).toBe('UNKNOWN_EXTERNAL_EDIT');
  expect(f.store.request({type:'memory.library.read',companionId:'alice',id:a.id}).memoryRead!.memory.content).toBe(a.content);expect(digest(original)).not.toBe(digest('UNKNOWN_EXTERNAL_EDIT'));
});

it('continues a fresh automatic passive invocation with integrity unavailable, while explicit search stays hard-rejected',async()=>{
  const f=fixture(),a=f.record('BROKEN_B_IS_NOT_A_REASON_TO_SEND_ITS_SQL_BODY');await f.publish();writeFileSync(f.noteFile(a),'UNKNOWN_EXTERNAL_BODY');
  const current=f.source('INDEPENDENT_CURRENT_CHAT_INPUT'),state=f.store.state(),companion=state.companions.find(owner=>owner.id==='alice')!,conversation=f.store.openPrivate('alice');
  await expect(f.search('explicit damaged-artifact search')).rejects.toThrow();
  const recall=f.memory.recall({companion,conversation,messages:[],currentMessage:current,config:{apiFormat:'openai_chat',model:'controlled',apiKey:'fixture'},
    recovery:{taskKey:'fresh-independent-integrity-case',isCurrent:async()=>true,onPrepared:async()=>undefined}});
  const result=await recall;
  expect(result).toMatchObject({memories:[],degraded:true,pending:false,failure:{kind:'integrity_error',code:'MEMORY_FILE_CHANGED'}});
  expect(result.context).toBeUndefined();
  expect(f.client.replace).not.toHaveBeenCalled();expect(f.client.remember).not.toHaveBeenCalled();expect(f.reports.length).toBeGreaterThan(0);
});

it('preserves foreign-owner, type-domain and source closure boundaries in the published view',async()=>{
  const f=fixture(),a=f.record('ALICE_EPISODE'),bobSource=f.source('BOB_PRIVATE_SOURCE','bob');
  const bob=f.store.request({type:'memory.record',companionId:'bob',conversationId:f.store.openPrivate('bob').id,candidate:f.candidate('BOB_PRIVATE_MEMORY',[bobSource.id])}).memories![0]!;
  const selfSource=f.source('ALICE_SELF_EXPRESSION'),self=f.store.request({type:'memory.record',...f.scope,candidate:{...f.candidate('ALICE_SELF_ONLY',[selfSource.id]),artifactKind:'self_understanding'}}).memories![0]!;
  f.index();await f.publish();await f.publish('bob');
  await expect(f.ready.ensure(f.scope,bob.id,bob.contentRevision!)).rejects.toThrow();
  const facts=await f.projection.acquire({...f.scope,publishedOnly:true,contentKinds:['episode_memory']});try{expect(facts!.value.notes.map(note=>note.id)).toEqual([a.id]);expect(facts!.value.byId.has(self.id)).toBe(false);expect(facts!.value.byId.has(bob.id)).toBe(false);}finally{facts?.release();}
  f.store.request({type:'memory.forget',...f.scope,sourceMessageIds:[a.sources[0]!.messageId]});await expect(f.ready.ensure(f.scope,a.id,a.contentRevision!)).rejects.toThrow();
  expect((await f.ready.ensure({companionId:'bob',conversationId:f.store.openPrivate('bob').id},bob.id,bob.contentRevision!)).content).toBe(bob.content);
});
