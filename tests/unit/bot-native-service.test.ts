import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, BotDshOutputLimitError, BotDshTurnFailedError, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { botRequestSchema } from '../../src/shared/companion-bot';
import { BOT_TOOLS } from '../../src/main/companion-bot/tools';
import type {BotNativeContext} from '../../src/shared/companion-native-context';

class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No VCP process in this protocol test'); }, embedding: async () => { throw Error('No model'); } }); }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async appendHistory() { return { appended: [] }; }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'native', evidence: '已核验的VCP证据', metadata: {}, events: [], status: 'ready', omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async resumePrepared(input:Parameters<BotMemoryService['resumePrepared']>[0]):Promise<BotMemoryPrepared>{return {requestId:input.requestId,scope:input.scope,messages:[],inputHash:'native',evidence:'已核验的VCP证据',metadata:{},events:[],status:'ready',omittedChars:0};}
}
class Brain extends BotDshBrain {
  calls: BotDshRun[] = [];
  stops: Array<{ eventId: string; suspend: boolean }> = [];
  stop: () => Promise<void> = async () => undefined;
  override async cancelDurable(input: Parameters<BotDshBrain['cancelDurable']>[0], suspend = false) {
    this.stops.push({ eventId: input.eventId, suspend }); await this.stop();
    return { accepted: true, paused: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) };
  }
  contextCalls:string[]=[];
  readContext:(laneId:string)=>Promise<BotNativeContext>=async laneId=>({source:'dsh-native-projections',sessionId:BotDshBrain.sessionId(laneId),state:'ready',asOfSeq:10,sampledAt:new Date().toISOString(),pressure:{pressureTokens:10000,projectedTokens:11000,contextWindow:128000}});
  override async topicContext(laneId:string){this.contextCalls.push(laneId);return this.readContext(laneId);}
  guidance:Array<{laneId:string;input:Parameters<BotDshBrain['send']>[1]}>=[];
  execute: (input: BotDshRun) => Promise<Partial<BotDshResult>> = async () => ({ text: '原生最终正文' });
  constructor() { super({ getHost: async () => { throw Error('Only native adapter boundary is mocked'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    if (input.laneId.startsWith('memory-')) return { sessionId: this.session(input), eventId: input.eventId, status: 'succeeded', text: '{"notes":[]}' };
    this.calls.push(input);
    return { sessionId: this.session(input), eventId: input.eventId, status: 'succeeded', text: '', ...await this.execute(input) };
  }
  private session(input: BotDshRun) { return BotDshBrain.sessionId(input.laneId); }
  override async archive() {}
  override async send(laneId:string,input:Parameters<BotDshBrain['send']>[1]){this.guidance.push({laneId,input});}
  override async close() {}
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-service-')), brain = new Brain();
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.join(root, 'builtins') });
  const service = new BotService({ root, brain, media, memory: new Memory(path.join(root, 'memory')),
    model: () => ({ apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', model: 'fixture', apiKey: 'test-only' }), onEvent: () => undefined });
  const snapshot = (await service.handle({ type: 'state' })).snapshot!, room = snapshot.conversations[0]!;
  cleanups.push(async () => { await service.shutdown(); await rm(root, { recursive: true, force: true }); });
  let sequence = 0;
  const send = (content: string) => service.handle({ type: 'message.send', conversationId: room.id, content, requestId: 'native-' + ++sequence });
  return { root, brain, service, room, send };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { if (Date.now() > end) throw Error('Native service did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function callback(input: BotDshRun, name: string, args: object, callId = 'native-tool') {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  const result = await response.json() as { ok: boolean; result?: unknown; error?: string };
  if (!result.ok) throw Error(result.error); return result.result;
}
it('reads the selected topic context without inference and retains a labelled saved reading when DSH disconnects',async()=>{
  const f=await fixture(),sent=await f.send('项目上下文');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='sent');
  const topic=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!.chatRuntime!.topic!;
  const command={type:'topic.context' as const,conversationId:f.room.id,topicId:topic.id,companionId:f.service.store.getEvent(f.brain.calls[0]!.eventId)!.companionId};
  const result=await f.service.handle(command);expect(result.topicContext?.sample?.pressure?.projectedTokens).toBe(11000);expect(f.brain.calls).toHaveLength(1);
  f.brain.readContext=async()=>{throw Error('DSH disconnected');};const offline=await f.service.handle(command);
  expect(offline.topicContext).toMatchObject({stale:true,error:'DSH disconnected',sample:{sessionId:result.topicContext!.sample!.sessionId,pressure:{projectedTokens:11000}}});
  const empty=(await f.service.handle({type:'topic.new',conversationId:f.room.id,requestId:'empty-context'})).topic!,calls=f.brain.contextCalls.length;
  expect((await f.service.handle({...command,topicId:empty.id})).topicContext?.sample).toBeUndefined();expect(f.brain.contextCalls).toHaveLength(calls);
});
it('projects native context pushes independently of chat output and never treats a meter frame as dispatch admission',async()=>{
  const f=await fixture();let eventId='';
  f.brain.execute=async input=>{eventId=input.eventId;const context=await f.brain.readContext(input.laneId);
    input.onEvent?.({type:'context',sequence:1,receivedAt:new Date().toISOString(),context});
    expect(f.service.store.getEvent(input.eventId)?.dshEventId).toBeUndefined();
    input.onEvent?.({type:'context',sequence:2,receivedAt:new Date().toISOString(),context:{...context,sessionId:'another-session',asOfSeq:999,pressure:{projectedTokens:999999,contextWindow:128000}}});
    input.onEvent?.({type:'context',sequence:3,receivedAt:new Date().toISOString(),context:{...context,pressure:{contextWindow:-1}}});
    return{text:'正式正文'};
  };
  const sent=await f.send('实时统计');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='sent');
  const snapshot=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!,sample=snapshot.chatRuntime!.contexts![f.service.store.getEvent(eventId)!.companionId]!;
  expect(sample.pressure?.projectedTokens).toBe(11000);expect(snapshot.messages.find(message=>message.id===sent.replyMessageIds![0])?.execution?.steps.some(step=>step.type==='context')).toBe(false);
});
it('reconciles all ordered user-facing parts from a cached native receipt without duplicating delivery',async()=>{
  const f=await fixture(),file=path.join(f.root,'receipt-output.txt');await writeFile(file,'NATIVE_FILE');
  f.brain.execute=async()=>({text:'关键回答\n\n完成',artifacts:[{path:file}],outputs:[{id:'native-text-10',sequence:10,text:'关键回答'},{id:'native-files-20',sequence:20,files:[{path:file}]},{id:'native-text-30',sequence:30,text:'完成'}]});
  const sent=await f.send('缓存回执重连');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='sent');
  const message=f.service.store.getMessage(sent.replyMessageIds![0]!)!;expect(message.content).toBe('关键回答\n\n完成');expect(message.parts?.map(part=>part.sequence)).toEqual([10,20,30]);expect(message.attachments).toHaveLength(1);
});
it('retains early answers and delivered files when a later native step fails, including a cold receipt',async()=>{
  const f=await fixture(),file=path.join(f.root,'partial-output.txt');await writeFile(file,'PARTIAL_NATIVE_FILE');
  f.brain.execute=async input=>{const result:BotDshResult={eventId:input.eventId,sessionId:BotDshBrain.sessionId(input.laneId),status:'failed',text:'已确认的关键结论',artifacts:[{path:file}],outputs:[{id:'native-text-10',sequence:10,text:'已确认的关键结论'},{id:'native-files-20',sequence:20,files:[{path:file}]}]};throw new BotDshTurnFailedError(input.eventId,'后续模型步骤失败',result.text,true,undefined,result);};
  const sent=await f.send('失败前的结果不能消失');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='failed');
  const message=f.service.store.getMessage(sent.replyMessageIds![0]!)!;expect(message.content).toBe('已确认的关键结论');expect(message.parts?.map(part=>part.sequence)).toEqual([10,20]);expect(message.attachments).toHaveLength(1);expect(message.error).toContain('后续模型步骤失败');
});
it('routes a follow-up to the selected native DSH session without replaying the application transcript', async () => {
  const f = await fixture();
  const first = await f.send('第一轮的私有上下文');
  await until(() => f.service.store.getMessage(first.replyMessageIds![0]!)?.status === 'sent');
  const second = await f.send('第二轮');
  await until(() => f.service.store.getMessage(second.replyMessageIds![0]!)?.status === 'sent');
  expect(f.brain.calls).toHaveLength(2);
  expect(f.brain.calls[0]!.laneId).toBe(f.brain.calls[1]!.laneId);
  expect(f.brain.calls[0]!.cwd).toBe(f.brain.calls[1]!.cwd);
  expect(f.brain.calls[1]!.prompt).not.toContain('第一轮的私有上下文');
  expect(f.brain.calls[1]!.prompt).toContain('已核验的VCP证据');
  expect(f.brain.calls[1]).toMatchObject({ role: 'worker', workerAccess: 'full', tools: [] });
  expect(f.service.store.getMessage(second.replyMessageIds![0]!)!.content).toBe('原生最终正文');
});
it('creates a new topic explicitly and reconnects earlier native history without changing the companion workspace',async()=>{
  const f=await fixture(),first=await f.send('先前项目');await until(()=>f.service.store.getMessage(first.replyMessageIds![0]!)?.status==='sent');
  const prior=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!.chatRuntime!.topic!;
  await f.service.handle({type:'topic.new',conversationId:f.room.id,requestId:'manual-new'});
  const second=await f.send('独立问题');await until(()=>f.service.store.getMessage(second.replyMessageIds![0]!)?.status==='sent');
  await f.service.handle({type:'topic.select',conversationId:f.room.id,topicId:prior.id});
  const third=await f.send('追问先前项目');await until(()=>f.service.store.getMessage(third.replyMessageIds![0]!)?.status==='sent');
  expect(f.brain.calls[0]?.laneId).not.toBe(f.brain.calls[1]?.laneId);expect(f.brain.calls[2]?.laneId).toBe(f.brain.calls[0]?.laneId);
});
it('queues new input above the composer, steers it exactly once into the pinned task and captures the actual supplemental input',async()=>{
  const f=await fixture();let finish!:(text:Partial<BotDshResult>)=>void;f.brain.execute=()=>new Promise(resolve=>{finish=resolve;});
  const first=await f.send('正在执行的项目');await until(()=>!!finish);
  const second=await f.send('包含用户新要求的补充');
  const pending=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!.chatRuntime!;
  expect(pending.queued[0]?.messageId).toBe(second.messageId);expect(pending.hiddenMessageIds).toContain(second.replyMessageIds![0]);
  await f.service.handle({type:'message.guide',conversationId:f.room.id,messageId:second.messageId!});await f.service.handle({type:'message.guide',conversationId:f.room.id,messageId:second.messageId!});
  expect(f.brain.guidance).toHaveLength(1);expect(f.brain.guidance[0]?.laneId).toBe(f.brain.calls[0]?.laneId);expect(f.brain.guidance[0]?.input.text).toContain('包含用户新要求的补充');
  finish({text:'已按补充完成'});await until(()=>f.service.store.getMessage(first.replyMessageIds![0]!)?.status==='sent');
  expect(f.brain.calls).toHaveLength(1);expect(f.service.store.eventForReply(second.replyMessageIds![0]!)?.status).toBe('cancelled');
  const capture=f.service.store.taskTransaction(sql=>sql.prepare("SELECT payload_json FROM bot_memory_jobs WHERE kind='capture' ORDER BY created_at DESC LIMIT 1").get()) as {payload_json:string};
  expect(capture.payload_json).toContain('包含用户新要求的补充');
});
it('projects real native deliveries onto the reply and preserves process separately from final text', async () => {
  const f = await fixture();
  f.brain.execute = async input => {
    const file = path.join(input.cwd, 'native-report.txt'); await writeFile(file, 'DSH原生产物');
    input.onEvent?.({ type: 'tool_call', sequence: 1, receivedAt: new Date().toISOString(), toolName: 'present' });
    input.onEvent?.({ type: 'artifacts', sequence: 2, receivedAt: new Date().toISOString(), artifacts: [{ path: file }] });
    return { text: '最终交付正文', artifacts: [{ path: file }] };
  };
  const sent = await f.send('写一份文件');
  await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  const snapshot = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!;
  const reply = snapshot.messages.find(message => message.id === sent.replyMessageIds![0])!;
  expect(reply.content).toBe('最终交付正文'); expect(reply.attachments).toHaveLength(1);
  expect(reply.attachments![0]!.name).toBe('native-report.txt');
  expect(reply.execution).toMatchObject({ status: 'succeeded', steps: [{ toolName: 'present' }, { type: 'artifacts' }] });
  const followup = await f.send('继续检查结果');
  await until(() => f.service.store.getMessage(followup.replyMessageIds![0]!)?.status === 'sent');
  expect(JSON.parse(f.brain.calls[1]!.prompt).files).toEqual([]);
  expect(f.brain.calls[1]!.prompt).not.toContain('native-report.txt');
});
it('keeps a native question pending and resumes that exact session after the user answers', async () => {
  const f = await fixture();
  f.brain.execute = async input => ({ text: '用户选择：' + (await callback(input, 'chat_ask_user', { question: '选择红色还是蓝色？' }) as { text: string }).text });
  const sent = await f.send('需要一个选择');
  let questionId = '';
  await until(async () => { const reply = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!.messages.find(message => message.id === sent.replyMessageIds![0]); questionId = reply?.execution?.question?.id ?? ''; return !!questionId; });
  await f.service.handle({ type: 'execution.answer', messageId: sent.replyMessageIds![0]!, questionId, text: '蓝色' });
  await until(() => f.service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
  expect(f.brain.calls).toHaveLength(1); expect(f.service.store.getMessage(sent.replyMessageIds![0]!)!.content).toBe('用户选择：蓝色');
});
it('persists native reasoning as complete loop phases rather than one row per streamed delta',async()=>{
  const f=await fixture();
  f.brain.execute=async input=>{
    let sequence=0;
    const emit=(patch:Partial<Parameters<NonNullable<BotDshRun['onEvent']>>[0]>)=>input.onEvent?.({type:'reasoning',sequence:++sequence,receivedAt:new Date().toISOString(),nativeSessionId:'root',nativeTurn:1,nativeStep:1,...patch});
    emit({type:'status',stage:'step_start',summary:'开始第 1 步处理'});
    for(const text of ['用户','让我','自我介绍'])emit({text,streamId:'attempt-a'});
    emit({text:'用户让我自我介绍。',streamId:'attempt-a',textMode:'snapshot',outputState:'committed'});
    emit({type:'status',stage:'step_start',nativeStep:2,summary:'开始第 2 步处理'});
    emit({nativeStep:2,text:'下一步思考',streamId:'attempt-b'});
    return {text:'最终正文'};
  };
  const sent=await f.send('介绍自己');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='sent');
  const snapshot=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!;
  const reply=snapshot.messages.find(message=>message.id===sent.replyMessageIds![0])!;
  expect(reply.execution!.steps.filter(item=>item.type==='reasoning').map(item=>item.text)).toEqual(['用户让我自我介绍。','下一步思考']);
  expect(reply.content).toBe('最终正文');
});
it('removes application task APIs and custom file delivery tools', () => {
  expect(botRequestSchema.safeParse({ type: 'task.list', conversationId: 'room' }).success).toBe(false);
  for (const name of ['dsh_task', 'dsh_plan', 'chat_send_file', 'worker_chat_send_file']) expect(BOT_TOOLS.some(tool => tool.name === name)).toBe(false);
});
it('continues a budget-limited reply in the exact native session and finishes its VCP response only once',async()=>{
  const f=await fixture();
  f.brain.execute=async input=>{
    if(input.continueAfterSeq!==77)throw new BotDshOutputLimitError(input.eventId,BotDshBrain.sessionId(input.laneId),77,'已写入一半',true);
    return {text:'续跑后的最终正文'};
  };
  const sent=await f.send('开发项目');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='failed');
  const messageId=sent.replyMessageIds![0]!,before=(await f.service.handle({type:'state',conversationId:f.room.id})).snapshot!.messages.find(item=>item.id===messageId)!;
  expect(before.execution?.continuation).toEqual({checkpoint:77});expect(before.content).toBe('已写入一半');
  expect(f.service.store.taskTransaction(sql=>sql.prepare("SELECT COUNT(*) n FROM bot_memory_jobs WHERE kind='response'").get())).toEqual({n:0});
  const request={type:'execution.continue' as const,messageId,requestId:'once-only'};
  await f.service.handle(request);await f.service.handle(request);
  await until(()=>f.service.store.getMessage(messageId)?.status==='sent');
  expect(f.brain.calls).toHaveLength(2);expect(f.brain.calls[1]!.laneId).toBe(f.brain.calls[0]!.laneId);expect(f.brain.calls[1]!.eventId).toBe(f.brain.calls[0]!.eventId);
  expect(f.service.store.getMessage(messageId)!.content).toBe('续跑后的最终正文');
  expect(f.service.store.taskTransaction(sql=>sql.prepare("SELECT COUNT(*) n FROM bot_memory_jobs WHERE kind='response'").get())).toEqual({n:1});
});
it('interrupts and directly resumes the same reply twice without another user message or premature VCP completion', async () => {
  const f = await fixture(); let aborted = 0;
  f.brain.execute = async input => {
    if (f.brain.calls.length <= 2) {
      input.onEvent?.({ type: 'reasoning', sequence: f.brain.calls.length, receivedAt: new Date().toISOString(), text: '已保留的进展' });
      await new Promise<void>((_, reject) => input.signal!.addEventListener('abort', () => {
        expect(input.signal!.reason.code).toBe('BOT_SUSPEND'); aborted++; reject(input.signal!.reason);
      }, { once: true }));
    }
    return { text: '原任务完成' };
  };
  const sent = await f.send('开始可中断的任务'), messageId = sent.replyMessageIds![0]!;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await until(() => f.brain.calls.length === attempt);
    await f.service.handle({ type: 'reply.cancel', messageId });
    await until(async () => (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!.messages.find(item => item.id === messageId)?.execution?.interruption?.state === 'ready');
    expect(f.service.store.getMessage(messageId)?.status).toBe('cancelled');
    expect(f.service.store.taskTransaction(sql => sql.prepare("SELECT COUNT(*) n FROM bot_memory_jobs WHERE kind='response'").get())).toEqual({ n: 0 });
    const request = { type: 'execution.continue' as const, messageId, requestId: 'resume-' + attempt };
    await f.service.handle(request); await f.service.handle(request);
  }
  await until(() => f.service.store.getMessage(messageId)?.status === 'sent');
  expect(aborted).toBe(2); expect(f.brain.calls).toHaveLength(3);
  expect(new Set(f.brain.calls.map(call => call.eventId)).size).toBe(1);
  expect(new Set(f.brain.calls.map(call => call.laneId)).size).toBe(1);
  expect(new Set(f.brain.calls.map(call => call.prompt)).size).toBe(1);
  expect(f.brain.calls.slice(1).every(call => call.resumeHost)).toBe(true);
  expect(f.brain.stops.every(stop => stop.suspend)).toBe(true);
  const snapshot = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!;
  expect(snapshot.messages.filter(item => item.senderId === 'user')).toHaveLength(1);
  expect(snapshot.messages.find(item => item.id === messageId)).toMatchObject({ content: '原任务完成', execution: { status: 'succeeded' } });
  expect(snapshot.messages.find(item => item.id === messageId)?.execution?.interruption).toBeUndefined();
  expect(f.service.store.taskTransaction(sql => sql.prepare("SELECT COUNT(*) n FROM bot_memory_jobs WHERE kind='response'").get())).toEqual({ n: 1 });
});
it('does not offer continuation before the native stop is confirmed, or resume a withdrawn task', async () => {
  const f = await fixture(); let confirm!: () => void;
  f.brain.stop = () => new Promise<void>(resolve => { confirm = resolve; });
  f.brain.execute = input => new Promise((_, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
  const sent = await f.send('等待原生停止回执'), messageId = sent.replyMessageIds![0]!;
  await until(() => f.brain.calls.length === 1); await f.service.handle({ type: 'reply.cancel', messageId });
  await until(() => !!confirm);
  const snapshot = (await f.service.handle({ type: 'state', conversationId: f.room.id })).snapshot!;
  expect(snapshot.messages.find(item => item.id === messageId)?.execution?.interruption?.state).toBe('stopping');
  await expect(f.service.handle({ type: 'execution.continue', messageId, requestId: 'too-early' })).rejects.toThrow('没有可继续');
  expect(JSON.parse(f.service.store.getMetadata('native-stop:' + f.brain.calls[0]!.eventId)!)).toMatchObject({ suspend: true });
  confirm(); await until(() => !f.service.store.getMetadata('native-stop:' + f.brain.calls[0]!.eventId));
  const event = f.service.store.eventForReply(messageId)!;
  f.service.store.taskTransaction(sql => sql.prepare('UPDATE bot_lanes SET epoch=epoch+1 WHERE id=?').run(event.laneId));
  await expect(f.service.handle({ type: 'execution.continue', messageId, requestId: 'withdrawn' })).rejects.toThrow('资料或授权');
  expect(f.brain.calls).toHaveLength(1);
});
it('reuses historical effect receipts whose fingerprints included the old embedded native identity',async()=>{
  const f=await fixture();f.brain.execute=async input=>{
    const args={query:'GPT',nativeSessionId:'native-root',nativeCallId:'raw-call'},callId='legacy-call';
    const fingerprint=createHash('sha256').update(JSON.stringify(['companion_directory',args])).digest('hex');
    f.service.store.setMetadata(`effect:${input.eventId}:${callId}`,JSON.stringify({fingerprint,result:{historicalReceipt:true}}));
    expect(await callback(input,'companion_directory',args,callId)).toEqual({historicalReceipt:true});return {text:'done'};
  };
  const sent=await f.send('继续历史调用');await until(()=>f.service.store.getMessage(sent.replyMessageIds![0]!)?.status==='sent');
});
it('creates separate explicitly named project groups with the same companions, preserving independent memory audiences',async()=>{
  const f=await fixture();
  const create=(title:string)=>f.service.handle({type:'conversation.create',kind:'group',title,memberIds:['builtin-dafeiyu','claude']});
  const a=await create('项目甲'),b=await create('项目乙');expect(a.conversationId).not.toBe(b.conversationId);
  const first=f.service.store.getConversation(a.conversationId!)!,second=f.service.store.getConversation(b.conversationId!)!;
  expect(first.title).toBe('项目甲');expect(second.title).toBe('项目乙');expect(first.securityDomainId).not.toBe(second.securityDomainId);
});
it('runs an explicitly addressed group teammate while the coordinator is still waiting, without starting ordinary group replies',async()=>{
  const f=await fixture();
  const created=await f.service.handle({type:'conversation.create',kind:'group',title:'并行协作',memberIds:['builtin-dafeiyu','claude','gpt']});
  let release=()=>undefined as void;
  const teammateFinished=new Promise<void>(resolve=>{release=resolve;});
  let coordinatorWaiting=false,teammateRan=false;
  f.brain.execute=async input=>{
    const companionId=f.service.store.getEvent(input.eventId)!.companionId;
    if(companionId==='builtin-dafeiyu'){
      coordinatorWaiting=true;
      await callback(input,'message_peer',{companionId:'claude',content:'完成独立实现后回复'});
      await teammateFinished;coordinatorWaiting=false;return {text:'协调完成'};
    }
    if(companionId==='claude'){
      expect(coordinatorWaiting).toBe(true);teammateRan=true;release();return {text:'实现完成'};
    }
    throw Error('Ordinary unaddressed group work must stay serialized');
  };
  const sent=f.service.store.enqueue({conversationId:created.conversationId!,senderId:'user',content:'请大肥鱼协调开发',recipientIds:['builtin-dafeiyu'],sourceMessageId:'collaborate'});
  try{await until(()=>f.service.store.getMessage(sent.events[0]!.replyMessageId)?.status==='sent');expect(teammateRan).toBe(true);}
  finally{release();}
});
