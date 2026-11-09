import {afterEach,expect,it} from 'vitest';
import {BotStore} from '../../src/main/companion-bot/store';
import {BotTopics} from '../../src/main/companion-bot/topics';
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
it('rejects cross-room topics and contexts invalidated by memory withdrawal or ACL changes',()=>{
  const f=fixture(),selected=f.topics.create(f.room.id,'first'),one=f.send('第一条');f.topics.bind(one.events,selected);
  const other=store.createCompanion({name:'其他',persona:'其他'}),room=store.openDirect(other.id);
  expect(()=>f.topics.select(room.id,selected.id)).toThrow();
  store.rotateDomain(f.companion.id,f.room.securityDomainId);expect(()=>f.topics.select(f.room.id,selected.id)).toThrow('上下文');expect(f.topics.current(f.room.id)).toBeUndefined();
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
