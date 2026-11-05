import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotDshBrain, BotDshDeliveryUnknownError, BotDshTurnFailedError, type BotDshRun, type BotDshResult, type BotDshHandoff } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import type { BotRequest, BotResponse } from '../../src/shared/companion-bot';

class Memory extends BotMemoryService {
  recorded = 0;
  private readonly preparations = new Map<string, BotMemoryPrepared>();
  constructor(root: string) { super({ root, runtime: async () => { throw new Error('fixture boundary'); }, embedding: async () => { throw new Error('fixture boundary'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    const prepared: BotMemoryPrepared = { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '本域记忆', status: 'ready', omittedChars: 0 };
    this.preparations.set(input.requestId, prepared); return prepared;
  }
  override async resumePrepared(input: Parameters<BotMemoryService['resumePrepared']>[0]) { const prepared = this.preparations.get(input.requestId); if (!prepared) throw new Error('Missing fixture preparation'); return prepared; }
  override async finishTurn() { this.recorded++; return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async close() {}
}
class Brain extends BotDshBrain {
  calls: BotDshRun[] = [];
  handoffs: string[] = [];
  constructor(private readonly handler: (input: BotDshRun) => Promise<string> = async () => '已经收到。') { super({ getHost: async () => { throw new Error('fixture boundary'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> { this.calls.push(input); const text = await this.handler(input); return { text, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded' }; }
  override async handoff(input: Omit<BotDshRun, 'prompt' | 'onEvent'>): Promise<BotDshHandoff> {
    this.handoffs.push(input.eventId);
    return { format: 'worldlinebox-bot-handoff-v1', laneId: input.laneId, sessionId: BotDshBrain.sessionId(input.laneId), throughEventId: input.eventId,
      nativeCursor: 4, summaryText: '已确认的计划', summarySeq: 3, compactionId: 'fixture', coveredEventSeqs: [1, 2], tail: [] };
  }
  override async close() {}
}
const owned: Array<{ root: string; service: BotService }> = [];
afterEach(async () => { for (const item of owned.splice(0)) { await item.service.shutdown(); await rm(item.root, { recursive: true, force: true }); } });
async function fixture(brain = new Brain(), retention?: { maxTurns?: number; maxBytes?: number }, activityBudget?: BotServiceOptions['activityBudget'], options?: Pick<BotServiceOptions, 'runtimePreparation'>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-service-')), memory = new Memory(root);
  const service = new BotService({ root, brain, memory, retention, activityBudget, ...options, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }), onEvent: () => undefined });
  owned.push({ root, service });
  const state = (await service.handle({ type: 'state' })).snapshot!;
  return { service, brain, memory, conversationId: state.conversations[0]!.id };
}
async function poll(fn: () => Promise<boolean>, timeout = 3000) {
  const started = Date.now(); while (!await fn()) { if (Date.now() - started > timeout) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function send(service: BotService, conversationId: string, requestId: string) { return service.handle({ type: 'message.send', conversationId, content: '你好', requestId }); }

describe('new companion orchestration', () => {
  it('reports an actual waiting phase and persists end-to-end and first-text timing on the terminal reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const brain = new Brain(async () => { await gate; return '已经收到'; });
    const preparation = { phase: 'ready', elapsedMs: 0 };
    const { service, conversationId } = await fixture(brain, undefined, undefined, { runtimePreparation: () => preparation });
    await send(service, conversationId, 'timed-reply');
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.progress?.phase === 'waiting-model'));
    preparation.phase = 'starting-host'; service.runtimePreparationChanged();
    expect((await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.progress?.phase === 'waiting-runtime')).toBe(true);
    preparation.phase = 'ready'; service.runtimePreparationChanged();
    expect((await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.progress?.phase === 'waiting-model')).toBe(true);
    release();
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.content === '已经收到'));
    const reply = (await service.handle({ type: 'state', conversationId })).snapshot!.messages.find(message => message.content === '已经收到')!;
    expect(reply.progress).toBeUndefined();
    expect(reply.timing).toMatchObject({ elapsedMs: expect.any(Number), queueMs: expect.any(Number), prepareMs: expect.any(Number), modelMs: expect.any(Number), firstTextMs: expect.any(Number) });
    expect(reply.timing!.firstTextMs).toBeLessThanOrEqual(reply.timing!.elapsedMs);
  });
  it('continues the same chat through native handoff and counts definite terminal failures', async () => {
    const brain = new Brain(async input => { if (input.eventId === brain.calls[0]!.eventId) throw new BotDshTurnFailedError(input.eventId, 'fixture terminal'); return '继续完成'; });
    const { service, conversationId } = await fixture(brain, { maxTurns: 1 });
    await send(service, conversationId, 'first');
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.status === 'failed'));
    await send(service, conversationId, 'second');
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.content === '继续完成'));
    expect(brain.handoffs).toEqual([brain.calls[0]!.eventId]);
    expect(brain.calls[1]!.laneId).toBe(`${brain.calls[0]!.laneId}-epoch-2`);
    expect(JSON.parse(brain.calls[1]!.prompt).nativeHandoff).toMatchObject({ kind: 'historical-context', summaryText: '已确认的计划' });
    expect((await service.handle({ type: 'state' })).snapshot!.conversations).toHaveLength(1);
    expect(service.store.getMetadata(`native-input:${brain.calls[1]!.eventId}`)).toBe('');
  });
  it('keeps a real App unknown-write quarantine out of retention while fresh chat and the next rollover continue',async()=>{
    let modelRequests=0,writes=0,appBrain:BotAppBrain|undefined;
    const stream=(delta:object,finish='stop')=>new Response('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    class AppLoop extends Brain {
      override async run(input:BotDshRun):Promise<BotDshResult>{
        this.calls.push(input);
        appBrain??=new BotAppBrain({root:input.cwd,
          callTool:async()=>{writes++;throw Error('An external write occurred before its receipt was lost');},
          fetchFn:async()=>++modelRequests===1?stream({tool_calls:[{index:0,id:'external-write',type:'function',function:{name:'chat_send_sticker',arguments:'{"stickerId":"builtin-encourage"}'}}]},'tool_calls')
            :stream({content:modelRequests===2?'新的聊天正常完成':'交接后的聊天正常完成'}),
          summarize:async()=> '已确认的新聊天已完成；旧工具效果仍待核实。'});
        return appBrain.run(input);
      }
      override async handoff(input:Omit<BotDshRun,'prompt'|'onEvent'>){this.handoffs.push(input.eventId);return appBrain!.handoff(input);}
      override async close(){await appBrain?.close();}
    }
    const brain=new AppLoop(),{service,conversationId}=await fixture(brain,{maxTurns:1});
    const initial=await send(service,conversationId,'unknown-write-budget');
    await poll(async()=>service.store.getMessage(initial.replyMessageIds![0]!)?.status==='failed',8000);
    const unknown=brain.calls[0]!;expect(brain.calls.filter(call=>call.eventId===unknown.eventId)).toHaveLength(3);expect(writes).toBe(1);
    expect(service.store.getLaneRetention(unknown.laneId)).toMatchObject({turns:0,bytes:0});
    expect(service.store.getLaneRetention(unknown.laneId).last).toBeUndefined();
    expect(service.store.getMetadata(`native-terminal-counted:${unknown.eventId}`)).toBe('quarantined');expect(service.store.getMetadata(`native-admission:${unknown.eventId}`)).toBe('');
    await send(service,conversationId,'fresh-after-isolation');await poll(async()=>brain.calls.some(call=>service.store.getEvent(call.eventId)?.status==='done'));
    const confirmed=brain.calls.at(-1)!;expect(brain.handoffs).toEqual([]);expect(confirmed.laneId).toBe(unknown.laneId);
    await send(service,conversationId,'rollover-after-isolation');await poll(async()=>(await service.handle({type:'state',conversationId})).snapshot!.messages.some(message=>message.content==='交接后的聊天正常完成'));
    expect(brain.handoffs).toEqual([confirmed.eventId]);expect(brain.calls.at(-1)!.laneId).toBe(unknown.laneId+'-epoch-2');expect(writes).toBe(1);expect(modelRequests).toBe(3);
  });
  it('retries uncertain delivery with exactly the frozen input despite a changed persona', async () => {
    const brain = new Brain(async () => { if (brain.calls.length === 1) throw new BotDshDeliveryUnknownError('fixture disconnect'); return '恢复完成'; });
    const { service, conversationId } = await fixture(brain);
    await send(service, conversationId, 'uncertain');
    await poll(async () => brain.calls.length === 1);
    const saved = await service.handle({ type: 'companion.personas.save', companionId: DEFAULT_BOT_COMPANION_ID, name: '新的已保存人格', prompt: '重试期间的新人格', activate: true });
    await service.handle({ type: 'companion.update', companionId: DEFAULT_BOT_COMPANION_ID, name: '新名字' });
    await poll(async () => brain.calls.length === 2);
    expect(brain.calls[1]!.prompt).toBe(brain.calls[0]!.prompt);
    expect(brain.calls[1]!.system).toBe(brain.calls[0]!.system);
    expect(brain.calls[1]!.eventId).toBe(brain.calls[0]!.eventId);
    await poll(async () => service.store.getEvent(brain.calls[1]!.eventId)?.status === 'done');
    await send(service, conversationId, 'after-persona-activation');
    await poll(async () => brain.calls.length === 3);
    expect(brain.calls[2]!.system).toContain('重试期间的新人格');
    expect(service.store.getCompanion(DEFAULT_BOT_COMPANION_ID)!.activePersonaId).toBe(saved.persona!.id);
  });
  it('persists a reply once for a retried ingress and queues response recording separately', async () => {
    const { service, brain, conversationId } = await fixture();
    const first = await send(service, conversationId, 'stable-request'), duplicate = await send(service, conversationId, 'stable-request');
    expect(duplicate.messageId).toBe(first.messageId);
    expect(first.replyMessageIds).toHaveLength(1);
    expect(duplicate.replyMessageIds).toEqual(first.replyMessageIds);
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(message => message.content === '已经收到。' && message.status === 'sent'));
    expect(brain.calls).toHaveLength(1);
    expect((await service.handle({ type: 'state', conversationId })).snapshot!.messages.find(message => message.id === first.replyMessageIds![0])).toMatchObject({ senderId: DEFAULT_BOT_COMPANION_ID, status: 'sent', content: '已经收到。' });
    expect(service.store.listPendingMemory().some(job => job.kind === 'projection')).toBe(true);
  });
  it('enforces durable coordination action capacity over HTTP without charging a stable tool receipt twice, and admits fresh user work', async () => {
    const responses: Array<{ status: number; body: { ok: boolean; result?: unknown; error?: string } }> = [];
    const brain = new Brain(async input => {
      if (input.role === 'worker') return '工作已完成';
      if (input.laneId.startsWith('memory-encoder-')) return '{"notes":[]}';
      if (JSON.parse(input.prompt).trigger.source !== 'user') return '已收到任务回执';
      const invoke = async (callId: string) => {
        const response = await fetch(input.callback!.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback!.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name: 'dsh_task', args: { goal: '输出并验证一个产物' } }) });
        const value = { status: response.status, body: await response.json() }; responses.push(value); return value;
      };
      const first = await invoke('same-tool'); expect(await invoke('same-tool')).toEqual(first);
      expect(await invoke('extra-tool')).toMatchObject({ status: 400, body: { ok: false, error: expect.stringContaining('预算') } }); return '已按真实预算收件';
    });
    const { service, conversationId } = await fixture(brain, undefined, { maxActions: 1 });
    await send(service, conversationId, 'budget-first');
    await poll(async () => responses.length === 3);
    await send(service, conversationId, 'budget-new-user');
    await poll(async () => responses.length === 6);
    expect(responses[0]).toMatchObject({ status: 200, body: { ok: true } }); expect(responses[3]).toMatchObject({ status: 200, body: { ok: true } });
    expect(service.store.listTasks()).toHaveLength(2);
  });
  it('keeps a slow lane from blocking a second conversation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const brain = new Brain(async input => { if (JSON.parse(input.prompt).trigger.content === 'slow') await gate; return '完成'; });
    const { service, conversationId } = await fixture(brain);
    const added = await service.handle({ type: 'companion.create', name: '第二位', persona: '独立伙伴' });
    await service.handle({ type: 'message.send', conversationId, content: 'slow', requestId: 'one' });
    await send(service, added.conversationId!, 'two');
    try { await poll(async () => (await service.handle({ type: 'state', conversationId: added.conversationId })).snapshot!.messages.some(message => message.content === '完成')); }
    finally { release(); }
    expect(brain.calls.some(call => JSON.parse(call.prompt).envelope.conversationId === added.conversationId)).toBe(true);
  });
  it('delivers a late group reply by publication order once, even when its placeholder predates the last trigger and recent UI window', async () => {
    let releaseBeta!: () => void;
    const slowBeta = new Promise<void>(resolve => { releaseBeta = resolve; });
    const brain = new Brain(async input => {
      if (input.laneId.startsWith('memory-encoder-')) return '{"notes":[]}';
      const body = JSON.parse(input.prompt);
      if (body.envelope.companionId === DEFAULT_BOT_COMPANION_ID) return `A:${body.trigger.content}`;
      if (body.trigger.content === 'first') await slowBeta;
      return `B:${body.trigger.content}`;
    });
    const { service, memory } = await fixture(brain);
    const betaId = 'zz-late-beta'; service.store.createCompanion({ id: betaId, name: 'Beta', persona: '伙伴 B' });
    const group = await service.handle({ type: 'conversation.create', title: '迟到发言', kind: 'group', memberIds: [DEFAULT_BOT_COMPANION_ID, betaId], participationMode: 'all' });
    const conversationId = group.conversationId!;
    const message = (content: string) => service.handle({ type: 'message.send', conversationId, content, requestId: content });
    try {
      await message('first');
      await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.messages.some(item => item.content === 'A:first'));
      await message('second');
      expect(brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'second')).toBe(false);
      await poll(async () => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === betaId));
      const betaFirst = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === betaId)!;
      const betaReply = service.store.getEvent(betaFirst.eventId)!.replyMessageId;
      // These real, sent source records move the UI sequence window past the
      // preallocated B placeholder while B is still computing its first reply.
      for (let index = 0; index < 85; index++) service.store.enqueue({ conversationId, senderId: 'user', source: 'user', sourceMessageId: `filler-${index}`, recipientIds: [], content: `历史记录 ${index}` });
      releaseBeta();
      await poll(async () => service.store.getMessage(betaReply)?.status === 'sent');
      await poll(async () => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'second'));
      const second = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'second')!;
      expect(JSON.parse(second.prompt).history.filter((item: { id: string }) => item.id === betaReply)).toEqual([expect.objectContaining({ content: 'B:first' })]);
      expect(service.store.messagesPage(conversationId, { limit: 80 }).items.some(item => item.id === betaReply)).toBe(false);
      let releasePreparation!: () => void, preparingThird = false;
      const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
      const prepare = memory.prepareTurn.bind(memory);
      memory.prepareTurn = async input => { if (input.query === 'third' && input.scope.companionId === DEFAULT_BOT_COMPANION_ID) { preparingThird = true; await preparation; } return prepare(input); };
      await message('third');
      await poll(async () => preparingThird);
      // A later user message is already published before the third context is
      // assembled. The third trigger must still fence it out.
      await message('future'); releasePreparation();
      await poll(async () => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'third'));
      const third = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'third')!;
      expect(JSON.parse(third.prompt).history.some((item: { id: string }) => item.id === betaReply)).toBe(false);
      expect(JSON.parse(third.prompt).history.some((item: { content: string }) => item.content === 'future')).toBe(false);
      await poll(async () => service.store.getEvent(third.eventId)?.status === 'done');
      await message('fourth');
      await poll(async () => brain.calls.some(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'fourth'));
      const fourth = brain.calls.find(call => !call.laneId.startsWith('memory-encoder-') && JSON.parse(call.prompt).envelope.companionId === DEFAULT_BOT_COMPANION_ID && JSON.parse(call.prompt).trigger.content === 'fourth')!;
      expect(JSON.parse(fourth.prompt).history.some((item: { id: string }) => item.id === betaReply)).toBe(false);
      const lane = service.store.getEvent(third.eventId)!.laneId;
      expect(JSON.parse(service.store.getMetadata(`delivered:${lane}`)!).ids.length).toBeLessThanOrEqual(400);
    } finally { releaseBeta(); }
  });
  it('fences a late model completion after cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { service, brain, conversationId } = await fixture(new Brain(async () => { await gate; return '迟到正文'; }));
    await send(service, conversationId, 'cancel-request');
    await poll(async () => brain.calls.length === 1);
    const reply = (await service.handle({ type: 'state', conversationId })).snapshot!.messages.find(message => message.status === 'running')!;
    await service.handle({ type: 'reply.cancel', messageId: reply.id }); release();
    await poll(async () => (await service.handle({ type: 'state', conversationId })).snapshot!.runtime.activeLanes === 0);
    const state = (await service.handle({ type: 'state', conversationId })).snapshot!;
    expect(state.messages.find(message => message.id === reply.id)).toMatchObject({ status: 'cancelled', content: '' });
  });
  it('rejects memory access for a companion outside the selected audience', async () => {
    const { service, conversationId } = await fixture();
    const other = await service.handle({ type: 'companion.create', name: '另一位', persona: '独立伙伴' });
    const id = (await service.handle({ type: 'state', conversationId: other.conversationId })).snapshot!.conversations.find(c => c.id === other.conversationId)!.memberIds.find(id => id !== 'user')!;
    await expect(service.handle({ type: 'memory.inspect', conversationId, companionId: id })).rejects.toThrow('当前会话没有这位伙伴');
  });
});

// Compile-time assertion keeps fixture requests on the actual public IPC contract.
const contract: (service: BotService, request: BotRequest) => Promise<BotResponse> = (service, request) => service.handle(request);
void contract;
