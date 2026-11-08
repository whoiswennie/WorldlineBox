import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {BotStore} from '../../src/main/companion-bot/store';
import {BotDelegationRuntime} from '../../src/main/companion-bot/delegation-runtime';
import type {BotEvent,BotTask} from '../../src/main/companion-bot/types';
import type {BotMediaRef} from '../../src/shared/companion-bot-media';
import {BotCompanionRuntime} from '../../src/main/companion-bot/companion-runtime';

const stores:BotStore[]=[],roots:string[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
function fixture(database=':memory:'){
  const store=new BotStore(database,{activityBudget:{maxActions:1000,maxDerivedEvents:1000,maxTasks:1000,maxPendingInbox:1000,maxPendingTasks:1000}});stores.push(store);
  for(const companionId of ['alice','bob','carol','dave'])store.createCompanion({id:companionId,name:companionId,persona:'独立角色，任务授权受控。'});
  const runtime=new BotDelegationRuntime(store),room=store.openDirect('alice');
  const source=store.enqueue({conversationId:room.id,senderId:'user',content:'请让 Bob 分析两份原始资料，并将核验后的结果交回本聊天。',sourceMessageId:'user-source'}).events[0]!;
  const goal='对两份明确选定的原始资料核算与审计，再汇总真实结果。';
  const contact=store.contactPeer(source,'bob','contact','请按原始资料拆分核算与审计，再汇总结果。','peer');if(!contact.accepted)throw Error('Expected real host peer delivery');
  const peer=contact.events[0]!,proxy=store.createTask({id:'proxy',conversationId:room.id,companionId:'alice',sourceEventId:source.id,goal,extra:{title:'跨伙伴资料分析'}});
  const input={recipientId:'bob',peerConversationId:peer.conversationId,contactEventId:peer.id,proxyTaskId:proxy.id,goal,title:'跨伙伴资料分析'};
  const ticket=runtime.create(source,'create',input);
  const worker=(taskId:string,from:BotEvent=peer,delegationId=ticket.id)=>store.createTask({id:taskId,conversationId:from.conversationId,companionId:from.companionId,sourceEventId:from.id,goal:'仅分析选定原件。',extra:{delegationId,title:taskId}});
  const notice=(task:BotTask,from:BotEvent=peer)=>store.enqueue({conversationId:from.conversationId,senderId:'task-service',source:'task',recipientIds:[from.companionId],
    content:'真实任务已经返回。',kind:'task_done',sourceMessageId:'notice-'+task.id,payload:{taskId:task.id},causationId:task.sourceEventId,correlationId:from.correlationId}).events[0]!;
  return{store,runtime,room,source,peer,proxy,input,ticket,worker,notice};
}

it('persists one real user-to-peer delegation and keeps retries idempotent across a new SQLite connection',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'wlb-delegation-'));roots.push(root);const database=path.join(root,'bot.sqlite'),f=fixture(database);
  expect(f.runtime.forEvent(f.peer)).toEqual(f.ticket);expect(f.runtime.allowsWork(f.peer)).toBe(true);
  expect(f.runtime.create(f.source,'create',f.input)).toEqual(f.ticket);
  expect(()=>f.runtime.create(f.source,'create',{...f.input,title:'changed goal'})).toThrow('同一委派调用');
  const worker=f.worker('finance');f.store.updateTask(worker.id,{status:'running',extra:{...worker.extra,progress:{phase:'running',detail:'已读取选中的第一份原件。'}}});
  f.store.close();stores.splice(stores.indexOf(f.store),1);const restarted=new BotStore(database);stores.push(restarted);const runtime=new BotDelegationRuntime(restarted);
  expect(runtime.get(f.ticket.id)).toEqual(f.ticket);expect(runtime.forEvent(restarted.getEvent(f.peer.id)!)).toEqual(f.ticket);expect(runtime.tasks(f.ticket.id).map(task=>task.id)).toEqual(['finance']);
  expect(runtime.status(restarted.getEvent(f.source.id)!,f.ticket.id).tickets[0]!.tasks[0]).toMatchObject({id:'finance',status:'running',progress:{phase:'running'}});
});

it('rejects forged contacts and verifies either committed reply destination before delegating',()=>{
  const f=fixture(),plain=f.store.enqueue({conversationId:f.peer.conversationId,senderId:'alice',source:'companion',recipientIds:['bob'],content:f.peer.content,
    sourceMessageId:'ordinary-causal-message',causationId:f.source.id,correlationId:f.source.correlationId}).events[0]!;
  expect(()=>f.runtime.create(plain,'forbidden',f.input)).toThrow('另一位伙伴');
  expect(()=>f.runtime.create({...f.source,content:'forged demand'},'forged',f.input)).toThrow('失效');
  expect(()=>f.runtime.create(f.source,'ordinary',{...f.input,contactEventId:plain.id})).toThrow('Main 已提交');
  const forwarded=f.store.contactPeer(f.source,'bob','user-work','请查询天气后告诉用户。','user');if(!forwarded.accepted)throw Error('Expected real user-route contact');
  const proxy=f.store.createTask({id:'user-route-proxy',conversationId:f.room.id,companionId:'alice',sourceEventId:f.source.id,goal:forwarded.message.content});
  const input={...f.input,contactEventId:forwarded.events[0]!.id,proxyTaskId:proxy.id,goal:proxy.goal};
  const receiptKey=`peer-contact-receipt:${f.source.id}:user-work`,receipt=f.store.getMetadata(receiptKey)!;
  f.store.setMetadata(receiptKey,JSON.stringify({...JSON.parse(receipt),destination:'peer'}));
  expect(()=>f.runtime.create(f.source,'user-route',input)).toThrow('转达回执');
  f.store.setMetadata(receiptKey,receipt);
  expect(f.runtime.create(f.source,'user-route',input)).toMatchObject({contactEventId:forwarded.events[0]!.id,proxyTaskId:proxy.id});
});

it('rejects a proxy from another user request and does not bind one contact or proxy to multiple tickets',()=>{
  const f=fixture(),other=f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'另一份任务',sourceMessageId:'other-source'}).events[0]!;
  const proxy=f.store.createTask({id:'other-proxy',conversationId:f.room.id,companionId:'alice',sourceEventId:other.id,goal:f.input.goal});
  expect(()=>f.runtime.create(f.source,'other-proxy',{...f.input,proxyTaskId:proxy.id})).toThrow('代理任务');
  expect(()=>f.runtime.create(f.source,'new-ticket',f.input)).toThrow();
  expect(f.runtime.status(f.source).tickets).toHaveLength(1);
});

it('recognizes only exact bound updates and actual recipient task notices, never ordinary companion payloads or causation',()=>{
  const f=fixture(),worker=f.worker('finance'),taskNotice=f.notice(worker);
  expect(f.runtime.forEvent(taskNotice)?.id).toBe(f.ticket.id);
  const ordinary=f.store.enqueue({conversationId:f.peer.conversationId,senderId:'alice',source:'companion',recipientIds:['bob'],content:'普通聊天不是新工作授权。',
    sourceMessageId:'ordinary-with-task',payload:{taskId:worker.id,delegationId:f.ticket.id},causationId:f.peer.id,correlationId:f.ticket.correlationId}).events[0]!;
  expect(f.runtime.forEvent(ordinary)).toBeUndefined();
  expect(f.runtime.forEvent(f.source)).toBeUndefined();
  const update=f.store.enqueue({conversationId:f.peer.conversationId,senderId:'alice',source:'companion',recipientIds:['bob'],content:'用户明确补充：使用税后金额。',
    sourceMessageId:'explicit-update',causationId:f.source.id,correlationId:f.ticket.correlationId}).events[0]!;
  expect(f.runtime.forEvent(update)).toBeUndefined();f.runtime.bindEvent(f.ticket.id,update.id);f.runtime.bindEvent(f.ticket.id,update.id);
  expect(f.runtime.forEvent(update)?.id).toBe(f.ticket.id);expect(f.runtime.allowsWork(update)).toBe(true);
  expect(()=>f.runtime.forEvent({...update,payload:{delegationId:'forged'}})).toThrow('失效');
});

it('scopes directory access to the original requester chat and the recipient peer chat',()=>{
  const f=fixture(),bobRoom=f.store.openDirect('bob'),direct=f.store.enqueue({conversationId:bobRoom.id,senderId:'user',content:'Bob 的个人任务',sourceMessageId:'bob-direct'}).events[0]!;
  const group=f.store.createGroup({title:'独立群',memberIds:['alice','bob','carol']}),groupEvent=f.store.enqueue({conversationId:group.id,senderId:'user',content:'另一群的讨论',sourceMessageId:'other-group',recipientIds:['alice']}).events[0]!;
  expect(f.runtime.scoped(f.source,f.ticket.id).id).toBe(f.ticket.id);expect(f.runtime.scoped(f.peer,f.ticket.id).id).toBe(f.ticket.id);
  for(const event of [direct,groupEvent]){expect(()=>f.runtime.scoped(event,f.ticket.id)).toThrow('不属于');expect(f.runtime.status(event).tickets).toEqual([]);expect(()=>f.runtime.bindEvent(f.ticket.id,event.id)).toThrow('不属于');}
});

it('returns only target-owner peer-domain child tasks while preserving ordinary peer, direct and group work',()=>{
  const f=fixture(),included=f.worker('included');f.store.createTask({id:'ordinary-peer',conversationId:f.peer.conversationId,companionId:'bob',sourceEventId:f.peer.id,goal:'独立聊天任务。'});
  const directRoom=f.store.openDirect('bob'),direct=f.store.enqueue({conversationId:directRoom.id,senderId:'user',content:'独立工作',sourceMessageId:'bob-direct'}).events[0]!,outside=f.worker('outside-direct',direct);
  const group=f.store.createGroup({title:'独立群',memberIds:['bob','carol']}),groupEvent=f.store.enqueue({conversationId:group.id,senderId:'user',content:'群工作',sourceMessageId:'bob-group',recipientIds:['bob']}).events[0]!,groupTask=f.worker('outside-group',groupEvent);
  expect(f.runtime.tasks(f.ticket.id).map(task=>task.id)).toEqual([included.id]);
  expect(f.runtime.forEvent(f.notice(outside,direct))).toBeUndefined();expect(f.runtime.forEvent(f.notice(groupTask,groupEvent))).toBeUndefined();
  f.store.updateTask(f.proxy.id,{extra:{...f.proxy.extra,delegationId:f.ticket.id}});
  expect(f.runtime.forEvent(f.notice(f.store.getTask(f.proxy.id)!,f.source))).toBeUndefined();
});

it('revalidates the source withdrawal and original room ACL instead of trusting a cached active ticket',()=>{
  const f=fixture();f.store.withdrawSources('alice',f.source.securityDomainId,[f.source.id]);
  expect(()=>f.runtime.assertActive(f.ticket)).toThrow();expect(f.runtime.allowsWork(f.peer)).toBe(false);expect(()=>f.runtime.create(f.source,'create',f.input)).toThrow();
  const current=f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'查看已撤回的委派状态',sourceMessageId:'new-user'}).events[0]!;
  expect(f.runtime.status(current,f.ticket.id).tickets[0]).toMatchObject({title:'',goal:'',available:false,allowsWork:false,tasks:[]});
  const group=f.store.createGroup({title:'原群',memberIds:['alice','carol']}),source=f.store.enqueue({conversationId:group.id,senderId:'user',content:'委派 Bob 核验。',sourceMessageId:'group-source',recipientIds:['alice']}).events[0]!;
  const contact=f.store.contactPeer(source,'bob','group-contact','请核验用户明确给出的任务。','peer');if(!contact.accepted)throw Error('Expected contact');
  const proxy=f.store.createTask({id:'group-proxy',conversationId:group.id,companionId:'alice',sourceEventId:source.id,goal:'群内授权任务。'});
  const ticket=f.runtime.create(source,'group-create',{recipientId:'bob',peerConversationId:contact.conversationId,contactEventId:contact.events[0]!.id,proxyTaskId:proxy.id,goal:proxy.goal,title:'群委派'});
  f.store.updateMembers(group.id,['alice','dave']);expect(()=>f.runtime.assertActive(ticket)).toThrow('权限');expect(f.runtime.allowsWork(contact.events[0]!)).toBe(false);
});

it.each(['paused','cancelled','succeeded','failed'] as const)('blocks new work while the real proxy is %s and permits no automatic reopening',status=>{
  const f=fixture();f.store.updateTask(f.proxy.id,{status});expect(()=>f.runtime.assertActive(f.ticket)).toThrow();expect(f.runtime.allowsWork(f.peer)).toBe(false);
  if(status==='paused'){f.store.updateTask(f.proxy.id,{status:'running'});expect(f.runtime.allowsWork(f.peer)).toBe(true);}
});

it('does not trust a forged ticket, a removed proxy or a stopped ticket after a delayed successful callback',()=>{
  const f=fixture();expect(()=>f.runtime.assertActive({...f.ticket,recipientId:'carol'})).toThrow();
  f.store.updateTask(f.proxy.id,{extra:{...f.proxy.extra,removedAt:new Date().toISOString()}});expect(f.runtime.allowsWork(f.peer)).toBe(false);
  const ended=f.runtime.finish(f.ticket.id,'cancelled');expect(ended.state).toBe('cancelled');expect(f.runtime.finish(f.ticket.id,'cancelled')).toEqual(ended);
  expect(f.runtime.create(f.source,'create',f.input).state).toBe('cancelled');expect(()=>f.runtime.finish(f.ticket.id,'completed')).toThrow('不能自动重开');
  expect(()=>f.runtime.bindEvent(f.ticket.id,f.peer.id)).toThrow();expect(()=>f.runtime.recordResult(f.ticket.id,'late',{content:'迟到的完成结果'})).toThrow();
});

it('closes only the originating owner and chat tickets, returning actual recipient task IDs for Main to stop',()=>{
  const f=fixture(),child=f.worker('recipient-child'),otherRoom=f.store.openDirect('carol'),other=f.store.enqueue({conversationId:otherRoom.id,senderId:'user',content:'另一位主脑的委派',sourceMessageId:'carol-root'}).events[0]!;
  const contact=f.store.contactPeer(other,'bob','carol-contact','另一份明确委派','peer');if(!contact.accepted)throw Error('Expected contact');
  const proxy=f.store.createTask({id:'carol-proxy',conversationId:otherRoom.id,companionId:'carol',sourceEventId:other.id,goal:'另一位主脑的任务'}),ticket=f.runtime.create(other,'carol-create',
    {recipientId:'bob',peerConversationId:contact.conversationId,contactEventId:contact.events[0]!.id,proxyTaskId:proxy.id,goal:proxy.goal,title:'另一份工作'});
  const protectedTask=f.worker('protected-child',contact.events[0]!,ticket.id),result=f.runtime.cancelScope(f.source);
  expect(result.taskIds).toEqual([child.id]);expect(result.tickets.map(item=>item.id)).toEqual([f.ticket.id]);expect(f.runtime.get(ticket.id)?.state).toBe('active');
  expect(f.store.getTask(child.id)?.status).toBe('queued');expect(f.store.getTask(protectedTask.id)?.status).toBe('queued');expect(f.runtime.allowsWork(f.peer)).toBe(false);
  expect(f.runtime.cancelScope(f.room.id,'alice')).toEqual({tickets:[],taskIds:[]});
});

it('stores an idempotent result receipt for real delivery and rejects altered content or attachments on retries',()=>{
  const f=fixture(),message=f.store.enqueue({conversationId:f.room.id,senderId:'alice',source:'companion',recipientIds:[],content:'两份原件已核验，总额为 207.00。',sourceMessageId:'real-result'}).message;
  const input={content:message.content,attachmentIds:[],messageId:message.id},receipt=f.runtime.recordResult(f.ticket.id,'submit',input);
  expect(f.runtime.recordResult(f.ticket.id,'submit',input)).toEqual(receipt);expect(new BotDelegationRuntime(f.store).resultReceipt(f.ticket.id,'submit',input)).toEqual(receipt);
  expect(()=>f.runtime.recordResult(f.ticket.id,'submit',{...input,content:'另外一个结果'})).toThrow('回执参数');
  expect(()=>f.runtime.recordResult(f.ticket.id,'submit',{...input,attachmentIds:['other-file']})).toThrow('回执参数');
  expect(()=>f.runtime.recordResult(f.ticket.id,'fabricated',{content:'不真实消息',messageId:'nonexistent-message'})).toThrow('真实原聊天');
  f.runtime.finish(f.ticket.id,'completed');expect(f.runtime.recordResult(f.ticket.id,'submit',input)).toEqual(receipt);
  expect(()=>f.runtime.recordResult(f.ticket.id,'new-submit',{content:'自动再次发送'})).toThrow('不能自动重开');
});

it('limits read-only directory pages and status projections without returning unrelated history or Worker prompts',()=>{
  const f=fixture(),worker=f.worker('private-prompt');f.store.updateTask(worker.id,{extra:{...worker.extra,prompt:'秘密内部Worker提示',progress:{phase:'running',detail:'已核验原件'}}});
  for(let index=0;index<11;index++){
    const contact=f.store.contactPeer(f.source,'bob','contact-'+index,'仅处理第 '+index+' 份明确工作。','peer');if(!contact.accepted)throw Error('Expected contact');
    const proxy=f.store.createTask({id:'proxy-'+index,conversationId:f.room.id,companionId:'alice',sourceEventId:f.source.id,goal:'相关目标 '+index});
    f.runtime.create(f.source,'create-'+index,{recipientId:'bob',peerConversationId:contact.conversationId,contactEventId:contact.events[0]!.id,proxyTaskId:proxy.id,goal:proxy.goal,title:'任务 '+index});
  }
  const first=f.runtime.status(f.source,undefined,{limit:100});expect(first.tickets).toHaveLength(10);expect(first.nextOffset).toBe(10);
  const rest=f.runtime.status(f.source,undefined,{offset:first.nextOffset});expect(rest.tickets).toHaveLength(2);expect(rest.nextOffset).toBeUndefined();
  const status=f.runtime.status(f.source,f.ticket.id);expect(JSON.stringify(status)).not.toContain('秘密内部Worker提示');expect(JSON.stringify(status)).not.toContain('请让 Bob 分析两份原始资料');
  expect(status.tickets[0]!.tasks[0]).toMatchObject({id:'private-prompt',status:'queued',progress:{phase:'running',detail:'已核验原件'}});
});

it('preserves selected attachment grants through a real peer delivery and propagates withdrawal of an older source file',()=>{
  const f=fixture(),original:BotMediaRef={id:'original-analysis',name:'原始账单.csv',mimeType:'text/csv',size:12,sha256:'a'.repeat(64),kind:'file',url:'worldlinebox://fixture/original'};
  const uploaded=f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'这是后续任务需要的原件。',sourceMessageId:'older-file-source',attachments:[original]}).events[0]!;
  const source=f.store.enqueue({conversationId:f.room.id,senderId:'user',content:'请把刚才的账单交给 Bob 核验。',sourceMessageId:'file-delegation'}).events[0]!;
  const grant=f.store.modelAttachmentGrants(source,{ids:[original.id]})[0]!,sourceIds=f.store.attachmentGrantSourceIds([grant.grantId,grant.grantId]);
  expect(sourceIds).toContain(uploaded.id);expect(sourceIds).toContain(uploaded.sourceMessageRecordId);expect(new Set(sourceIds).size).toBe(sourceIds.length);
  expect(f.store.attachmentGrantSourceIds(['unknown-grant'])).toEqual([]);
  const transferred={...original,id:'transferred-analysis',url:'worldlinebox://fixture/peer'};
  const contact=f.store.contactPeer(source,'bob','files','请核验这份真实原件。','peer',{attachments:[transferred],sourceIds});if(!contact.accepted)throw Error('Expected actual attachment contact');
  const event=contact.events[0]!;expect(event.content).toContain(transferred.id);expect(contact.message.content).toBe('请核验这份真实原件。');
  expect(f.store.modelAttachments(event,{ids:[transferred.id]})).toEqual([transferred]);
  const proxy=f.store.createTask({id:'file-proxy',conversationId:f.room.id,companionId:'alice',sourceEventId:source.id,goal:'核验明确选择的原始账单。'});
  const ticket=f.runtime.create(source,'files',{recipientId:'bob',peerConversationId:contact.conversationId,contactEventId:event.id,proxyTaskId:proxy.id,goal:proxy.goal,title:'账单核验'});
  expect(f.runtime.allowsWork(event)).toBe(true);expect(new BotCompanionRuntime(f.store).workAuthority(event)?.id).toBe(source.id);
  expect(f.store.contactPeer(source,'bob','files','请核验这份真实原件。','peer',{attachments:[transferred],sourceIds:[...sourceIds].reverse()})).toMatchObject({accepted:true,events:[],message:{id:contact.message.id}});
  expect(()=>f.store.contactPeer(source,'bob','files','请核验这份真实原件。','peer',{attachments:[{...transferred,name:'其他文件.csv'}],sourceIds})).toThrow('不同附件');
  expect(()=>f.store.contactPeer(source,'bob','files','请核验这份真实原件。','peer',{attachments:[transferred],sourceIds:[...sourceIds,'another-source']})).toThrow('不同附件');
  f.store.withdrawSources('alice',source.securityDomainId,[uploaded.id]);
  expect(f.store.peerWithdrawalTargets('alice',source.securityDomainId)).toContainEqual({conversationId:contact.conversationId,messageId:contact.message.id});
  // Main consumes the durable cross-domain outbox and applies its destination
  // withdrawal; this data module must not mutate another audience implicitly.
  f.store.withdrawSources('bob',event.securityDomainId,[contact.message.id]);
  expect(f.runtime.allowsWork(event)).toBe(false);expect(()=>f.runtime.assertActive(ticket)).toThrow();expect(f.store.modelAttachments(event,{ids:[transferred.id]})).toEqual([]);
});

it('retains old text-only contact receipts while refusing to add attachments to a previously committed call',()=>{
  const f=fixture(),receiptKey=`peer-contact-receipt:${f.source.id}:contact`,receipt=JSON.parse(f.store.getMetadata(receiptKey)!);delete receipt.transferFingerprint;f.store.setMetadata(receiptKey,JSON.stringify(receipt));
  expect(f.store.contactPeer(f.source,'bob','contact',f.peer.content,'peer')).toMatchObject({accepted:true,events:[]});
  const file:BotMediaRef={id:'new-file',name:'new.txt',mimeType:'text/plain',size:1,sha256:'a'.repeat(64),kind:'file',url:'worldlinebox://fixture/new'};
  expect(()=>f.store.contactPeer(f.source,'bob','contact',f.peer.content,'peer',{attachments:[file],sourceIds:[f.source.id]})).toThrow('不同附件');
});

it('publishes transferred output only from an active exact proxy binding without fabricating a native Worker execution',()=>{
  const f=fixture(),file:BotMediaRef={id:'final-report',name:'核验结果.txt',mimeType:'text/plain',size:12,sha256:'a'.repeat(64),kind:'file',url:'worldlinebox://fixture/report'};
  f.store.updateTask(f.proxy.id,{status:'running',extra:{...f.proxy.extra,delegationProxy:true,delegationId:f.ticket.id}});
  const published=f.store.publishForTask(f.proxy.id,'result-once',{content:'核验完成。',attachments:[file],sourceIds:[f.peer.id]});
  expect(published).toMatchObject({conversationId:f.room.id,senderId:'alice',content:'核验完成。',attachments:[file]});expect(f.store.getTask(f.proxy.id)?.extra.nativeAttempted).toBeUndefined();
  expect(f.store.publishForTask(f.proxy.id,'result-once',{content:'核验完成。',attachments:[file],sourceIds:[f.peer.id]}).id).toBe(published.id);
  f.runtime.recordResult(f.ticket.id,'submit',{content:published.content,attachmentIds:[file.id],messageId:published.id});f.runtime.finish(f.ticket.id,'cancelled');
  expect(()=>f.store.publishForTask(f.proxy.id,'late',{attachments:[file]})).toThrow('有效');
});

it('refuses an unbound proxy flag, wrong ticket identity, a withdrawn source and the no-delegation-table fixture',()=>{
  const f=fixture(),file:BotMediaRef={id:'report',name:'report.txt',mimeType:'text/plain',size:1,sha256:'a'.repeat(64),kind:'file',url:'worldlinebox://fixture/report'};
  const unbound=f.store.createTask({id:'unbound-proxy',conversationId:f.room.id,companionId:'alice',sourceEventId:f.source.id,goal:'未绑定任务',extra:{delegationProxy:true}});f.store.updateTask(unbound.id,{status:'running'});
  expect(()=>f.store.publishForTask(unbound.id,'no-ticket',{attachments:[file]})).toThrow('有效');
  f.store.updateTask(f.proxy.id,{status:'running',extra:{...f.proxy.extra,delegationProxy:true,delegationId:'wrong-ticket'}});expect(()=>f.store.publishForTask(f.proxy.id,'wrong',{attachments:[file]})).toThrow('有效');
  f.store.updateTask(f.proxy.id,{extra:{...f.proxy.extra,delegationProxy:true,delegationId:f.ticket.id}});f.store.withdrawSources('alice',f.source.securityDomainId,[f.source.id]);
  expect(()=>f.store.publishForTask(f.proxy.id,'withdrawn',{attachments:[file]})).toThrow('有效');
  const plain=new BotStore(':memory:');stores.push(plain);plain.createCompanion({id:'worker-owner',name:'Worker',persona:'普通执行器'});const room=plain.openDirect('worker-owner'),event=plain.enqueue({conversationId:room.id,senderId:'user',content:'普通任务',sourceMessageId:'plain'}).events[0]!;
  const native=plain.createTask({id:'native',conversationId:room.id,companionId:event.companionId,sourceEventId:event.id,goal:'真实已收编执行器',extra:{nativeAttempted:true}});plain.updateTask(native.id,{status:'running'});
  expect(plain.publishForTask(native.id,'native-result',{attachments:[file]}).attachments).toEqual([file]);
  const forged=plain.createTask({id:'fake',conversationId:room.id,companionId:event.companionId,sourceEventId:event.id,goal:'只有标签',extra:{delegationProxy:true}});plain.updateTask(forged.id,{status:'running'});
  expect(()=>plain.publishForTask(forged.id,'forged-result',{attachments:[file]})).toThrow('有效');
});
