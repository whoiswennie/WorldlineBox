import {afterEach,expect,it} from 'vitest';
import {BotStore} from '../../src/main/companion-bot/store';
import {BotTopics} from '../../src/main/companion-bot/topics';
import {BotDshBrain} from '../../src/main/companion-bot/dsh-brain';
import type {BotNativeContext} from '../../src/shared/companion-native-context';
let store:BotStore;
afterEach(()=>store?.close());
function fixture(){store=new BotStore(':memory:');const companion=store.createCompanion({name:'伙伴',persona:'伙伴'}),room=store.openDirect(companion.id),topics=new BotTopics(store);let sequence=0;
  const send=(content:string,requestId=String(++sequence))=>store.enqueue({conversationId:room.id,senderId:'user',sourceMessageId:requestId,content,payload:{userQueued:true}});
  return{companion,room,topics,send};}
it('reuses a selected topic, isolates new topics and restores an earlier topic after browsing',()=>{
  const f=fixture(),first=f.topics.create(f.room.id,'first','项目一'),one=f.send('设计项目一');f.topics.bind(one.events,first);
  const two=f.send('补充导出功能');f.topics.bind(two.events,f.topics.current(f.room.id)!);
  expect(f.topics.lane(one.events[0]!)).toBe(f.topics.lane(two.events[0]!));
  const second=f.topics.create(f.room.id,'second','项目二'),three=f.send('新任务');f.topics.bind(three.events,second);
  expect(f.topics.lane(three.events[0]!)).not.toBe(f.topics.lane(one.events[0]!));
  f.topics.select(f.room.id,first.id);expect(f.topics.current(f.room.id)?.id).toBe(first.id);
  expect(f.topics.list(f.room.id,'项目一').items).toHaveLength(1);
});
it('keeps context measurements independent across topics and rejects out-of-order observations within one session',()=>{
  const f=fixture(),a=f.topics.create(f.room.id,'a'),first=f.send('项目A');f.topics.bind(first.events,a);const laneA=f.topics.lane(first.events[0]!);
  const b=f.topics.create(f.room.id,'b'),second=f.send('项目B');f.topics.bind(second.events,b);const laneB=f.topics.lane(second.events[0]!);
  const sample=(lane:string,seq:number,value:number):BotNativeContext=>({source:'dsh-native-projections',sessionId:BotDshBrain.sessionId(lane),state:'ready',asOfSeq:seq,sampledAt:new Date().toISOString(),pressure:{projectedTokens:value,contextWindow:128000}});
  f.topics.rememberContext(f.room.id,laneA,sample(laneA,100,6000));f.topics.rememberContext(f.room.id,laneB,sample(laneB,1,64000));f.topics.rememberContext(f.room.id,laneA,sample(laneA,99,1234));
  f.topics.select(f.room.id,a.id);expect(f.topics.runtime(f.room.id).contexts?.[f.companion.id]?.pressure?.projectedTokens).toBe(6000);
  f.topics.select(f.room.id,b.id);expect(f.topics.runtime(f.room.id).contexts?.[f.companion.id]?.pressure?.projectedTokens).toBe(64000);
  expect(()=>f.topics.contextBinding(a.id,f.room.id,'outsider')).toThrow();
});
it('rejects cross-room topics and contexts invalidated by memory withdrawal or ACL changes',()=>{
  const f=fixture(),selected=f.topics.create(f.room.id,'first'),one=f.send('第一条');f.topics.bind(one.events,selected);
  const other=store.createCompanion({name:'其他',persona:'其他'}),room=store.openDirect(other.id);
  expect(()=>f.topics.select(room.id,selected.id)).toThrow();
  store.rotateDomain(f.companion.id,f.room.securityDomainId);expect(()=>f.topics.select(f.room.id,selected.id)).toThrow('上下文');expect(f.topics.current(f.room.id)).toBeUndefined();
});
it('moves only an undispatched event into a clean topic after a recovered VCP withdrawal',()=>{
  const f=fixture(),selected=f.topics.create(f.room.id,'old'),first=f.send('旧任务');f.topics.bind(first.events,selected);
  const old=store.claim({workerId:'old'})!;store.bindEventNativeEpoch(old.event.id,1);store.markDispatched(old.event.id,old.leaseToken,old.event.id);store.settle({eventId:old.event.id,leaseToken:old.leaseToken,status:'done',content:'旧答复'});
  const second=f.send('重启后的新消息');f.topics.bind(second.events,selected);const next=store.claim({workerId:'next'})!,oldLane=f.topics.lane(old.event);
  store.rotateDomain(f.companion.id,f.room.securityDomainId);f.topics.refreshBeforeDispatch(next.event);
  expect(f.topics.lane(next.event)).not.toBe(oldLane);expect(f.topics.lane(old.event)).toBe(oldLane);expect(f.topics.reference(old.event.id)?.id).toBe(selected.id);
  expect(()=>f.topics.assertCurrent(next.event)).not.toThrow();expect(()=>f.topics.get(selected.id,f.room.id)).toThrow('上下文');
  expect(store.bindEventNativeEpoch(next.event.id,2)).toBe(2);
});
it('never redirects an already dispatched event after its native epoch is withdrawn',()=>{
  const f=fixture(),selected=f.topics.create(f.room.id,'old'),sent=f.send('已投递');f.topics.bind(sent.events,selected);const claim=store.claim({workerId:'one'})!;
  store.bindEventNativeEpoch(claim.event.id,1);store.markDispatched(claim.event.id,claim.leaseToken,claim.event.id);const lane=f.topics.lane(claim.event);
  store.rotateDomain(f.companion.id,f.room.securityDomainId);f.topics.refreshBeforeDispatch(claim.event);
  expect(f.topics.lane(claim.event)).toBe(lane);expect(()=>f.topics.assertCurrent(claim.event)).toThrow('上下文');
});
it('keeps fresh group events from one user message in the same replacement topic',()=>{
  const f=fixture(),second=store.createCompanion({name:'第二位',persona:'第二位'}),room=store.createGroup({title:'协同',memberIds:[f.companion.id,second.id],participationMode:'all'}),selected=f.topics.create(room.id,'old');
  const source=store.enqueue({conversationId:room.id,senderId:'user',content:'同一条新请求',sourceMessageId:'shared'});f.topics.bind(source.events,selected);
  const a=store.claim({workerId:'a'})!,b=store.claim({workerId:'b'})!;store.rotateDomain(a.event.companionId,room.securityDomainId);
  f.topics.refreshBeforeDispatch(a.event);f.topics.refreshBeforeDispatch(b.event);
  expect(f.topics.reference(a.event.id)?.id).toBe(f.topics.reference(b.event.id)?.id);expect(f.topics.reference(a.event.id)?.id).not.toBe(selected.id);
  expect(()=>f.topics.assertCurrent(a.event)).not.toThrow();expect(()=>f.topics.assertCurrent(b.event)).not.toThrow();
});
it('reserves a queued message atomically for native steering and restores it only after confirmed non-admission',()=>{
  const f=fixture();f.send('执行中的任务');const claim=store.claim({workerId:'one'})!;const queued=f.send('用户补充');
  expect(f.topics.runtime(f.room.id).queued).toHaveLength(1);
  const commands=f.topics.reserveGuidance(f.room.id,queued.message.id,new Map([[queued.events[0]!.id,'实际补充文本和附件绝对路径']]));
  expect(store.getEvent(queued.events[0]!.id)?.status).toBe('cancelled');expect(commands[0]?.event_id).toBe(claim.event.id);
  expect(store.claim({workerId:'two'})).toBeUndefined();
  f.topics.guidanceResult(commands[0]!,'网络结果未知');expect(f.topics.runtime(f.room.id).queued[0]?.state).toBe('attention');
  expect(()=>f.topics.cancelQueued(f.room.id,queued.message.id)).toThrow('投递正在确认');
  f.topics.guidanceNotAccepted(commands[0]!);expect(store.getEvent(queued.events[0]!.id)?.status).toBe('queued');expect(f.topics.pendingGuidance()).toHaveLength(0);
});
it('does not steal an already running queued message when the user requests steering',()=>{
  const f=fixture(),sent=f.send('任务'),claim=store.claim({workerId:'one'})!;
  expect(claim.event.id).toBe(sent.events[0]!.id);
  expect(()=>f.topics.reserveGuidance(f.room.id,sent.message.id,new Map([[claim.event.id,'补充']]))).toThrow('已经开始');
  expect(store.getEvent(claim.event.id)?.status).toBe('running');
});
it('imports old WorldlineBox sessions without reading unrelated native DSH history',()=>{
  const f=fixture(),sent=f.send('旧版任务'),claim=store.claim({workerId:'one'})!;
  store.markDispatched(claim.event.id,claim.leaseToken,claim.event.id);store.settle({eventId:claim.event.id,leaseToken:claim.leaseToken,status:'done',content:'完成'});
  const selected=f.topics.list(f.room.id).items[0]!;expect(selected.title).toBe('旧版任务');f.topics.select(f.room.id,selected.id);
  const followup=f.send('接续旧版');f.topics.bind(followup.events,selected);
  expect(f.topics.lane(followup.events[0]!)).toBe('turn-'+sent.events[0]!.id);
});
it('keeps private companion collaboration in its own native topic while reconnecting the same project on later contact',()=>{
  const f=fixture(),other=store.createCompanion({name:'协作者',persona:'协作者'}),peer=store.openPeer(f.companion.id,other.id),selected=f.topics.create(f.room.id,'project');
  const original=f.send('项目');f.topics.bind(original.events,selected);
  const contact=(cause:string,request:string)=>store.enqueue({conversationId:peer.id,senderId:f.companion.id,source:'companion',sourceMessageId:request,content:'实际分工',recipientIds:[other.id],causationId:cause});
  const first=contact(original.events[0]!.id,'contact-one').events[0]!;f.topics.started(first);
  const followup=f.send('追问同一项目');f.topics.bind(followup.events,selected);
  const second=contact(followup.events[0]!.id,'contact-two').events[0]!;f.topics.started(second);
  expect(f.topics.lane(first)).toBe(f.topics.lane(second));expect(f.topics.reference(first.id)?.id).not.toBe(selected.id);
  expect(()=>f.topics.select(peer.id,f.topics.reference(first.id)!.id)).toThrow('不能管理');
});
it('bounds the recent view, paginates the full list, pins first and searches only favorites when requested',()=>{
  const f=fixture(),items=[];
  for(let index=0;index<32;index++){
    const value=f.topics.create(f.room.id,'item-'+index,index===0?'上海出行的天气资料':index===1?'上海另一份天气资料':'资料 '+index);items.push(value);
    store.taskTransaction(sql=>sql.prepare('UPDATE bot_native_topics SET activity_at=? WHERE id=?').run(new Date(1000000+index*1000).toISOString(),value.id));
  }
  f.topics.flags(f.room.id,items[0]!.id,{pinned:true,favorite:true});
  expect(f.topics.list(f.room.id).items).toHaveLength(6);expect(f.topics.list(f.room.id).items[0]?.id).toBe(items[0]!.id);
  const first=f.topics.list(f.room.id,'',undefined,'all'),second=f.topics.list(f.room.id,'',first.next,'all');
  expect(first.items).toHaveLength(12);expect(second.items).toHaveLength(12);expect(second.items.some(topic=>first.items.some(prior=>prior.id===topic.id))).toBe(false);
  expect(f.topics.list(f.room.id,'上海天气',undefined,'all').items).toHaveLength(2);
  expect(f.topics.list(f.room.id,'上海天气',undefined,'favorites').items.map(topic=>topic.id)).toEqual([items[0]!.id]);
});
it('retains explicit renames and newest native title jobs across replay and out-of-order acknowledgements',()=>{
  const f=fixture(),selected=f.topics.create(f.room.id,'project'),sent=f.send('原始标题');f.topics.bind(sent.events,selected);
  const claim=store.claim({workerId:'one'})!;store.markDispatched(claim.event.id,claim.leaseToken,claim.event.id);
  f.topics.rename(f.room.id,selected.id,'手动标题','rename-one');const old=f.topics.titleJobs()[0]!;
  f.topics.rename(f.room.id,selected.id,'手动标题','rename-one');expect(f.topics.titleJobs()[0]?.revision).toBe(1);
  f.topics.rename(f.room.id,selected.id,'最终标题','rename-two');f.topics.titleResult(old);
  const latest=f.topics.titleJobs()[0]!;expect(latest).toMatchObject({title:'最终标题',revision:2});expect(f.topics.get(selected.id,f.room.id).renamePending).toBe(true);
  f.topics.titleResult(latest);expect(f.topics.get(selected.id,f.room.id)).toMatchObject({title:'最终标题',renamePending:false});
  f.topics.bind(sent.events,f.topics.get(selected.id,f.room.id));expect(f.topics.get(selected.id,f.room.id).title).toBe('最终标题');
  expect(()=>f.topics.rename(f.room.id,selected.id,'不同标题','rename-one')).toThrow('不同内容');
});
it('fuzzy-searches an old session beyond the recent page without importing the lifetime history',()=>{
  const f=fixture();let original='';
  for(let index=0;index<70;index++){
    const sent=f.send(index===0?'归档已久的重要关键词':'普通话题 '+index),claim=store.claim({workerId:'worker'})!;if(!index)original=sent.events[0]!.id;
    store.markDispatched(claim.event.id,claim.leaseToken,claim.event.id);store.settle({eventId:claim.event.id,leaseToken:claim.leaseToken,status:'done',content:'回答'});
  }
  const result=f.topics.list(f.room.id,'归档关键词');expect(result.items.map(topic=>topic.id)).toEqual(['legacy-'+original]);
  expect(store.taskTransaction(sql=>sql.prepare('SELECT count(*) AS count FROM bot_native_topics').get())).toMatchObject({count:0});
  f.topics.select(f.room.id,result.items[0]!.id);expect(f.topics.lane(store.getEvent(original)!)).toBe('turn-'+original);
});
