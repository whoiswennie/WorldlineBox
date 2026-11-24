import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun, type BotDshResult } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BotCabinWorldApp } from '../../src/main/companion-bot/cabin-world-app';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { PresenceArchive } from '../../src/main/companion-bot/presence-archive';
import type { BotEvent } from '../../src/shared/companion-bot';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until<T>(read: () => T | undefined | Promise<T | undefined>) {
  const end = Date.now() + 5000;
  for (;;) { const found = await read(); if (found !== undefined) return found; if (Date.now() >= end) throw new Error('Controlled service fixture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(memoryError?: Error, cabinWorldApp?: BotCabinWorldApp, replyText = '你好，我在。', assertMessageReady?: () => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-real-progress-')), preparation = gate(), completion = gate(), reported: unknown[] = [];
  let run: BotDshRun | undefined, prepares = 0;
  const memory = new class extends BotMemoryService {
    override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
      prepares++; input.onPhase?.('recalling-memory'); await preparation.promise; if (memoryError) throw memoryError;
      return { requestId: input.requestId, inputHash: 'controlled', scope: input.scope, messages: input.messages, metadata: {}, evidence: '', events: [], omittedChars: 0, status: 'ready' };
    }
    override async finishTurn() { return { recorded: true }; }
    override async appendHistory() { return { archived: true }; }
    override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
    override async remember() { return { state: 'indexed', indexed: true, durable: true }; }
    override async catalog() { return { items: [], tags: [], total: 0 }; }
    override async close() {}
  }({ root, runtime: async () => { throw new Error('No native runtime for controlled fixture'); }, embedding: async () => { throw new Error('No paid embedding'); } });
  const host = vi.fn(async () => { throw new Error('Native adapter progress must not start DSH'); });
  const steer = vi.fn<BotDshBrain['send']>(async () => undefined);
  const brain = new class extends BotDshBrain {
    override async run(input: BotDshRun): Promise<BotDshResult> {
      if (input.laneId.startsWith('memory-encoder-')) return { text: '{"notes":[]}', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
      run = input; await completion.promise;
      return { text: replyText, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded', inputContextCommitted: true };
    }
    override send(...args: Parameters<BotDshBrain['send']>) { return steer(...args); }
    override async archive() {}
  }({ getHost: host });
  const events: BotEvent[] = [];
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot: path.resolve('resources/bot-stickers') });
  const service = new BotService({ root, brain, memory, media, model: () => ({ model: 'controlled-local', apiKey: 'never-used-fixture', baseUrl: 'http://127.0.0.1:9', apiFormat: 'openai_chat' }),
    cabinWorldApp, assertMessageReady, onEvent: event => { events.push(event); }, report: error => { reported.push(error); } });
  const initial = (await service.handle({ type: 'state' })).snapshot!, conversationId = initial.conversations[0]!.id;
  cleanups.push(async () => { preparation.resolve(); completion.resolve(); await service.shutdown(); await media.close(); await rm(root, { recursive: true, force: true }); });
  const send = (content = '你好', room = conversationId) => service.handle({ type: 'message.send', conversationId: room, content, requestId: 'controlled' });
  const reply = async (room = conversationId, surface?: 'call') => (await service.handle({ type: 'state', conversationId: room, surface })).snapshot!.messages.find(message => message.senderId !== 'user');
  let sequence = 0;
  const emit = (type: string, text?: string, toolName?: string) => run!.onEvent?.({ type, text, toolName, nativeStep: 4, sequence: ++sequence, receivedAt: new Date().toISOString() });
  return { service, brain, media, root, preparation, completion, reported, host, send, reply, emit, conversationId, steer, events, get run() { return run; }, get prepares() { return prepares; } };
}

it('rejects new desktop, call, mobile and world messages before queueing and allows an explicit resend after startup', async () => {
  let ready = false;
  const f = await fixture(undefined, undefined, undefined, () => { if (!ready) throw Error('DSH 正在启动，本次消息未发送'); });
  const base = { type: 'message.send' as const, conversationId: f.conversationId, content: 'hello', requestId: 'mobile-attempt' };
  const phone = { id: 'mobile:phone', kind: 'mobile' as const, label: 'Android' };
  for (const attempt of [
    () => f.service.handle({ ...base, requestId: 'desktop' }),
    () => f.service.handle({ ...base, surface: 'call', requestId: 'call' }),
    () => f.service.handle(base, phone),
    () => f.service.handle({ ...base, type: 'world.event' }),
  ]) await expect(attempt()).rejects.toThrow('本次消息未发送');
  expect((await f.service.handle({ type: 'state', conversationId: f.conversationId })).snapshot!.messages).toHaveLength(0);
  ready = true;
  expect(f.service.store.ingressExists(f.conversationId, base.requestId)).toBe(false);
  const receipt = await f.service.handle(base, phone);
  ready = false;
  expect((await f.service.handle(base, phone)).messageId).toBe(receipt.messageId);
});

it('rechecks DSH before enqueue when the host was stopped during asynchronous message preparation', async () => {
  const check = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw Error('DSH 已关闭'); });
  const f = await fixture(undefined, undefined, undefined, check);
  await expect(f.send()).rejects.toThrow('DSH 已关闭');
  expect(f.service.store.ingressExists(f.conversationId, 'controlled')).toBe(false);
});

it('can immediately stop a prepared reply before its native turn was sent', async () => {
  const f = await fixture();
  f.preparation.resolve();
  const receipt = await f.send();
  const run = await until(() => f.run);
  expect(f.service.store.getMetadata('native-input:' + run.eventId)).toBeTruthy();
  await f.service.handle({ type: 'reply.cancel', messageId: receipt.replyMessageIds![0]! });
  expect(run.signal?.aborted).toBe(true);
  expect(f.service.store.getEvent(run.eventId)?.status).toBe('cancelled');
  expect(f.service.store.getMetadata('native-stop:' + run.eventId)).toBeFalsy();
  expect((await f.reply())?.execution?.interruption?.state).toBe('ready');
  expect(f.host).not.toHaveBeenCalled();
});

it.each([undefined, 'call' as const])('interrupts the current reply after speech is accepted and prioritizes the new question (%s)', async surface => {
  const f = await fixture();
  const stop = vi.spyOn(f.brain, 'cancelDurable').mockImplementation(async input => ({
    accepted: true, eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId),
  }));
  f.preparation.resolve();
  const send = (content: string, requestId: string, options: { topicId?: string; delivery?: 'interrupt'; attachmentIds?: string[] } = {}) =>
    f.service.handle({ type: 'message.send', conversationId: f.conversationId, content, requestId, surface, ...options });
  const first = await send('旧问题', 'first');
  const active = await until(() => f.run);
  active.beforeSendTurn?.();
  f.emit('status');
  const state = () => f.service.handle({ type: 'state', conversationId: f.conversationId });
  const topicId = (await state()).snapshot!.chatRuntime!.topic!.id;
  const attachment = path.join(f.root, '稍后处理.txt');
  await writeFile(attachment, '这属于普通排队消息。');
  const [file] = await f.media.importFiles({ conversationId: f.conversationId, paths: [attachment] });
  const queued = await send('已经排队的消息', 'older-queued', { topicId, attachmentIds: [file!.id] });
  await expect(send('无法投递的问题', 'rejected', { delivery: 'interrupt', topicId: 'unknown-topic' })).rejects.toThrow();
  expect(active.signal?.aborted).toBe(false);

  const receipt = await send('先回答这个问题', 'priority', { delivery: 'interrupt', topicId });
  expect(receipt.interruptedReplyIds).toEqual(first.replyMessageIds);
  expect(active.signal?.aborted).toBe(true);
  await until(() => stop.mock.calls[0]);
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ eventId: active.eventId, laneId: active.laneId }), false);
  expect(f.service.store.getMessage(first.replyMessageIds![0]!)?.status).toBe('cancelled');
  expect(f.service.store.getMessage(queued.replyMessageIds![0]!)?.status).toBe('queued');
  const next = await until(() => f.run?.eventId !== active.eventId ? f.run : undefined);
  expect(next.laneId).toBe(active.laneId);
  expect(JSON.parse(next.prompt).message.content).toBe('先回答这个问题');
  expect(JSON.parse(next.prompt).files ?? []).toHaveLength(0);
  expect(await send('先回答这个问题', 'priority', { delivery: 'interrupt', topicId })).toEqual(receipt);
  expect(next.signal?.aborted).toBe(false);
  expect(f.steer).not.toHaveBeenCalled();

  f.completion.resolve();
  const last = await until(() => f.run?.eventId !== next.eventId ? f.run : undefined);
  expect(JSON.parse(last.prompt).message.content).toMatch(/^已经排队的消息/u);
  expect(JSON.parse(last.prompt).files).toMatchObject([{ id: file!.id }]);
});

it('automatically observes each started or steered task, keeping the same evidence on delivery retry', async () => {
  let place = '小屋', reads = 0;
  const cabin = new BotCabinWorldApp({ open: async () => undefined, async request(route, _signal, body) {
    if (route === '/v1/events') return { events: [] };
    const tool = body as { name: string; arguments: { actor?: string } };
    if (tool.name === 'cabin_residents') return { ok: true, residents: [] };
    reads++;
    return { ok: true, connected: true, actor: tool.arguments.actor, position: { place } };
  } });
  const f = await fixture(undefined, cabin), conversationId = f.conversationId;
  f.preparation.resolve();
  const send = (content: string, delivery?: 'steer') => f.service.handle({ type: 'message.send', conversationId, content,
    delivery, requestId: content, ...(content === '早啊' ? { apps: ['cabin-world' as const] } : {}) });
  await f.service.handle({ type: 'app.connect', conversationId, appId: 'cabin-world' });
  reads = 0;
  await send('早啊');
  const first = await until(() => f.run);
  expect(JSON.parse(first.prompt).cabinWorld).toMatchObject({ place: '小屋' });
  expect(reads).toBe(1);

  place = '公园';
  f.emit('text_stream', '收到');
  f.steer.mockRejectedValueOnce(Error('acknowledgement lost'));
  const guided = await send('再补一句', 'steer');
  const initial = (await until(() => f.steer.mock.calls[0]))[1].text;
  await until(async () => (await f.service.handle({ type: 'state', conversationId })).snapshot?.chatRuntime?.queued
    .find(item => item.messageId === guided.messageId && item.state === 'attention'));
  expect(JSON.parse(initial).cabinWorld).toMatchObject({ place: '公园' });
  expect(reads).toBe(2);

  place = '小卖部';
  await f.service.handle({ type: 'message.guide', conversationId, messageId: guided.messageId! });
  expect(f.steer.mock.calls[1]![1].text).toBe(initial);
  expect(reads).toBe(2);

  await send('另一件事');
  expect(reads).toBe(2);
  f.completion.resolve();
  const queued = await until(() => f.run && f.run.eventId !== first.eventId ? f.run : undefined);
  expect(JSON.parse(queued.prompt).cabinWorld).toMatchObject({ place: '小卖部' });
  expect(reads).toBe(3);
});
it('automatically delivers speech captured during preparation to the same native turn in order', async () => {
  const f = await fixture();
  const first = await f.send();
  const state = () => f.service.handle({ type: 'state', conversationId: f.conversationId });
  const running = await until(async () => (await state()).snapshot?.chatRuntime?.running[0]);
  const input = { type: 'message.send' as const, conversationId: f.conversationId, delivery: 'steer' as const, surface: 'call' as const };
  const firstAddition = { ...input, content: '补充第一点', requestId: 'speech-1' };
  const supplement = await f.service.handle(firstAddition);
  expect(supplement).toMatchObject({ ok: true, guiding: true });
  expect(await f.service.handle(firstAddition)).toMatchObject({ messageId: supplement.messageId, guiding: true });
  await f.service.handle({ ...input, content: '补充第二点', requestId: 'speech-2' });
  const another = await f.service.handle({ type: 'topic.new', conversationId: f.conversationId, requestId: 'a-distinct-topic' });
  expect(another.topic?.id).not.toBe(running.topicId);
  const queued = await f.service.handle({ ...input, topicId: another.topic!.id, content: '另一个话题', requestId: 'speech-other-topic' });
  expect(queued.guiding).toBeUndefined();
  expect(f.steer).not.toHaveBeenCalled();

  f.preparation.resolve();
  const run = await until(() => f.run);
  f.emit('status');
  await until(() => f.steer.mock.calls[1]);
  expect(f.steer.mock.calls.map(([lane, item]) => [lane, item.eventId, JSON.parse(item.text).message.content]))
    .toEqual([[run.laneId, run.eventId, '补充第一点'], [run.laneId, run.eventId, '补充第二点']]);
  expect((await state()).snapshot?.chatRuntime?.hiddenMessageIds).toContain(supplement.replyMessageIds![0]);
  expect((await state()).snapshot?.messages.find(message => message.id === first.replyMessageIds![0])?.status).toBe('running');
});

it('runs a speech supplement in the same topic if the native turn rejects it as already finished', async () => {
  const f = await fixture();
  f.preparation.resolve();
  await f.send();
  const first = await until(() => f.run);
  f.emit('status');
  f.steer.mockRejectedValueOnce(Object.assign(Error('Turn finished'), { code: 'BOT_GUIDANCE_NOT_ACCEPTED' }));
  const result = await f.service.handle({ type: 'message.send', conversationId: f.conversationId,
    content: '补充一个要求', delivery: 'steer', requestId: 'speech-late' });
  expect(result.guiding).toBe(true);
  const state = () => f.service.handle({ type: 'state', conversationId: f.conversationId });
  await until(async () => (await state()).snapshot?.chatRuntime?.queued.find(item => item.messageId === result.messageId && item.state === 'queued'));
  f.completion.resolve();
  const next = await until(() => f.run?.eventId !== first.eventId ? f.run : undefined);
  expect(next.laneId).toBe(first.laneId);
  expect(JSON.parse(next.prompt).message.content).toBe('补充一个要求');
});
it('projects actual memory/model/compaction/tool phases, retaining text across tools and returning to generation without token-wide snapshots', async () => {
  const f = await fixture(); await f.send();
  await until(async () => (await f.reply())?.progress?.phase === 'recalling-memory' ? true : undefined);
  f.preparation.resolve(); await until(() => f.run);
  expect((await f.reply())?.progress?.phase).toBe('waiting-model');
  f.emit('text_stream', '先答一半'); expect(await f.reply()).toMatchObject({ content: '先答一半', progress: { phase: 'generating' } });
  f.emit('tool_call', undefined, 'memory_history'); expect(await f.reply()).toMatchObject({ content: '先答一半', progress: { phase: 'using-tool', toolName: 'memory_history' } });
  f.emit('tool_reconciling', undefined, 'memory_history'); expect((await f.reply())?.progress).toEqual({ phase: 'using-tool', toolName: 'memory_history' });
  f.emit('tool_result'); expect((await f.reply())?.progress?.phase).toBe('preparing-context');
  f.emit('context_compacting'); expect((await f.reply())?.progress?.phase).toBe('compacting-context');
  f.emit('model_request'); expect((await f.reply())?.progress?.phase).toBe('waiting-model');
  f.emit('text_stream', '继续回答'); expect(await f.reply()).toMatchObject({ content: '继续回答', progress: { phase: 'generating' } });
  f.completion.resolve(); await until(async () => (await f.reply())?.status === 'sent' ? true : undefined);
  expect((await f.reply())?.progress).toBeUndefined(); expect(f.host).not.toHaveBeenCalled();
});
it('projects only the current step and short tool description into meeting progress', async () => {
  const f = await fixture();
  const meeting = (await f.service.handle({ type: 'call.open', conversationId: f.conversationId })).conversationId!;
  expect(meeting).toBe(f.conversationId);
  const sent = await f.service.handle({ type: 'message.send', conversationId: meeting, surface: 'call', content: '看一下文件', requestId: 'controlled' });
  f.preparation.resolve(); await until(() => f.run);
  f.emit('reasoning', '内部推理正文');
  f.emit('tool_call', JSON.stringify({ description: '核对两份文件', command: 'SECRET' }), 'shell');
  const active = await f.reply(meeting, 'call');
  expect(active?.id).toBe(sent.replyMessageIds?.[0]);
  expect((await f.reply())?.id).toBe(active?.id);
  expect(active).toMatchObject({ execution: { steps: [] }, progress: { phase: 'using-tool', toolName: 'shell', activity: { step: 4, summary: '核对两份文件' } } });
  expect(JSON.stringify(active)).not.toMatch(/SECRET|内部推理正文/u);
  f.emit('tool_result', '原始工具输出');
  expect((await f.reply(meeting, 'call'))?.progress).toEqual({ phase: 'preparing-context', toolName: undefined, activity: { step: 4, summary: undefined } });
  f.completion.resolve(); await until(async () => (await f.reply(meeting))?.status === 'sent' ? true : undefined);
  expect((await f.reply(meeting))?.progress).toBeUndefined();
  expect((await f.reply())?.parts?.some(part => part.presentation && part.text === '你好，我在。')).toBe(true);
});
it.each(['call', 'pet'] as const)('keeps a successful quiet %s observation offstage', async surface => {
  const f = await fixture(undefined, undefined, surface === 'pet' ? '[[保持安静]]' : '');
  const record = new PresenceArchive().add(f.conversationId, 'screen', new Uint8Array([1]));
  const response = f.service.presenceTarget(f.conversationId, surface).observe({
    records: [record], frames: [{ kind: 'keyframe', timestamps: ['00:00:00.000'], jpeg: 'AQ==' }],
    subtitles: [], sources: [{ kind: 'screen', from: 0, to: 0 }],
  }, new AbortController().signal);
  const run = await until(() => f.run);
  expect(run.workerTools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'call_present' })]));
  expect(JSON.parse(run.prompt).observation.keyframes[0].timestamp).toBe('00:00:00.000');
  f.completion.resolve();
  const result = await response;
  expect(result?.reaction).toBe('');
  const reply = await f.reply(f.conversationId, 'call');
  expect(reply?.parts?.length ?? 0).toBe(0);
});
it('preempts an admitted observation when a user message arrives even without a renderer status poll', async () => {
  const f = await fixture(), target = f.service.presenceTarget(f.conversationId, 'call');
  const record = new PresenceArchive().add(f.conversationId, 'screen', new Uint8Array([1]));
  const observed = target.observe({ records: [record], frames: [{ kind: 'keyframe', timestamps: ['00:00:00.000'], jpeg: 'AQ==' }],
    sources: [{ kind: 'screen', from: 0, to: 0 }], subtitles: [] }, new AbortController().signal);
  const background = await until(() => f.run);
  expect(target.busy()).toBe(false);
  const message = await f.send();
  expect(message.ok).toBe(true);
  expect(await observed).toBeUndefined();
  expect(background.signal?.aborted).toBe(true);
  expect(target.busy()).toBe(true);
});
it('carries a quiet observation into the next heartbeat of the same topic', async () => {
  const note = '文档标题已更新。', f = await fixture(undefined, undefined, '[[保持安静]]' + note);
  const target = f.service.presenceTarget(f.conversationId, 'pet');
  const record = new PresenceArchive().add(f.conversationId, 'screen', new Uint8Array([1]));
  const sample = { records: [record], frames: [{ kind: 'keyframe' as const, timestamps: ['00:00:00.000'], jpeg: 'AQ==' }],
    subtitles: [], sources: [{ kind: 'screen' as const, from: 0, to: 0 }] };
  f.completion.resolve();
  const first = await target.observe(sample, new AbortController().signal);
  expect(first).toMatchObject({ reaction: '', note });
  await target.observe(sample, new AbortController().signal);
  expect(JSON.parse(f.run!.prompt).observation.previousObservations).toEqual([note]);
});
it('keeps a crashed memory preparation terminal and readable, preserves the source and reports the original technical error once', async () => {
  const original = Object.assign(new Error('Memory session closed (exit 3221226505)'), { code: 'MEMORY_SESSION_CLOSED' }), f = await fixture(original);
  await f.send(); await until(() => f.prepares ? true : undefined); f.preparation.resolve();
  await until(async () => (await f.reply())?.status === 'failed' ? true : undefined);
  expect((await f.reply())?.error).toBe('记忆服务异常退出，本条消息已保留；可重试。');
  expect(f.service.store.messagesPage(f.conversationId).items.find(message => message.senderId === 'user')?.content).toBe('你好');
  expect(f.prepares).toBe(1); expect(f.reported).toEqual([original]); expect(f.run).toBeUndefined(); expect(f.host).not.toHaveBeenCalled();
});
it('persists a v3 interaction diary even when semantic encoding returns no notes', async () => {
  const f = await fixture(); await f.send('刚刚我们一起讨论了桌面整理，尚未动手。'); f.preparation.resolve(); await until(() => f.run); f.completion.resolve();
  await until(async () => (await f.reply())?.status === 'sent' ? true : undefined);
  const companionId = f.service.store.getConversation(f.conversationId)!.memberIds.find(id => id !== 'user')!;
  const scope = { companionId, conversationId: f.conversationId, securityDomainId: f.service.store.getConversation(f.conversationId)!.securityDomainId };
  await until(() => f.service.store.memoryActivity(scope).capture.withNotes === 1 ? true : undefined);
  const response = await f.service.handle({ type: 'memory.catalog', companionId, conversationId: f.conversationId, limit: 24 });
  expect(response.memory).toMatchObject({ total: 0, activity: { capture: { empty: 0, withNotes: 1, unknownDone: 0, queued: 0, running: 0 } } });
  expect(f.host).not.toHaveBeenCalled();
});
