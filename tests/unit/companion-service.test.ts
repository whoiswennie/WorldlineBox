import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { DshLauncherResponse } from '../../src/shared/dsh-launcher';
import type { DshTaskEvent, DshTaskRecord } from '../../src/shared/dsh-tasks';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import { CompanionService } from '../../src/main/companions/service';
import type { BrowserWindow } from 'electron';
import { COMPANION_REPLY_STREAM_CHANNEL, type CompanionReplyStreamEvent } from '../../src/shared/companions';

const transport = vi.hoisted(() => ({
  request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>(), memoryFetch: vi.fn<typeof fetch>(),
  worldFetch: vi.fn<typeof fetch>(),
  send: vi.fn<(channel: string, payload?: unknown) => void>(),
}));

// Exercise the real service and real SQLite contract; only its utility-process transport is replaced.
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = transport.start;
  request = transport.request;
  close = transport.close;
} }));
vi.mock('electron', () => ({
  net: { fetch: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => /memory_(?:extraction|query|maintenance|dream)/u.test(String(init?.body))
    ? transport.memoryFetch(input, init) : /world_(?:decision|attention)/u.test(String(init?.body)) ? transport.worldFetch(input, init) : transport.fetch(input, init)) }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() },
}));

const seeds: CompanionSeed[] = [{ id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳',
  model: '', avatar: 'sister', proactive: false }];
const roots: string[] = [];
const stores = new Set<CompanionsStore>();
const services = new Set<CompanionService>();
const fixedTime = '2026-10-13T02:00:00Z';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(fixedTime));
  transport.fetch.mockReset();
  transport.memoryFetch.mockReset();
  transport.worldFetch.mockReset(); transport.worldFetch.mockImplementation(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'world_attention') return modelResponseForJson({ urgency: data.source.content === '醒醒，有件紧急的事需要你帮忙。' ? 'urgent' : 'ordinary',
      confidence: .95, evidence: [data.source.content], reason: '测试中实际通知的明确语义分类。' });
    return modelResponseForJson({ action: null, reason: '当前没有需要打扰的世界事件。', appraisals: [] });
  });
  transport.memoryFetch.mockImplementation(async (_url, init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(/memory_dream/u.test(String(init?.body)) ? { candidates: [], dream: null } : { candidates: [] }) } }] }),
    { headers: { 'Content-Type': 'application/json' } }));
  transport.fetch.mockImplementation(async () => modelResponse('这次执行未成功，详情保存在行动卡中。'));
});
afterEach(async () => {
  for (const service of services) await closeService(service);
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots.splice(0)) {
    // Delete only directories created by this test, directly beneath its explicit temporary parent.
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-companion-service-')) {
      throw new Error('Unexpected companion test cleanup target.');
    }
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function modelResponse(text: string, action?: { title: string; prompt: string }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text, memories: [], ...(action ? { action } : {}) }),
    reasoning_content: 'PRIVATE_PROVIDER_THINKING' } }] }),
    { headers: { 'Content-Type': 'application/json' } });
}
function modelResponseForJson(value: unknown): Response { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } }); }
function sourceContext(serialized: string) {
  const { hostClock: _clock, runtimeState: _state, runtimeBehavior: _behavior, world: _world, worldTrust: _worldTrust, ...sources } = JSON.parse(serialized);
  void _clock; void _state; void _behavior; void _world; void _worldTrust;
  return sources;
}
function taskRecord(status: DshTaskRecord['status'] = 'running'): DshTaskRecord {
  return { id: 'dsh-task', operationId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0',
    title: '整理文件', status, startedAt: fixedTime };
}
function fakeDsh(state: () => { tasks: DshTaskRecord[]; operations: Array<{ id: string; status: string }> },
  requestTask: DshLauncher['requestTask']): DshLauncher {
  return { state, requestTask } as unknown as DshLauncher;
}
function fixture(dsh: DshLauncher, publish = false, prepareComputer = true) {
  const testNow = Date.now(); if (prepareComputer) vi.setSystemTime(testNow - 10_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-service-'));
  roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const store = new CompanionsStore(databasePath, seeds);
  stores.add(store);
  const conversation = store.openPrivate('sister');
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '帮我整理这些文件。' });
  if (prepareComputer) {
    const computer = world.scenes.find(scene => scene.ownerId === 'sister')!.objects.find(object => object.kind === 'computer')!;
    store.request({ type: 'world.tool', companionId: 'sister', conversationId: conversation.id, sourceMessageId: source.id,
      arguments: { action: 'move', destinationId: computer.id } });
    vi.setSystemTime(testNow); store.request({ type: 'world.tick' });
  }
  bindStorage(store);
  const service = startService(root, dsh, publish);
  return { root, databasePath, store, service, conversation, source };
}
function bindStorage(store: CompanionsStore) {
  transport.request.mockImplementation(async command => store.request(command));
  transport.close.mockImplementation(async () => { store.close(); stores.delete(store); });
}
function startService(root: string, dsh: DshLauncher, publish = false): CompanionService {
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', window: () => publish
    ? { isDestroyed: () => false, webContents: { send: transport.send } } as unknown as BrowserWindow : undefined,
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'test-key' }),
    hasConfig: () => true, dsh: () => dsh, report: vi.fn() });
  services.add(service);
  return service;
}
async function closeService(service: CompanionService) {
  const done = service.shutdown();
  // Polling jobs use one-second timers; shutdown must settle after this tick, without replaying a task.
  await vi.advanceTimersByTimeAsync(1_000);
  await done;
  services.delete(service);
}

function replyEvents(): CompanionReplyStreamEvent[] {
  return transport.send.mock.calls.filter(([channel]) => channel === COMPANION_REPLY_STREAM_CHANNEL).map(([, value]) => value as CompanionReplyStreamEvent);
}
function modelStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, cancel, send(delta: unknown, finish_reason: string | null = null) {
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'));
  } };
}

describe('CompanionService actual streaming with SQLite and renderer events', () => {
  it('publishes the first real fragment before completion while durable drafts stay out of history and memory', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), true), stream = modelStream();
    transport.fetch.mockResolvedValueOnce(stream.response);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '聊聊今天的计划', clientId: 'stream-visible' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1), { timeout: 5000 });
    stream.send({ reasoning_content: 'PRIVATE_STREAM_THOUGHT', content: '流式标记，' });
    await vi.waitFor(() => expect(replyEvents().some(event => event.text === '流式标记，' && event.phase === 'streaming')).toBe(true), { timeout: 5000 });
    const event = replyEvents().find(event => event.text === '流式标记，')!;
    expect(event.sourceMessageId).toBe(source.id);
    expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.turns).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    expect(f.store.getMessage(event.messageId)).toMatchObject({ content: '流式标记，', isReplyDraft: true, replyDraft: { text: '流式标记，' } });
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [event.messageId] }).memorySources).toEqual([]);
    expect(f.store.request({ type: 'message.search', conversationId: f.conversation.id, query: '流式标记' }).messages).toEqual([]);
    const jobIds: string[] = [];
    for (let i = 0; i < 10; i++) { const job = f.store.request({ type: 'memory.jobs.claim' }).memoryJob; if (!job) break; jobIds.push(...job.sourceMessageIds);
      f.store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken!, candidates: [] }); }
    expect(jobIds).not.toContain(event.messageId);
    stream.send({ content: '现在已经完整回答。' }, 'stop');
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(f.store.getMessage(event.messageId)).toMatchObject({ content: '流式标记，现在已经完整回答。' });
    expect(f.store.getMessage(event.messageId).isReplyDraft).toBeUndefined();
    expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [event.messageId] }).memorySources?.map(message => message.id)).toEqual([event.messageId]);
    expect(f.store.request({ type: 'message.search', conversationId: f.conversation.id, query: '流式标记' }).messages?.map(message => message.id)).toEqual([event.messageId]);
    expect(f.store.request({ type: 'memory.jobs.claim' }).memoryJob?.sourceMessageIds).toContain(event.messageId);
    expect(JSON.stringify(replyEvents())).not.toContain('PRIVATE_STREAM_THOUGHT'); expect(stream.cancel).toHaveBeenCalled();
  });

  it('waits for complete native tool arguments and the provider terminal before performing a real action', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run' ? { ok: true, operationId: 'dsh-task' }
      : request.type === 'task.result' ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '实际只读检查完成。' } } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [] }), requestTask), true), stream = modelStream();
    transport.fetch.mockResolvedValueOnce(stream.response).mockImplementation(async () => modelResponse('检查完成，没有修改文件。'));
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '只读检查这些文件，禁止修改。', clientId: 'stream-native' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    stream.send({ content: '我开始只读检查。', tool_calls: [{ index: 0, id: 'stream-tool', function: { name: 'dsh', arguments: '{"tasks":[{"title":"只读检查",' } }] });
    await vi.advanceTimersByTimeAsync(800);
    expect(f.store.listAction(f.conversation.id)).toEqual([]); expect(requestTask).not.toHaveBeenCalled();
    stream.send({ tool_calls: [{ index: 0, function: { arguments: '"prompt":"只读检查文件，禁止修改。"}]}' } }] });
    await vi.advanceTimersByTimeAsync(20);
    expect(f.store.listAction(f.conversation.id)).toEqual([]); expect(requestTask).not.toHaveBeenCalled();
    stream.send({}, 'tool_calls');
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    const loop = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(loop.turns[0]?.calls[0]).toMatchObject({ id: 'stream-tool', name: 'dsh' });
    expect(f.store.getMessage(loop.messageId!).segments?.map(segment => segment.text)).toEqual(['我开始只读检查。', '检查完成，没有修改文件。']);
    expect(replyEvents().filter(event => event.phase === 'streaming').every(event => !event.text.includes('"tasks"') && !event.text.includes('"prompt"'))).toBe(true);
  });

  it('cancels the actual reader and resumes into the same bubble with a new attempt replacing the interrupted draft', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), true), first = modelStream(), second = modelStream();
    transport.fetch.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '回答这个问题', clientId: 'stream-resume' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    first.send({ content: '旧的未完成草稿' }); await vi.advanceTimersByTimeAsync(800);
    const old = replyEvents().find(event => event.text === '旧的未完成草稿')!;
    expect(f.store.getMessage(old.messageId).replyDraft?.text).toBe('旧的未完成草稿');
    await f.service.handle({ type: 'reply.cancel', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(f.store.request({ type: 'reply.checkpoint.get', conversationId: f.conversation.id }).replyRecovery?.status).toBe('interrupted'), { timeout: 5000 });
    expect(first.cancel).toHaveBeenCalled();
    await f.service.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const restarted = replyEvents().findLast(event => event.phase === 'streaming' && event.text === '')!;
    expect(restarted.messageId).toBe(old.messageId); expect(restarted.attemptId).not.toBe(old.attemptId);
    second.send({ content: '新的答案' }); await vi.advanceTimersByTimeAsync(800);
    expect(f.store.getMessage(old.messageId).content).toBe('新的答案');
    second.send({ content: '已完成。' }, 'stop');
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    const bubbles = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'sister');
    expect(bubbles).toHaveLength(1); expect(bubbles[0]).toMatchObject({ id: old.messageId, content: '新的答案已完成。' });
    expect(bubbles[0]?.replyDraft).toBeUndefined();
    expect(f.store.request({ type: 'message.search', conversationId: f.conversation.id, query: '旧的未完成草稿' }).messages).toEqual([]);
    expect(replyEvents().filter(event => event.phase === 'committed').map(event => event.text)).toEqual(['新的答案已完成。']);
  });
  it('does not start a late action when cancellation happens while its durable creation is still awaiting storage', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask), true), stream = modelStream();
    const entered = deferred<void>(), release = deferred<void>();
    transport.request.mockImplementation(async command => {
      if (command.type === 'action.create') { entered.resolve(); await release.promise; }
      return f.store.request(command);
    });
    transport.fetch.mockResolvedValueOnce(stream.response);
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '只读检查文件。', clientId: 'stream-late-cancel' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    stream.send({ tool_calls: [{ index: 0, id: 'late-create', function: { name: 'dsh', arguments: JSON.stringify({ tasks: [{ title: '检查', prompt: '只读检查文件。' }] }) } }] }, 'tool_calls');
    await entered.promise;
    expect(f.store.listAction(f.conversation.id)).toEqual([]);
    await f.service.handle({ type: 'reply.cancel', conversationId: f.conversation.id }); release.resolve();
    await vi.waitFor(() => expect(f.store.listAction(f.conversation.id)[0]?.status).toBe('cancelled'), { timeout: 5000 });
    expect(requestTask.mock.calls.some(([request]) => request.type === 'task.run')).toBe(false);
  });
});

describe('CompanionService DSH action lifecycle with real SQLite', () => {
  it('observes the world without broadcasting a global chat change for each read', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), true);
    await f.service.handle({ type: 'state' }); await vi.advanceTimersByTimeAsync(1); transport.send.mockClear();
    await f.service.handle({ type: 'world.snapshot' });
    await f.service.handle({ type: 'world.observe', companionId: 'sister', conversationId: f.conversation.id });
    expect(transport.send).not.toHaveBeenCalled();
  });
  it('shows real movement before any task inference and releases the computer when the user cancels on the way', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask), false, false);
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '请解释这段代码。', clientId: 'walking-before-inference' });
    await vi.advanceTimersByTimeAsync(1000);
    const walking = f.store.request({ type: 'world.snapshot' }).world!;
    expect(walking.works.some(work => work.kind === 'chat' && work.status === 'moving')).toBe(true);
    expect(walking.actors[0]!.route.length).toBeGreaterThan(0);
    expect(transport.fetch).not.toHaveBeenCalled(); expect(requestTask).not.toHaveBeenCalled();
    await f.service.handle({ type: 'reply.cancel', conversationId: f.conversation.id });
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = f.store.request({ type: 'world.snapshot' }).world!;
    expect(stopped.works.every(work => work.status === 'ended')).toBe(true);
    expect(stopped.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
  it('classifies a deadline while awake but away from a computer before choosing running speed or primary inference', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const content = '两分钟后就截止了，快救我核对这句话。';
    transport.worldFetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return modelResponseForJson(data.purpose === 'world_attention' ? { urgency: 'urgent', confidence: .98, evidence: [data.source.content], reason: '实际用户当前临近截止并请求立即协助。' }
        : { action: null, reason: '暂不处理其他世界动作。', appraisals: [] });
    });
    transport.fetch.mockImplementation(async (_url, init) => {
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(context.world.actors[0]).toMatchObject({ activity: 'working', locomotion: 'run', furnitureId: 'sister_computer' });
      return modelResponse('文字检查完成。');
    });
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content, clientId: 'awake-deadline' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.store.request({ type: 'world.snapshot' }).world!.actors[0]!.locomotion).toBe('run'); expect(transport.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000); expect(transport.fetch).toHaveBeenCalledTimes(1);
  });

  it('perceives an implicit deadline notification while asleep, without waking for quoted urgency, negation or conditional instructions', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const routine = (await f.service.handle({ type: 'routine.get', ...scope })).routine!;
    await f.service.handle({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '01:00', wakeAt: '03:00', meals: [], habits: [] } });
    const ordinaryTexts = ['如果电脑占用就马上帮我换。', '新闻写着“紧急任务”。', '不紧急，你睡醒再说。'];
    const deadline = '两分钟后就截止了，快救我看看哪里写错。';
    transport.worldFetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      expect(request.tools).toBeUndefined();
      if (data.purpose === 'world_attention') return modelResponseForJson({ urgency: data.source.content === deadline ? 'urgent' : 'ordinary', confidence: .97,
        evidence: [data.source.content], reason: data.source.content === deadline ? '当前本人临近截止并实际求助。' : '只有条件、引用或明确否定，没有要求打断。' });
      return modelResponseForJson({ action: null, reason: '没有需要执行的世界动作。', appraisals: [] });
    });
    const ordinary = [];
    for (const [index, content] of ordinaryTexts.entries()) ordinary.push((await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content, clientId: 'ordinary-notification-' + index })).message!);
    await vi.advanceTimersByTimeAsync(1000); expect(transport.fetch).not.toHaveBeenCalled();
    const urgent = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: deadline, clientId: 'implicit-deadline' })).message!;
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(f.store.request({ type: 'world.snapshot' }).world!.actors[0]).toMatchObject({ activity: 'walking', locomotion: 'run' });
    await vi.advanceTimersByTimeAsync(12000);
    expect(f.store.request({ type: 'work.list', sourceMessageId: urgent.id }).works?.[0]?.status).toBe('done');
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.parse(String(transport.fetch.mock.calls[0]?.[1]?.body)).messages[1].content).taskRequest.prompt).toBe(deadline);
    for (const source of ordinary) expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.[0]?.status).toBe('queued');
  });

  it('calls the primary model only while seated and returns a real native world inspection in its next tool turn', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    let observed = false;
    transport.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      expect(data.world.actors.find((actor: { companionId: string }) => actor.companionId === 'sister').activity).toBe('working');
      expect(data.world.works.some((work: { status: string }) => work.status === 'ready')).toBe(true);
      const tool = request.messages.findLast((message: { role: string }) => message.role === 'tool');
      if (!tool) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'inspect-actual-world', type: 'function', function: { name: 'world', arguments: '{"action":"inspect"}' } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
      expect(JSON.parse(tool.content).world.actors[0].furnitureId).toBe('sister_computer'); observed = true;
      return modelResponse('我在自己的电脑前，已经坐好了。');
    });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '看看你现在在哪里。', clientId: 'native-world' })).message!;
    await vi.advanceTimersByTimeAsync(1000); expect(transport.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12000);
    expect(observed).toBe(true);
    expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.[0]?.status).toBe('done');
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false);
  });

  it('wakes and walks for a fixed promise but cancels a reminder before arrival without sending or holding a computer', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const routine = (await f.service.handle({ type: 'routine.get', ...scope })).routine!;
    await f.service.handle({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '01:00', wakeAt: '03:00', meals: [], habits: [] } });
    const result = await f.service.handle({ type: 'schedule.create', ...scope, entries: [{ title: '约好的喝水提醒', prompt: '提醒我喝水', kind: 'reminder', runAt: '2026-10-13T02:00:02Z', timeZone: 'UTC', recurrence: 'once', flexible: false }] });
    await vi.advanceTimersByTimeAsync(2100);
    expect(f.store.request({ type: 'world.snapshot' }).world!.works.some(work => work.kind === 'schedule' && work.status === 'moving')).toBe(true);
    const current = (await f.service.handle({ type: 'schedule.list', ...scope, includeHistory: false, limit: 100 })).schedules!.find(schedule => schedule.id === result.schedules![0]!.id)!;
    await f.service.handle({ type: 'schedule.cancel', ...scope, id: current.id, expectedRevision: current.revision });
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'sister' && message.content.includes('约好的喝水提醒'))).toHaveLength(0);
    const world = f.store.request({ type: 'world.snapshot' }).world!;
    expect(world.works.every(work => work.status === 'ended')).toBe(true);
    expect(world.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('creates native scheduled reminders from the actual request and sends each occurrence once across restart', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    let submitted = false;
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.messages[1].content);
      expect(context.hostClock.now).toBeDefined();
      expect(context.runtimeState.companionId).toBe('sister');
      if (submitted) return modelResponse('两项提醒已经设置好了。');
      submitted = true;
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'calendar-create', type: 'function',
        function: { name: 'schedule', arguments: JSON.stringify({ action: 'create', entries: [
          { title: '喝水', prompt: '提醒我喝水', kind: 'reminder', runAt: '2026-10-13T02:00:02Z' },
          { title: '休息', prompt: '提醒我站起来休息', kind: 'reminder', runAt: '2026-10-13T02:00:05Z' },
        ] }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id,
      content: '请设置两个定时提醒，2 秒后喝水，5 秒后休息。', clientId: 'native-schedule-request' })).message!;
    await vi.waitFor(() => expect(f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id }).schedules).toHaveLength(2), { timeout: 5000 });
    expect(f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id }).schedules?.every(schedule => schedule.sourceMessageId === source.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    const listed = f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true });
    expect(listed.scheduleOccurrences).toHaveLength(2);
    expect(listed.scheduleOccurrences?.every(occurrence => occurrence.status === 'done')).toBe(true);
    const ids = listed.scheduleOccurrences!.map(occurrence => occurrence.messageId);
    expect(new Set(ids).size).toBe(2);
    expect(f.store.request({ type: 'messages', conversationId: f.conversation.id, limit: 50 }).messages?.filter(message => ids.includes(message.id))).toHaveLength(2);
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await restarted.handle({ type: 'state' }); await vi.advanceTimersByTimeAsync(5_000);
    expect(reopened.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true }).scheduleOccurrences).toHaveLength(2);
    expect(reopened.request({ type: 'messages', conversationId: f.conversation.id, limit: 50 }).messages?.filter(message => ids.includes(message.id))).toHaveLength(2);
  });

  it('dispatches an authorized scheduled task through the real action lifecycle and preserves its read-only restriction', async () => {
    const record = { ...taskRecord('succeeded'), sessionId: 'scheduled-session', accessMode: 'danger-full-access' as const };
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'dsh-task' } : request.type === 'task.result'
        ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', sessionId: 'scheduled-session', text: '已实际只读检查文件清单，没有写入。' } }
        : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [record], operations: [] }), requestTask));
    await f.service.handle({ type: 'schedule.create', companionId: 'sister', conversationId: f.conversation.id,
      clientId: 'ui-scheduled-task', entries: [{ title: '检查文件', prompt: '只读检查文件清单，禁止写入、删除或移动任何文件。', kind: 'task', runAt: '2026-10-13T02:00:02Z', timeZone: 'system', recurrence: 'once', flexible: false }] });
    await vi.advanceTimersByTimeAsync(5_000);
    const listed = await f.service.handle({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true, limit: 100 });
    expect(listed.scheduleOccurrences).toHaveLength(1);
    expect(listed.scheduleOccurrences![0]).toMatchObject({ status: 'done', result: expect.stringContaining('只读') });
    const run = requestTask.mock.calls.find(([request]) => request.type === 'task.run')![0];
    expect(run.type === 'task.run' && run.prompt).toContain('禁止写入、删除或移动');
    expect(f.store.listAction(f.conversation.id)[0]).toMatchObject({ status: 'succeeded', scheduleOccurrenceId: listed.scheduleOccurrences![0]!.id });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
  });

  it('feeds an evidence-based emotional event into the next actual inference and rejects unrelated historical state sources', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    const initial = f.store.request({ type: 'state.get', companionId: 'sister', conversationId: f.conversation.id }).runtimeState!;
    const contexts: Array<{ runtimeState: typeof initial; taskRequest: { sourceMessageId: string; prompt: string } }> = [];
    const native = (id: string, args: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'state', arguments: JSON.stringify(args) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
    let step = 0;
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.messages[1].content); contexts.push(context);
      if (step++ === 0) return native('state-inspect', { action: 'inspect' });
      if (step === 2) {
        const inspected = JSON.parse(body.messages.findLast((message: { role: string }) => message.role === 'tool').content).runtimeState;
        return native('state-support', { action: 'update', expectedRevision: inspected.revision, proposal: {
          expression: 'gentle', reason: '用户明确表达感谢和支持。', sourceMessageIds: [context.taskRequest.sourceMessageId],
          evidence: [{ sourceMessageId: context.taskRequest.sourceMessageId, quote: context.taskRequest.prompt }],
          appraisals: [{ type: 'support', target: 'user', intensity: 0.8, confidence: 0.95 }],
        } });
      }
      if (step === 3) {
        expect(context.runtimeState.affect.pleasure).toBeGreaterThan(initial.affect.pleasure);
        expect(context.runtimeState.relationship.affinity).toBeGreaterThan(initial.relationship.affinity);
        return native('unrelated-past-state', { action: 'update', expectedRevision: context.runtimeState.revision, proposal: {
          focus: '未经本次互动授权的旧关注', reason: '旧用户消息。', sourceMessageIds: [f.source.id], evidence: [{ sourceMessageId: f.source.id, quote: f.source.content }], appraisals: [],
        } });
      }
      const last = body.messages.findLast((message: { role: string }) => message.role === 'tool');
      expect(JSON.parse(last.content)).toMatchObject({ ok: false, error: expect.stringContaining('本次真实互动') });
      return modelResponse('听到你的支持很开心，我们继续吧。');
    });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id,
      content: '谢谢你一直认真帮我，我很珍惜你的支持。', clientId: 'emotional-support' })).message!;
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.every(work => work.status === 'done')).toBe(true), { timeout: 5000 });
    expect(contexts).toHaveLength(4);
    const updated = f.store.request({ type: 'state.get', companionId: 'sister', conversationId: f.conversation.id }).runtimeState!;
    expect(updated.sourceMessageIds).toContain(source.id);
    expect(updated.focus).not.toBe('未经本次互动授权的旧关注');
    expect(updated.relationship.affinity).toBeGreaterThan(initial.relationship.affinity);
  });

  it('does not let an ordinary greeting immediately run a remembered future task', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    const created = await f.service.handle({ type: 'schedule.create', companionId: 'sister', conversationId: f.conversation.id,
      clientId: 'future-only', entries: [{ title: '明天的检查', prompt: '只读检查清单', kind: 'task', runAt: '2026-10-14T02:00:00Z', timeZone: 'system', recurrence: 'once', flexible: false }] });
    const schedule = created.schedules![0]!;
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'unauthorized-now', type: 'function',
      function: { name: 'schedule', arguments: JSON.stringify({ action: 'run-now', id: schedule.id, expectedRevision: schedule.revision }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } }))
      .mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(JSON.parse(body.messages.findLast((message: { role: string }) => message.role === 'tool').content)).toMatchObject({ ok: false, error: expect.stringContaining('本次用户明确') });
        return modelResponse('你好，今天过得怎么样？');
      });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '你好', clientId: 'greeting-no-schedule-consent' })).message!;
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.every(work => work.status === 'done')).toBe(true), { timeout: 5000 });
    expect(requestTask).not.toHaveBeenCalled();
    expect(f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true }).scheduleOccurrences).toHaveLength(0);
  });

  it('cancels both the future schedule and its actual running task', async () => {
    let stopped = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.cancel') stopped = true;
      return request.type === 'task.run' ? { ok: true, operationId: 'dsh-task' } : { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(stopped ? 'cancelled' : 'running')], operations: [] }), requestTask));
    const created = await f.service.handle({ type: 'schedule.create', companionId: 'sister', conversationId: f.conversation.id,
      entries: [{ title: '定时检查', prompt: '只读检查文件', kind: 'task', runAt: '2026-10-13T02:00:02Z', timeZone: 'system', recurrence: 'daily', flexible: false }] });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(f.store.listAction(f.conversation.id)[0]?.status).toBe('running'), { timeout: 5000 });
    const current = f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id }).schedules!.find(schedule => schedule.id === created.schedules![0]!.id)!;
    await f.service.handle({ type: 'schedule.cancel', companionId: 'sister', conversationId: f.conversation.id, id: current.id, expectedRevision: current.revision });
    expect(stopped).toBe(true);
    expect(f.store.listAction(f.conversation.id)[0]?.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true }).scheduleOccurrences![0]!.status).toBe('cancelled');
    expect(f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id }).schedules![0]!.nextRunAt).toBeUndefined();
  });

  it('queues ordinary sleeping chat, wakes for an actual urgent request, and resumes the older chat only at normal wake time', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    const routine = (await f.service.handle({ type: 'routine.get', companionId: 'sister', conversationId: f.conversation.id })).routine!;
    await f.service.handle({ type: 'routine.configure', companionId: 'sister', conversationId: f.conversation.id,
      expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '01:00', wakeAt: '03:00', meals: [], habits: [] } });
    const observed: string[] = [];
    transport.fetch.mockImplementation(async (_url, init) => {
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      observed.push(context.taskRequest.prompt);
      expect(context.runtimeState.routine.canRespond).toBe(true);
      return modelResponse('我在，先处理你这条消息。');
    });
    const ordinary = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '有空时陪我聊聊吧。', clientId: 'sleeping-ordinary' })).message!;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.fetch).not.toHaveBeenCalled();
    expect(f.store.request({ type: 'work.list', sourceMessageId: ordinary.id }).works?.[0]?.status).toBe('queued');
    const urgent = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '醒醒，有件紧急的事需要你帮忙。', clientId: 'actual-urgent' })).message!;
    await vi.advanceTimersByTimeAsync(12000); // Finish any actual wake, turn, walk and sit transitions.
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: urgent.id }).works?.[0]?.status).toBe('done'), { timeout: 5000 });
    expect(observed).toEqual(['醒醒，有件紧急的事需要你帮忙。']);
    expect(f.store.request({ type: 'work.list', sourceMessageId: ordinary.id }).works?.[0]?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(10000); // Returning to bed is physical movement, not an immediate phase label.
    expect((await f.service.handle({ type: 'routine.get', companionId: 'sister', conversationId: f.conversation.id })).routine?.runtime.phase).toBe('sleeping');
    vi.setSystemTime('2026-10-13T03:00:00Z'); await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: ordinary.id }).works?.[0]?.status).toBe('done'), { timeout: 5000 });
    expect(observed).toEqual(['醒醒，有件紧急的事需要你帮忙。', '有空时陪我聊聊吧。']);
  });

  it('reports offline on an observed authentication failure and clears that observation after the connection changes', async () => {
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })));
    const f = fixture(dsh);
    let configured = false; let apiKey = 'original-test-key';
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const service = new CompanionService({ userData: f.root, workerPath: 'mocked-worker', window: () => undefined,
      getConfig: () => ({ apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey }), hasConfig: () => configured,
      dsh: () => dsh, report: vi.fn() }); services.add(service);
    expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('offline');
    configured = true;
    expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('ready');
    transport.fetch.mockImplementation(async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '连接状态验证', clientId: 'presence-auth' });
    await vi.waitFor(async () => expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('offline'), { timeout: 5000 });
    const unavailable = (await service.handle({ type: 'state' })).state!.companions[0]!;
    expect(unavailable.availabilityReason).toBeTruthy(); expect(JSON.stringify(unavailable)).not.toContain(apiKey);
    apiKey = 'replacement-test-key';
    expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('ready');
  });
  it('dissolves a group, cancels its native task and durable queue, and never resumes them on restart', async () => {
    let stopped = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.cancel') stopped = true;
      return request.type === 'task.run' ? { ok: true, operationId: 'dsh-task' } : { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(stopped ? 'cancelled' : 'running')], operations: [] }), requestTask));
    const group = f.store.createConversation('', ['sister']);
    const source = f.store.appendMessage({ conversationId: group.id, authorId: 'user', content: '群里的工作', replyDirective: 'auto' });
    await f.service.handle({ type: 'action.run', conversationId: group.id, companionId: 'sister', sourceMessageId: source.id, title: '群聊能力', prompt: '运行这个群的任务' });
    await vi.waitFor(() => expect(f.store.listAction(group.id)[0]?.taskId).toBe('dsh-task'), { timeout: 5000 });
    f.store.request({ type: 'work.enqueue', work: { id: 'group-queue', sourceMessageId: source.id, conversationId: group.id, companionId: 'sister', status: 'queued', proactive: false, createdAt: source.createdAt, updatedAt: source.createdAt } });
    await f.service.handle({ type: 'conversation.delete', id: group.id, mode: 'dissolve' });
    expect(requestTask).toHaveBeenCalledWith({ type: 'task.cancel', taskId: 'dsh-task' });
    expect(f.store.listAction(group.id)[0]?.status).toBe('cancelled');
    expect(f.store.request({ type: 'work.list' }).works?.find(work => work.id === 'group-queue')?.status).toBe('cancelled');
    expect(f.store.state().conversations.some(room => room.id === group.id)).toBe(false);
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await restarted.handle({ type: 'state' }); await vi.advanceTimersByTimeAsync(1000);
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    expect(reopened.state().recoveries).toHaveLength(0);
  });
  it('resumes the same native session and original access after closing the app mid-task', async () => {
    let resumed = false, stopped = false;
    const original = { ...taskRecord(), runtimeVersion: '0.2.1-alpha.2', sessionId: 'session-original', accessMode: 'read-only' as const, workspacePath: process.cwd() };
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') { if (request.sessionId) resumed = true; return { ok: true, operationId: resumed ? 'resumed-task' : 'dsh-task' }; }
      if (request.type === 'task.cancel') stopped = true;
      if (request.type === 'task.result') return { ok: true, taskResult: { taskId: resumed ? 'resumed-task' : 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '0.2.1-alpha.2', sessionId: 'session-original', text: '原会话剩余工作已经完成' } };
      return { ok: true };
    });
    const dsh = fakeDsh(() => ({ tasks: [{ ...original, ...(resumed ? { id: 'resumed-task', operationId: 'resumed-task' } : {}), status: resumed ? 'succeeded' : stopped ? 'cancelled' : 'running' }], operations: [] }), requestTask);
    const f = fixture(dsh);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id, title: '半途工作', prompt: '完成两个阶段，已经写入的第一阶段不要再写。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.sessionId).toBe('session-original'), { timeout: 5000 });
    const id = f.store.listAction()[0]!.id;
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    await restarted.handle({ type: 'action.resume', id });
    await vi.waitFor(() => expect(reopened.getAction(id).status).toBe('succeeded'), { timeout: 5000 });
    const resumeCall = requestTask.mock.calls.find(([request]) => request.type === 'task.run' && request.sessionId === 'session-original')!;
    expect(resumeCall[0]).toMatchObject({ instanceId: 'instance', sessionId: 'session-original' });
    expect(resumeCall[1]).toMatchObject({ access: { mode: 'read-only' }, resume: { runtimeVersion: '0.2.1-alpha.2', workspacePath: process.cwd(), sessionId: 'session-original' } });
    expect(reopened.listAction(f.conversation.id)).toHaveLength(1);
    expect(reopened.getAction(id)).toMatchObject({ attempt: 2, result: '原会话剩余工作已经完成' });
    await closeService(restarted);
  });
  it('recovers only the unfinished group speaker after shutdown before a DSH call', async () => {
    const pending = deferred<Response>();
    transport.fetch.mockImplementationOnce(async () => modelResponse('姐姐已经说完。')).mockImplementationOnce(() => pending.promise);
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), requestTask), f = fixture(dsh);
    const flash = f.store.createCompanion({ name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false });
    const group = f.store.createConversation('', ['sister', flash.id]);
    await f.service.handle({ type: 'message.send', conversationId: group.id, content: '大家聊聊今天的心情吧。', clientId: 'group-recovery-source', delivery: 'chat' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 12000 });
    const closing = closeService(f.service); pending.resolve(modelResponse('这条未完成的回复不应写入。')); await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    expect((await restarted.handle({ type: 'state' })).state?.recoveries).toEqual([expect.objectContaining({ completedIds: ['sister'], status: 'interrupted' })]);
    transport.fetch.mockImplementation(async () => modelResponse('妹妹继续之前的话题。'));
    await restarted.handle({ type: 'reply.resume', conversationId: group.id });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: group.id }).messages.some(message => message.content === '妹妹继续之前的话题。')).toBe(true), { timeout: 5000 });
    const messages = reopened.messages({ conversationId: group.id }).messages;
    expect(messages.filter(message => message.content === '姐姐已经说完。')).toHaveLength(1);
    expect(messages.some(message => message.content === '这条未完成的回复不应写入。')).toBe(false);
    expect(requestTask).not.toHaveBeenCalled();
    await closeService(restarted);
  });



  it('reports an executor result without claiming the user goal succeeded when companion feedback fails', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') return { ok: true, operationId: 'dsh-task' };
      if (request.type === 'task.result') return { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance',
        runtimeId: 'runtime', runtimeVersion: '1.0', text: '未能完成图片识别：当前图片无法读取。' } };
      return { ok: true };
    });
    transport.fetch.mockRejectedValue(new Error('Provider unavailable'));
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [] }), requestTask));
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister',
      sourceMessageId: f.source.id, title: '检查图片', prompt: '实际查看图片，无法读取时如实报告。' });
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(message =>
      message.kind === 'notice' && message.content.includes('执行器已返回结果'))).toBe(true), { timeout: 5000 });
    const notice = f.store.messages({ conversationId: f.conversation.id }).messages.find(message => message.content.includes('执行器已返回结果'));
    expect(notice?.content).not.toContain('已完成');
    expect(f.store.listAction()[0]?.result).toContain('未能完成图片识别');
    expect(requestTask.mock.calls.find(([request]) => request.type === 'task.run')?.[1]).toMatchObject({ toolkit: true });
    await closeService(f.service);
  });

  it('anchors real executor feedback to the original human source instead of a newer message or mistaken historical address', async () => {
    let succeeded = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'dsh-task' } : request.type === 'task.result'
        ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '原任务实际只读查询完成。' } } : { ok: true, taskEvents: [] });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(succeeded ? 'succeeded' : 'running')], operations: [] }), requestTask));
    f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'sister', content: '姐姐，我来帮你。', replyDirective: 'none' });
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
      expect(body.tools).toBeUndefined(); expect(data.identity.self.id).toBe('sister');
      expect(data.identity.currentReply).toMatchObject({ sourceMessageId: f.source.id, replyToMessageId: f.source.id,
        speaker: { id: 'user', kind: 'human_player' }, addressee: { id: 'user' }, event: 'action_result_for_original_source' });
      expect(JSON.stringify(data.messages)).not.toContain('后来独立的新消息');
      return modelResponse('原任务的真实查询结果已经返回。');
    });
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id, title: '原任务', prompt: '只读查询。' });
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([request]) => request.type === 'task.run')).toBe(true), { timeout: 5000 });
    f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '后来独立的新消息', replyDirective: 'none' });
    succeeded = true; await vi.advanceTimersByTimeAsync(1500);
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(message => message.content === '原任务的真实查询结果已经返回。')).toBe(true));
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.find(message => message.content === '原任务的真实查询结果已经返回。')?.replyToId).toBe(f.source.id);
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1); await closeService(f.service);
  });

  it('finishes a failed preparation operation even when no task record was created, and never replays it on restart', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const dsh = fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask);
    const f = fixture(dsh);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister',
      sourceMessageId: f.source.id, title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'failed', taskId: 'dsh-task' }), { timeout: 5000 });
    expect(f.store.listAction()[0]?.error).toContain('准备执行环境时失败');
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);

    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    const actions = await restarted.handle({ type: 'actions', conversationId: f.conversation.id });
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions?.[0]?.status).toBe('failed');
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    expect(reopened.messages({ conversationId: f.conversation.id }).messages.filter(value => value.kind === 'action' && !value.memoryEvidenceOnly)).toHaveLength(1);
    await closeService(restarted);
  });

  it('preserves a completed result when shutdown happens during the companion feedback request', async () => {
    const feedback = deferred<Response>();
    transport.fetch.mockImplementation(() => feedback.promise);
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'dsh-task' } : request.type === 'task.result'
        ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '真实完成结果' } } : { ok: true, taskEvents: [] });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [] }), requestTask));
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id, title: '完成工作', prompt: '检查并完成工作。' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const completed = f.store.listAction()[0]!;
    expect(completed).toMatchObject({ status: 'succeeded', result: '真实完成结果', startedAt: fixedTime });
    expect(completed.finishedAt).toBeDefined();
    const closing = closeService(f.service);
    feedback.resolve(modelResponse('工作的结果已经写好了。'));
    await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened);
    expect(reopened.getAction(completed.id)).toMatchObject({ status: 'succeeded', result: '真实完成结果', finishedAt: completed.finishedAt });
    reopened.interruptPendingActions();
    expect(reopened.getAction(completed.id).status).toBe('succeeded');
  });

  it('keeps cancellation terminal when a task.run operation ID arrives after cancellation', async () => {
    const started = deferred<DshLauncherResponse>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? started.promise : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    const launched = await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister',
      sourceMessageId: f.source.id, title: '整理文件', prompt: '按类型整理文件。' });
    const action = launched.actions?.[0]; expect(action).toBeDefined();
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([request]) => request.type === 'task.run')).toBe(true), { timeout: 5000 });
    await f.service.handle({ type: 'action.cancel', id: action!.id });
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    started.resolve({ ok: true, operationId: 'dsh-task' });
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'cancelled', taskId: 'dsh-task' }), { timeout: 5000 });
    const runningWrites = transport.request.mock.calls.map(([command]) => command)
      .filter(command => command.type === 'action.update' && command.patch.status === 'running');
    expect(runningWrites).toHaveLength(0);
    expect(requestTask.mock.calls.some(([request]) => request.type === 'task.cancel' && request.taskId === 'dsh-task')).toBe(true);
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);
  });

  it('persists cancellation even if DSH reports that the task is no longer running', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') return { ok: true, operationId: 'dsh-task' };
      if (request.type === 'task.cancel') throw new Error('This DSH task is no longer running.');
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord()], operations: [{ id: 'dsh-task', status: 'running' }] }), requestTask));
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 5000 });
    const id = f.store.listAction()[0]!.id;
    await expect(f.service.handle({ type: 'action.cancel', id })).resolves.toEqual({ ok: true });
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await f.service.handle({ type: 'state' })).state?.activities).toEqual([]);
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);
  });

  it('does not overwrite cancellation when a completed task result arrives after the user cancels', async () => {
    const lateResult = deferred<DshLauncherResponse>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') return { ok: true, operationId: 'dsh-task' };
      if (request.type === 'task.result') return lateResult.promise;
      if (request.type === 'task.cancel') throw new Error('This DSH task is no longer running.');
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [{ id: 'dsh-task', status: 'succeeded' }] }), requestTask));
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([request]) => request.type === 'task.result')).toBe(true), { timeout: 5000 });
    await f.service.handle({ type: 'action.cancel', id: f.store.listAction()[0]!.id });
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    lateResult.resolve({ ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime',
      runtimeVersion: '1.0', text: '完成了一部分整理。' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);
  });

  it('keeps an acknowledged cancellation across immediate service shutdown and SQLite reopening', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'dsh-task' } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord()], operations: [{ id: 'dsh-task', status: 'running' }] }), requestTask));
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 5000 });
    await f.service.handle({ type: 'action.cancel', id: f.store.listAction()[0]!.id });
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened);
    expect(reopened.listAction()[0]?.status).toBe('cancelled');
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('bounds the DSH title while retaining the full title in the action record', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask));
    const title = '文件'.repeat(55);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title, prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('failed'), { timeout: 5000 });
    const request = requestTask.mock.calls[0]?.[0];
    expect(request).toMatchObject({ type: 'task.run', title: title.slice(0, 100) });
    expect(f.store.listAction()[0]?.title).toBe(title);
    await closeService(f.service);
  });

  it('polls new DSH progress by sequence, persists only visible summaries, and keeps them after SQLite reopening', async () => {
    let status: DshTaskRecord['status'] = 'running';
    const events: DshTaskEvent[] = [
      { taskId: 'dsh-task', sequence: 0, type: 'session', stage: 'session', receivedAt: fixedTime, summary: '执行环境已准备' },
      { taskId: 'dsh-task', sequence: 1, type: 'thinking', receivedAt: fixedTime, text: 'PRIVATE_DSH_THINKING_BODY' },
      { taskId: 'dsh-task', sequence: 2, type: 'tool_start', stage: 'tool_start', toolName: 'read_image', receivedAt: fixedTime, summary: '正在查看第一张图片' },
      { taskId: 'dsh-task', sequence: 3, type: 'tool_end', stage: 'tool_end', toolName: 'read_image', receivedAt: fixedTime, summary: '图片查看结束' },
    ];
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') return { ok: true, operationId: 'dsh-task' };
      if (request.type === 'task.events') {
        if (request.after === -1) return { ok: true, taskEvents: events.slice(0, 3) };
        if (request.after === 2) { status = 'succeeded'; return { ok: true, taskEvents: events.slice(3) }; }
        return { ok: true, taskEvents: [] };
      }
      if (request.type === 'task.result') return { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance',
        runtimeId: 'runtime', runtimeVersion: '1.0', text: '已只读查看图片，没有改动原文件。' } };
      return { ok: true };
    });
    transport.fetch.mockImplementation(async () => modelResponse('DSH 已只读查看图片，原文件保持不变。'));
    const dsh = fakeDsh(() => ({ tasks: [taskRecord(status)], operations: [{ id: 'dsh-task', status }] }), requestTask);
    const f = fixture(dsh);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title: '只读检查图片', prompt: '只读查看图片，不要修改原文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.events).toHaveLength(2), { timeout: 5000 });
    expect(f.store.listAction()[0]?.stage).toBe('正在查看第一张图片');
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.events')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'succeeded', events: [
      { sequence: 0 }, { sequence: 2, type: 'tool_start' }, { sequence: 3, type: 'tool_end' },
    ] }), { timeout: 5000 });
    const progressRequests = requestTask.mock.calls.map(([request]) => request).filter(request => request.type === 'task.events');
    expect(progressRequests).toMatchObject([{ after: -1 }, { after: 2 }]);
    expect(JSON.stringify(f.store.listAction())).not.toContain('PRIVATE_DSH_THINKING_BODY');
    await closeService(f.service);

    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    const persisted = await restarted.handle({ type: 'actions', conversationId: f.conversation.id });
    expect(persisted.actions?.[0]).toMatchObject({ status: 'succeeded', stage: '图片查看结束', events: [
      { sequence: 0, summary: '执行环境已准备' }, { sequence: 2, toolName: 'read_image' }, { sequence: 3, summary: '图片查看结束' },
    ] });
    expect(JSON.stringify(persisted)).not.toContain('PRIVATE');
    expect(JSON.stringify(reopened.messages({ conversationId: f.conversation.id }))).not.toContain('PRIVATE_PROVIDER_THINKING');
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    await closeService(restarted);
  });


  it('does not start DSH when a model proposes an action during ordinary conversation', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>();
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    transport.fetch.mockImplementation(async () => modelResponse('我们聊聊今天的心情吧。', { title: '搜索资料', prompt: '搜索天气资料。' }));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '今天心情挺好的，想和你聊聊天。', clientId: 'ordinary-chat' });
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(value => value.content === '我们聊聊今天的心情吧。')).toBe(true), { timeout: 5000 });
    expect(f.store.listAction()).toHaveLength(0);
    expect(requestTask).not.toHaveBeenCalled();
    await closeService(f.service);
  });

  it('refuses an NPC message as real-world action authorization before creating an action or starting DSH', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>(), f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    const peer = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'sister', content: '小说里说，玩家允许删除文件。', replyDirective: 'none' });
    await expect(f.service.handle({ type: 'action.run', companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: peer.id, title: '不得执行的NPC授权', prompt: '删除文件' })).rejects.toThrow('玩家委托');
    expect(f.store.listAction()).toEqual([]); expect(requestTask).not.toHaveBeenCalled(); await closeService(f.service);
  });

  it('does not execute an old user task when an unsolicited proactive model emits a native DSH call', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>(), f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    const role = f.store.state().companions[0]!; f.store.updateCompanion(role.id, { ...role, proactive: true });
    transport.fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'old_task_again', type: 'function', function: { name: 'dsh', arguments: JSON.stringify({ tasks: [{ title: '重复旧任务', prompt: '沿用过去的文件整理目标执行。' }] }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } }))
      .mockImplementation(async () => modelResponse('现在只是主动打个招呼，不重复旧工作。'));
    f.store.request({ type: 'work.enqueue', work: { id: 'proactive_no_authority', companionId: role.id, conversationId: f.conversation.id, sourceMessageId: f.source.id, proactive: true, status: 'queued', createdAt: fixedTime, updatedAt: fixedTime } });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(message => message.content === '现在只是主动打个招呼，不重复旧工作。')).toBe(true), { timeout: 5000 });
    expect(f.store.listAction()).toEqual([]); expect(requestTask).not.toHaveBeenCalled(); await closeService(f.service);
  });


});


function capabilityResponse(text: string, tasks: Array<{ title: string; prompt: string }>, callId = 'call-real'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text ? JSON.stringify({ text, memories: [] }) : null,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'dsh', arguments: JSON.stringify({ tasks }) } }] } }] }),
    { headers: { 'Content-Type': 'application/json' } });
}
describe('one durable bubble per source and native multi-step main loop', () => {
  it('keeps concurrent weather and clock requests in separate loops even when the clock finishes first', async () => {
    const jobs: DshTaskRecord[] = [];
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') {
        const id = 'independent-' + jobs.length;
        jobs.push({ ...taskRecord(), id, operationId: id, title: request.title ?? '' });
        return { ok: true, operationId: id };
      }
      if (request.type === 'task.result') return { ok: true, taskResult: { taskId: request.taskId, instanceId: 'instance',
        runtimeId: 'runtime', runtimeVersion: '1.0', text: request.taskId === 'independent-0' ? '上海天气查询结果' : '系统时间查询结果' } };
      return { ok: true, taskEvents: [] };
    });
    const f = fixture(fakeDsh(() => ({ tasks: jobs, operations: [] }), requestTask));
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const context = JSON.parse(body.messages[1].content);
      const tool = body.messages.find((item: { role: string }) => item.role === 'tool');
      if (tool) return modelResponse(JSON.parse(tool.content).tasks[0].result);
      const clock = context.taskRequest?.prompt === '现在几点了';
      return capabilityResponse('', [{ title: clock ? '读取系统时间' : '查询上海天气', prompt: clock ? '读取系统时间与时区' : '查询上海实时天气' }]);
    });
    const weather = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '上海天气如何', clientId: 'weather-source' })).message!;
    await vi.waitFor(() => expect(jobs).toHaveLength(1), { timeout: 5000 });
    const clock = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '现在几点了', clientId: 'clock-source' })).message!;
    await vi.waitFor(() => expect(jobs).toHaveLength(2), { timeout: 5000 });
    expect(jobs.map(item => item.title)).toEqual(['查询上海天气', '读取系统时间']);
    const weatherSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop!.context!;
    const clockSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop!.context!;
    expect(weatherSnapshot.user).not.toContain('现在几点了');
    expect(JSON.parse(clockSnapshot.user).taskRequest).toEqual({ sourceMessageId: clock.id, prompt: '现在几点了' });
    jobs[1]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('running');
    jobs[0]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    const replies = f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister' && !item.memoryEvidenceOnly);
    expect(replies).toHaveLength(2);
    expect(replies.find(item => item.replyToId === clock.id)?.content).toBe('系统时间查询结果');
    expect(replies.find(item => item.replyToId === weather.id)?.content).toBe('上海天气查询结果');
    const bases = transport.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).messages[1].content);
    expect(bases.filter(value => JSON.stringify(sourceContext(value)) === JSON.stringify(sourceContext(weatherSnapshot.user)))).toHaveLength(2);
    expect(bases.filter(value => JSON.stringify(sourceContext(value)) === JSON.stringify(sourceContext(clockSnapshot.user)))).toHaveLength(2);
  });

  it('restores a saved source context after newer history has filled the latest page', async () => {
    const pending = deferred<Response>();
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true }));
    const f = fixture(dsh);
    transport.fetch.mockImplementation(() => pending.promise);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '只回答这个最早的问题', clientId: 'old-source' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const snapshot = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!.context!;
    for (let i = 0; i < 150; i++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '后来的其他消息 ' + i });
    const closing = closeService(f.service); pending.resolve(modelResponse('已停止的回复')); await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(sourceContext(body.messages[1].content)).toEqual(sourceContext(snapshot.user));
      expect(JSON.parse(body.messages[1].content).taskRequest.sourceMessageId).toBe(source.id);
      return modelResponse('这个最早的问题已回复');
    });
    await restarted.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(reopened.getMessage(reopened.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!.messageId!).content).toBe('这个最早的问题已回复'), { timeout: 5000 });
  });
  it('waits for a genuine tool result, then continues the same loop and bubble', async () => {
    let finished = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => {
      if (request.type === 'task.run') return { ok: true, operationId: 'dsh-task' };
      if (request.type === 'task.result') return { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '实际系统时间 23:58:01 UTC+08:00' } };
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(finished ? 'succeeded' : 'running')], operations: [] }), requestTask));
    transport.fetch.mockResolvedValueOnce(capabilityResponse('我看看现在几点了。', [{ title: '查看时间', prompt: '实际读取系统时间与时区' }]))
      .mockImplementation(async () => modelResponse('系统时间是23:58:01，UTC+08:00。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '几点了', clientId: 'loop-clock' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 5000 });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister' && item.kind === 'text')).toHaveLength(1);
    finished = true; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const request = JSON.parse(String(transport.fetch.mock.calls[1]![1]?.body));
    expect(request.messages.find((item: { role: string }) => item.role === 'tool')).toMatchObject({ tool_call_id: 'call-real' });
    expect(request.messages.find((item: { role: string }) => item.role === 'tool').content).toContain('实际系统时间');
    const bubble = f.store.messages({ conversationId: f.conversation.id }).messages.find(item => item.authorId === 'sister' && item.kind === 'text')!;
    expect(bubble.segments?.map(segment => segment.text)).toEqual(['我看看现在几点了。', '系统时间是23:58:01，UTC+08:00。']);
    expect(bubble.segments?.[0]?.actionIds).toHaveLength(1);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(item => item.kind === 'action' && !item.memoryEvidenceOnly)).toBe(false);
    expect(requestTask.mock.calls.find(([item]) => item.type === 'task.run')?.[1]).toMatchObject({ toolkit: true, interactive: true, access: { mode: 'danger-full-access' } });
  });
  it('preserves tool-only steps without inventing a text message', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run' ? { ok: true, operationId: 'dsh-task' }
      : request.type === 'task.result' ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '三个实际来源' } } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [] }), requestTask));
    transport.fetch.mockResolvedValueOnce(capabilityResponse('', [{ title: '搜索 AI 新闻', prompt: '用标准 web_search 和 web_fetch 检索最新资料并核对来源' }]))
      .mockImplementation(async () => modelResponse('我查到三个来源。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '最近有啥ai新闻啊', clientId: 'loop-news' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const bubble = f.store.messages({ conversationId: f.conversation.id }).messages.find(item => item.kind === 'text' && item.authorId === 'sister')!;
    expect(bubble.segments?.[0]).toMatchObject({ text: '', actionIds: [expect.any(String)] });
    expect(bubble.content).toBe('我查到三个来源。');
    const body = JSON.parse(String(transport.fetch.mock.calls[0]![1]?.body));
    expect(body.tools.map((item: { function: { name: string } }) => item.function.name)).toEqual([
      'dsh', 'memory_search', 'memory_read', 'memory_record', 'memory_revise', 'memory_organize', 'memory_forget',
      'schedule', 'state',
      'routine', 'world',
    ]);
  });
  it('admits independent DSH calls concurrently and waits for all of them', async () => {
    let count = 0; const done = new Set<string>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run' ? { ok: true, operationId: 'parallel-' + (++count) }
      : request.type === 'task.result' ? { ok: true, taskResult: { taskId: request.taskId, instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '结果 ' + request.taskId } } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: Array.from({ length: count }, (_, index) => ({ ...taskRecord(done.has('parallel-' + (index + 1)) ? 'succeeded' : 'running'), id: 'parallel-' + (index + 1), operationId: 'parallel-' + (index + 1) })), operations: [] }), requestTask));
    transport.fetch.mockResolvedValueOnce(capabilityResponse('同时核对两个独立来源。', [{ title: '来源A', prompt: '核对A' }, { title: '来源B', prompt: '核对B' }]))
      .mockImplementation(async () => modelResponse('两个来源都核对好了。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '帮我核对两个来源', clientId: 'loop-parallel' });
    await vi.waitFor(() => expect(count).toBe(2), { timeout: 5000 });
    done.add('parallel-2'); await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    done.add('parallel-1'); await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    const bubble = f.store.messages({ conversationId: f.conversation.id }).messages.find(item => item.kind === 'text' && item.authorId === 'sister')!;
    expect(bubble.segments?.[0]?.actionIds).toHaveLength(2);
    expect(f.store.listAction().every(item => item.parentMessageId === bubble.id)).toBe(true);
  });
  it('admits five independent messages in source order and queues the sixth without losing it', async () => {
    const replies = Array.from({ length: 6 }, () => deferred<Response>());
    transport.fetch.mockImplementation(async (_url, init) => {
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      const text = context.messages.filter((item: { speaker: string }) => item.speaker === 'user').at(-1).content;
      return replies[Number(text.match(/第(\d+)条/)[1]) - 1]!.promise;
    });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true })));
    const sources: string[] = [];
    for (let index = 1; index <= 6; index++) sources.push((await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '第' + index + '条', clientId: 'burst-' + index })).message!.id);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 5000 });
    const state = (await f.service.handle({ type: 'state' })).state!;
    expect(state.queue?.filter(item => item.status === 'running')).toHaveLength(5);
    expect(state.queue?.filter(item => item.status === 'queued').map(item => item.sourceMessageId)).toEqual([sources[5]]);
    replies[0]!.resolve(modelResponse('第一项完成。'));
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(6), { timeout: 5000 });
    const bubbles = f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister' && item.kind === 'text');
    expect(bubbles.map(item => item.replyToId)).toEqual(sources);
    expect(state.companions[0]?.availability).toBe('working');
  });
  it('promotes a queued message into one explicitly selected active reply', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<Response>());
    let initial = 0;
    transport.fetch.mockImplementation(async (_url, init) => String(init?.body).includes('用户在本次执行过程中给出的补充要求')
      ? modelResponse('我已按补充改成蓝色。') : pending[initial++]!.promise);
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true })));
    const sources: string[] = [];
    for (let index = 0; index < 5; index++) sources.push((await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '独立任务' + index, clientId: 'guide-slot-' + index })).message!.id);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 5000 });
    const queued = await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '补充：改成蓝色', clientId: 'guide-queued' });
    await f.service.handle({ type: 'message.guide', id: queued.message!.id, targetSourceMessageId: sources[0] });
    pending[0]!.resolve(modelResponse('这个旧决定必须被重新考虑。'));
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(item => item.content === '我已按补充改成蓝色。')).toBe(true), { timeout: 5000 });
    const bubbles = f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister' && item.kind === 'text');
    expect(bubbles).toHaveLength(5);
    expect(bubbles.some(item => item.replyToId === queued.message!.id)).toBe(false);
    expect(bubbles.find(item => item.replyToId === sources[0])?.content).not.toContain('旧决定');
    expect((await f.service.handle({ type: 'state' })).state?.queue?.some(item => item.sourceMessageId === queued.message!.id)).toBe(false);
  });
  it('automatically starts durable unstarted messages after restart while interrupted work stays recoverable', async () => {
    transport.fetch.mockImplementation(() => new Promise<Response>(() => undefined));
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true }));
    const f = fixture(dsh); const ids: string[] = [];
    for (let index = 0; index < 7; index++) ids.push((await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '重启队列' + index, clientId: 'restart-queue-' + index })).message!.id);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 5000 });
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds); stores.add(reopened); bindStorage(reopened);
    transport.fetch.mockReset(); transport.fetch.mockImplementation(async () => modelResponse('自动继续未开始的排队消息。'));
    const restarted = startService(f.root, dsh);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: f.conversation.id }).messages.filter(item => item.content === '自动继续未开始的排队消息。')).toHaveLength(2), { timeout: 5000 });
    expect(reopened.request({ type: 'work.list' }).works?.filter(item => item.status === 'done').map(item => item.sourceMessageId)).toEqual(ids.slice(5));
    await closeService(restarted);
  });
});
