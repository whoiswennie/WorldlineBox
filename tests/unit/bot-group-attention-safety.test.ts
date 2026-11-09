import { afterEach, expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
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
