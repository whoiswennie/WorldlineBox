import { afterEach, expect, it, vi } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTopics } from '../../src/main/companion-bot/topics';
import { buildNativeBotContext } from '../../src/main/companion-bot/context';
import { nativeServiceFixture, nativeCallback, waitNative } from '../fixtures/bot-native-service';
import type { BotEvent } from '../../src/main/companion-bot/types';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const closes: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
function fixture(){const store=new BotStore(':memory:');closes.push(async()=>store.close());
  for(const [id,name] of [['gpt','GPT'],['fish','大肥鱼'],['claude','Claude'],['gemini','Gemini']])store.createCompanion({id:id!,name:name!,persona:name!});
  const direct=store.openDirect('gpt'), source=store.enqueue({conversationId:direct.id,senderId:'user',content:'帮我了解大家的近况',source:'user'}).events[0]!;
  return{store,direct,source};}
function finish(store:BotStore,event:BotEvent,content:string,status:'done'|'failed'='done'){
  const claim=store.claim({workerId:'test',excludeLaneIds:store.taskTransaction(sql=>sql.prepare("SELECT DISTINCT lane_id FROM bot_inbox WHERE id<>? AND status IN ('queued','running')").all(event.id)).map(row=>(row as {lane_id:string}).lane_id)})!;
  expect(claim?.event.id).toBe(event.id);expect(store.settle({eventId:event.id,leaseToken:claim.leaseToken,status,content,error:status==='failed'?'实际失败':undefined})).toBe(true);
}
const returned=(store:BotStore)=>store.taskTransaction(sql=>sql.prepare("SELECT id FROM bot_inbox WHERE source_instance_id='peer-return-v1' ORDER BY sequence").all()).map(row=>store.getEvent((row as {id:string}).id)!);
function pendingReply() {
  let resolve!: (text: string) => void;
  const promise = new Promise<string>(finish => { resolve = finish; });
  return { promise, resolve };
}

it('returns exactly once to the original topic after a switch, without impersonating a room member or starting a peer reply loop',()=>{
  const {store,direct,source}=fixture(),topics=new BotTopics(store),original=topics.create(direct.id,'original');topics.bind([source],original);
  const contact=store.contactPeer(source,'fish','ask','你最近在忙什么？','peer');if(!contact.accepted)throw Error(contact.reason);
  topics.create(direct.id,'different','另一个完全无关的话题');
  finish(store,source,'我去问问。');finish(store,contact.events[0]!,'GPT，我在整理书架。');
  expect(store.observeGroupReply(contact.events[0]!.id)).toEqual([]);
  const [result]=returned(store);expect(result).toMatchObject({companionId:'gpt',conversationId:direct.id,senderId:'fish',senderName:'大肥鱼',causationId:source.id});
  topics.started(result!);expect(topics.reference(result!.id)?.id).toBe(original.id);expect(topics.current(direct.id)?.id).not.toBe(original.id);
  expect(store.getConversation(direct.id)!.memberIds).toEqual(['gpt','user']);expect(store.messagesPage(direct.id).items.some(m=>m.senderId==='fish')).toBe(false);
  store.peerReturns.settled(store.getEvent(contact.events[0]!.id)!);expect(returned(store)).toHaveLength(1);
  finish(store,result!,'大肥鱼说她正在整理书架。');expect(store.observeGroupReply(result!.id)).toEqual([]);
});
it('joins three workers once, including a failure, even when workers finish before the coordinator acknowledgement',()=>{
  const {store,source}=fixture();const events=['fish','claude','gemini'].map(id=>{const sent=store.contactPeer(source,id,id,'请报告你自己的近况');if(!sent.accepted)throw Error(sent.reason);return sent.events[0]!;});
  finish(store,events[0]!,'我在整理书架');finish(store,events[1]!,'我在画画');finish(store,events[2]!,'','failed');expect(returned(store)).toEqual([]);
  finish(store,source,'已联系三位伙伴');const results=returned(store);expect(results).toHaveLength(1);
  const payload=results[0]!.payload.peerReturn as {results:Array<{companionId:string;status:string;error?:string}>};
  expect(payload.results.map(r=>r.companionId).sort()).toEqual(['claude','fish','gemini']);expect(payload.results.find(r=>r.companionId==='gemini')).toMatchObject({status:'failed',error:'实际失败'});
});
it('does not duplicate delivery when the original native turn has already read the actual worker reply and answered',()=>{
  const {store,source}=fixture(),sent=store.contactPeer(source,'fish','inline','请说近况');if(!sent.accepted)throw Error(sent.reason);
  finish(store,sent.events[0]!,'GPT，我在整理书架。');
  store.taskTransaction(sql=>sql.prepare('INSERT INTO bot_peer_bridges VALUES(?,?,?,?,?)').run(source.companionId,sent.events[0]!.securityDomainId,sent.events[0]!.replyMessageId,source.conversationId,source.replyMessageId));
  finish(store,source,'大肥鱼说她在整理书架。');expect(returned(store)).toHaveLength(0);
});
it('falls back to the original topic if a ready response is lost before the native turn confirms it', () => {
  const { store, source } = fixture();
  const sent = store.contactPeer(source, 'fish', 'drop-inline-response', '请说近况');
  if (!sent.accepted) throw Error(sent.reason);
  finish(store, sent.events[0]!, '在整理书架');
  const batch = store.peerReturns.inlineResults(source);
  expect(batch).toMatchObject({ status: 'ready', results: [{ content: '在整理书架' }] });
  // The callback did not reach the model. A progress acknowledgement cannot
  // be used as evidence that the batch was incorporated into its reply.
  finish(store, source, '我已联系伙伴');
  expect(returned(store)).toHaveLength(1);
  expect(returned(store)[0]!.content).toContain('在整理书架');
});
it('wakes a running coordinator as soon as both contacted peers settle', async () => {
  const first = pendingReply(), second = pendingReply();
  const started = new Set<string>();
  let finishedWaiting = false;
  const f = await nativeServiceFixture(async input => {
    const { identity, delivery } = JSON.parse(input.prompt);
    if (identity.id !== 'wait-owner') {
      started.add(identity.id);
      return identity.id === 'wait-first' ? first.promise : second.promise;
    }
    expect(delivery.kind).toBe('user-request');
    for (const id of ['wait-first', 'wait-second']) {
      const contact = await nativeCallback(input, 'companion_contact', { companionId: id, destination: 'peer', message: '请回复资料' }, id);
      expect(contact.ok, contact.error).toBe(true);
    }
    await waitNative(() => started.size === 2);
    const reply = await nativeCallback(input, 'companion_wait', { timeout_ms: 120000 });
    finishedWaiting = true;
    expect(reply.ok, reply.error).toBe(true);
    expect(reply.result).toMatchObject({ status: 'ready', results: expect.arrayContaining([
      expect.objectContaining({ companionId: 'wait-first', status: 'done', contentIsExcerpt: true }),
      expect.objectContaining({ companionId: 'wait-second', status: 'done', content: '第二份资料' }),
    ]) });
    const items = reply.result!.results as Array<{ companionId: string; messageId: string }>;
    const read = await nativeCallback(input, 'chat_read_message', { messageId: items.find(item => item.companionId === 'wait-first')!.messageId, offset: 18000 });
    expect(read.result?.text).toBe('第一份资料结尾');
    return { text: '已汇总两份资料', peerResultsReceipt: String(reply.result!.receipt) };
  });
  closes.push(async () => { first.resolve(''); second.resolve(''); await f.close(); });
  const readBatch = vi.spyOn(f.service.store.peerReturns, 'inlineResults');
  for (const id of ['wait-owner', 'wait-first', 'wait-second']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('wait-owner');
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: '汇总两份资料', requestId: 'wait-for-peers' });
  await waitNative(() => readBatch.mock.results.some(result => result.value?.status === 'pending' && result.value.pending === 2));
  first.resolve('正式资料'.repeat(4500) + '第一份资料结尾');
  await waitNative(() => readBatch.mock.results.some(result => result.value?.status === 'pending' && result.value.pending === 1));
  expect(finishedWaiting).toBe(false);
  second.resolve('第二份资料');
  await waitNative(() => f.service.store.messagesPage(direct.id).items.some(message => message.content === '已汇总两份资料' && message.status === 'sent'));
  expect(f.calls).toHaveLength(3);
  expect(returned(f.service.store)).toEqual([]);
});
it('keeps waiting when the next task for the same peer starts as soon as the previous task settles', async () => {
  const first = pendingReply(), second = pendingReply();
  let started = 0;
  const f = await nativeServiceFixture(async input => {
    const { identity, delivery } = JSON.parse(input.prompt);
    if (identity.id === 'serial-worker') return (++started === 1 ? first : second).promise;
    expect(delivery.kind).toBe('user-request');
    for (const topic of ['第一件事', '第二件事']) {
      const contact = await nativeCallback(input, 'companion_contact', { companionId: 'serial-worker', destination: 'peer', message: topic }, topic);
      expect(contact.ok, contact.error).toBe(true);
    }
    await waitNative(() => started === 1);
    const batch = await nativeCallback(input, 'companion_wait', { timeout_ms: 120000 });
    expect(batch.result).toMatchObject({ status: 'ready', results: expect.arrayContaining([
      expect.objectContaining({ content: '第一份回信' }), expect.objectContaining({ content: '第二份回信' }),
    ]) });
    return { text: '两项任务都已交付', peerResultsReceipt: String(batch.result!.receipt) };
  });
  closes.push(async () => { first.resolve(''); second.resolve(''); await f.close(); });
  const batches = vi.spyOn(f.service.store.peerReturns, 'inlineResults');
  for (const id of ['serial-owner', 'serial-worker']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('serial-owner');
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: '让伙伴做两件事', requestId: 'serial-peer-tasks' });
  await waitNative(() => batches.mock.results.some(entry => entry.value?.status === 'pending' && entry.value.pending === 2));
  first.resolve('第一份回信');
  await waitNative(() => started === 2 && batches.mock.results.some(entry =>
    entry.value?.status === 'pending' && entry.value.pending === 1 && entry.value.running));
  second.resolve('第二份回信');
  await waitNative(() => f.service.store.messagesPage(direct.id).items.some(message => message.status === 'sent' && message.content === '两项任务都已交付'));
  expect(returned(f.service.store)).toEqual([]);
});
it('delivers deferred results to the original topic after the coordinator yields', async () => {
  const worker = pendingReply();
  const f = await nativeServiceFixture(async input => {
    const { identity, delivery } = JSON.parse(input.prompt);
    if (identity.id === 'deferred-worker') return worker.promise;
    if (delivery.kind === 'peer-results') {
      expect(delivery.peerReturn.results).toMatchObject([{ content: '稍后交付的资料' }]);
      return '已汇总稍后交付的资料';
    }
    const contact = await nativeCallback(input, 'companion_contact', { companionId: 'deferred-worker', destination: 'peer', message: '请回复资料' });
    expect(contact.ok, contact.error).toBe(true);
    const waiting = await nativeCallback(input, 'companion_wait', { timeout_ms: 0 });
    expect(waiting.result).toMatchObject({ status: 'deferred', pending: 1, timedOut: true });
    return '已联系伙伴';
  });
  closes.push(async () => { worker.resolve(''); await f.close(); });
  for (const id of ['deferred-owner', 'deferred-worker']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('deferred-owner');
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: '汇总伙伴资料', requestId: 'defer-peer-results' });
  const published = (content: string) => f.service.store.messagesPage(direct.id).items.some(message => message.content === content && message.status === 'sent');
  await waitNative(() => published('已联系伙伴'));
  worker.resolve('稍后交付的资料');
  await waitNative(() => published('已汇总稍后交付的资料'));
  expect(returned(f.service.store)).toHaveLength(1);
});
it('unblocks an in-flight wait when the worker executor is stopped', async () => {
  const worker = pendingReply();
  let workerLane: string | undefined;
  const f = await nativeServiceFixture(async input => {
    const { identity, delivery } = JSON.parse(input.prompt);
    if (identity.id === 'cancel-wait-worker') { workerLane = input.laneId; return worker.promise; }
    expect(delivery.kind).toBe('user-request');
    const contact = await nativeCallback(input, 'companion_contact', { companionId: 'cancel-wait-worker', destination: 'peer', message: '请回复资料' });
    expect(contact.ok, contact.error).toBe(true);
    const batch = await nativeCallback(input, 'companion_wait', { timeout_ms: 120000 });
    expect(batch.result).toMatchObject({ status: 'ready', results: [{ status: 'cancelled' }] });
    return { text: '伙伴的任务已取消', peerResultsReceipt: String(batch.result!.receipt) };
  });
  closes.push(async () => { worker.resolve(''); await f.close(); });
  const batches = vi.spyOn(f.service.store.peerReturns, 'inlineResults');
  for (const id of ['cancel-wait-owner', 'cancel-wait-worker']) f.service.store.createCompanion({ id, name: id, persona: id });
  const direct = f.service.store.openDirect('cancel-wait-owner');
  await f.service.handle({ type: 'message.send', conversationId: direct.id, content: '问一下伙伴', requestId: 'cancel-wait' });
  await waitNative(() => !!workerLane && batches.mock.results.some(entry => entry.value?.status === 'pending'));
  f.service.store.setMetadata('native-host:' + workerLane, 'stopped-executor');
  f.service.workerInstanceStopped('stopped-executor');
  await waitNative(() => f.service.store.messagesPage(direct.id).items.some(message => message.status === 'sent' && message.content === '伙伴的任务已取消'));
  expect(returned(f.service.store)).toEqual([]);
});
it('allows only exact returned publications to be read across the return boundary, not the worker private room',async()=>{
  let privateMessageId='';const f=await nativeServiceFixture(async input=>{const body=JSON.parse(input.prompt);
    if(body.delivery.kind==='peer-results'){
      const actual=body.delivery.peerReturn.results[0];expect(actual.contentIsExcerpt).toBe(true);
      const read=await nativeCallback(input,'chat_read_message',{messageId:actual.messageId,offset:18000,limit:1200});expect(read.ok,read.error).toBe(true);expect(read.result!.text).toContain('正文结尾');
      const denied=await nativeCallback(input,'chat_read_message',{messageId:privateMessageId},'private');expect(denied.ok).toBe(false);return '已核实长回信';
    }
    if(body.identity.id==='return-reader-owner'){const sent=await nativeCallback(input,'companion_contact',{companionId:'return-reader-worker',destination:'peer',message:'请回复完整资料'});expect(sent.ok,sent.error).toBe(true);return '我去问';}
    return '正式资料'.repeat(4500)+'正文结尾';
  });closes.push(f.close);
  for(const id of ['return-reader-owner','return-reader-worker'])f.service.store.createCompanion({id,name:id,persona:id});
  const workerPrivate=f.service.store.openDirect('return-reader-worker');privateMessageId=f.service.store.enqueue({conversationId:workerPrivate.id,senderId:'user',content:'不能泄露的私聊',recipientIds:[]}).message.id;
  const direct=f.service.store.openDirect('return-reader-owner');await f.service.handle({type:'message.send',conversationId:direct.id,content:'问一下资料',requestId:'read-return'});
  await waitNative(()=>f.service.store.messagesPage(direct.id).items.some(m=>m.content==='已核实长回信'&&m.status==='sent'));
});
it('waits for a nested worker and lets the delegate author its own result before returning to the original coordinator',()=>{
  const {store,source}=fixture(),first=store.contactPeer(source,'fish','first','请问Claude今天忙什么');if(!first.accepted)throw Error(first.reason);
  finish(store,source,'我去问');const fish=first.events[0]!,second=store.contactPeer(fish,'claude','nested','Claude，你今天忙什么');if(!second.accepted)throw Error(second.reason);
  finish(store,fish,'我去问Claude');expect(returned(store)).toEqual([]);finish(store,second.events[0]!,'我在画画');
  const fishReturn=returned(store)[0]!;expect(fishReturn.companionId).toBe('fish');expect(returned(store)).toHaveLength(1);
  finish(store,fishReturn,'GPT，Claude说她今天在画画。');const gptReturn=returned(store)[1]!;expect(gptReturn.companionId).toBe('gpt');expect(gptReturn.content).toContain('Claude说她今天在画画');
});
it('reports a failed delegate without waiting forever for its still-running nested worker',()=>{
  const {store,source}=fixture(),first=store.contactPeer(source,'fish','first','请协作');if(!first.accepted)throw Error(first.reason);
  finish(store,source,'我去问');const second=store.contactPeer(first.events[0]!,'claude','nested','请帮忙');if(!second.accepted)throw Error(second.reason);
  finish(store,first.events[0]!,'','failed');expect(returned(store)).toHaveLength(1);expect(returned(store)[0]!.content).toContain('实际失败');
  finish(store,second.events[0]!,'后续结果');expect(returned(store)).toHaveLength(1);
});
it('keeps the return address and exactly one queued continuation across store restarts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'wlb-peer-return-restart-'));let store=new BotStore(path.join(root,'bot.sqlite'));
  closes.push(async()=>{store.close();if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('wlb-peer-return-restart-'))throw Error('Invalid owned return profile');await rm(root,{recursive:true,force:true});});
  for(const id of ['owner','worker'])store.createCompanion({id,name:id,persona:id});
  const room=store.openDirect('owner'),source=store.enqueue({conversationId:room.id,senderId:'user',content:'请问worker'}).events[0]!,sent=store.contactPeer(source,'worker','restart','近况如何');if(!sent.accepted)throw Error(sent.reason);
  finish(store,source,'我去问');store.close();store=new BotStore(path.join(root,'bot.sqlite'));finish(store,sent.events[0]!,'正在整理资料');
  store.close();store=new BotStore(path.join(root,'bot.sqlite'));const events=returned(store);expect(events).toHaveLength(1);store.peerReturns.settled(store.getEvent(sent.events[0]!.id)!);expect(returned(store)).toHaveLength(1);finish(store,events[0]!,'worker说她正在整理资料');
});
it('does not revive a withdrawn original topic, and reports an explicitly cancelled worker to its coordinator',()=>{
  const {store,source}=fixture(),sent=store.contactPeer(source,'fish','cancel','请回答');if(!sent.accepted)throw Error(sent.reason);
  finish(store,source,'已联系');store.cancelEvent(sent.events[0]!.id);expect(returned(store)[0]!.content).toContain('cancelled');finish(store,returned(store)[0]!,'对方已取消');
  const other=store.enqueue({conversationId:source.conversationId,senderId:'user',content:'另一个请求'}).events[0]!,contact=store.contactPeer(other,'fish','withdraw','不能回传旧授权');if(!contact.accepted)throw Error(contact.reason);
  finish(store,other,'已联系');store.withdrawSources('gpt',source.securityDomainId,[other.id]);finish(store,contact.events[0]!,'撤回后的结果');expect(returned(store)).toHaveLength(1);
});
it('injects stable self, actual speaker, typed group audience and delegation origin without treating the UI label 我 as a name',()=>{
  const {store,source}=fixture(),sent=store.contactPeer(source,'fish','identity','告诉我近况');if(!sent.accepted)throw Error(sent.reason);
  const event=sent.events[0]!,room=store.getConversation(event.conversationId)!,companions=store.listCompanions();
  const context=buildNativeBotContext({companion:store.getCompanion('fish')!,event,conversation:room,companions,memories:'',files:[]}),body=JSON.parse(context.prompt);
  expect(body.delivery).toMatchObject({kind:'peer-request',self:{id:'fish',name:'大肥鱼'},speaker:{id:'gpt',name:'GPT'},responsibility:'delegate',audience:{userParticipates:false,userRole:'observer',recipients:[{id:'gpt',name:'GPT'}]},assignment:{requester:{id:'gpt'},originalSender:{id:'user',name:'用户',type:'user'}}});
  expect(context.system).toContain('不要称用户为“本人”');expect(context.system).toContain('第一人称“我”只指你');
  const group=store.createGroup({title:'四位伙伴一起聊',memberIds:['gpt','fish','claude','gemini'],participationMode:'all'});
  const groupEvent=store.enqueue({conversationId:group.id,senderId:'claude',source:'companion',content:'我是Claude，GPT请告诉大肥鱼',recipientIds:['gpt']}).events[0]!;
  const groupBody=JSON.parse(buildNativeBotContext({companion:store.getCompanion('gpt')!,event:groupEvent,conversation:group,companions,memories:'',files:[]}).prompt);
  expect(groupBody.delivery.self).toMatchObject({id:'gpt',name:'GPT'});expect(groupBody.delivery.speaker).toMatchObject({id:'claude',name:'Claude'});expect(groupBody.delivery.audience.recipients.map((p:{id:string})=>p.id).sort()).toEqual(['claude','fish','gemini','user']);
});
it('runs user → GPT → three group workers → GPT final delivery through authenticated callbacks with no duplicate observer conversation',async()=>{
  let groupId='';const f=await nativeServiceFixture(async input=>{const body=JSON.parse(input.prompt),self=body.identity.id;
    if(body.delivery.kind==='peer-results'){expect(self).toBe('gpt');expect(body.delivery.peerReturn.results).toHaveLength(3);return '用户，我问过了：大肥鱼整理书架，Claude画画，Gemini写歌。';}
    if(self==='gpt'){for(const id of ['fish','claude','gemini']){const receipt=await nativeCallback(input,'message_peer',{companionId:id,content:`${id}，请说说你自己的近况`},'ask-'+id);expect(receipt.ok,receipt.error).toBe(true);}return '我去问大家。';}
    expect(body.delivery.kind).toBe('peer-request');expect(body.delivery.speaker.id).toBe('gpt');expect(body.delivery.assignment.requester.id).toBe('gpt');return self==='fish'?'GPT，我在整理书架。':self==='claude'?'GPT，我在画画。':'GPT，我在写歌。';
  });closes.push(f.close);
  for(const id of ['gpt','fish','claude','gemini'])if(!f.service.store.getCompanion(id))f.service.store.createCompanion({id,name:id,persona:'你是'+id});
  groupId=f.service.store.createGroup({title:'多人协同验收',memberIds:['gpt','fish','claude','gemini'],participationMode:'mentions'}).id;
  await f.service.handle({type:'message.send',conversationId:groupId,content:'@gpt 问一下其他三位的近况，再告诉我',requestId:'group-fanout'});
  await waitNative(()=>f.service.store.messagesPage(groupId).items.some(m=>m.senderId==='gpt'&&m.status==='sent'&&m.content.startsWith('用户，我问过了')));
  expect(f.calls).toHaveLength(5);expect(f.service.store.messagesPage(groupId).items.filter(m=>m.id.startsWith('reply-')&&m.senderId==='gpt'&&m.status==='sent')).toHaveLength(2);
});
