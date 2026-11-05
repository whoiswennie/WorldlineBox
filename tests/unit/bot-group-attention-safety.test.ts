import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';

const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function until(check:()=>boolean){const end=Date.now()+7000;while(!check()){if(Date.now()>end)throw Error('Group attention fixture did not settle.');await new Promise(resolve=>setTimeout(resolve,15));}}
class NoMemory extends BotMemoryService{
  constructor(root:string){super({root,runtime:async()=>{throw Error('Quiet group assessment must not start VCP.');},embedding:async()=>{throw Error('Quiet group assessment must not embed.');}});}
}
class Attention extends BotDshBrain{
  calls:BotDshRun[]=[];
  answer:(input:BotDshRun)=>Promise<string>=async()=>'{"recipients":[],"reason":"没有需要补充的内容。"}';
  constructor(){super({getHost:async()=>{throw Error('Group attention must not start DSH.');}});}
  override async run(input:BotDshRun):Promise<BotDshResult>{this.calls.push(input);if(!input.laneId.startsWith('group-attention-'))throw Error('This fixture selects no speaker.');return{text:await this.answer(input),eventId:input.eventId,sessionId:'app-attention',status:'succeeded'};}
  override async archive(){}
  override async close(){}
}
async function serviceFixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'wlb-group-attention-safety-')),brain=new Attention();
  const service=new BotService({root,brain,brainRuntime:'worldlinebox',memory:new NoMemory(path.join(root,'memory')),model:()=>({apiFormat:'openai_chat',model:'small-cap',apiKey:'fixture-no-inference',baseUrl:'http://127.0.0.1:9',maxTokens:17,maxOutputTokens:17,contextWindow:32768}),onEvent:()=>undefined});
  await service.handle({type:'state'});
  for(const id of ['alice','bob','carol'])service.store.createCompanion({id,name:id,persona:'公开角色设定。'});
  const room=service.store.createGroup({title:'当前公开群聊',memberIds:['alice','bob'],participationMode:'automatic'});
  cleanups.push(async()=>{await service.shutdown();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('wlb-group-attention-safety-'))throw Error('Invalid attention cleanup.');await rm(root,{recursive:true,force:true});});
  return{service,store:service.store,brain,room};
}
function storeFixture(maxDerivedEvents=64){const store=new BotStore(':memory:',{activityBudget:{maxDerivedEvents}});for(const id of ['alice','bob','carol'])store.createCompanion({id,name:id,persona:'公开角色'});cleanups.push(async()=>store.close());const room=store.createGroup({title:'公开讨论',memberIds:['alice','bob'],participationMode:'automatic'});return{store,room};}
function complete(store:BotStore,eventId:string,content:string){let claim=store.claim({workerId:'group-safety'});while(claim&&claim.event.id!==eventId){store.settle({eventId:claim.event.id,leaseToken:claim.leaseToken,status:'done',content:''});claim=store.claim({workerId:'group-safety'});}if(!claim)throw Error('Missing observation claim.');store.promoteGroupReply(eventId,claim.leaseToken);expect(store.settle({eventId,leaseToken:claim.leaseToken,status:'done',content})).toBe(true);}

it('observes the actual published message once, creates no duplicate chat source, and confines observers to the original group',()=>{
  const f=storeFixture(),direct=f.store.openDirect('alice');
  f.store.enqueue({conversationId:direct.id,senderId:'user',recipientIds:[],sourceMessageId:'private',content:'PRIVATE_DIRECT_SENTINEL'});
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'public',content:'公开讨论一个小问题。'});
  expect(f.store.messagesPage(f.room.id).items).toHaveLength(1);expect(source.events).toHaveLength(2);
  f.store.setMetadata(`group-discussion:${f.room.id}:${source.events[0]!.correlationId}`,'1');
  f.store.resolveGroupCandidates(source.message.id,['alice']);
  complete(f.store,source.events.find(event=>event.companionId==='alice')!.id,'PUBLIC_ACTUAL_REPLY');
  const cause=source.events.find(event=>event.companionId==='alice')!,observed=f.store.observeGroupReply(cause.id);
  expect(observed).toHaveLength(1);expect(observed[0]).toMatchObject({conversationId:f.room.id,source:'group',companionId:'bob',sourceMessageRecordId:cause.replyMessageId,correlationId:cause.correlationId,payload:{hop:1}});
  expect(f.store.observeGroupReply(cause.id)).toEqual([]);
  expect(f.store.messagesPage(f.room.id).items.filter(message=>message.content==='PUBLIC_ACTUAL_REPLY')).toHaveLength(1);
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_DIRECT_SENTINEL');
});

it.each(['acl','dissolve','withdraw'] as const)('refuses new observers after %s revocation and never promotes a cancelled old lease',reason=>{
  const f=storeFixture(),source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'revoked',content:'公开观察来源。'}),cause=source.events[0]!;
  complete(f.store,cause.id,'公开答复');
  if(reason==='acl')f.store.updateMembers(f.room.id,['bob','carol']);
  else if(reason==='dissolve')f.store.dissolveConversation(f.room.id);
  else f.store.withdrawSources(cause.companionId,cause.securityDomainId,[cause.id]);
  expect(f.store.observeGroupReply(cause.id)).toEqual([]);
  const pending=source.events[1]!;f.store.cancelEvent(pending.id);expect(f.store.promoteGroupReply(pending.id,'stale-lease')).toBe(false);
});

it('keeps automatic observation under both hop and shared durable event budgets',()=>{
  const f=storeFixture(2),source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'bounded',content:'公开讨论。'}),cause=source.events[0]!;
  f.store.setMetadata(`group-discussion:${f.room.id}:${cause.correlationId}`,'1');f.store.resolveGroupCandidates(source.message.id,[cause.companionId]);
  complete(f.store,cause.id,'公开第一句');let next=f.store.observeGroupReply(cause.id)[0]!;
  complete(f.store,next.id,'公开第二句');next=f.store.observeGroupReply(next.id)[0]!;
  complete(f.store,next.id,'公开第三句');expect(()=>f.store.observeGroupReply(next.id)).toThrow('预算');
  const g=storeFixture(),second=g.store.enqueue({conversationId:g.room.id,senderId:'user',sourceMessageId:'hop',content:'公开讨论。'}),initial=second.events[0]!;
  g.store.setMetadata(`group-discussion:${g.room.id}:${initial.correlationId}`,'1');g.store.resolveGroupCandidates(second.message.id,[initial.companionId]);
  complete(g.store,initial.id,'起始');let current=initial;
  for(let hop=1;hop<=3;hop++){const observed=g.store.observeGroupReply(current.id);expect(observed).toHaveLength(1);expect(observed[0]!.payload.hop).toBe(hop);current=observed[0]!;complete(g.store,current.id,`公开进展${hop}`);}
  expect(g.store.observeGroupReply(current.id)).toEqual([]);
});

it('coalesces a quiet public assessment without private history, VCP, tools or a provider-output-cap override',async()=>{
  const f=await serviceFixture(),privateRoom=f.store.openDirect('alice');
  f.store.enqueue({conversationId:privateRoom.id,senderId:'user',recipientIds:[],sourceMessageId:'private-role',content:'PRIVATE_HISTORY_MUST_NOT_ENTER_JUDGE'});
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'quiet-public',content:'今天想随便讨论一下这个公开话题。'});
  await until(()=>source.events.every(event=>f.store.getEvent(event.id)!.status==='done'));
  expect(f.brain.calls).toHaveLength(1);expect(f.brain.calls[0]!.tools).toEqual([]);
  expect(f.brain.calls[0]!.prompt).not.toContain('PRIVATE_HISTORY_MUST_NOT_ENTER_JUDGE');
  expect(f.brain.calls[0]!.model.maxTokens).toBeLessThanOrEqual(17);expect(f.brain.calls[0]!.model.maxOutputTokens).toBeLessThanOrEqual(17);
  expect(f.store.messagesPage(f.room.id).items).toHaveLength(1);
});

it('does not submit a public trigger or public history that every candidate has already withdrawn to a new judge',async()=>{
  const f=await serviceFixture();
  const history=f.store.enqueue({conversationId:f.room.id,senderId:'user',recipientIds:[],sourceMessageId:'withdrawn-history',content:'WITHDRAWN_PUBLIC_HISTORY'}).message;
  for(const id of ['alice','bob'])f.store.withdrawSources(id,f.room.securityDomainId,[history.id]);
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'withdrawn-trigger',content:'WITHDRAWN_PUBLIC_TRIGGER'});
  for(const id of ['alice','bob'])f.store.withdrawSources(id,f.room.securityDomainId,[source.message.id]);
  await until(()=>source.events.every(event=>['done','cancelled'].includes(f.store.getEvent(event.id)!.status)));
  expect(f.brain.calls).toHaveLength(0);
});

it('does not publish an in-flight assessment after a member change or retain its revoked shared decision',async()=>{
  const f=await serviceFixture();let finish!:(text:string)=>void;
  f.brain.answer=async()=>new Promise(resolve=>{finish=resolve;});
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'changing-room',content:'讨论中的公开问题。'});
  await until(()=>f.brain.calls.length===1);
  await f.service.handle({type:'conversation.members',conversationId:f.room.id,memberIds:['bob','carol']});
  finish('{"recipients":["alice"],"reason":"迟到的旧决定"}');
  await until(()=>source.events.every(event=>f.store.getEvent(event.id)!.status==='cancelled'));
  await new Promise(resolve=>setTimeout(resolve,40));expect(f.brain.calls).toHaveLength(1);
  expect(f.store.getMetadata(`group-attention:${source.message.id}:${f.room.revision}`)).toBeUndefined();
  expect(f.store.messagesPage(f.room.id).items).toHaveLength(1);
});

it('cancels one recipient while the other completes the same shared assessment without restarting or aborting it',async()=>{
  const f=await serviceFixture();let finish!:(text:string)=>void;
  f.brain.answer=async()=>new Promise(resolve=>{finish=resolve;});
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'one-recipient-stopped',content:'这个公开问题暂时只需要观察。'});
  await until(()=>f.brain.calls.length===1);
  const first=source.events.find(event=>event.companionId==='alice')!,second=source.events.find(event=>event.companionId==='bob')!;
  await f.service.handle({type:'reply.cancel',messageId:first.replyMessageId});
  await until(()=>f.store.getEvent(first.id)!.status==='cancelled');
  expect(f.brain.calls[0]!.signal?.aborted).toBe(false);
  finish('{"recipients":[],"reason":"不需要补充。"}');
  await until(()=>f.store.getEvent(second.id)!.status==='done');
  expect(f.brain.calls).toHaveLength(1);expect(f.store.getEvent(first.id)!.status).toBe('cancelled');
  expect(f.store.messagesPage(f.room.id).items.filter(message=>message.content.trim())).toHaveLength(1);
});
it('aborts the shared assessment when the whole group is stopped even if its provider ignores cancellation',async()=>{
  const f=await serviceFixture();
  f.brain.answer=async()=>new Promise<string>(()=>undefined);
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',sourceMessageId:'whole-group-stopped',content:'讨论一下这个问题。'});
  await until(()=>f.brain.calls.length===1);
  const stopped=await f.service.handle({type:'message.send',conversationId:f.room.id,requestId:'stop-everyone',content:'停止讨论'});
  expect(stopped.ok).toBe(true);
  await until(()=>source.events.every(event=>f.store.getEvent(event.id)!.status==='cancelled'));
  await until(()=>f.brain.calls[0]!.signal!.aborted);
  f.brain.answer=async()=>' {"recipients":[],"reason":"新消息不需要补充。"}';
  const next=await f.service.handle({type:'message.send',conversationId:f.room.id,requestId:'after-stop',content:'新的公开话题'});
  await until(()=>f.brain.calls.length===2);
  await until(()=>next.replyMessageIds!.every(id=>f.store.eventForReply(id)?.status==='done'));
  expect(f.store.getMetadata(`group-attention:${source.message.id}:${f.room.revision}`)).toBeUndefined();
});
