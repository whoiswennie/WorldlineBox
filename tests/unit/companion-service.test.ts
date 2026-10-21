import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { DshLauncherResponse } from '../../src/shared/dsh-launcher';
import type { DshTaskEvent, DshTaskRecord } from '../../src/shared/dsh-tasks';
import type { DshLauncher } from '../../src/main/dsh/launcher';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionFileReader } from '../../src/main/companions/file-reader';
import type { CompanionMemoryService } from '../../src/main/companions/memory-service';
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
  // The source window stays frozen. Current host facts (including the public
  // identity projection) are intentionally refreshed on each inference.
  const { worldClock: _clock, runtimeState: _state, runtimeBehavior: _behavior, world: _world, worldTrust: _worldTrust,
    identity: _identity, publicProfiles: _profiles, visionManifest: _vision, visionNotice: _notice, ...sources } = JSON.parse(serialized);
  void _clock; void _state; void _behavior; void _world; void _worldTrust;
  void _identity; void _profiles; void _vision; void _notice;
  return sources;
}
function taskRecord(status: DshTaskRecord['status'] = 'running'): DshTaskRecord {
  return { id: 'dsh-task', operationId: 'dsh-task', instanceId: 'instance', runtimeId: 'runtime', runtimeVersion: '1.0',
    title: '整理文件', status, startedAt: fixedTime };
}
function fakeDsh(state: () => { tasks: DshTaskRecord[]; operations: Array<{ id: string; status: string }> },
  requestTask: DshLauncher['requestTask']): DshLauncher {
  return { state, requestTask, readTaskRecord: vi.fn(async () => { throw new Error('legacy record'); }), removeCompanionTaskRecords: vi.fn(async () => undefined) } as unknown as DshLauncher;
}
function fixture(dsh: DshLauncher, publish = false, prepareComputer = true) {
  const testNow = Date.now(); if (prepareComputer) vi.setSystemTime(testNow - 10_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-service-'));
  roots.push(root);
  const databasePath = path.join(root, 'companions', 'messages.sqlite');
  const store = new CompanionsStore(databasePath, seeds.map(seed => ({ ...seed, active: true })));
  stores.add(store);
  const conversation = store.openPrivate('sister');
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const scope = { companionId: 'sister', conversationId: conversation.id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '01:00', meals: [], habits: [] } });
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
function keepAwake(store: CompanionsStore, companionId: string, conversationId: string) {
  const scope = { companionId, conversationId }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '01:00', meals: [], habits: [] } });
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
async function finishReset(store: CompanionsStore, id = 'sister') {
  for (let batch = 0; batch < 500; batch++) {
    const job = store.request({ type: 'companion.reset.status', id }).reset;
    if (job?.status !== 'running') { expect(job?.status, job?.error).toBe('completed'); return; }
    await store.advanceReset();
  }
  throw new Error('Reset did not finish within the bounded fixture batches.');
}

describe('CompanionService durable factory reset', () => {
  it('drains a late native file commit before acknowledging the reset cleanup boundary', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    const sourcePath = path.join(f.root, 'before-reset.txt'); writeFileSync(sourcePath, '旧任务读取的文件内容');
    const files = (f.service as unknown as { files: CompanionFileReader }).files, original = files.readFile.bind(files), gate = deferred<void>();
    const read = vi.spyOn(files, 'readFile').mockImplementation(async (...args) => { await gate.promise; return original(...args); });
    transport.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'late-native-file', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: sourcePath }) } }] }, finish_reason: 'tool_calls' }] }), { headers: { 'Content-Type': 'application/json' } }));
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '读取这份文件 ' + sourcePath, clientId: 'reset-late-file' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { timeout: 5000 });
    let finished = false; const resetting = f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' }).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(f.store.request({ type: 'companion.reset.status', id: 'sister' }).reset?.phase).toBe('stopping'));
    await vi.advanceTimersByTimeAsync(100); expect(finished).toBe(false);
    expect(transport.request.mock.calls.some(([command]) => command.type === 'companion.reset.cleanup')).toBe(false);
    gate.resolve(); await resetting; await finishReset(f.store);
    const committed = transport.request.mock.calls.map(([command]) => command).find(command => command.type === 'file.result.commit');
    expect(committed?.type).toBe('file.result.commit');
    if (committed?.type !== 'file.result.commit') throw new Error('Expected the real delayed file commit.');
    expect(f.store.request({ type: 'file.result.get', key: committed.key }).fileToolResult).toBeUndefined();
    expect(f.store.messages({ conversationId: f.store.openPrivate('sister').id }).messages).toEqual([]);
    await closeService(f.service);
  });
  it('cancels an in-flight reply and rejects its late result after restoring the default identity', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    const before = (await f.service.handle({ type: 'state' })).state!.companions[0]!;
    await f.service.handle({ type: 'companion.update', id: before.id, expectedRevision: before.revision,
      companion: { ...seeds[0]!, name: '临时昵称', persona: '临时人设', llm: { apiFormat: 'openai_chat', baseUrl: 'https://private.invalid', model: 'private-model' } }, apiKey: 'private-test-key' });
    const pending = deferred<Response>(); transport.fetch.mockImplementation(() => pending.promise);
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '重置前的旧问题。', clientId: 'before-reset' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect((await f.service.handle({ type: 'state' })).state?.activities).toContainEqual(expect.objectContaining({
      companionId: 'sister', sourceMessageId: expect.any(String), status: 'thinking', stage: '正在生成回复', startedAt: expect.any(String),
    }));
    const started = await f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' });
    expect(started.reset?.phase).toBe('rooms'); expect('resetTaskIds' in started).toBe(false);
    pending.resolve(modelResponse('旧的迟到回复绝不能复活。')); await vi.advanceTimersByTimeAsync(100);
    await finishReset(f.store);
    const restored = (await f.service.handle({ type: 'state' })).state!.companions[0]!;
    expect(restored).toMatchObject({ id: 'sister', name: seeds[0]!.name, persona: seeds[0]!.persona, avatar: 'sister', builtin: true });
    expect(restored.llm).toBeUndefined(); expect(restored.avatarAttachmentId).toBeUndefined();
    const room = f.store.openPrivate('sister'); expect(f.store.messages({ conversationId: room.id }).messages).toEqual([]);
    expect(transport.fetch).toHaveBeenCalledOnce(); await closeService(f.service);
  });
  it('keeps a durable failed cancellation and retries the same reset before deleting any source', async () => {
    let status: DshTaskRecord['status'] = 'running', shouldFail = true;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async input => {
      if (input.type === 'task.terminate') { if (shouldFail) throw new Error('Fixture termination unavailable'); status = 'cancelled'; }
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(status)], operations: [] }), requestTask));
    await f.service.handle({ type: 'state' });
    f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id,
      title: '必须先停止的旧工作', status: 'running', taskId: 'dsh-task' });
    await expect(f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' })).rejects.toThrow();
    const failed = f.store.request({ type: 'companion.reset.status', id: 'sister' });
    expect(failed.reset).toMatchObject({ status: 'failed', phase: 'stopping' }); expect(failed.resetTaskIds).toEqual(['dsh-task']);
    expect(f.store.getMessage(f.source.id).content).toBe('帮我整理这些文件。');
    shouldFail = false;
    const resumed = await f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' });
    expect(resumed.reset?.id).toBe(failed.reset?.id); expect(status).toBe('cancelled'); expect(resumed.reset?.phase).toBe('rooms');
    await finishReset(f.store); await closeService(f.service);
  });
});
describe('CompanionService owner process stop boundary', () => {
  it('durably tracks a late task.run ID and waits for process termination before resetting', async () => {
    const run = deferred<DshLauncherResponse>(), termination = deferred<DshLauncherResponse>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async request => request.type === 'task.run'
      ? run.promise : request.type === 'task.terminate' ? termination.promise : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await f.service.handle({ type: 'action.run', companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageId: f.source.id, title: '迟到的启动确认', prompt: '只读检查文件。' });
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([input]) => input.type === 'task.run')).toBe(true), { timeout: 5000 });
    let resetSettled = false;
    const resetting = f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' }).then(result => { resetSettled = true; return result; });
    await vi.waitFor(() => expect(f.store.request({ type: 'companion.reset.status', id: 'sister' }).reset?.phase).toBe('stopping'));
    expect(resetSettled).toBe(false);
    run.resolve({ ok: true, operationId: 'late-owner-process' });
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([input]) => input.type === 'task.terminate' && input.taskId === 'late-owner-process')).toBe(true));
    expect(f.store.request({ type: 'companion.task-ids', id: 'sister' }).companionTaskIds).toContain('late-owner-process');
    expect(resetSettled).toBe(false);
    expect(transport.request.mock.calls.some(([input]) => input.type === 'companion.reset.cleanup')).toBe(false);
    const stopBoundary = transport.request.mock.calls.findIndex(([input]) => input.type === 'companion.reset');
    termination.resolve({ ok: true }); await resetting; await finishReset(f.store);
    expect(transport.request.mock.calls.slice(stopBoundary).some(([input]) => input.type === 'action.update')).toBe(false);
    expect(f.store.listAction()).toEqual([]);
    expect(f.store.messages({ conversationId: f.store.openPrivate('sister').id }).messages).toEqual([]);
    expect(transport.fetch).not.toHaveBeenCalled();
  });

  it('keeps a custom contact and its sources until pending owner termination succeeds, and preserves them on failure', async () => {
    const termination = deferred<DshLauncherResponse>(), reply = deferred<Response>();
    let stoppingAllowed = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async input => input.type === 'task.terminate'
      ? stoppingAllowed ? { ok: true } : termination.promise : { ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await f.service.handle({ type: 'state' });
    const custom = f.store.createCompanion({ name: '独立伙伴', description: '', persona: '安静友好', model: '', avatar: 'flash', proactive: false });
    f.store.setCompanionActive(custom.id, true);
    const room = f.store.openPrivate(custom.id);
    keepAwake(f.store, custom.id, room.id);
    const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '这份委托和资料要保留。' });
    const home = f.store.request({ type: 'world.snapshot' }).world!.scenes.find(scene => scene.ownerId === custom.id)!;
    f.store.request({ type: 'world.tool', companionId: custom.id, conversationId: room.id, sourceMessageId: source.id,
      arguments: { action: 'move', destinationId: home.objects.find(object => object.kind === 'computer')!.id } });
    vi.setSystemTime(Date.now() + 20_000); f.store.request({ type: 'world.tick' });
    transport.fetch.mockImplementation(() => reply.promise);
    await f.service.handle({ type: 'message.send', conversationId: room.id, content: '删除前正在回答的问题。', clientId: 'custom-delete-reply' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const action = f.store.createAction({ companionId: custom.id, conversationId: room.id, sourceMessageId: source.id,
      title: '拥有者的真实任务登记', status: 'running', taskId: 'custom-owner-process' });
    let settled = false;
    const deleting = f.service.handle({ type: 'companion.delete', id: custom.id }).then(() => undefined, error => error as Error).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(requestTask.mock.calls.some(([input]) => input.type === 'task.terminate')).toBe(true));
    expect(settled).toBe(false);
    expect(f.store.request({ type: 'state' }).state?.companions.some(companion => companion.id === custom.id)).toBe(true);
    expect(f.store.getMessage(source.id).content).toBe(source.content);
    termination.resolve({ ok: false, error: '该拥有者进程还未退出。' });
    reply.resolve(modelResponse('删除前的迟到回答不得复活。'));
    expect(await deleting).toBeInstanceOf(Error);
    expect(f.store.request({ type: 'state' }).state?.companions.some(companion => companion.id === custom.id)).toBe(true);
    expect(f.store.getAction(action.id).taskId).toBe('custom-owner-process');
    expect(f.store.getMessage(source.id).content).toBe(source.content);
    expect(transport.request.mock.calls.some(([input]) => input.type === 'companion.delete')).toBe(false);
    stoppingAllowed = true;
    await f.service.handle({ type: 'companion.delete', id: custom.id });
    expect(f.store.request({ type: 'state' }).state?.companions.some(companion => companion.id === custom.id)).toBe(false);
    // Deleting a contact hides it; the task's historical evidence is retained.
    expect(f.store.getAction(action.id)).toMatchObject({ taskId: 'custom-owner-process', status: 'cancelled' });
    expect(transport.request.mock.calls.some(([input]) => input.type === 'message.append' && input.message.content === '删除前的迟到回答不得复活。')).toBe(false);
  });

  it('settles every parallel owner termination before reporting failure and never stops another owner', async () => {
    const slow = deferred<DshLauncherResponse>();
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async input => {
      if (input.type !== 'task.terminate') return { ok: true };
      if (input.taskId === 'owner-slow') return slow.promise;
      if (input.taskId === 'owner-reject') throw new Error('Fixture process still running');
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await f.service.handle({ type: 'state' });
    for (const taskId of ['owner-slow', 'owner-reject']) f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageId: f.source.id, title: taskId, status: 'running', taskId });
    const other = f.store.createCompanion({ name: '另一个伙伴', description: '', persona: '友好', model: '', avatar: 'flash', proactive: false });
    f.store.setCompanionActive(other.id, true);
    const otherRoom = f.store.openPrivate(other.id), otherSource = f.store.appendMessage({ conversationId: otherRoom.id, authorId: 'user', content: '另一位伙伴的委托。' });
    const otherAction = f.store.createAction({ companionId: other.id, conversationId: otherRoom.id,
      sourceMessageId: otherSource.id, title: '别人的任务', status: 'running', taskId: 'different-owner' });
    let settled = false;
    const resetting = f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' }).then(() => undefined, error => error as Error).then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(requestTask.mock.calls.filter(([input]) => input.type === 'task.terminate')).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(100); expect(settled).toBe(false);
    expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
    slow.resolve({ ok: true }); expect(await resetting).toBeInstanceOf(Error);
    expect(requestTask.mock.calls.some(([input]) => input.type === 'task.terminate' && input.taskId === 'different-owner')).toBe(false);
    expect(f.store.getAction(otherAction.id)).toMatchObject({ status: 'running', taskId: 'different-owner' });
    expect(f.store.request({ type: 'companion.reset.status', id: 'sister' }).reset).toMatchObject({ phase: 'stopping', status: 'failed' });
    expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
  });

  it('preserves the custom contact and evidence when key cleanup fails, then cancels historical activity on a successful retry', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    await f.service.handle({ type: 'state' });
    const custom = f.store.createCompanion({ name: '待删除伙伴', description: '', persona: '友好', model: '', avatar: 'flash', proactive: false });
    f.store.setCompanionActive(custom.id, true);
    const room = f.store.openPrivate(custom.id), source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '保存这条任务来源。' });
    const action = f.store.createAction({ companionId: custom.id, conversationId: room.id, sourceMessageId: source.id,
      title: '保留既有证据的任务', status: 'running', taskId: 'credential-owner-process' });
    const credentials = (f.service as unknown as { credentials: { save(id: string, key: string): Promise<void> } }).credentials;
    const save = vi.spyOn(credentials, 'save').mockRejectedValueOnce(new Error('Fixture credential cleanup unavailable'));
    await expect(f.service.handle({ type: 'companion.delete', id: custom.id })).rejects.toThrow('credential cleanup unavailable');
    expect(requestTask.mock.calls.some(([input]) => input.type === 'task.terminate' && input.taskId === 'credential-owner-process')).toBe(true);
    expect(save).toHaveBeenCalledWith(custom.id, '');
    expect(f.store.request({ type: 'state' }).state?.companions.some(companion => companion.id === custom.id)).toBe(true);
    expect(f.store.getMessage(source.id).content).toBe(source.content);
    expect(f.store.getAction(action.id).taskId).toBe('credential-owner-process');
    expect(transport.request.mock.calls.some(([input]) => input.type === 'companion.delete')).toBe(false);
    await f.service.handle({ type: 'companion.delete', id: custom.id });
    expect(f.store.request({ type: 'state' }).state?.companions.some(companion => companion.id === custom.id)).toBe(false);
    expect(f.store.getAction(action.id)).toMatchObject({ taskId: 'credential-owner-process', status: 'cancelled' });
    expect(f.store.getMessage(source.id).content).toBe(source.content);
  });

  it('retains an unacknowledged started process for reset retry when both tracking and immediate termination fail', async () => {
    let canStop = false;
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async input => {
      if (input.type === 'task.run') return { ok: true, operationId: 'untracked-owner-process' };
      if (input.type === 'task.terminate' && !canStop) throw new Error('Fixture stop unavailable');
      return { ok: true };
    });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    transport.request.mockImplementation(async command => {
      if (command.type === 'companion.task.track') throw new Error('Fixture durable tracking temporarily unavailable');
      return f.store.request(command);
    });
    await f.service.handle({ type: 'action.run', companionId: 'sister', conversationId: f.conversation.id,
      sourceMessageId: f.source.id, title: '确认写入失败的进程', prompt: '只读检查。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]?.status).toBe('failed'), { timeout: 5000 });
    expect(requestTask.mock.calls.some(([input]) => input.type === 'task.terminate' && input.taskId === 'untracked-owner-process')).toBe(true);
    expect(f.store.request({ type: 'companion.task-ids', id: 'sister' }).companionTaskIds).toEqual([]);
    await expect(f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' })).rejects.toThrow('尚未确认停止');
    expect(f.store.getMessage(f.source.id).content).toBe(f.source.content);
    canStop = true;
    await f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' }); await finishReset(f.store);
    expect(f.store.listAction()).toEqual([]);
    expect(f.store.messages({ conversationId: f.store.openPrivate('sister').id }).messages).toEqual([]);
    expect(transport.fetch).not.toHaveBeenCalled();
  });
});

function modelStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'Content-Type': 'text/event-stream' } });
  return { response, cancel, send(delta: unknown, finish_reason: string | null = null) {
    controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'));
  } };
}

describe('CompanionService current public player identity', () => {
  it('uses saved public information in each conversation without changing the durable player ID', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    const first = (await f.service.handle({ type: 'player.profile.get' })).playerProfile!;
    await f.service.handle({ type: 'player.profile.update', expectedRevision: first.revision,
      profile: { name: '林澈', description: '喜欢海边和安静的音乐。' } });
    transport.fetch.mockResolvedValue(modelResponse('记得你的公开自述了。'));
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '你好', clientId: 'public-profile-identity' })).message!;
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    const body = JSON.parse(String(transport.fetch.mock.calls[0]![1]?.body));
    const context = JSON.parse(body.messages[1].content);
    expect(context.publicProfiles.find((profile: { id: string }) => profile.id === 'user')).toMatchObject({ id: 'user', kind: 'human_player', name: '林澈', description: '喜欢海边和安静的音乐。' });
    expect(context.identity.currentReply.speaker).toMatchObject({ id: 'user', kind: 'human_player', name: '林澈' });
    expect(f.store.getMessage(source.id).authorId).toBe('user');
    const checkpoint = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(checkpoint.context!.user).not.toContain('publicProfiles');
    // Instructions may name an encoding; durable data must not carry pixels.
    expect(JSON.stringify({ user: JSON.parse(checkpoint.context!.user), turns: checkpoint.turns })).not.toContain('"base64":');
    expect(JSON.stringify(checkpoint)).not.toContain('data:image/');
  });

  it('discards an in-flight response to an outdated profile and retries with the latest identity', async () => {
    const pending = deferred<Response>();
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), true);
    transport.fetch.mockImplementationOnce(() => pending.promise).mockResolvedValue(modelResponse('新的公开资料已生效。'));
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '认识一下彼此', clientId: 'profile-changed-mid-reply' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const first = (await f.service.handle({ type: 'player.profile.get' })).playerProfile!;
    await f.service.handle({ type: 'player.profile.update', expectedRevision: first.revision,
      profile: { name: '澈', description: '这是更新后的公开自述。' } });
    pending.resolve(modelResponse('旧资料中的称呼。'));
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(JSON.parse(String(transport.fetch.mock.calls[1]![1]?.body)).messages[1].content);
    expect(latest.identity.currentReply.speaker).toMatchObject({ id: 'user', name: '澈' });
    expect(latest.publicProfiles.find((profile: { id: string }) => profile.id === 'user').description).toBe('这是更新后的公开自述。');
    expect(replyEvents().some(event => event.phase === 'discarded')).toBe(true);
    const loop = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(f.store.getMessage(loop.messageId!).content).toBe('新的公开资料已生效。');
    expect(JSON.stringify(loop.turns)).not.toContain('旧资料中的称呼');
  });
  it('refreshes the companion public profile during a pending reply without cancelling its source request', async () => {
    const pending = deferred<Response>(), requestTask = vi.fn(async () => ({ ok: true as const }));
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask));
    transport.fetch.mockImplementationOnce(() => pending.promise).mockResolvedValue(modelResponse('我使用更新后的公开资料。'));
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '我们接着聊', clientId: 'companion-profile-inflight' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const previous = f.store.state().companions[0]!;
    await f.service.handle({ type: 'companion.update', id: previous.id, expectedRevision: previous.revision,
      companion: { ...seeds[0]!, name: '鱼', description: '更新后的公开签名。' } });
    pending.resolve(modelResponse('旧伙伴资料中的回复。'));
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    const latest = JSON.parse(JSON.parse(String(transport.fetch.mock.calls[1]![1]?.body)).messages[1].content);
    expect(latest.identity.self).toMatchObject({ id: 'sister', name: '鱼', description: '更新后的公开签名。' });
    const loop = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(f.store.getMessage(loop.messageId!).content).toBe('我使用更新后的公开资料。');
    expect(requestTask).not.toHaveBeenCalled();
  });
  it('discards an in-flight result when a source is forgotten and rebuilds the allowed source window', async () => {
    const pending = deferred<Response>();
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    transport.fetch.mockImplementationOnce(() => pending.promise).mockResolvedValue(modelResponse('现在仅使用仍有效的资料。'));
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '只处理这条新的消息', clientId: 'forget-during-inference' })).message!;
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    await f.service.handle({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, sourceMessageIds: [f.source.id], persistent: false });
    pending.resolve(modelResponse('这段依赖旧资料的结果不应提交。'));
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    expect(transport.fetch).toHaveBeenCalledTimes(2);
    const context = JSON.parse(JSON.parse(String(transport.fetch.mock.calls[1]![1]?.body)).messages[1].content);
    expect(context.messages.some((message: { id: string }) => message.id === f.source.id)).toBe(false);
    expect(context.taskRequest.sourceMessageId).toBe(source.id);
    const loop = f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop!;
    expect(f.store.getMessage(loop.messageId!).content).toBe('现在仅使用仍有效的资料。');
    expect(JSON.stringify(loop.turns)).not.toContain('不应提交');
  });
});

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
  it('answers chat in place by phone and cancellation prevents the pending answer without reserving a computer', async () => {
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockResolvedValue({ ok: true });
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), requestTask), false, false);
    const pending = deferred<Response>(); transport.fetch.mockImplementation(() => pending.promise);
    const initial = f.store.request({ type: 'world.snapshot' }).world!.actors[0]!, before = initial.position, beforeRoute = initial.route;
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '请解释这段代码。', clientId: 'walking-before-inference' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce(), { timeout: 5000 });
    const phone = f.store.request({ type: 'world.snapshot' }).world!;
    expect(phone.works.some(work => work.kind === 'chat' && work.status === 'ready' && !work.computerId)).toBe(true);
    expect(phone.actors[0]!.position).toEqual(before); expect(phone.actors[0]!.route).toEqual(beforeRoute);
    expect(phone.actors[0]!.communication?.phase).toBe('responding'); expect(requestTask).not.toHaveBeenCalled();
    await f.service.handle({ type: 'reply.cancel', conversationId: f.conversation.id });
    pending.resolve(modelResponse('已取消的迟到手机回答不能发送。'));
    await vi.advanceTimersByTimeAsync(1000);
    const stopped = f.store.request({ type: 'world.snapshot' }).world!;
    expect(stopped.works.every(work => work.status === 'ended')).toBe(true);
    expect(stopped.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false);
    expect(transport.fetch).toHaveBeenCalledOnce();
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(message => message.content.includes('已取消的迟到手机回答'))).toBe(false);
  });
  it('answers an awake deadline message by phone without inventing a computer trip or running', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const content = '两分钟后就截止了，快救我核对这句话。';
    transport.worldFetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      return modelResponseForJson(data.purpose === 'world_attention' ? { urgency: 'urgent', confidence: .98, evidence: [data.source.content], reason: '实际用户当前临近截止并请求立即协助。' }
        : { action: null, reason: '暂不处理其他世界动作。', appraisals: [] });
    });
    transport.fetch.mockImplementation(async (_url, init) => {
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(context.world.actors[0].communication).toMatchObject({ channel: 'phone', phase: 'responding' });
      expect(context.world.actors[0].furnitureId).not.toBe('sister_computer');
      expect(context.world.works.filter((work: { kind: string }) => work.kind === 'chat').every((work: { computerId?: string }) => !work.computerId)).toBe(true);
      return modelResponse('文字检查完成。');
    });
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content, clientId: 'awake-deadline' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false);
    // Native image preparation is real asynchronous I/O, independent of the virtual world clock.
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });

  it('perceives an implicit deadline notification while asleep, without waking for quoted urgency, negation or conditional instructions', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const routine = (await f.service.handle({ type: 'routine.get', ...scope })).routine!;
    await f.service.handle({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: '01:00', wakeAt: '03:00', meals: [], habits: [] } });
    await vi.advanceTimersByTimeAsync(15_000); // Be physically asleep before evaluating the notification.
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
    const preparing = f.store.request({ type: 'world.snapshot' }).world!.actors[0]!;
    expect(['waking', 'standingUp', 'idle']).toContain(preparing.activity); expect(preparing.route).toEqual([]);
    await vi.advanceTimersByTimeAsync(12000);
    // Current identity images are prepared through real file/Sharp I/O, which
    // is not completed merely by advancing the deterministic world clock.
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: urgent.id }).works?.[0]?.status).toBe('done'), { timeout: 5000 });
    expect(transport.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.parse(String(transport.fetch.mock.calls[0]?.[1]?.body)).messages[1].content).taskRequest.prompt).toBe(deadline);
    for (const source of ordinary) expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.[0]?.status).toBe('queued');
  });

  it('calls the primary model from the actual phone position and returns the same location in a native inspection', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))), false, false);
    const position = f.store.request({ type: 'world.snapshot' }).world!.actors[0]!.position;
    let observed = false;
    transport.fetch.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      expect(data.world.actors.find((actor: { companionId: string }) => actor.companionId === 'sister')).toMatchObject({ position, communication: { phase: 'responding' } });
      expect(data.world.works.some((work: { status: string }) => work.status === 'ready')).toBe(true);
      const tool = request.messages.findLast((message: { role: string }) => message.role === 'tool');
      if (!tool) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'inspect-actual-world', type: 'function', function: { name: 'world', arguments: '{"action":"inspect"}' } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
      expect(JSON.parse(tool.content).world.actors[0].position).toEqual(position); observed = true;
      return modelResponse('我在这里用手机回复你。');
    });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '看看你现在在哪里。', clientId: 'native-world' })).message!;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(observed).toBe(true), { timeout: 5000 });
    expect(f.store.request({ type: 'work.list', sourceMessageId: source.id }).works?.[0]?.status).toBe('done');
    await vi.waitFor(() => expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy)).toBe(false), { timeout: 5000 });
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
      expect(context.worldClock.now).toBeDefined();
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
    // Reminders retain the physical promise gate: after phone chat, the actor
    // must walk to the reserved computer and finish seating before delivery.
    await vi.advanceTimersByTimeAsync(15_000);
    const listed = f.store.request({ type: 'schedule.list', companionId: 'sister', conversationId: f.conversation.id, includeHistory: true });
    expect(listed.scheduleOccurrences).toHaveLength(2);
    expect(listed.scheduleOccurrences?.every(occurrence => occurrence.status === 'done')).toBe(true);
    const ids = listed.scheduleOccurrences!.map(occurrence => occurrence.messageId);
    expect(new Set(ids).size).toBe(2);
    expect(f.store.request({ type: 'messages', conversationId: f.conversation.id, limit: 50 }).messages?.filter(message => ids.includes(message.id))).toHaveLength(2);
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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

  it.each([false, true])('queues ordinary sleeping chat and wakes for urgent contact, explicit priority=%s', async explicit => {
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
    const urgentText = explicit ? '请先帮我处理这件事。' : '醒醒，有件紧急的事需要你帮忙。';
    const urgent = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: urgentText, ...(explicit ? { priority: 'urgent' as const } : {}), clientId: 'actual-urgent' })).message!;
    await vi.advanceTimersByTimeAsync(12000); // Finish any actual wake, turn, walk and sit transitions.
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: urgent.id }).works?.[0]?.status).toBe('done'), { timeout: 5000 });
    expect(observed).toEqual([urgentText]);
    expect(f.store.request({ type: 'work.list', sourceMessageId: ordinary.id }).works?.[0]?.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(10000); // Returning to bed is physical movement, not an immediate phase label.
    expect((await f.service.handle({ type: 'routine.get', companionId: 'sister', conversationId: f.conversation.id })).routine?.runtime.phase).toBe('sleeping');
    vi.setSystemTime('2026-10-13T03:00:00Z'); await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list', sourceMessageId: ordinary.id }).works?.[0]?.status).toBe('done'), { timeout: 5000 });
    expect(observed).toEqual([urgentText, '有空时陪我聊聊吧。']);
  });

  it('reports offline on an observed authentication failure and clears that observation after the connection changes', async () => {
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })));
    const f = fixture(dsh);
    let configured = false; let apiKey = 'original-test-key';
    await closeService(f.service);
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
    f.store.setCompanionActive(flash.id, true);
    keepAwake(f.store, flash.id, f.store.openPrivate(flash.id).id);
    const group = f.store.createConversation('', ['sister', flash.id]);
    await f.service.handle({ type: 'message.send', conversationId: group.id, content: '大家聊聊今天的心情吧。', clientId: 'group-recovery-source', delivery: 'chat' });
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 12000 });
    const closing = closeService(f.service); pending.resolve(modelResponse('这条未完成的回复不应写入。')); await closing;
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
    const dsh = fakeDsh(() => ({ tasks: [], operations: [{ id: 'dsh-task', status: 'failed', error: 'DSH 0.2.1-alpha.4 兼容性检测尚未通过。失败检查：model-settings。' }] }), requestTask);
    const f = fixture(dsh);
    await f.service.handle({ type: 'action.run', conversationId: f.conversation.id, companionId: 'sister',
      sourceMessageId: f.source.id, title: '整理文件', prompt: '按类型整理文件。' });
    await vi.waitFor(() => expect(f.store.listAction()[0]).toMatchObject({ status: 'failed', taskId: 'dsh-task' }), { timeout: 5000 });
    expect(f.store.listAction()[0]?.error).toContain('失败检查：model-settings');
    const options = requestTask.mock.calls.find(([request]) => request.type === 'task.run')?.[1];
    expect(options).toMatchObject({ toolkit: true, interactive: true });
    expect(options).not.toHaveProperty('connection');
    expect(transport.fetch).not.toHaveBeenCalled();
    await closeService(f.service);

    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened);
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
    expect(requestTask.mock.calls.some(([request]) => request.type === 'task.terminate' && request.taskId === 'dsh-task')).toBe(true);
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened);
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

    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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

  it('keeps proactive context through already sent replies and preserves the original request checkpoint', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn()));
    const role = f.store.state().companions[0]!; f.store.updateCompanion(role.id, { ...role, proactive: true });
    const prior = f.store.appendMessage({ conversationId: f.conversation.id, authorId: role.id, content: '之前的整理已经结束，结果在这里。', replyDirective: 'none' });
    const original = { conversationId: f.conversation.id, companionId: role.id, sourceMessageId: f.source.id, messageId: prior.id,
      status: 'done' as const, turns: [{ text: prior.content, rawText: prior.content, calls: [] }], supplements: [] };
    f.store.request({ type: 'loop.save', checkpoint: original });
    transport.fetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.messages.some((message: { id: string; content: string }) => message.id === prior.id && message.content === prior.content)).toBe(true);
      expect(data.event).toBe('proactive_opportunity'); expect(data.taskRequest).toBeUndefined();
      expect(data.identity.authorization.playerRequestMessageId).toBeNull();
      return modelResponse('刚刚听到一首新歌，想分享给你。');
    });
    f.store.request({ type: 'work.enqueue', work: { id: 'proactive_context', companionId: role.id, conversationId: f.conversation.id,
      sourceMessageId: f.source.id, proactive: true, status: 'queued', createdAt: fixedTime, updatedAt: fixedTime } });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() => expect(f.store.request({ type: 'work.list' }).works?.find(work => work.id === 'proactive_context')?.status).toBe('done'));
    expect(f.store.request({ type: 'loop.get', sourceMessageId: f.source.id, companionId: role.id }).loop).toEqual(original);
    const proactive = f.store.request({ type: 'loop.get', sourceMessageId: f.source.id, companionId: role.id, proactiveWorkId: 'proactive_context' }).loop!;
    expect(proactive.contextThroughSequence).toBeGreaterThanOrEqual(prior.sequence);
    expect(f.store.getMessage(proactive.messageId!).replyToId).toBeUndefined();
    expect(transport.fetch).toHaveBeenCalledOnce(); await closeService(f.service);
  });


});


function capabilityResponse(text: string, tasks: Array<{ title: string; prompt: string }>, callId = 'call-real'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: text ? JSON.stringify({ text, memories: [] }) : null,
    tool_calls: [{ id: callId, type: 'function', function: { name: 'dsh', arguments: JSON.stringify({ tasks }) } }] } }] }),
    { headers: { 'Content-Type': 'application/json' } });
}
describe('one durable bubble per source and native multi-step main loop', () => {
  it('hands a chat movement to the durable loop and automatically reports freshly observed weather without another player message', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn()));
    let chatCalls = 0, observations = 0; let expectedLabel = '';
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), context = JSON.parse(body.messages[1].content);
      if (context.purpose === 'activity_task_step') {
        observations++;
        expect(context.originalRequest.content).toBe('现在天气怎样？去门口看一眼再告诉我。');
        expect(context.world.actors[0].position).toEqual({ x: 10, y: 15 });
        expect(context.world.actors[0].route).toHaveLength(0);
        expect(context.world.environment.weatherStatus).toBe('current');
        expect(context.world.environment.weatherObservedAtVirtual).toBe(context.world.perception.observedAtVirtual);
        const authoritative = f.store.request({ type: 'world.snapshot' }).world!;
        expect(context.world.environment.weather).toBe(authoritative.environment.weather);
        expectedLabel = context.world.environment.weatherLabel;
        return modelResponseForJson({ status: 'complete', action: null, wait: null, summary: '我到门口看过了，现在是' + expectedLabel + '。' });
      }
      chatCalls++;
      // Reproduce the user's duplicate native moves. Neither retry may reset the
      // route or create a second goal, and chat completion must not lose the goal.
      if (chatCalls <= 2) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [
        { id: 'weather-move-' + chatCalls, type: 'function', function: { name: 'world', arguments: '{"action":"move","destinationId":"sister_door"}' } },
      ] } }] }), { headers: { 'Content-Type': 'application/json' } });
      return modelResponse('我到门口核实后告诉你。');
    });
    const source = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '现在天气怎样？去门口看一眼再告诉我。', clientId: 'weather-continuation' })).message!;
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const tasks = f.store.request({ type: 'activity.list', ...scope }).activityTasks!;
    expect(tasks).toHaveLength(1); expect(tasks[0]).toMatchObject({ status: 'waiting', step: 1 });
    await vi.advanceTimersByTimeAsync(25000);
    await vi.waitFor(() => expect(f.store.request({ type: 'activity.get', ...scope, id: tasks[0]!.id }).activityTask?.status).toBe('succeeded'), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    const reports = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.replyToId === source.id && message.content.includes('我到门口看过了'));
    expect(reports).toHaveLength(1); expect(reports[0]!.content).toContain(expectedLabel); expect(observations).toBe(1); expect(chatCalls).toBe(3);
    expect(transport.request.mock.calls.filter(([request]) => request.type === 'activity.motion.ensure')).toHaveLength(2);
    expect(f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'user' && message.content === source.content)).toHaveLength(1);
  });
  it('processes one retried player submission only once while generating and after completion', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn())), pending = deferred<Response>();
    transport.fetch.mockImplementation(() => pending.promise);
    const command = { type: 'message.send' as const, conversationId: f.conversation.id, content: '你去找妹妹玩吧。', clientId: 'same_submission' };
    const first = (await f.service.handle(command)).message!;
    await vi.advanceTimersByTimeAsync(500); await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce());
    expect((await f.service.handle(command)).message!.id).toBe(first.id);
    pending.resolve(modelResponse('我先问问她有没有空。'));
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: first.id, companionId: 'sister' }).loop?.status).toBe('done'));
    expect((await f.service.handle(command)).message!.id).toBe(first.id);
    const related = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => message.authorId === 'sister' && message.replyToId === first.id);
    expect(related).toHaveLength(1); expect(transport.fetch).toHaveBeenCalledOnce(); await closeService(f.service);
  });
  it('keeps weather and queued clock requests in separate loops while the current computer work finishes first', async () => {
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
      if (tool) return modelResponse(JSON.parse(tool.content).tasks[0].finalReply);
      const clock = context.taskRequest?.prompt === '现在几点了';
      return capabilityResponse('', [{ title: clock ? '读取系统时间' : '查询上海天气', prompt: clock ? '读取系统时间与时区' : '查询上海实时天气' }]);
    });
    const weather = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '上海天气如何', clientId: 'weather-source' })).message!;
    await vi.waitFor(() => expect(jobs).toHaveLength(1), { timeout: 5000 });
    const clock = (await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '现在几点了', clientId: 'clock-source' })).message!;
    await vi.advanceTimersByTimeAsync(1000); expect(jobs).toHaveLength(1);
    const weatherSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop!.context!;
    expect(weatherSnapshot.user).not.toContain('现在几点了');
    expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('running');
    jobs[0]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: weather.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
    await vi.waitFor(() => expect(jobs).toHaveLength(2), { timeout: 5000 });
    expect(jobs.map(item => item.title)).toEqual(['查询上海天气', '读取系统时间']);
    const clockSnapshot = f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop!.context!;
    expect(JSON.parse(clockSnapshot.user).taskRequest).toEqual({ sourceMessageId: clock.id, prompt: '现在几点了' });
    jobs[1]!.status = 'succeeded'; await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.request({ type: 'loop.get', sourceMessageId: clock.id, companionId: 'sister' }).loop?.status).toBe('done'), { timeout: 5000 });
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
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
      'dsh', 'dsh_record', 'memory_world_query', 'memory_search', 'memory_read', 'memory_record', 'memory_revise', 'memory_organize', 'memory_forget',
      'schedule', 'state',
      'routine', 'world', 'activity', 'work', 'life_rule',
      'read_file', 'read_image', 'send_file',
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
    transport.fetch.mockImplementation(async (_url, init) => {
      if (String(init?.body).includes('用户在本次执行过程中给出的补充要求')) return modelResponse('我已按补充改成蓝色。');
      const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      // Independent native image I/O can finish in a different order than admission.
      return pending[Number(context.taskRequest.prompt.match(/独立任务(\d+)/u)[1])]!.promise;
    });
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
    const reopened = new CompanionsStore(f.databasePath, seeds.map(seed => ({ ...seed, active: true }))); stores.add(reopened); bindStorage(reopened);
    transport.fetch.mockReset(); transport.fetch.mockImplementation(async () => modelResponse('自动继续未开始的排队消息。'));
    const restarted = startService(f.root, dsh);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledTimes(2), { timeout: 5000 });
    await vi.waitFor(() => expect(reopened.messages({ conversationId: f.conversation.id }).messages.filter(item => item.content === '自动继续未开始的排队消息。')).toHaveLength(2), { timeout: 5000 });
    expect(reopened.request({ type: 'work.list' }).works?.filter(item => item.status === 'done').map(item => item.sourceMessageId)).toEqual(ids.slice(5));
    await closeService(restarted);
  });
});

describe('CompanionService native work and life management', () => {
  function native(service: CompanionService, name: string, args: unknown, scope: { companionId: string; conversationId: string }, ids: string[], identity: string, sequence: number, current = true) {
    return (service as unknown as { executePartnerTool(name: string, serialized: string, scope: { companionId: string; conversationId: string }, ids: string[], identity: string, sequence: number, signal: undefined, current: boolean): Promise<CompanionStorageResponse> })
      .executePartnerTool(name, JSON.stringify(args), scope, ids, identity, sequence, undefined, current);
  }
  function authorize() {
    transport.fetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.purpose).toBe('companion_management_authorization');
      return modelResponseForJson({ allowed: true, confidence: .98, sourceMessageId: data.source.id, tool: data.tool, action: data.action, targetId: data.targetId, evidence: [data.source.content] });
    });
  }
  it.each(['visit', 'message'] as const)('retains the full user intent=%s when the first native action is only a phone message', async intent => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' });
    const target = f.store.createCompanion({ name: '妹妹', description: '', persona: '友好', model: '', avatar: 'flash', proactive: false });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: intent === 'visit' ? '你去找妹妹玩吧。' : '你发消息问问妹妹有空吗。', replyDirective: 'none' });
    transport.fetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      expect(data.purpose).toBe('world_message_authorization'); expect(data.intentRules).toContain('完整目标');
      return modelResponseForJson({ allowed: true, confidence: .99, evidence: [source.content], reason: '当前明确请求。', intent });
    });
    const scope = { companionId: 'sister', conversationId: f.conversation.id }, args = { action: 'message', recipientIds: [target.id], text: '现在方便吗？' };
    const sent = await native(f.service, 'world', args, scope, [source.id], 'native_phone_visit', source.sequence);
    expect(sent.ok).toBe(true); expect(sent.socialPending).toBe(true);
    expect(sent.activityTask?.visitTargetId).toBe(intent === 'visit' ? target.id : undefined);
    expect(f.store.request({ type: 'activity.list', ...scope }).activityTasks).toHaveLength(intent === 'visit' ? 1 : 0);
    await closeService(f.service);
  });
  it.each(['visit', 'message'] as const)('checks a direct native visit against the real user goal=%s before retaining movement', async intent => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' });
    const target = f.store.createCompanion({ name: '妹妹', description: '', persona: '友好', model: '', avatar: 'flash', proactive: false });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: intent === 'visit' ? '去找妹妹玩吧。' : '给妹妹发一句问好就行，不用过去。', replyDirective: 'none' });
    transport.fetch.mockResolvedValue(modelResponseForJson({ allowed: true, intent, confidence: .99, evidence: [source.content], reason: '明确的原始目标。' }));
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const result = await native(f.service, 'world', { action: 'visit', targetCompanionId: target.id, reason: '现在方便来找你玩吗？' }, scope, [source.id], 'direct_visit', source.sequence);
    expect(result.ok).toBe(intent === 'visit');
    expect(f.store.request({ type: 'activity.list', ...scope }).activityTasks).toHaveLength(intent === 'visit' ? 1 : 0);
    expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.some(scene => scene.ownerId === target.id)).toBe(false);
    await closeService(f.service);
  });
  it('binds native work and life writes to the exact current human and keeps creation retries idempotent', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' }); authorize();
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请建立只读整理照片的工作，禁止删除或改写原文件；并增加每天14点到18点有35%机会问候朋友的生活事件。', replyDirective: 'none' });
    const work = { action: 'create', title: '只读整理照片', instruction: '只读整理照片，禁止删除或改写原文件。', sourceMessageId: source.id, evidence: ['请建立只读整理照片的工作，禁止删除或改写原文件'] };
    const created = await native(f.service, 'work', work, scope, [source.id], 'work-tool-call', source.sequence);
    expect(created.workOrder).toMatchObject({ companionId: 'sister', publisherId: 'user', sourceMessageId: source.id, execution: 'external', status: 'accepted', instruction: work.instruction });
    expect((await native(f.service, 'work', work, scope, [source.id], 'work-tool-call', source.sequence)).workOrder!.id).toBe(created.workOrder!.id);
    const rule = { title: '午后问候朋友', enabled: true, startMinute: 840, endMinute: 1080, probability: .35, action: 'message' };
    const args = { action: 'create', rule, sourceMessageId: source.id, evidence: ['增加每天14点到18点有35%机会问候朋友的生活事件'] };
    const first = await native(f.service, 'life_rule', args, scope, [source.id], 'life-tool-call', source.sequence);
    expect(first.lifeRule).toMatchObject({ companionId: 'sister', ...rule });
    expect((await native(f.service, 'life_rule', args, scope, [source.id], 'life-tool-call', source.sequence)).lifeRule!.id).toBe(first.lifeRule!.id);
    const checks = transport.fetch.mock.calls.map(([, init]) => JSON.parse(JSON.parse(String(init?.body)).messages[1].content));
    expect(checks.every(value => value.source.id === source.id && value.source.authorId === 'user')).toBe(true);
    expect(checks[0].requested.instruction).toContain('禁止删除或改写');
    expect(f.store.listAction(scope.conversationId)).toHaveLength(0);
  });
  it('denies recalled, autonomous, semantically unrequested or newly withdrawn management sources before durable mutation', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' });
    const scope = { companionId: 'sister', conversationId: f.conversation.id }, source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '今天只是聊天，不要创建工作。', replyDirective: 'none' });
    const args = { action: 'create', title: '不该创建的工作', instruction: '擅自改文件', sourceMessageId: source.id, evidence: [source.content] };
    expect((await native(f.service, 'work', args, scope, [f.source.id], 'old-source', source.sequence)).ok).toBe(false);
    expect((await native(f.service, 'work', args, scope, [source.id], 'proactive-source', source.sequence, false)).ok).toBe(false);
    expect(transport.fetch).not.toHaveBeenCalled();
    transport.fetch.mockImplementation(async (_url, init) => { const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content); return modelResponseForJson({ allowed: false, confidence: .99, sourceMessageId: source.id, tool: data.tool, action: data.action, targetId: null, evidence: [source.content] }); });
    expect((await native(f.service, 'work', args, scope, [source.id], 'unrequested', source.sequence)).ok).toBe(false);
    transport.fetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      f.store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id] });
      return modelResponseForJson({ allowed: true, confidence: .99, sourceMessageId: source.id, tool: data.tool, action: data.action, targetId: null, evidence: [source.content] });
    });
    expect((await native(f.service, 'work', args, scope, [source.id], 'withdrawn-during-check', source.sequence)).ok).toBe(false);
    expect(f.store.request({ type: 'work-order.list', ...scope, includeHistory: true }).workOrderPage!.items).toHaveLength(0);
  });
  it('does not acknowledge a native work pause until the actual owner task termination resolves', async () => {
    const stopped = deferred<void>(); let status: DshTaskRecord['status'] = 'running';
    const requestTask = vi.fn<DshLauncher['requestTask']>().mockImplementation(async command => { if (command.type === 'task.terminate') { await stopped.promise; status = 'cancelled'; } return { ok: true }; });
    const f = fixture(fakeDsh(() => ({ tasks: [taskRecord(status)], operations: [] }), requestTask));
    await f.service.handle({ type: 'state' }); authorize();
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const action = f.store.createAction({ ...scope, sourceMessageId: f.source.id, title: '整理照片', status: 'running', taskId: 'dsh-task' });
    const order = f.store.request({ type: 'work-order.list', ...scope }).workOrderPage!.items.find(order => order.actionId === action.id)!;
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '请暂停整理照片这份工作，原文件保留。', replyDirective: 'none' });
    let acknowledged = false;
    const pending = native(f.service, 'work', { action: 'pause', paused: true, id: order.id, expectedRevision: order.revision, sourceMessageId: source.id, evidence: [source.content] }, scope, [source.id], 'pause-real-owner', source.sequence).then(result => { acknowledged = true; return result; });
    await vi.waitFor(() => expect(requestTask).toHaveBeenCalledWith({ type: 'task.terminate', taskId: 'dsh-task' }));
    expect(acknowledged).toBe(false); expect(f.store.listAction(scope.conversationId).find(item => item.id === action.id)!.status).toBe('running');
    stopped.resolve(); expect((await pending).ok).toBe(true); expect(acknowledged).toBe(true);
    expect(f.store.listAction(scope.conversationId).find(item => item.id === action.id)!.status).toBe('cancelled');
    expect(f.store.request({ type: 'work-order.list', ...scope }).workOrderPage!.items.find(item => item.id === order.id)!.status).toBe('paused');
  });
});

describe('CompanionService executor feedback evidence boundary', () => {
  function feedback(service: CompanionService, action: ReturnType<CompanionsStore['createAction']>) {
    return (service as unknown as { feedbackAction(value: typeof action, status: 'succeeded', content: string): Promise<void> })
      .feedbackAction(action, 'succeeded', '执行器实际返回的结果。');
  }
  it.each([['forget', false], ['forget', true], ['reset', false], ['reset', true]] as const)('suppresses both normal and fallback late feedback after %s (provider fails=%s)', async (withdrawal, fails) => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' });
    const source = f.store.appendMessage({ conversationId: f.conversation.id, authorId: 'user', content: '只读核对SOURCE_FEEDBACK_SECRET。', replyDirective: 'none' });
    const action = f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: source.id, title: 'FALLBACK_TITLE_SECRET', status: 'succeeded' });
    const generated = deferred<Response>();
    transport.fetch.mockImplementation(async () => { const response = await generated.promise; if (fails) throw new Error('Provider failed after withdrawal'); return response; });
    const pending = feedback(f.service, action);
    await vi.waitFor(() => expect(transport.fetch).toHaveBeenCalledOnce());
    if (withdrawal === 'forget') await f.service.handle({ type: 'memory.forget', companionId: 'sister', conversationId: f.conversation.id, sourceMessageIds: [source.id], persistent: true });
    else { await f.service.handle({ type: 'companion.reset', id: 'sister', scope: 'all' }); await finishReset(f.store); }
    generated.resolve(modelResponse('SOURCE_FEEDBACK_SECRET不得迟到重现。')); await pending;
    const room = f.store.openPrivate('sister');
    expect(f.store.messages({ conversationId: room.id }).messages.filter(message => message.authorId !== 'user' && !message.memoryEvidenceOnly).some(message => /SOURCE_FEEDBACK_SECRET|FALLBACK_TITLE_SECRET|执行器已返回结果/u.test(message.content))).toBe(false);
    expect(transport.fetch).toHaveBeenCalledOnce();
  });
  it('discards a reply referencing withdrawn memory and regenerates once with the new real SQLite context', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const }))));
    await f.service.handle({ type: 'state' });
    const scope = { companionId: 'sister', conversationId: f.conversation.id };
    const history = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我喜欢REFERENCE_MEMORY_SECRET。', replyDirective: 'none' });
    const source = f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请反馈这份只读检查的实际结果。', replyDirective: 'none' });
    const memory = f.store.request({ type: 'memory.record', ...scope, beforeSequence: source.sequence, candidate: { kind: 'preference', subject: 'user', factKey: 'favorite_reference', value: 'REFERENCE_MEMORY_SECRET', content: history.content, sourceMessageIds: [history.id], evidence: [{ sourceMessageId: history.id, quote: history.content }] } }).memories![0]!;
    // Only semantic retrieval selection is fixed; evidence validity remains the real SQLite implementation.
    const serviceMemory = (f.service as unknown as { memory: CompanionMemoryService }).memory;
    vi.spyOn(serviceMemory, 'recall').mockImplementation(async () => ({
      memories: f.store.request({ type: 'memory.records.filter', ...scope, ids: [memory.id] }).memories ?? [],
      sources: f.store.request({ type: 'memory.sources.filter', ...scope, ids: [history.id] }).memorySources ?? [],
      reasons: [], pending: false, degraded: false,
    }));
    const action = f.store.createAction({ ...scope, sourceMessageId: source.id, title: '核对实际结果', status: 'succeeded' });
    const generated = deferred<Response>(); let calls = 0;
    transport.fetch.mockImplementation(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (++calls === 1) { expect(JSON.stringify(data)).toContain('REFERENCE_MEMORY_SECRET'); return generated.promise; }
      expect(JSON.stringify(data)).not.toContain('REFERENCE_MEMORY_SECRET'); return modelResponse('实际检查结果已返回，详情在工作卡中。');
    });
    const pending = feedback(f.service, action); await vi.waitFor(() => expect(calls).toBe(1));
    await f.service.handle({ type: 'memory.forget', ...scope, sourceMessageIds: [history.id], persistent: true });
    generated.resolve(modelResponse('带有REFERENCE_MEMORY_SECRET的旧回答')); await pending;
    const sent = f.store.messages({ conversationId: scope.conversationId }).messages.filter(message => message.authorId === 'sister' && !message.memoryEvidenceOnly);
    expect(calls).toBe(2); expect(sent).toHaveLength(1); expect(sent[0]!.content).toBe('实际检查结果已返回，详情在工作卡中。');
  });
  it('bounds repeated evidence changes to the initial generation plus two retries and never publishes a stale result', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })))); await f.service.handle({ type: 'state' });
    const scope = { companionId: 'sister', conversationId: f.conversation.id }, action = f.store.createAction({ ...scope, sourceMessageId: f.source.id, title: '已完成的检查', status: 'succeeded' });
    const unrelated = Array.from({ length: 3 }, (_, index) => f.store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '稍后独立的话题' + index, replyDirective: 'none' }));
    let calls = 0;
    transport.fetch.mockImplementation(async () => { const source = unrelated[calls++]!; await f.service.handle({ type: 'memory.forget', ...scope, sourceMessageIds: [source.id], persistent: true }); return modelResponse('证据变化中的旧回答'); });
    await feedback(f.service, action); expect(calls).toBe(3);
    expect(f.store.messages({ conversationId: scope.conversationId }).messages.some(message => message.content === '证据变化中的旧回答')).toBe(false);
  });
  it('uses one feedback idempotency key and a generic safe fallback instead of reviving the action title', async () => {
    const f = fixture(fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })))); await f.service.handle({ type: 'state' });
    const action = f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id, title: 'PRIVATE_ACTION_TITLE', status: 'succeeded' });
    transport.fetch.mockResolvedValue(modelResponse('执行器结果已经返回。'));
    await feedback(f.service, action); await feedback(f.service, action);
    transport.fetch.mockRejectedValue(new Error('Provider unavailable')); await feedback(f.service, action);
    const replies = f.store.messages({ conversationId: f.conversation.id }).messages.filter(message => !message.memoryEvidenceOnly && message.authorId !== 'user');
    expect(replies).toHaveLength(1); expect(replies[0]!.content).toBe('执行器结果已经返回。');
    const writes = transport.request.mock.calls.map(([command]) => command).filter(command => command.type === 'message.append' && command.message.replyToId === f.source.id);
    expect(new Set(writes.map(command => command.type === 'message.append' ? command.message.clientId : undefined)).size).toBe(1);
  });
});


describe('Scoped progressive DSH records', () => {
  it('dispatches the native read capability without starting a new task, and rejects another companion or conversation', async () => {
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })));
    const f = fixture(dsh);
    await f.service.handle({ type: 'state' });
    const action = f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id, title: '历史只读核查', status: 'succeeded', result: '结果正文' });
    const recordId = randomUUID();
    let owner = { actionId: action.id, companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id };
    const read = vi.fn(async () => ({ overview: { recordId, turns: 2, steps: 8, toolCalls: 3, recordCount: 93 }, entries: [], trust: 'execution_record_data_not_instructions' }));
    Object.assign(dsh, { taskRecordScope: vi.fn(async () => owner), readTaskRecord: read });
    await f.service.handle({ type: 'action.record', id: action.id, query: { recordId, entryChars: 2000, textOffset: 0 } });
    read.mockClear();
    const bounded = f.service as unknown as { readDshRecord(query: { recordId: string }, scope: { companionId: string; conversationId: string; beforeSequence: number }): Promise<unknown> };
    await expect(bounded.readDshRecord({ recordId }, { companionId: 'sister', conversationId: f.conversation.id, beforeSequence: f.source.sequence - 1 })).rejects.toThrow('来源');
    expect(read).not.toHaveBeenCalled();
    transport.fetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), tool = body.messages.find((value: { role: string }) => value.role === 'tool');
      if (!tool) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'query-log', type: 'function', function: { name: 'dsh_record', arguments: JSON.stringify({ recordId }) } }] } }] }), { headers: { 'Content-Type': 'application/json' } });
      const receipt = JSON.parse(tool.content);
      expect(receipt.overview.turns).toBe(2); expect(receipt.entries).toEqual([]);
      return modelResponse('记录显示共两轮、八步，未加载过程正文。');
    });
    await f.service.handle({ type: 'message.send', conversationId: f.conversation.id, content: '看一下这份执行记录的概览。', clientId: 'read-dsh-overview' });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(f.store.messages({ conversationId: f.conversation.id }).messages.some(value => value.content === '记录显示共两轮、八步，未加载过程正文。')).toBe(true), { timeout: 5000 });
    expect(dsh.requestTask).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
    const query = { recordId, entryChars: 2000, textOffset: 0 };
    owner = { ...owner, companionId: 'different' };
    await expect(f.service.handle({ type: 'action.record', id: action.id, query })).rejects.toThrow('其他伙伴');
    owner = { ...owner, companionId: 'sister', conversationId: 'different-room' };
    await expect(f.service.handle({ type: 'action.record', id: action.id, query })).rejects.toThrow('当前会话');
    expect(read).toHaveBeenCalledOnce();
    await closeService(f.service);
  });
  it('discards a page if its source is reset while the disk read is in flight', async () => {
    const dsh = fakeDsh(() => ({ tasks: [], operations: [] }), vi.fn(async () => ({ ok: true as const })));
    const f = fixture(dsh); await f.service.handle({ type: 'state' });
    const action = f.store.createAction({ companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id, title: '旧记录', status: 'succeeded' });
    const recordId = randomUUID(), pending = deferred<unknown>();
    const read = vi.fn(() => pending.promise);
    Object.assign(dsh, { taskRecordScope: vi.fn(async () => ({ actionId: action.id, companionId: 'sister', conversationId: f.conversation.id, sourceMessageId: f.source.id })), readTaskRecord: read });
    const request = f.service.handle({ type: 'action.record', id: action.id, query: { recordId, entryChars: 2000, textOffset: 0 } });
    void request.catch(() => undefined);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    f.store.request({ type: 'companion.reset', id: 'sister', scope: 'all' });
    pending.resolve({ overview: { recordId }, entries: [{ event: { text: 'WITHDRAWN_RECORD_SECRET' } }] });
    await expect(request).rejects.toThrow(/重置|来源/);
    await closeService(f.service);
  });
});
