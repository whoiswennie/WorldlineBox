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
    transport.fetch.mockResolvedValue(modelResponse('妹妹继续之前的话题。'));
    await restarted.handle({ type: 'reply.resume', conversationId: group.id });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: group.id }).messages.some(message => message.content === '妹妹继续之前的话题。')).toBe(true), { timeout: 200 });
    const messages = reopened.messages({ conversationId: group.id }).messages;
    expect(messages.filter(message => message.content === '姐姐已经说完。')).toHaveLength(1);
    expect(messages.some(message => message.content === '这条未完成的回复不应写入。')).toBe(false);
    expect(requestTask).not.toHaveBeenCalled();
    await closeService(restarted);
  });
  it('starts the actual capability for a natural time request even when the chat model omits an action', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask));
    transport.fetch.mockResolvedValue(modelResponse('要不要我委托 DSH 查一下？'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '大肥鱼看看现在几点了', clientId: 'natural-time' });
    await vi.waitFor(() => expect(f.store.listAction()).toHaveLength(1), { timeout: 500 });
    expect(f.store.listAction()[0]?.title).toBe('查看当前时间');
    expect(requestTask.mock.calls.find(([request]) => request.type === 'task.run')?.[1]).toMatchObject({ toolkit: true, interactive: true });
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'sister' && message.kind === 'text').map(message => message.content).join('')).not.toContain('DSH');
    await closeService(f.service);
  });
  it('dispatches a contextual 都行 against the earlier real task instead of losing its object', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true, operationId: 'dsh-task' });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask));
    const news = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '你帮我搜一下最近的新闻' });
    f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'sister', content: '想看哪方面？' });
    transport.fetch.mockResolvedValue(modelResponse('我去看看最近的新闻。'));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '都行', clientId: 'news-followup' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.sourceMessageId).toBe(news.id), { timeout: 500 });
    const task = requestTask.mock.calls.find(([request]) => request.type === 'task.run')?.[0];
    expect(task?.type === 'task.run' ? task.prompt : '').toContain('综合新闻');
    await closeService(f.service);
  });
  it('starts two independent native loops from one allowed dsh function call and attributes them to the requested partners', async () => {
    let next = 0;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'native-' + (++next) } : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: Array.from({ length: next }, (_, index) => ({ id: 'native-' + (index + 1), status: 'failed' })) }), requestTask));
    const flash = f.store.createCompanion({ name: '小肥鱼', description: '妹妹', persona: '活泼', model: '', avatar: 'flash', proactive: false });
    const group = f.store.createConversation('共同写作', ['sister', flash.id]);
    transport.fetch.mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ type: 'function', function: {
      name: 'dsh', arguments: JSON.stringify({ tasks: [
        { title: '写前五章', prompt: '大肥鱼在公共文件夹写前五章并核验。', companionId: 'sister' },
        { title: '写后五章', prompt: '小肥鱼在公共文件夹写后五章并核验。', companionId: flash.id },
      ] }),
    } }] } }] }), { headers: { 'Content-Type': 'application/json' } }));
    await f.service.handle({ type: 'message.send', conversationId: group.id, content: '请帮我让大肥鱼和小肥鱼在公共文件夹写10章小说，每人5章。', clientId: 'two-loops', delivery: 'parallel' });
    await vi.waitFor(() => expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(2), { timeout: 500 });
    expect(f.store.listAction(group.id).map(action => action.companionId).sort()).toEqual(['sister', flash.id].sort());
    await closeService(f.service);
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

  it('automatically delegates an explicit group request through only its first speaker and never replays it on reply.retry', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? { ok: true, operationId: 'dsh-task' } : { ok: true, taskEvents: [] });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed' }] }), requestTask));
    const second = f.store.createCompanion({ name: '小肥鱼', description: '妹妹', persona: '活泼好奇', model: '', avatar: 'flash', proactive: false });
    const group = f.store.createConversation('一起查看', ['sister', second.id]);
    const content = '请帮我检查桌面图片，不要删除或修改文件。';
    transport.fetch.mockImplementation(async () => modelResponse('我交给 DSH 只读检查。', { title: '只读检查图片', prompt: '检查桌面图片，不要删除或修改文件。' }));
    await f.service.handle({ type: 'message.send', conversationId: group.id, content, clientId: 'auto-group-send' });
    await vi.waitFor(() => expect(f.store.messages({ conversationId: group.id }).messages.filter(value => value.kind === 'text' && value.authorId !== 'user')).toHaveLength(2), { timeout: 500 });
    await vi.waitFor(() => expect(f.store.listAction(group.id)[0]?.status).toBe('failed'), { timeout: 200 });
    const source = f.store.messages({ conversationId: group.id }).messages.find(value => value.authorId === 'user')!;
    expect(f.store.listAction(group.id)).toHaveLength(1);
    expect(f.store.listAction(group.id)[0]).toMatchObject({ companionId: 'sister', sourceMessageId: source.id });
    const started = requestTask.mock.calls.map(([request]) => request).find(request => request.type === 'task.run');
    expect(started?.type === 'task.run' ? started.prompt : '').toContain(content);

    await f.service.handle({ type: 'reply.retry', conversationId: group.id });
    await vi.waitFor(() => expect(f.store.messages({ conversationId: group.id }).messages.filter(value => value.kind === 'text' && value.authorId !== 'user')).toHaveLength(4), { timeout: 500 });
    expect(f.store.listAction(group.id)).toHaveLength(1);
    expect(requestTask.mock.calls.filter(([request]) => request.type === 'task.run')).toHaveLength(1);
    await closeService(f.service);
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

  it('supersedes an old inference and never commits its late response after a newer user message', async () => {
    const first = deferred<Response>();
    transport.fetch.mockImplementationOnce(() => first.promise).mockImplementationOnce(async () => modelResponse('这是对新消息的回复。'));
    const requestTask = vi.fn<DshLauncher['requestTask']>();
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '旧问题', clientId: 'first-send' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1), { timeout: 200 });
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '新的问题', clientId: 'second-send' });
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(value => value.content === '这是对新消息的回复。')).toBe(true), { timeout: 200 });
    first.resolve(modelResponse('这是过时的旧回复。'));
    await vi.advanceTimersByTimeAsync(1);
    const content = f.store.messages({ conversationId: f.conversation.id }).messages.map(value => value.content);
    expect(content).not.toContain('这是过时的旧回复。');
    expect(content.filter(value => value === '这是对新消息的回复。')).toHaveLength(1);
    expect(requestTask).not.toHaveBeenCalled();
    await closeService(f.service);
  });
});
