import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { mkdtempSync } from 'node:fs';
import { mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMessage } from '../../src/shared/companions';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

vi.mock('electron',()=>({utilityProcess:{fork:vi.fn()}}));

const fixtures:Array<{root:string;store:CompanionsStore}>=[];
afterEach(()=>{for(const item of fixtures.splice(0)){item.store.close();if(path.dirname(item.root)!==tmpdir()||!path.basename(item.root).startsWith('worldlinebox-fiction-memory-'))throw Error('Unexpected fixture');removeOwnedDirectorySync(item.root);}});
function fixture(){const root=mkdtempSync(path.join(tmpdir(),'worldlinebox-fiction-memory-')),file=path.join(root,'messages.sqlite');
  const store=new CompanionsStore(file,['alice','bob','carol'].map(id=>({id,name:id,description:'',persona:'认真',model:'',avatar:'sister',proactive:false,active:true})));fixtures.push({root,store});
  const room=store.openPrivate('alice').id,scope={companionId:'alice',conversationId:room};
  return {root,file,store,room,scope,topic:(kind:'game'|'story')=>store.request({type:'topic.create',conversationId:room,readerId:'user',title:'虚构对局',kind}).topic!,
    bind:(messageId:string,topicId:string)=>{const db=new(Database as {new(file:string):CompanionConnection})(file);try{db.prepare('INSERT OR REPLACE INTO companion_message_topics(message_id,topic_id) VALUES(?,?)').run(messageId,topicId);}finally{db.close();}}};}
const candidate=(source:CompanionMessage)=>({content:'虚构身份不是现实事实：'+source.content,tags:['测试'],sourceMessageIds:[source.id],evidence:[{sourceMessageId:source.id,quote:source.content}]});

it('revokes deleted discussion bodies, their derived index receipts and in-flight indexing while preserving actual participation',()=>{
  const f=fixture();
  let topic=f.store.request({type:'topic.create',conversationId:f.room,readerId:'user',title:'删除后不可回读的讨论',kind:'discussion',participantIds:['alice'],tags:['删除边界']}).topic!;
  topic=f.store.request({type:'topic.join',conversationId:f.room,topicId:topic.id,readerId:'alice'}).topic!;
  const source=f.store.appendMessage({conversationId:f.room,authorId:'user',content:'DELETE_RAW_DISCUSSION_BODY'});
  const note=f.store.request({type:'memory.record',...f.scope,candidate:{...candidate(source),content:source.content,diaryName:'经历'}}).memories![0]!;
  const lookup=f.store.request({type:'memory.world_query',...f.scope,category:'topics',query:'删除后',topicId:topic.id,limit:10}).memorySources![0]!;
  const deliveries=[];
  for(;;){const entry=f.store.request({type:'memory.outbox.claim',companionId:'alice'}).memoryOutbox;if(!entry)break;deliveries.push(entry);}
  const indexing=deliveries.find(entry=>entry.note.id===note.id)!;expect(indexing).toBeDefined();
  f.store.request({type:'topic.delete',conversationId:f.room,readerId:'user',topicId:topic.id,expectedRevision:topic.revision});
  expect(f.store.request({type:'memory.sources.filter',...f.scope,ids:[source.id,lookup.id]}).memorySources).toEqual([]);
  expect(()=>f.store.request({type:'memory.read',...f.scope,id:note.id})).toThrow('来源失效');
  f.store.request({type:'memory.outbox.complete',id:indexing.id,leaseToken:indexing.leaseToken,indexed:true});
  expect(f.store.request({type:'memory.list',companionId:'alice'}).memories!.some(entry=>entry.id===note.id)).toBe(false);
  const db=new(Database as {new(file:string):CompanionConnection})(f.file);
  try{expect((db.prepare("SELECT json_extract(data,'$.status') status FROM vcp_memory_notes WHERE id=?").get(note.id) as {status:string}).status).toBe('invalid');}
  finally{db.close();}
  const participation=deliveries.find(entry=>entry.note.metadata?.trust==='actual_participation_only')!;
  expect(participation).toBeDefined();
  expect(f.store.request({type:'memory.sources.filter',...f.scope,ids:participation.note.sources.map(entry=>entry.messageId)}).memorySources).toHaveLength(1);
  expect(f.store.request({type:'memory.jobs.claim',companionId:'alice'}).memoryJob).toBeUndefined();
});

it.each(['game','story'] as const)('isolates %s sources from active writes, finalized loops and historical capture while preserving explicit topic source access',kind=>{
  const f=fixture(),topic=f.topic(kind);
  f.store.request({type:'topic.join',conversationId:f.room,topicId:topic.id,readerId:'alice'});
  const source=f.store.appendMessage({conversationId:f.room,authorId:'user',content:'这一局我的身份是凶手，密钥是月光。'});
  expect(source.topicId).toBe(topic.id);
  expect(()=>f.store.request({type:'memory.record',...f.scope,candidate:candidate(source)})).toThrow('不能写入全局记忆');
  const reply=f.store.appendMessage({conversationId:f.room,authorId:'alice',replyToId:source.id,content:'这只是故事设定。'});
  f.store.request({type:'loop.save',checkpoint:{...f.scope,sourceMessageId:source.id,messageId:reply.id,status:'done',supplements:[],turns:[{text:reply.content,rawText:reply.content,calls:[],results:[]}]}});
  f.store.request({type:'memory.jobs.backfill'});
  expect(f.store.request({type:'memory.jobs.claim',companionId:'alice'}).memoryJob).toBeUndefined();
  const actualParticipation=f.store.request({type:'memory.outbox.claim',companionId:'alice'}).memoryOutbox;
  expect(actualParticipation?.note.metadata?.trust).toBe('actual_participation_only');
  expect(JSON.stringify(actualParticipation)).not.toContain('这一局我的身份是凶手');
  expect(f.store.request({type:'memory.sources.filter',...f.scope,ids:[source.id]}).memorySources?.[0]?.content).toBe(source.content);
  f.store.request({type:'topic.activate',conversationId:f.room,readerId:'user',topicId:null});
  const experience=f.store.appendMessage({conversationId:f.room,authorId:'user',content:'今天我和Alice实际玩了一局推理游戏，很开心。'});
  expect(f.store.request({type:'memory.record',...f.scope,candidate:{...candidate(experience),content:experience.content,diaryName:'活动体验'}}).memories).toHaveLength(1);
});

it('recalls only actual participation experiences through the real VCP engine with tag-filtered pagination across entrances',async()=>{
  const f=fixture(),room=f.store.createConversation('实际参与记录',['alice','bob']).id;
  let topic=f.store.request({type:'topic.create',conversationId:room,readerId:'user',title:'红场推理',kind:'game',tags:['红场'],participantIds:['user','alice','bob']}).topic!;
  topic=f.store.request({type:'topic.join',conversationId:room,topicId:topic.id,readerId:'alice'}).topic!;
  topic=f.store.request({type:'topic.join',conversationId:room,topicId:topic.id,readerId:'bob'}).topic!;
  topic=f.store.request({type:'topic.update',conversationId:room,topicId:topic.id,readerId:'user',expectedRevision:topic.revision,
    patch:{privateRecipientId:'alice',workingState:{summary:'ALICE_SECRET_CULPRIT',state:{role:'fictional-culprit'}}}}).topic!;
  f.store.appendMessage({conversationId:room,topicId:topic.id,authorId:'alice',content:'RAW_FICTION_SECRET_NOT_A_REAL_FACT'});
  topic=f.store.request({type:'topic.leave',conversationId:room,topicId:topic.id,readerId:'alice'}).topic!;
  topic=f.store.request({type:'topic.join',conversationId:room,topicId:topic.id,readerId:'alice'}).topic!;
  f.store.request({type:'topic.close',conversationId:room,topicId:topic.id,readerId:'user',expectedRevision:topic.revision});
  const notes=f.store.request({type:'memory.list',companionId:'alice'}).memories!;
  expect(notes.length).toBeGreaterThanOrEqual(3);
  expect(notes.every(note=>note.diaryName==='活动体验'&&note.tags.includes('红场')&&note.metadata?.trust==='actual_participation_only')).toBe(true);
  expect(JSON.stringify(notes)).not.toContain('ALICE_SECRET_CULPRIT');expect(JSON.stringify(notes)).not.toContain('RAW_FICTION_SECRET_NOT_A_REAL_FACT');
  const receiptSource=f.store.getMessage(notes[0]!.sourceMessageId!);
  expect(()=>f.store.request({type:'memory.record',...f.scope,candidate:{...candidate(receiptSource),content:'ALICE_SECRET_CULPRIT 是现实事实',diaryName:'知识',metadata:notes[0]!.metadata}})).toThrow('只能保存宿主核验的实际参与事实');
  const native=await nativeManagementHarness(f.root,async command=>f.store.request(command)),errors:unknown[]=[];
  const service=new CompanionMemoryService({request:async command=>f.store.request(command),configFor:async()=>({apiFormat:'openai_chat',baseUrl:'',model:'',apiKey:''}),
    runtime:controlledMemoryRuntime({get:async()=>({client:native.client,profileKey:'topic-native-recall'}),close:()=>native.client.close()}),cacheRoot:path.join(f.root,'recall-cache'),fetchFn:fetch,changed:()=>undefined,report:error=>errors.push(error),busy:()=>false});
  try{
    while(true){
      const delivery=f.store.request({type:'memory.outbox.claim'}).memoryOutbox;if(!delivery)break;
      const note=delivery.note;
      await native.client.remember(delivery,{id:note.id,content:note.content,tags:note.tags,diaryName:note.diaryName,occurredAt:note.occurredAt,metadata:note.metadata,author:note.companionId});
      f.store.request({type:'memory.outbox.complete',id:delivery.id,leaseToken:delivery.leaseToken,indexed:true});
    }
    const recalled=await service.search({...f.scope,query:'红场 话题参与',tags:['红场','话题参与'],diaryName:'活动体验',limit:10});
    expect(recalled.memoryPage!.items.length).toBeGreaterThan(0);
    expect(recalled.memoryPage!.items.every(hit=>hit.reasons.some(reason=>reason.startsWith('VCP '))&&notes.some(note=>note.id===hit.memory.id))).toBe(true);
    // A native semantic query may intentionally collapse similar events. Tag
    // browsing still pages every authorized indexed receipt without inventing hits.
    const ids:string[]=[];let cursor:number|undefined;
    do{
      const page=await service.search({...f.scope,query:'',tags:['红场','话题参与'],diaryName:'活动体验',limit:1,cursor});
      expect(page.memoryPage!.items).toHaveLength(1);ids.push(page.memoryPage!.items[0]!.memory.id);
      cursor=page.memoryPage!.nextCursor;
    }while(cursor!==undefined);
    expect(new Set(ids).size).toBe(ids.length);expect(ids.length).toBe(notes.length);
    expect((await service.search({...f.scope,query:'红场',tags:['不存在的标签'],limit:10})).memoryPage!.items).toEqual([]);
    const carol={companionId:'carol',conversationId:f.store.openPrivate('carol').id};
    expect((await service.search({...carol,query:'红场 话题参与',tags:['红场'],limit:10})).memoryPage!.items).toEqual([]);
    expect(JSON.stringify(native.embeddingRequests)).not.toContain('ALICE_SECRET_CULPRIT');expect(JSON.stringify(native.embeddingRequests)).not.toContain('RAW_FICTION_SECRET_NOT_A_REAL_FACT');
    expect(errors).toEqual([]);expect(native.errors).toEqual([]);
    await mkdir(path.resolve('.tools/test-output'),{recursive:true});
    await writeFile(path.resolve('.tools/test-output/companion-topic-vcp-participation.json'),JSON.stringify({status:'passed',engine:'actual vendored VCP worker/SQLite/Rust',
      embedding:'synthetic 16-dimensional loopback vectors; orchestration and authorization only, not semantic model quality',
      topicKind:topic.kind,recordedActions:notes.map(note=>note.metadata?.participationAction),actualParticipationNotes:notes.length,
      nativeRecallEngines:[...new Set(recalled.memoryPage!.items.flatMap(hit=>hit.reasons))],nativeRecallHits:recalled.memoryPage!.items.length,
      tagBrowsePages:ids.length,distinctPagedIds:new Set(ids).size,crossEntranceRecall:true,privateRolesExcluded:true,rawFictionExcluded:true,outsiderExcluded:true},null,2));
  }finally{await service.close();await native.close();}
},120000);

it('discards previously queued or leased fictional capture and its state proposal after topic association is restored',()=>{
  const f=fixture();const source=f.store.appendMessage({conversationId:f.room,authorId:'user',content:'角色秘密仅属于对局。'});
  const job=f.store.request({type:'memory.jobs.claim',companionId:'alice'}).memoryJob!;expect(job).toBeTruthy();
  const topic=f.topic('game');f.bind(source.id,topic.id);
  expect(f.store.request({type:'memory.jobs.complete',id:job.id,leaseToken:job.leaseToken,notes:[candidate(source)]}).memories).toEqual([]);
  expect(f.store.request({type:'memory.jobs.claim',companionId:'alice'}).memoryJob).toBeUndefined();
  expect(f.store.request({type:'memory.outbox.claim',companionId:'alice'}).memoryOutbox).toBeUndefined();
  expect(JSON.stringify(f.store.request({type:'memory.processing.status',companionId:'alice'}))).not.toContain('角色秘密仅属于对局');
});

it('hides old fictional notes and converts an already leased index delivery to a forget operation',()=>{
  const f=fixture(),source=f.store.appendMessage({conversationId:f.room,authorId:'user',content:'人物身份最初尚未分配话题。'});
  const note=f.store.request({type:'memory.record',...f.scope,candidate:candidate(source)}).memories![0]!;
  const delivery=f.store.request({type:'memory.outbox.claim',companionId:'alice'}).memoryOutbox!;expect(delivery.operation).toBe('remember');
  const topic=f.topic('story');f.bind(source.id,topic.id);
  expect(f.store.request({type:'memory.records.filter',...f.scope,ids:[note.id]}).memories).toEqual([]);
  expect(()=>f.store.request({type:'memory.revise',...f.scope,id:note.id,expectedVersion:note.version,candidate:candidate(source)})).toThrow('不能写入全局记忆');
  f.store.request({type:'memory.outbox.complete',id:delivery.id,leaseToken:delivery.leaseToken,indexed:true});
  const removal=f.store.request({type:'memory.outbox.claim',companionId:'alice'}).memoryOutbox!;
  expect(removal).toMatchObject({operation:'forget',noteId:note.id});expect(removal.note.content).not.toContain(source.content);
});

it('queries topic tags and real participation scopes without exposing other readers private roles or promoting returned topic state to facts',()=>{
  const f=fixture(),room=f.store.createConversation('话题索引测试',['alice','bob','carol']).id;
  let topic=f.store.request({type:'topic.create',conversationId:room,readerId:'user',title:'红色谜题',kind:'game',participantIds:['user','alice','bob'],tags:['侦探','red']}).topic!;
  topic=f.store.request({type:'topic.join',conversationId:room,readerId:'alice',topicId:topic.id}).topic!;
  const patch=(value:{shared?:{summary:string};workingState?:{summary:string;state:Record<string,unknown>};privateRecipientId?:string})=>{
    topic=f.store.request({type:'topic.update',conversationId:room,readerId:'user',topicId:topic.id,expectedRevision:topic.revision,patch:value}).topic!;
  };
  patch({shared:{summary:'PUBLIC_PHASE: investigate the red room.'}});
  patch({privateRecipientId:'alice',workingState:{summary:'ALICE_ROLE_PRIVATE',state:{role:'detective'}}});
  patch({privateRecipientId:'bob',workingState:{summary:'BOB_ROLE_SECRET',state:{role:'culprit'}}});
  const query=(companionId:string,extra:{topicId?:string;query?:string;tags?:string[]}={})=>f.store.request({type:'memory.world_query',companionId,conversationId:room,category:'topics',limit:10,query:'',...extra});
  const alice=query('alice',{tags:['RED']});
  expect(alice.worldKnowledge?.items).toHaveLength(1);
  const index=alice.worldKnowledge!.items[0] as Record<string,unknown>;
  expect(index).toMatchObject({topicId:topic.id,kind:'game',participation:'joined',workingSummary:'ALICE_ROLE_PRIVATE',source:'participant_topic_index',trust:'topic_state_not_real_world_facts'});
  expect(index.workingState).toBeUndefined();expect(JSON.stringify(alice)).not.toContain('BOB_ROLE_SECRET');
  expect(query('alice',{query:'absent'}).worldKnowledge?.items).toEqual([]);
  expect(query('alice',{tags:['absent']}).worldKnowledge?.items).toEqual([]);
  expect(query('carol').worldKnowledge?.items).toEqual([]);
  const bobInvited=query('bob',{topicId:topic.id});expect(bobInvited.worldKnowledge?.items[0]).toMatchObject({participation:'invited'});
  expect(JSON.stringify(bobInvited)).not.toContain('BOB_ROLE_SECRET');expect(JSON.stringify(bobInvited)).not.toContain('ALICE_ROLE_PRIVATE');
  const detail=query('alice',{topicId:topic.id});expect(detail.worldKnowledge?.items[0]).toMatchObject({workingState:{state:{role:'detective'}}});
  const receipt=detail.memorySources![0]!;
  expect(()=>f.store.request({type:'memory.record',companionId:'alice',conversationId:room,candidate:candidate(receipt)})).toThrow('不能写入全局记忆');
  expect(f.store.request({type:'memory.sources.filter',companionId:'bob',conversationId:room,ids:[receipt.id]}).memorySources).toEqual([]);
});
