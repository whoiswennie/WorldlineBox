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

const transport = vi.hoisted(() => ({
  request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  start: vi.fn(async () => undefined), close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>(),
}));

// Exercise the real service and real SQLite contract; only its utility-process transport is replaced.
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = transport.start;
  request = transport.request;
  close = transport.close;
} }));
vi.mock('electron', () => ({
  net: { fetch: transport.fetch }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
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
function taskRecord(status: DshTaskRecord['status'] = 'running'): DshTaskRecord {
  return { id: 'dsh-task', operationId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0',
    title: '整理文件', status, startedAt: fixedTime };
}
function fakeDsh(state: () => { tasks: DshTaskRecord[]; operations: Array<{ id: string; status: string }> },
  requestTask: DshLauncher['requestTask']): DshLauncher {
  return { state, requestTask } as unknown as DshLauncher;
}
function fixture(dsh: DshLauncher) {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-service-'));
  roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const store = new CompanionsStore(databasePath, seeds, {});
  stores.add(store);
  const conversation = store.openPrivate('sister');
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '帮我整理这些文件。' });
  bindStorage(store);
  const service = startService(root, dsh);
  return { root, databasePath, store, service, conversation, source };
}
function bindStorage(store: CompanionsStore) {
  transport.request.mockImplementation(async command => store.request(command));
  transport.close.mockImplementation(async () => { store.close(); stores.delete(store); });
}
function startService(root: string, dsh: DshLauncher): CompanionService {
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', window: () => undefined,
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

describe('CompanionService DSH action lifecycle with real SQLite', () => {
  it('reports offline on an observed authentication failure and clears that observation after the connection changes', async () => {
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })));
    const f = fixture(dsh);
    let configured = false; let apiKey = 'original-test-key';
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    const service = new CompanionService({ userData: f.root, workerPath: 'mocked-worker', window: () => undefined,
      getConfig: () => ({ apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey }), hasConfig: () => configured,
      dsh: () => dsh, report: vi.fn() }); services.add(service);
    expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('offline');
    configured = true;
    expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('ready');
    transport.fetch.mockImplementation(async () => new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }));
    await service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '连接状态验证', clientId: 'presence-auth' });
    await vi.waitFor(async () => expect((await service.handle({ type: 'state' })).state!.companions[0]?.availability).toBe('offline'), { timeout: 200 });
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
    await vi.waitFor(() => expect(f.store.listAction(group.id)[0]?.taskId).toBe('dsh-task'), { timeout: 200 });
    f.store.request({ type: 'work.enqueue', work: { id: 'group-queue', sourceMessageId: source.id, conversationId: group.id, companionId: 'sister', status: 'queued', proactive: false, createdAt: source.createdAt, updatedAt: source.createdAt } });
    await f.service.handle({ type: 'conversation.delete', id: group.id, mode: 'dissolve' });
    expect(requestTask).toHaveBeenCalledWith({ type: 'task.cancel', taskId: 'dsh-task' });
    expect(f.store.listAction(group.id)[0]?.status).toBe('cancelled');
    expect(f.store.request({ type: 'work.list' }).works?.find(work => work.id === 'group-queue')?.status).toBe('cancelled');
    expect(f.store.state().conversations.some(room => room.id === group.id)).toBe(false);
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
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
    await vi.waitFor(() => expect(f.store.listAction()[0]?.sessionId).toBe('session-original'), { timeout: 200 });
    const id = f.store.listAction()[0]!.id;
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    await restarted.handle({ type: 'action.resume', id });
    await vi.waitFor(() => expect(reopened.getAction(id).status).toBe('succeeded'), { timeout: 200 });
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
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 200 });
    const closing = closeService(f.service); pending.resolve(modelResponse('这条未完成的回复不应写入。')); await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    expect((await restarted.handle({ type: 'state' })).state?.recoveries).toEqual([expect.objectContaining({ completedIds: ['sister'], status: 'interrupted' })]);
    transport.fetch.mockImplementation(async () => modelResponse('妹妹继续之前的话题。'));
    await restarted.handle({ type: 'reply.resume', conversationId: group.id });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: group.id }).messages.some(message => message.content === '妹妹继续之前的话题。')).toBe(true), { timeout: 200 });
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
      message.kind === 'notice' && message.content.includes('执行器已返回结果'))).toBe(true), { timeout: 200 });
    const notice = f.store.messages({ conversationId: f.conversation.id }).messages.find(message => message.content.includes('执行器已返回结果'));
    expect(notice?.content).not.toContain('已完成');
    expect(f.store.listAction()[0]?.result).toContain('未能完成图片识别');
    expect(requestTask.mock.calls.find(([request]) => request.type === 'task.run')?.[1]).toMatchObject({ toolkit: true });
    await closeService(f.service);
  });

  it('finishes a failed preparation operation even when no task record was created, and never replays it on restart', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const dsh = fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask);
    const f = fixture(dsh);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister',
      sourceMessageId: f.source.id, title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'failed', taskId: 'dsh-task' }), { timeout: 200 });
    expect(f.store.listAction()[0]?.error).toContain('准备执行环境时失败');
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);

    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    const actions = await restarted.handle({ type: 'actions', conversationId: f.conversation.id });
    expect(actions.actions).toHaveLength(1);
    expect(actions.actions?.[0]?.status).toBe('failed');
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    expect(reopened.messages({ conversationId: f.conversation.id }).messages.filter(value => value.kind === 'action')).toHaveLength(1);
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
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 200 });
    const completed = f.store.listAction()[0]!;
    expect(completed).toMatchObject({ status: 'succeeded', result: '真实完成结果', startedAt: fixedTime });
    expect(completed.finishedAt).toBeDefined();
    const closing = closeService(f.service);
    feedback.resolve(modelResponse('工作的结果已经写好了。'));
    await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened);
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
    await f.service.handle({ type: 'action.cancel', id: action!.id });
    expect(f.store.listAction()[0]?.status).toBe('cancelled');
    started.resolve({ ok: true, operationId: 'dsh-task' });
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'cancelled', taskId: 'dsh-task' }), { timeout: 200 });
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
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 200 });
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
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([request]) => request.type === 'task.result')).toBe(true), { timeout: 200 });
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
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 200 });
    await f.service.handle({ type: 'action.cancel', id: f.store.listAction()[0]!.id });
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened);
    expect(reopened.listAction()[0]?.status).toBe('cancelled');
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('bounds the DSH title while retaining the full title in the action record', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask));
    const title = '文件'.repeat(55);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister', sourceMessageId: f.source.id,
      title, prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('failed'), { timeout: 200 });
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
    await vi.waitFor(() => expect(f.store.listAction()[0]?.events).toHaveLength(2), { timeout: 200 });
    expect(f.store.listAction()[0]?.stage).toBe('正在查看第一张图片');
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.events')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'succeeded', events: [
      { sequence: 0 }, { sequence: 2, type: 'tool_start' }, { sequence: 3, type: 'tool_end' },
    ] }), { timeout: 200 });
    const progressRequests = requestTask.mock.calls.map(([request]) => request).filter(request => request.type === 'task.events');
    expect(progressRequests).toMatchObject([{ after: -1 }, { after: 2 }]);
    expect(JSON.stringify(f.store.listAction())).not.toContain('PRIVATE_DSH_THINKING_BODY');
    await closeService(f.service);

    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
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
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(value => value.content === '我们聊聊今天的心情吧。')).toBe(true), { timeout: 500 });
    expect(f.store.listAction()).toHaveLength(0);
    expect(requestTask).not.toHaveBeenCalled();
    await closeService(f.service);
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
    await vi.waitFor(() => expect(jobs).toHaveLength(1), { timeout: 500 });
    const clock = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '现在几点了', clientId: 'clock-source' })).message!;
    await vi.waitFor(() => expect(jobs).toHaveLength(2), { timeout: 500 });
    expect(jobs.map(item => item.title)).toEqual(['查询上海天气', '读取系统时间']);
    const weatherSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop!.context!;
    const clockSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop!.context!;
    expect(weatherSnapshot.user).not.toContain('现在几点了');
    expect(JSON.parse(clockSnapshot.user).taskRequest).toEqual({ sourceMessageId: clock.id, prompt: '现在几点了' });
    jobs[1]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 500 });
    expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('running');
    jobs[0]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 500 });
    const replies = f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister');
    expect(replies).toHaveLength(2);
    expect(replies.find(item => item.replyToId === clock.id)?.content).toBe('系统时间查询结果');
    expect(replies.find(item => item.replyToId === weather.id)?.content).toBe('上海天气查询结果');
    const bases = transport.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).messages[1].content);
    expect(bases.filter(value => value === weatherSnapshot.user)).toHaveLength(2);
    expect(bases.filter(value => value === clockSnapshot.user)).toHaveLength(2);
  });

  it('restores a saved source context after newer history has filled the latest page', async () => {
    const pending = deferred<Response>();
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true }));
    const f = fixture(dsh);
    transport.fetch.mockImplementation(() => pending.promise);
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '只回答这个最早的问题', clientId: 'old-source' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 500 });
    const snapshot = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!.context!;
    for (let i = 0; i < 150; i++) f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '后来的其他消息 ' + i });
    const closing = closeService(f.service); pending.resolve(modelResponse('已停止的回复')); await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    const restarted = startService(f.root, dsh);
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toBe(snapshot.user);
      expect(JSON.parse(body.messages[1].content).taskRequest.sourceMessageId).toBe(source.id);
      return modelResponse('这个最早的问题已回复');
    });
    await restarted.handle({ type: 'reply.resume', conversationId: f.conversation.id });
    await vi.waitFor(() => expect(reopened.getMessage(reopened.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!.messageId!).content).toBe('这个最早的问题已回复'), { timeout: 500 });
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
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('running'), { timeout: 500 });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.filter(item => item.authorId === 'sister' && item.kind === 'text')).toHaveLength(1);
    finished = true; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 500 });
    const request = JSON.parse(String(transport.fetch.mock.calls[1]![1]?.body));
    expect(request.messages.find((item: { role: string }) => item.role === 'tool')).toMatchObject({ tool_call_id: 'call-real' });
    expect(request.messages.find((item: { role: string }) => item.role === 'tool').content).toContain('实际系统时间');
    const bubble = f.store.messages({ conversationId: f.conversation.id }).messages.find(item => item.authorId === 'sister' && item.kind === 'text')!;
    expect(bubble.segments?.map(segment => segment.text)).toEqual(['我看看现在几点了。', '系统时间是23:58:01，UTC+08:00。']);
    expect(bubble.segments?.[0]?.actionIds).toHaveLength(1);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(item => item.kind === 'action')).toBe(false);
    expect(requestTask.mock.calls.find(([item]) => item.type === 'task.run')?.[1]).toMatchObject({ toolkit: true, interactive: true, access: { mode: 'danger-full-access' } });
  });
  it('preserves tool-only steps without inventing a text message', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run' ? { ok: true, operationId: 'dsh-task' }
      : request.type === 'task.result' ? { ok: true, taskResult: { taskId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '三个实际来源' } } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord('succeeded')], operations: [] }), requestTask));
    transport.fetch.mockResolvedValueOnce(capabilityResponse('', [{ title: '搜索 AI 新闻', prompt: '用标准 web_search 和 web_fetch 检索最新资料并核对来源' }]))
      .mockImplementation(async () => modelResponse('我查到三个来源。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '最近有啥ai新闻啊', clientId: 'loop-news' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 500 });
    const bubble = f.store.messages({ conversationId: f.conversation.id }).messages.find(item => item.kind === 'text' && item.authorId === 'sister')!;
    expect(bubble.segments?.[0]).toMatchObject({ text: '', actionIds: [expect.any(String)] });
    expect(bubble.content).toBe('我查到三个来源。');
    const body = JSON.parse(String(transport.fetch.mock.calls[0]![1]?.body));
    expect(body.tools.map((item: { function: { name: string } }) => item.function.name)).toEqual(['dsh']);
  });
  it('admits independent DSH calls concurrently and waits for all of them', async () => {
    let count = 0; const done = new Set<string>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run' ? { ok: true, operationId: 'parallel-' + (++count) }
      : request.type === 'task.result' ? { ok: true, taskResult: { taskId: request.taskId, instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0', text: '结果 ' + request.taskId } } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: Array.from({ length: count }, (_, index) => ({ ...taskRecord(done.has('parallel-' + (index + 1)) ? 'succeeded' : 'running'), id: 'parallel-' + (index + 1), operationId: 'parallel-' + (index + 1) })), operations: [] }), requestTask));
    transport.fetch.mockResolvedValueOnce(capabilityResponse('同时核对两个独立来源。', [{ title: '来源A', prompt: '核对A' }, { title: '来源B', prompt: '核对B' }]))
      .mockImplementation(async () => modelResponse('两个来源都核对好了。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '帮我核对两个来源', clientId: 'loop-parallel' });
    await vi.waitFor(() => expect(count).toBe(2), { timeout: 500 });
    done.add('parallel-2'); await vi.advanceTimersByTimeAsync(1000);
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    done.add('parallel-1'); await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 500 });
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
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 500 });
    const state = (await f.service.handle({ type: 'state' })).state!;
    expect(state.queue?.filter(item => item.status === 'running')).toHaveLength(5);
    expect(state.queue?.filter(item => item.status === 'queued').map(item => item.sourceMessageId)).toEqual([sources[5]]);
    replies[0]!.resolve(modelResponse('第一项完成。'));
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(6), { timeout: 500 });
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
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 500 });
    const queued = await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '补充：改成蓝色', clientId: 'guide-queued' });
    await f.service.handle({ type: 'message.guide', id: queued.message!.id, targetSourceMessageId: sources[0] });
    pending[0]!.resolve(modelResponse('这个旧决定必须被重新考虑。'));
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(item => item.content === '我已按补充改成蓝色。')).toBe(true), { timeout: 500 });
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
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(5), { timeout: 500 });
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds, {}); stores.add(reopened); bindStorage(reopened);
    transport.fetch.mockReset(); transport.fetch.mockImplementation(async () => modelResponse('自动继续未开始的排队消息。'));
    const restarted = startService(f.root, dsh);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 500 });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: f.conversation.id }).messages.filter(item => item.content === '自动继续未开始的排队消息。')).toHaveLength(2), { timeout: 500 });
    expect(reopened.request({ type: 'work.list' }).works?.filter(item => item.status === 'done').map(item => item.sourceMessageId)).toEqual(ids.slice(5));
    await closeService(restarted);
  });
});
