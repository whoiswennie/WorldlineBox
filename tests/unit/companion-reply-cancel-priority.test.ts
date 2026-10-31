import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionWork } from '../../src/shared/companion-loop';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture() {
  const at = '2026-10-30T01:50:00.000Z', room = 'room_alice', selected = new AbortController(), other = new AbortController(),
    child = new AbortController(), nativeCleanup = deferred(), slowHistory = deferred();
  let metadataGate: ReturnType<typeof deferred> | undefined;
  const work: CompanionWork = { id: 'selected_work', companionId: 'alice', conversationId: room, sourceMessageId: 'source',
    messageId: 'bubble', status: 'running', proactive: false, createdAt: at, updatedAt: at };
  const action: CompanionAction = { id: 'child_action', companionId: 'alice', conversationId: room, sourceMessageId: 'source',
    parentMessageId: 'bubble', taskId: 'native_child', title: 'Actual active child', status: 'running', createdAt: at, updatedAt: at };
  const requestTask = vi.fn(async () => { await nativeCleanup.promise; return { ok: true }; });
  const raw = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'work.list') { await metadataGate?.promise; return { ok: true, works: [work] }; }
    if (command.type === 'loop.get') return { ok: true, loop: { companionId: 'alice', conversationId: room,
      sourceMessageId: 'source', messageId: 'bubble', status: 'running', supplements: [], turns: [] } };
    if (command.type === 'actions.invocation' || command.type === 'actions') return { ok: true, actions: [action] };
    if (command.type === 'work.status') { work.status = command.status; return { ok: true }; }
    if (command.type === 'action.update') { Object.assign(action, command.patch); return { ok: true }; }
    return { ok: true };
  });
  const call = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    // This is the expensive Main source-validation boundary. A stop must read
    // action identities through raw storage, not authorize historical prose.
    if (command.type === 'actions' || command.type === 'actions.invocation' || command.type === 'action.get'
      || command.type === 'action.update') await slowHistory.promise;
    return raw(command);
  });
  const subject = Object.assign(Object.create(CompanionService.prototype), { initialization: Promise.resolve(), closed: false,
    replies: new Map([[work.id, { controller: selected, promise: Promise.resolve() }], ['unrelated_work', { controller: other, promise: Promise.resolve() }]]),
    replyControllers: new Map([[selected, room], [other, 'another_room']]), replyOwners: new Map([[selected, 'alice'], [other, 'bob']]),
    replyRetries: new Map(), userStoppedReplies: new Map(), cancelledActions: new Set(), actionControllers: new Map([[action.id, child]]),
    storage: { request: raw }, call, changed: vi.fn(), options: { dsh: () => ({ requestTask }), report: vi.fn() },
  }) as CompanionService;
  const cancel = () => subject.handle({ type: 'reply.cancel', conversationId: room, workId: work.id });
  return { subject, cancel, selected, other, child, work, action, raw, call, requestTask, nativeCleanup, slowHistory,
    blockMetadata: () => { metadataGate = deferred(); return metadataGate; } };
}

it('aborts the exact reply before waiting for even the first task identity read', async () => {
  const f = fixture(), metadata = f.blockMetadata(), pending = f.cancel();
  try {
    await Promise.resolve();
    expect(f.selected.signal.aborted).toBe(true);
    expect(f.other.signal.aborted).toBe(false);
    metadata.release();
    expect(await pending).toMatchObject({ ok: true });
  } finally { metadata.release(); f.slowHistory.release(); f.nativeCleanup.release(); await pending.catch(() => undefined); }
});

it('rejects a work identity from another room without aborting its active controller', async () => {
  const f = fixture();
  try {
    await expect(f.subject.handle({ type: 'reply.cancel', conversationId: 'wrong_room', workId: f.work.id })).rejects.toThrow();
    expect(f.selected.signal.aborted).toBe(false); expect(f.child.signal.aborted).toBe(false);
    expect(f.work.status).toBe('running'); expect(f.action.status).toBe('running');
  } finally { f.slowHistory.release(); f.nativeCleanup.release(); }
});

it('commits the real SQL stop fence before acknowledgement and rejects a late final callback', async () => {
  const data = managedMemoryFiles();
  try {
    const source = data.store.appendMessage({ conversationId: data.scope.conversationId, authorId: 'user',
      content: 'A source-backed reply whose preparation is being cancelled.', replyDirective: 'auto' });
    const work = data.store.request({ type: 'work.list', sourceMessageId: source.id }).works![0]!;
    const checkpoint = data.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop!;
    const selected = new AbortController();
    const raw = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => data.store.request(command));
    const subject = Object.assign(Object.create(CompanionService.prototype), { initialization: Promise.resolve(), closed: false,
      replies: new Map([[work.id, { controller: selected, promise: Promise.resolve() }]]),
      replyControllers: new Map([[selected, data.scope.conversationId]]), replyOwners: new Map([[selected, 'alice']]),
      replyRetries: new Map(), userStoppedReplies: new Map(), cancelledActions: new Set(), actionControllers: new Map(),
      storage: { request: raw }, call: raw, changed: vi.fn(), options: { dsh: () => undefined, report: vi.fn() },
    }) as CompanionService;
    expect(await subject.handle({ type: 'reply.cancel', conversationId: data.scope.conversationId, workId: work.id })).toMatchObject({ ok: true });
    expect(selected.signal.aborted).toBe(true);
    expect(data.store.request({ type: 'work.list', sourceMessageId: source.id }).works![0]!.status).toBe('cancelled');
    const stopped = data.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop!;
    expect(stopped.progress?.stop).toMatchObject({ actor: 'user', reason: 'user_requested' });
    expect(() => data.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done',
      turns: [{ text: 'A late final must not revive this task.', rawText: 'A late final must not revive this task.', calls: [] }] } })).toThrow('停止');
    expect(data.store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop!.status).toBe('running');
  } finally { await data.close(); }
});

it('acknowledges the persisted stop while history authorization and native cleanup remain unresolved', async () => {
  const f = fixture(), pending = f.cancel();
  let acknowledged = false;
  void pending.then(() => { acknowledged = true; });
  try {
    await vi.waitFor(() => expect(acknowledged).toBe(true), { timeout: 1000, interval: 5 });
    expect(await pending).toMatchObject({ ok: true });
    expect(f.work.status).toBe('cancelled'); expect(f.action.status).toBe('cancelled');
    expect(f.selected.signal.aborted).toBe(true); expect(f.child.signal.aborted).toBe(true); expect(f.other.signal.aborted).toBe(false);
    expect(f.call.mock.calls.filter(([command]) => ['actions', 'actions.invocation', 'action.get', 'action.update'].includes(command.type))).toEqual([]);
    expect(f.call.mock.calls.filter(([command]) => command.type === 'task-stop.record')).toHaveLength(2);
    expect(f.requestTask).toHaveBeenCalledWith({ type: 'task.cancel', taskId: 'native_child' });
  } finally { f.slowHistory.release(); f.nativeCleanup.release(); await pending.catch(() => undefined); }
});

it('keeps a child completion that wins the stop race without delaying the parent stop', async () => {
  const f = fixture(), raw = f.raw.getMockImplementation()!;
  f.raw.mockImplementation(async command => command.type === 'action.update'
    ? { ok: true, action: { ...f.action, status: 'succeeded' } } : raw(command));
  try {
    expect(await f.cancel()).toMatchObject({ ok: true });
    expect(f.work.status).toBe('cancelled');
    expect(f.call.mock.calls.filter(([command]) => command.type === 'task-stop.record' && command.kind === 'action')).toHaveLength(0);
    expect(f.requestTask).not.toHaveBeenCalled();
  } finally { f.slowHistory.release(); f.nativeCleanup.release(); }
});
