import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionAutonomyService } from '../../src/main/companions/autonomy-service';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionAutonomyService>(), releases: Array<() => void> = [];
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '如实表达，不冒充玩家或他人。', model: '', avatar: 'sister', proactive: false }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); vi.setSystemTime('2026-10-15T10:00:00Z'); });
afterEach(async () => { releases.splice(0).forEach(release => release()); for (const service of services) await service.close(); services.clear(); for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(predicate: () => boolean) { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)); } expect(predicate()).toBe(true); }
function response(value: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } }); }
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-autonomy-')); roots.push(root); const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, active: true }))); stores.add(store);
  const snapshot = store.request({ type: 'world.snapshot' }).world!; store.request({ type: 'world.configure', expectedRevision: snapshot.settings.revision, patch: { timeZone: 'UTC' } });
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type !== 'memory.search') return store.request(command);
    const snapshot = store.request({ type: 'memory.snapshot', companionId: command.companionId, conversationId: command.conversationId }).memorySnapshot!;
    return { ok: true as const, memoryPage: { items: snapshot.notes.map(memory => ({ memory, reasons: ['authorized fixture'], path: [] })), hasMore: false },
      memoryContext: { text: snapshot.notes.map(note => note.content).join('\n'), revision: snapshot.revision, profileKey: 'fixture-vcp-profile' } };
  });
  const fetchFn = vi.fn<typeof fetch>(), report = vi.fn(), changed = vi.fn(), launch = vi.fn(), resume = vi.fn(), wait = vi.fn();
  const ready = vi.fn(async (order: CompanionWorkOrder, signal: AbortSignal) => {
    if (signal.aborted) throw new Error('cancelled');
    const workId = 'order_run_' + order.id;
    store.request({ type: 'world.work.begin', companionId: order.companionId, conversationId: order.conversationId, workId, kind: 'action', fixed: true, ...(order.execution === 'external' ? { sourceMessageId: order.sourceMessageId } : {}) });
    vi.setSystemTime(Date.now() + 10000); store.request({ type: 'world.tick' });
    expect(store.request({ type: 'world.work.ready', companionId: order.companionId, workId }).worldWork!.status).toBe('ready');
  });
  const end = vi.fn(async (order: CompanionWorkOrder) => { store.request({ type: 'world.work.end', companionId: order.companionId, workId: 'order_run_' + order.id }); });
  const service = new CompanionAutonomyService({ request, ready, end, fetchFn, report, changed, launch, resume, wait, blocked: () => false,
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'configured-chat-model', baseUrl: 'https://provider.invalid', apiKey: 'synthetic-key' }) }); services.add(service);
  const orders = (owner = scope) => store.request({ type: 'work-order.list', ...owner, includeHistory: true }).workOrderPage!.items;
  const peerOrder = () => {
    const room = store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'] }).socialConversation!;
    const source = store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '请依据这段共同讨论整理一份提纲，不需要现实操作。', replyDirective: 'none' });
    const owner = { companionId: 'alice', conversationId: room.id }, order = store.request({ type: 'work-order.create', ...owner, title: '整理共同提纲', instruction: source.content, sourceMessageId: source.id }).workOrder!;
    store.request({ type: 'work-order.accept', ...owner, id: order.id, expectedRevision: order.revision }); return { source, order, owner };
  };
  return { store, service, request, scope, fetchFn, report, changed, launch, resume, wait, ready, end, orders, peerOrder };
}

it('dispatches an external order through one actual action, waits for its result and releases the computer', async () => {
  const f = fixture(), completion = deferred<void>(); releases.push(() => completion.resolve());
  const order = f.store.request({ type: 'work-order.create', ...f.scope, title: '核对文件', instruction: '只读核对，不修改文件。' }).workOrder!;
  f.launch.mockImplementation(async (assigned: CompanionWorkOrder) => f.store.createAction({ ...f.scope, workOrderId: assigned.id, sourceMessageId: assigned.sourceMessageId, title: assigned.title, status: 'running' }));
  f.wait.mockReturnValue(completion.promise); f.service.tick();
  await until(() => f.launch.mock.calls.length === 1);
  const action = f.store.listAction()[0]!; expect(f.orders()[0]).toMatchObject({ id: order.id, status: 'running', actionId: action.id });
  f.service.tick(); await until(() => f.request.mock.calls.filter(([command]) => command.type === 'work-order.claim').length >= 2);
  expect(f.launch).toHaveBeenCalledOnce(); expect(f.fetchFn).not.toHaveBeenCalled();
  f.store.updateAction(action.id, { status: 'succeeded', result: '实际只读核对完成，未写入。' }); completion.resolve();
  await until(() => f.end.mock.calls.length === 1);
  expect(f.orders()[0]).toMatchObject({ status: 'completed', result: '实际只读核对完成，未写入。' });
  vi.setSystemTime(Date.now() + 2000); f.store.request({ type: 'world.tick' }); // Release after the full standing-up transition.
  expect(f.store.request({ type: 'world.snapshot' }).world!.scenes.flatMap(scene => scene.objects).some(object => object.reservedBy === 'alice')).toBe(false);
  expect(f.report).not.toHaveBeenCalled();
});

it('keeps another resident life clock advancing while both cognition slots wait on actual work', async () => {
  const f = fixture(), completion = deferred<void>(); releases.push(() => completion.resolve());
  const carol = f.store.createCompanion({ name: 'Carol', description: '', persona: '友好', model: '', avatar: 'flash', proactive: true });
  f.store.setCompanionActive(carol.id, true);
  for (const rule of f.store.request({ type: 'life-rule.list', companionId: carol.id }).lifeRules!) {
    f.store.request({ type: 'life-rule.update', companionId: carol.id, id: rule.id, expectedRevision: rule.revision,
      rule: { title: rule.title, enabled: false, action: rule.action, startMinute: rule.startMinute, endMinute: rule.endMinute, probability: rule.probability, targetId: rule.targetId } });
  }
  const rule = f.store.request({ type: 'life-rule.create', companionId: carol.id, rule: { title: '独立生活时钟', action: 'message', targetId: 'user', startMinute: 0, endMinute: 1440, probability: 0 } }).lifeRule!;
  for (const companionId of ['alice', 'bob']) f.store.request({ type: 'work-order.create', companionId, conversationId: f.store.openPrivate(companionId).id, title: '需要等待的工作', instruction: '只读检查。' });
  f.launch.mockImplementation(async (assigned: CompanionWorkOrder) => f.store.createAction({ companionId: assigned.companionId, conversationId: assigned.conversationId,
    workOrderId: assigned.id, sourceMessageId: assigned.sourceMessageId, title: assigned.title, status: 'running' }));
  f.wait.mockReturnValue(completion.promise);
  f.service.tick(); await until(() => f.launch.mock.calls.length === 1); await new Promise<void>(resolve => setImmediate(resolve));
  f.service.tick(); await until(() => f.launch.mock.calls.length === 2); await new Promise<void>(resolve => setImmediate(resolve));
  const occurrence = () => f.store.request({ type: 'life-rule.list', companionId: carol.id }).lifeOccurrences!.find(occ => occ.ruleId === rule.id)!;
  const previous = occurrence().lastRealAt;
  vi.setSystemTime(Date.now() + 10000); f.service.tick(); await until(() => occurrence().lastRealAt !== previous);
  expect(occurrence().lastRealAt).toBe(new Date().toISOString());
  expect(f.launch).toHaveBeenCalledTimes(2); expect(f.fetchFn).not.toHaveBeenCalled();
});

it.each(['succeeded', 'failed'] as const)('keeps a slow actual %s action feedback alive after its order is terminal', async status => {
  const f = fixture(), completion = deferred<void>(); releases.push(() => completion.resolve());
  const order = f.store.request({ type: 'work-order.create', ...f.scope, title: '核对文件', instruction: '只读核对，不修改文件。' }).workOrder!;
  let actionSignal: AbortSignal | undefined;
  f.launch.mockImplementation(async (assigned: CompanionWorkOrder, signal: AbortSignal) => {
    actionSignal = signal;
    return f.store.createAction({ ...f.scope, workOrderId: assigned.id, sourceMessageId: assigned.sourceMessageId, title: assigned.title, status: 'running' });
  });
  f.wait.mockReturnValue(completion.promise); f.service.tick(); await until(() => f.launch.mock.calls.length === 1);
  const action = f.store.listAction()[0]!;
  f.store.updateAction(action.id, { status, ...(status === 'succeeded' ? { result: '实际检查完成，回报仍在生成。' } : { error: '实际检查失败，失败说明仍在生成。' }) });
  expect(f.orders()[0]).toMatchObject({ id: order.id, status: status === 'succeeded' ? 'completed' : 'failed' });
  await vi.advanceTimersByTimeAsync(20001);
  expect(actionSignal!.aborted).toBe(false);
  const renewals = f.request.mock.calls.filter(([command]) => command.type === 'work-order.heartbeat').length;
  await vi.advanceTimersByTimeAsync(40000);
  expect(f.request.mock.calls.filter(([command]) => command.type === 'work-order.heartbeat')).toHaveLength(renewals);
  expect(f.end).not.toHaveBeenCalled(); expect(f.launch).toHaveBeenCalledOnce();
  completion.resolve(); await until(() => f.end.mock.calls.length === 1); expect(f.report).not.toHaveBeenCalled();
});

it.each(['pause', 'cancel', 'withdraw'] as const)('still aborts a waiting external action when its order is %s', async kind => {
  const f = fixture(), completion = deferred<void>(); releases.push(() => completion.resolve());
  const order = f.store.request({ type: 'work-order.create', ...f.scope, title: '核对文件', instruction: '只读核对。' }).workOrder!;
  let actionSignal: AbortSignal | undefined;
  f.launch.mockImplementation(async (assigned: CompanionWorkOrder, signal: AbortSignal) => {
    actionSignal = signal;
    return f.store.createAction({ ...f.scope, workOrderId: assigned.id, sourceMessageId: assigned.sourceMessageId, title: assigned.title, status: 'running' });
  });
  f.wait.mockReturnValue(completion.promise); f.service.tick(); await until(() => f.launch.mock.calls.length === 1);
  const active = f.orders()[0]!;
  if (kind === 'withdraw') f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [order.sourceMessageId] });
  else if (kind === 'pause') f.store.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: active.revision, paused: true });
  else f.store.request({ type: 'work-order.cancel', ...f.scope, id: order.id, expectedRevision: active.revision });
  await vi.advanceTimersByTimeAsync(20001);
  expect(actionSignal!.aborted).toBe(true); completion.resolve(); await until(() => f.end.mock.calls.length === 1);
});

it('finishes peer internal work with the configured model, no external tools or player data, and one true author result', async () => {
  const f = fixture(), { order, owner, source } = f.peerOrder();
  f.store.updatePlayerProfile({ name: 'PRIVATE_PLAYER', description: 'PRIVATE_PLAYER_DESCRIPTION' }, 1);
  f.fetchFn.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages[1].content);
    expect(body.tools).toBeUndefined(); expect(input).toMatchObject({ orderId: order.id, assigneeId: 'alice', publisherId: 'bob', source: { id: source.id, authorId: 'bob' } });
    expect(String(init?.body)).not.toContain('PRIVATE_PLAYER'); expect(String(init?.body)).toContain('不能调用现实工具');
    return response({ orderId: order.id, result: '依据共同讨论整理出的有限提纲。' });
  });
  f.service.tick(); await until(() => f.orders(owner)[0]?.status === 'completed');
  const actual = f.orders(owner)[0]!, message = f.store.getMessage(actual.completionMessageId!);
  expect(message).toMatchObject({ authorId: 'alice', conversationId: owner.conversationId, replyToId: source.id, content: '依据共同讨论整理出的有限提纲。' });
  expect(f.launch).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.wait).not.toHaveBeenCalled();
  f.service.tick(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.report).not.toHaveBeenCalled();
});

it('resumes the stopped action of a paused external order instead of stranding or duplicating its checkpoint', async () => {
  const f = fixture(), order = f.store.request({ type: 'work-order.create', ...f.scope, title: '继续只读检查', instruction: '只读核对原清单，不能写入。' }).workOrder!;
  const action = f.store.createAction({ ...f.scope, workOrderId: order.id, sourceMessageId: order.sourceMessageId, title: order.title, status: 'running' }, { prompt: order.instruction, waitForActionIds: [], supplements: [] });
  let current = f.orders()[0]!;
  const paused = f.store.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: current.revision, paused: true }).workOrder!;
  f.store.updateAction(action.id, { status: 'cancelled', error: '实际执行已停止，checkpoint仍在。' });
  current = f.orders()[0]!; expect(current.status).toBe(paused.status);
  f.store.request({ type: 'work-order.pause', ...f.scope, id: order.id, expectedRevision: current.revision, paused: false });
  f.resume.mockImplementation(async (id: string) => { const resumed = f.store.resumeAction(id); expect(resumed.attempt).toBe(2); f.store.updateAction(id, { status: 'succeeded', result: '原清单剩余核对已实际完成。' }); });
  f.service.tick(); await until(() => f.orders()[0]?.status === 'completed');
  expect(f.resume).toHaveBeenCalledExactlyOnceWith(action.id); expect(f.launch).not.toHaveBeenCalled(); expect(f.fetchFn).not.toHaveBeenCalled();
  expect(f.store.listAction()).toHaveLength(1); expect(f.store.checkpoint(action.id)?.prompt).toBe(order.instruction);
  expect(f.orders()[0]).toMatchObject({ actionId: action.id, result: '原清单剩余核对已实际完成。' }); expect(f.report).not.toHaveBeenCalled();
});

it('rejects a late internal result after its real peer source is withdrawn', async () => {
  const f = fixture(), { order, owner, source } = f.peerOrder(), pending = deferred<Response>();
  releases.push(() => pending.resolve(response({ orderId: order.id, result: 'SHOULD_NOT_RETURN_AFTER_FORGET' })));
  f.fetchFn.mockImplementation(() => pending.promise); f.service.tick(); await until(() => f.fetchFn.mock.calls.length === 1);
  f.store.request({ type: 'memory.forget', ...owner, sourceMessageIds: [source.id] });
  pending.resolve(response({ orderId: order.id, result: 'SHOULD_NOT_RETURN_AFTER_FORGET' })); await until(() => f.end.mock.calls.length === 1);
  expect(f.orders(owner)[0]).toMatchObject({ status: 'cancelled', instruction: '原始要求已撤回。' });
  expect(f.store.messages({ conversationId: owner.conversationId }).messages.some(message => message.content.includes('SHOULD_NOT_RETURN_AFTER_FORGET'))).toBe(false);
  expect(f.launch).not.toHaveBeenCalled();
});

it('uses accumulated world-time life probability to send one authored spontaneous greeting without DSH or a fake player instruction', async () => {
  const f = fixture(), companion = f.store.state().companions.find(role => role.id === 'alice')!;
  f.store.updateCompanion('alice', { ...companion, proactive: true });
  for (const rule of f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeRules!) f.store.request({ type: 'life-rule.remove', companionId: 'alice', id: rule.id, expectedRevision: rule.revision });
  const current = f.store.request({ type: 'world.snapshot' }).world!;
  f.store.request({ type: 'world.configure', expectedRevision: current.settings.revision, patch: { mode: 'compressed' } });
  const rule = f.store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '向玩家问候', action: 'message', targetId: 'user', startMinute: 600, endMinute: 610, probability: 1, checkIntervalMinutes: 1 } }).lifeRule!;
  f.fetchFn.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages[1].content);
    expect(body.tools).toBeUndefined(); expect(input).toMatchObject({ speakerId: 'alice', target: { id: 'user', kind: 'human_player' }, action: 'message' });
    return response({ eventId: input.eventId, speakerId: 'alice', targetId: 'user', text: '想和你打个招呼，现在方便聊聊吗？' });
  });
  f.service.tick(); await until(() => f.store.request({ type: 'life-rule.list', companionId: 'alice' }).lifeOccurrences!.some(occurrence => occurrence.ruleId === rule.id));
  vi.setSystemTime(Date.now() + 8000); f.service.tick();
  await until(() => f.store.messages({ conversationId: f.scope.conversationId }).messages.some(message => message.authorId === 'alice' && message.content.includes('打个招呼')));
  const messages = f.store.messages({ conversationId: f.scope.conversationId }).messages;
  expect(messages.filter(message => message.authorId === 'alice')).toHaveLength(1);
  expect(messages.filter(message => message.authorId === 'user')).toHaveLength(0);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.ready).not.toHaveBeenCalled();
  f.service.tick(); await new Promise<void>(resolve => setImmediate(resolve)); expect(f.fetchFn).toHaveBeenCalledOnce(); expect(f.report).not.toHaveBeenCalled();
});

it('bounds independent life cognition at two owners and respects a real silence decision without blocking the third owner', async () => {
  const f = fixture(), pending = deferred<Response>();
  const third = f.store.createCompanion({ name: 'Charlie', persona: '只在有实际资料时交流，喜欢保留安静时间。', description: '', model: '', avatar: 'sister', proactive: true });
  f.store.setCompanionActive(third.id, true);
  const owners = ['alice', 'bob', third.id];
  for (const [index, owner] of owners.entries()) {
    const role = f.store.state().companions.find(role => role.id === owner)!; f.store.updateCompanion(owner, { ...role, proactive: true });
    for (const rule of f.store.request({ type: 'life-rule.list', companionId: owner }).lifeRules!) f.store.request({ type: 'life-rule.remove', companionId: owner, id: rule.id, expectedRevision: rule.revision });
    f.store.request({ type: 'life-rule.create', companionId: owner, rule: { title: '有内容再交流', action: 'message', targetId: owners[(index + 1) % owners.length],
      startMinute: 0, endMinute: 1440, probability: 1, checkIntervalMinutes: 1, silenceCooldownMinutes: 1 } });
  }
  const world = f.store.request({ type: 'world.snapshot' }).world!;
  f.store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'compressed' } });
  let active = 0, maximum = 0; const started: string[] = []; let slowOutput: unknown, slowOwner: string | undefined;
  releases.push(() => pending.resolve(response(slowOutput)));
  f.fetchFn.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages[1].content);
    expect(String(init?.body)).toContain('不是必须发言'); expect(input.memoryContext).toBeDefined();
    started.push(input.speakerId); active++; maximum = Math.max(maximum, active);
    const value = { eventId: input.eventId, speakerId: input.speakerId, targetId: input.target.id,
      decision: 'silence', text: null, reason: '这次没有新的内容，继续自己的阅读。' };
    slowOwner ??= input.speakerId;
    if (input.speakerId === slowOwner) { slowOutput = value; const reply = await pending.promise; active--; return reply; }
    active--; return response(value);
  });
  f.service.tick(); await until(() => f.request.mock.calls.some(([command]) => command.type === 'life-event.claim'));
  await new Promise<void>(resolve => setImmediate(resolve)); vi.setSystemTime(Date.now() + 1000); f.service.tick();
  await until(() => started.length === 2); expect(maximum).toBe(2);
  const thirdOwner = owners.find(owner => !started.includes(owner))!;
  await until(() => f.store.request({ type: 'life-rule.list', companionId: started[1]! }).lifeOccurrences!.some(occ => occ.status === 'silent'));
  await new Promise<void>(resolve => setImmediate(resolve)); vi.setSystemTime(Date.now() + 1000); f.service.tick();
  await until(() => started.includes(thirdOwner)); expect(started[0]).toBe(slowOwner); expect(maximum).toBe(2);
  pending.resolve(response(slowOutput)); await until(() => f.store.request({ type: 'life-rule.list', companionId: slowOwner! }).lifeOccurrences!.some(occ => occ.status === 'silent'));
  for (const owner of owners) expect(f.store.messages({ conversationId: f.store.openPrivate(owner).id }).messages.filter(message => message.authorId === owner)).toHaveLength(0);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
});

it('cancels only the selected assignee internal cognition and leaves a different assignee order eligible', async () => {
  const f = fixture(), { order, owner } = f.peerOrder(), pending = deferred<Response>();
  releases.push(() => pending.resolve(response({ orderId: order.id, result: 'CANCELLED_INTERNAL_RESULT' })));
  f.fetchFn.mockImplementation(() => pending.promise); f.service.tick(); await until(() => f.fetchFn.mock.calls.length === 1);
  f.service.cancelCompanion('alice'); await f.service.drainCompanion('alice');
  expect(f.store.messages({ conversationId: owner.conversationId }).messages.some(message => message.content.includes('CANCELLED_INTERNAL_RESULT'))).toBe(false);
  const bob = { companionId: 'bob', conversationId: f.store.openPrivate('bob').id }, other = f.store.request({ type: 'work-order.create', ...bob, title: 'Bob的工作', instruction: 'Bob的真实独立授权。' }).workOrder!;
  expect(f.store.request({ type: 'work-order.claim', companionId: 'bob' }).workOrderClaim!.order.id).toBe(other.id);
  expect(f.launch).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
});
