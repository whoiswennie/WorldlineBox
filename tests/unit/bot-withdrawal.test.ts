import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BotService } from '../../src/main/companion-bot/service';
import { BotDshBrain, BotDshAbortAcknowledgedError, BotDshDeliveryUnknownError, type BotDshRun, type BotDshResult, type BotDshCancelAck } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryForget, type BotMemoryPrepared, type BotMemoryScope, type BotMemoryWrite } from '../../src/main/companion-bot/memory-service';
import type { BotActivityBudgetPolicy } from '../../src/main/companion-bot/activity-budget';

type Withdrawal = Pick<BotMemoryForget, 'revision' | 'sourceEventIds' | 'sourceMessageIds'>;
/** A narrow VCP boundary fixture. Its committed tombstone state survives host restarts. */
class MemoryBoundary extends BotMemoryService {
  prepared: Array<Parameters<BotMemoryService['prepareTurn']>[0]> = [];
  writes: BotMemoryWrite[] = [];
  attempts: BotMemoryWrite[] = [];
  beforeWrite?: (input: BotMemoryWrite) => Promise<void>;
  withdrawals = new Map<string, Withdrawal>();
  deletions = new Map<string, Withdrawal>();
  constructor(root: string) { super({ root, runtime: async () => { throw new Error('VCP boundary fixture'); }, embedding: async () => { throw new Error('VCP boundary fixture'); } }); }
  domain(scope: BotMemoryScope) { return JSON.stringify([scope.companionId, scope.securityDomainId]); }
  override async withdrawnSources(scope: BotMemoryScope): Promise<Withdrawal> {
    return this.withdrawals.get(this.domain(scope)) ?? { revision: '0', sourceEventIds: [], sourceMessageIds: [] };
  }
  override async withdrawSources(scope: BotMemoryScope, input: Parameters<BotMemoryService['withdrawSources']>[1]) {
    const previous = await this.withdrawnSources(scope), next = { revision: previous.revision,
      sourceEventIds: [...new Set([...previous.sourceEventIds, ...input.sourceEventIds])], sourceMessageIds: [...new Set([...previous.sourceMessageIds, ...input.sourceMessageIds])] };
    this.withdrawals.set(this.domain(scope), next); return { withdrawn: true as const, ...next };
  }
  override async forget(scope: BotMemoryScope, { id }: { id: string }): Promise<BotMemoryForget> {
    const receipt = this.deletions.get(id); if (!receipt) throw new Error('Fixture note not found');
    this.withdrawals.set(this.domain(scope), receipt);
    return { ...receipt, id, forgotten: true, relatedIds: [id], physicalSourceErasure: false };
  }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    this.prepared.push(input);
    const withdrawal = await this.withdrawnSources(input.scope);
    if (withdrawal.sourceEventIds.includes(input.requestId)) throw Object.assign(new Error('Withdrawn VCP source'), { code: 'MEMORY_SOURCE_WITHDRAWN' });
    return { requestId: input.requestId, inputHash: 'fixture', scope: input.scope, messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0,
      sourceMessageIds: input.messages.map(message => message.id) };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async remember(scope: BotMemoryScope, input: BotMemoryWrite) {
    this.attempts.push(input);
    await this.beforeWrite?.(input);
    const withdrawn = await this.withdrawnSources(scope);
    if (withdrawn.sourceEventIds.includes(input.sourceRootEventId ?? input.sourceEventId)
      || input.sourceMessageIds?.some(id => withdrawn.sourceMessageIds.includes(id))) return { withdrawn: true };
    this.writes.push(input); return { id: `note-${this.writes.length}` };
  }
  override async close() {}
}
class BrainBoundary extends BotDshBrain {
  calls: BotDshRun[] = [];
  stops: Array<Omit<BotDshRun, 'prompt' | 'onEvent'>> = [];
  stopping: (input: Omit<BotDshRun, 'prompt' | 'onEvent'>) => Promise<BotDshCancelAck> = async input => ({ accepted: true,
    result: { text: '', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'cancelled' } });
  encoder?: (input: BotDshRun) => Promise<string>;
  constructor(readonly handler: (input: BotDshRun) => Promise<string> = async () => '收到') { super({ getHost: async () => { throw new Error('DSH boundary fixture'); } }); }
  override async run(input: BotDshRun): Promise<BotDshResult> {
    this.calls.push(input);
    const text = await (input.laneId.startsWith('memory-encoder-') ? this.encoder?.(input) ?? Promise.resolve('{"notes":[]}') : this.handler(input));
    if (input.signal?.aborted) throw new BotDshAbortAcknowledgedError({ text: '', sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'cancelled' });
    input.onEvent?.({ type: 'text', text, sequence: 1, receivedAt: new Date().toISOString() });
    return { text, sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, status: 'succeeded' };
  }
  override async cancelDurable(input: Omit<BotDshRun, 'prompt' | 'onEvent'>) { this.stops.push(input); return this.stopping(input); }
  override async archive() {}
  override async close() {}
}
const owned: Array<{ root: string; services: BotService[] }> = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    for (const service of item.services) await service.shutdown();
    if (path.dirname(path.resolve(item.root)) !== path.resolve(tmpdir()) || !path.basename(item.root).startsWith('wlb-bot-withdrawal-')) throw new Error('Invalid fixture cleanup target');
    await rm(item.root, { recursive: true, force: true });
  }
});
async function fixture(brain = new BrainBoundary(), activityBudget?: Partial<BotActivityBudgetPolicy>) {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-withdrawal-')), memory = new MemoryBoundary(root);
  const emitted: Array<{ type: string; text?: string }> = [];
  const owner = { root, services: [] as BotService[] }; owned.push(owner);
  const open = (nextBrain: BrainBoundary) => {
    const service = new BotService({ root, brain: nextBrain, memory, activityBudget, model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }), onEvent: event => emitted.push(event) });
    owner.services.push(service); return service;
  };
  const service = open(brain), state = (await service.handle({ type: 'state' })).snapshot!;
  const conversationId = state.conversations[0]!.id, companionId = DEFAULT_BOT_COMPANION_ID;
  const scope = { conversationId, companionId, securityDomainId: service.store.getConversation(conversationId)!.securityDomainId };
  return { service, brain, memory, scope, emitted, reopen: open };
}
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 3500) {
  const started = Date.now(); while (!await check()) { if (Date.now() - started > timeout) throw new Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function send(service: BotService, conversationId: string, content: string, requestId: string) {
  const result = await service.handle({ type: 'message.send', conversationId, content, requestId });
  const state = (await service.handle({ type: 'state', conversationId })).snapshot!;
  const message = state.messages.find(item => item.id === result.messageId)!;
  const event = state.messages.map(item => service.store.eventForReply(item.id)).find(item => item?.sourceMessageRecordId === message.id)!;
  expect(event).toBeDefined(); return { message, event };
}
async function tool(input: BotDshRun, name: string, args: Record<string, unknown>, callId: string) {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: `Bearer ${input.callback.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  return { status: response.status, body: await response.json() as { ok: boolean; result?: { taskId: string }; error?: string } };
}

it('UI forget fences an in-flight reply, rotates its native lane and leaves another domain running', async () => {
  const blockers = new Map<string, () => void>();
  const brain = new BrainBoundary(async input => {
    const content = JSON.parse(input.prompt).trigger.content;
    if (content !== 'fresh') await new Promise<void>(resolve => { blockers.set(content, resolve); });
    return content === 'fresh' ? '全新回复' : '迟到的秘密';
  });
  const { service, memory, scope } = await fixture(brain);
  const other = await service.handle({ type: 'companion.create', name: '另一位', persona: '独立' });
  const source = await send(service, scope.conversationId, 'old-secret', 'first');
  await send(service, other.conversationId!, 'other-domain', 'second');
  try {
    await waitFor(() => blockers.size === 2);
    const first = brain.calls.find(input => JSON.parse(input.prompt).trigger.content === 'old-secret')!;
    const second = brain.calls.find(input => JSON.parse(input.prompt).trigger.content === 'other-domain')!;
    memory.deletions.set('note', { revision: '1', sourceEventIds: [source.event!.id], sourceMessageIds: [source.message.id, source.event!.replyMessageId] });
    await service.handle({ type: 'memory.forget', ...scope, id: 'note' });
    expect(first.signal?.aborted).toBe(true); expect(second.signal?.aborted).toBe(false);
    blockers.get('old-secret')!();
    await waitFor(() => service.store.getEvent(source.event!.id)?.status === 'cancelled');
    await send(service, scope.conversationId, 'fresh', 'third');
    await waitFor(() => brain.calls.some(input => input.laneId.includes('-epoch-2')));
    const next = brain.calls.find(input => input.laneId.includes('-epoch-2'))!;
    expect(next.prompt).not.toContain('old-secret'); expect(next.prompt).not.toContain('迟到的秘密');
    expect(memory.prepared.at(-1)!.messages.map(message => message.content)).not.toContain('old-secret');
    expect(service.store.getMessage(source.event!.replyMessageId)).toMatchObject({ status: 'cancelled', content: '' });
  } finally { for (const release of blockers.values()) release(); }
});

it('withdraws raw source messages, published answers and task cards from the next clean context', async () => {
  const { service, brain, memory, scope } = await fixture(new BrainBoundary(async input => JSON.parse(input.prompt).trigger.content === 'secret preference' ? 'secret answer' : 'clean'));
  const source = await send(service, scope.conversationId, 'secret preference', 'secret');
  await waitFor(() => service.store.getEvent(source.event!.id)?.status === 'done');
  const task = service.store.createTask({ conversationId: scope.conversationId, companionId: scope.companionId, sourceEventId: source.event!.id, goal: 'secret task goal' });
  service.store.updateTask(task.id, { status: 'succeeded', summary: 'secret task summary' });
  memory.deletions.set('note', { revision: '1', sourceEventIds: [source.event!.id], sourceMessageIds: [source.message.id, source.event!.replyMessageId] });
  await service.handle({ type: 'memory.forget', ...scope, id: 'note' });
  await send(service, scope.conversationId, 'next', 'next');
  await waitFor(() => brain.calls.some(input => input.laneId.endsWith('-epoch-2')));
  const next = brain.calls.find(input => input.laneId.endsWith('-epoch-2'))!;
  expect(next.prompt).not.toMatch(/secret preference|secret answer|secret task goal|secret task summary/);
  expect(JSON.parse(next.prompt).tasks).toEqual([]);
  expect(service.store.getLane(source.event!.laneId)?.sessionId).not.toBe(BotDshBrain.sessionId(source.event!.laneId));
});

it('does not run a queued capture again after its source has been withdrawn', async () => {
  const { service, brain, memory, scope } = await fixture();
  const source = await send(service, scope.conversationId, '你好', 'greeting');
  await waitFor(() => service.store.getEvent(source.event!.id)?.status === 'done');
  const job = service.store.enqueueMemoryJob({ kind: 'capture', key: 'old-capture', payload: { scope, sourceEventId: source.event!.id,
    messages: [{ id: source.message.id, role: 'user', content: 'old secret', timestamp: Date.now() }], answer: 'old answer', answerMessageId: source.event!.replyMessageId } });
  memory.deletions.set('note', { revision: '1', sourceEventIds: [source.event!.id], sourceMessageIds: [source.message.id] });
  await service.handle({ type: 'memory.forget', ...scope, id: 'note' });
  await waitFor(() => service.store.getMemoryJob(job.id)?.status === 'done');
  expect(brain.calls.filter(input => input.laneId.startsWith('memory-encoder-'))).toEqual([]);
  expect(memory.writes).toEqual([]);
});

it('preserves source bindings on an already running capture so VCP can fence its delayed write', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const brain = new BrainBoundary(); brain.encoder = async () => { await gate; return '{"notes":[{"content":"old secret","tags":[]}]}'; };
  const { service, memory, scope } = await fixture(brain);
  try {
    const source = await send(service, scope.conversationId, '你好', 'greeting');
    await waitFor(() => service.store.getEvent(source.event.id)?.status === 'done');
    const job = service.store.enqueueMemoryJob({ kind: 'capture', key: 'running-capture', payload: { scope, sourceEventId: source.event.id,
      messages: [{ id: source.message.id, role: 'user', content: 'old secret', timestamp: Date.now() }], answer: 'old answer', answerMessageId: source.event.replyMessageId } });
    await waitFor(() => brain.calls.some(input => input.laneId.startsWith('memory-encoder-')));
    memory.deletions.set('note', { revision: '1', sourceEventIds: [source.event.id], sourceMessageIds: [source.message.id] });
    await service.handle({ type: 'memory.forget', ...scope, id: 'note' });
    release(); await waitFor(() => service.store.getMemoryJob(job.id)?.status === 'done');
    expect(memory.attempts).toHaveLength(1);
    expect(memory.attempts[0]).toMatchObject({ sourceRootEventId: source.event.id, sourceMessageIds: [source.message.id, source.event.replyMessageId] });
    expect(memory.writes).toEqual([]);
  } finally { release(); }
});

it('restores a committed VCP revision after a crash before host rotation, including notes without chat origins', async () => {
  const { service, brain, memory, scope, reopen } = await fixture();
  const source = await send(service, scope.conversationId, '你好', 'first');
  await waitFor(() => service.store.getEvent(source.event!.id)?.status === 'done');
  expect(brain.calls[0]!.laneId).toBe(source.event!.laneId);
  await service.shutdown();
  // The VCP commit is authoritative even if the host never received its receipt.
  memory.withdrawals.set(memory.domain(scope), { revision: '7', sourceEventIds: [], sourceMessageIds: [] });
  const nextBrain = new BrainBoundary(), restarted = reopen(nextBrain);
  await send(restarted, scope.conversationId, '你好', 'after-crash');
  await waitFor(() => nextBrain.calls.length === 1);
  expect(nextBrain.calls[0]!.laneId).toBe(`${source.event!.laneId}-epoch-2`);
  await waitFor(() => restarted.store.getEvent(nextBrain.calls[0]!.eventId)?.status === 'done');
  await send(restarted, scope.conversationId, '你好', 'same-revision');
  await waitFor(() => nextBrain.calls.length === 2);
  expect(nextBrain.calls[1]!.laneId).toBe(nextBrain.calls[0]!.laneId);
});

it('deduplicates real HTTP task callbacks and refuses a reused effect ID with a changed goal', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const results: Awaited<ReturnType<typeof tool>>[] = [];
  const brain = new BrainBoundary(async input => {
    if (input.role === 'worker') { await gate; return 'verified artifact'; }
    if (JSON.parse(input.prompt).trigger.content === 'delegate') {
      results.push(await tool(input, 'dsh_task', { goal: 'create artifact' }, 'delegate-once'));
      results.push(await tool(input, 'dsh_task', { goal: 'create artifact' }, 'delegate-once'));
      results.push(await tool(input, 'dsh_task', { goal: 'changed goal' }, 'delegate-once'));
    }
    return '任务已提交';
  });
  const { service, scope } = await fixture(brain);
  try {
    await send(service, scope.conversationId, 'delegate', 'delegate');
    await waitFor(() => results.length === 3);
    expect(results.map(result => result.status)).toEqual([200, 200, 400]);
    expect(results[1]!.body.result?.taskId).toBe(results[0]!.body.result?.taskId);
    expect(service.store.listTasks()).toHaveLength(1);
    await waitFor(() => brain.calls.filter(input => input.role === 'worker').length === 1);
    expect(brain.calls.filter(input => input.role === 'worker')).toHaveLength(1);
    release();
    await waitFor(() => service.store.listTasks()[0]?.status === 'succeeded');
    await waitFor(async () => (await service.handle({ type: 'state', conversationId: scope.conversationId })).snapshot!.messages.some(message => message.senderId === 'task-service'));
    const state = (await service.handle({ type: 'state', conversationId: scope.conversationId })).snapshot!;
    expect(state.messages.filter(message => message.senderId === 'task-service')).toHaveLength(1);
  } finally { release(); }
});

it('checks duplicate tool fingerprints while the original effect is still pending', async () => {
  let release!: () => void, writing!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { writing = resolve; });
  const results: Awaited<ReturnType<typeof tool>>[] = [];
  const brain = new BrainBoundary(async input => {
    const first = tool(input, 'memory_write', { content: 'original fact' }, 'same-effect');
    await started;
    const duplicate = tool(input, 'memory_write', { content: 'original fact' }, 'same-effect');
    try {
      const changed = await Promise.race([
        tool(input, 'memory_write', { content: 'different fact' }, 'same-effect'),
        new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('A conflicting tool call waited for the original effect')), 1000); timer.unref(); }),
      ]);
      results.push(changed);
    } finally { release(); }
    results.push(await first, await duplicate); return '收到';
  });
  const { service, memory, scope } = await fixture(brain);
  memory.beforeWrite = async () => { writing(); await gate; };
  try {
    const source = await send(service, scope.conversationId, '你好', 'tools');
    await waitFor(() => service.store.getEvent(source.event.id)?.status === 'done');
    expect(results.map(result => result.status)).toEqual([400, 200, 200]);
    expect(memory.attempts).toHaveLength(1); expect(memory.writes).toHaveLength(1);
  } finally { release(); }
});

it('cancels a task derived from forgotten material and rejects its late worker result', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const brain = new BrainBoundary(async input => {
    if (input.role === 'worker') { await gate; return 'late secret artifact'; }
    if (JSON.parse(input.prompt).trigger.content === 'delegate') await tool(input, 'dsh_task', { goal: 'secret task' }, 'task');
    return '收到';
  });
  const { service, memory, scope } = await fixture(brain);
  try {
    const source = await send(service, scope.conversationId, 'delegate', 'task-source');
    await waitFor(() => brain.calls.some(input => input.role === 'worker'));
    const worker = brain.calls.find(input => input.role === 'worker')!, task = service.store.listTasks()[0]!;
    memory.deletions.set('note', { revision: '1', sourceEventIds: [source.event!.id], sourceMessageIds: [source.message.id] });
    await service.handle({ type: 'memory.forget', ...scope, id: 'note' });
    expect(worker.signal?.aborted).toBe(true); expect(service.store.getTask(task.id)?.extra.cancelRequested).toBe(true);
    release(); await waitFor(() => service.store.getTask(task.id)?.status === 'cancelled');
    const state = (await service.handle({ type: 'state', conversationId: scope.conversationId })).snapshot!;
    expect(state.messages.some(message => message.content.includes('late secret artifact'))).toBe(false);
    expect(service.store.getTask(task.id)).toMatchObject({ status: 'cancelled', summary: '' });
  } finally { release(); }
});

it('rebuilds VCP withdrawal receipts before restarting any persisted DSH task', async () => {
  const { service, memory, scope, reopen } = await fixture();
  const source = await send(service, scope.conversationId, '你好', 'source');
  await waitFor(() => service.store.getEvent(source.event!.id)?.status === 'done');
  const task = service.store.createTask({ conversationId: scope.conversationId, companionId: scope.companionId, sourceEventId: source.event!.id, goal: 'withdrawn work' });
  await service.shutdown();
  memory.withdrawals.set(memory.domain(scope), { revision: '3', sourceEventIds: [source.event!.id], sourceMessageIds: [source.message.id] });
  const nextBrain = new BrainBoundary(), restarted = reopen(nextBrain);
  await restarted.handle({ type: 'state', conversationId: scope.conversationId });
  await waitFor(() => ['cancelled', 'succeeded', 'failed'].includes(restarted.store.getTask(task.id)!.status));
  expect(restarted.store.getTask(task.id)?.status).toBe('cancelled');
  expect(nextBrain.calls.filter(input => input.role === 'worker')).toEqual([]);
});
it('withdraws an older active task even after more than 100 newer terminal tasks hide it from the UI list', async () => {
  const { service, memory, scope } = await fixture(new BrainBoundary(), { maxTasks: 1000, maxPendingTasks: 1000 });
  const source = await send(service, scope.conversationId, '你好', 'source-for-many-tasks');
  await waitFor(() => service.store.getEvent(source.event.id)?.status === 'done');
  const old = service.store.createTask({ id: '000-old-task', conversationId: scope.conversationId, companionId: scope.companionId, sourceEventId: source.event.id, goal: '撤回的旧任务' });
  await new Promise(resolve => setTimeout(resolve, 5));
  for (let index = 0; index < 101; index++) {
    const recent = service.store.createTask({ id: `zzz-new-${String(index).padStart(3, '0')}`, conversationId: scope.conversationId, companionId: scope.companionId,
      sourceEventId: source.event.id, goal: '已结束任务' });
    service.store.updateTask(recent.id, { status: 'succeeded' });
  }
  expect(service.store.listTasks(scope.conversationId).some(task => task.id === old.id)).toBe(false);
  memory.deletions.set('old-note', { revision: '1', sourceEventIds: [source.event.id], sourceMessageIds: [source.message.id] });
  await service.handle({ type: 'memory.forget', ...scope, id: 'old-note' });
  expect(service.store.getTask(old.id)?.extra.cancelRequested).toBe(true);
});
it('durably retires a queued unknown native admission across restart without replaying it in the new epoch', async () => {
  const brain = new BrainBoundary(async () => { throw new BotDshDeliveryUnknownError('native stream detached'); });
  brain.stopping = input => new Promise<BotDshCancelAck>((_resolve, reject) => { input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }); });
  const f = await fixture(brain), source = await send(f.service, f.scope.conversationId, 'secret pending source', 'unknown-source');
  await waitFor(() => f.service.store.getEvent(source.event.id)?.status === 'queued' && brain.calls.length === 1);
  f.memory.deletions.set('unknown-note', { revision: '1', sourceEventIds: [source.event.id], sourceMessageIds: [source.message.id] });
  await f.service.handle({ type: 'memory.forget', ...f.scope, id: 'unknown-note' }); await waitFor(() => brain.stops.length === 1);
  expect(f.service.store.getEvent(source.event.id)?.status).toBe('cancelled');
  expect(f.service.store.pendingCancelledNativeAdmissions(source.event.laneId)).toHaveLength(1);
  await f.service.shutdown();
  const next = new BrainBoundary(), restarted = f.reopen(next);
  await restarted.handle({ type: 'state', conversationId: f.scope.conversationId });
  await waitFor(() => next.stops.length === 1 && restarted.store.pendingCancelledNativeAdmissions(source.event.laneId).length === 0, 5000);
  expect(next.stops[0]).toMatchObject({ eventId: source.event.id, laneId: source.event.laneId });
  expect(next.calls).toEqual([]); expect(restarted.store.getLane(source.event.laneId)?.epoch).toBe(2);
});
it('commits a safe host confirmation for model memory_forget and fences old-context stream text through restart', async () => {
  let forgotten = false;
  const brain = new BrainBoundary(async input => {
    const result = await tool(input, 'memory_forget', { id: 'owned-note' }, 'forget-once'); forgotten = result.body.ok;
    input.onEvent?.({ type: 'text', text: 'OLD_SECRET_AFTER_FORGET', sequence: 9, receivedAt: new Date().toISOString() });
    return 'OLD_SECRET_AFTER_FORGET';
  });
  const f = await fixture(brain); f.memory.deletions.set('owned-note', { revision: '1', sourceEventIds: [], sourceMessageIds: [] });
  const source = await send(f.service, f.scope.conversationId, 'please-forget', 'model-forget');
  await waitFor(() => forgotten && f.service.store.getEvent(source.event.id)?.status === 'cancelled');
  const state = (await f.service.handle({ type: 'state', conversationId: f.scope.conversationId })).snapshot!;
  expect(state.messages.filter(message => message.content === '已撤回这条记忆的使用。')).toHaveLength(1);
  expect(state.messages.find(message => message.id === source.event.replyMessageId)).toMatchObject({ status: 'cancelled', content: '' });
  expect(f.emitted.some(event => event.text?.includes('OLD_SECRET'))).toBe(false);
  expect(JSON.parse(f.service.store.getMetadata(`memory-forget-receipt:${source.event.id}:forget-once`)!)).toMatchObject({ id: 'owned-note', forgotten: true });
  await f.service.shutdown(); const next = new BrainBoundary(), restarted = f.reopen(next);
  const after = (await restarted.handle({ type: 'state', conversationId: f.scope.conversationId })).snapshot!;
  expect(after.messages.filter(message => message.content === '已撤回这条记忆的使用。')).toHaveLength(1); expect(next.calls).toEqual([]);
});
it('synchronizes committed tombstones after an uncertain forget failure without manufacturing a success receipt', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(new BrainBoundary(async () => { await gate; return 'OLD_UNCERTAIN_SECRET'; }));
  const source = await send(f.service, f.scope.conversationId, '待撤回来源', 'uncertain-forget'); await waitFor(() => f.brain.calls.length === 1);
  f.memory.forget = async scope => {
    f.memory.withdrawals.set(f.memory.domain(scope), { revision: '1', sourceEventIds: [source.event.id], sourceMessageIds: [source.message.id] });
    throw Object.assign(new Error('cleanup outcome unknown'), { code: 'MEMORY_OUTCOME_UNKNOWN' });
  };
  try {
    await expect(f.service.handle({ type: 'memory.forget', ...f.scope, id: 'unknown' })).rejects.toThrow('cleanup outcome unknown');
    expect(f.service.store.getLane(source.event.laneId)?.epoch).toBe(2); expect(f.service.store.getEvent(source.event.id)?.status).toBe('cancelled');
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.emitted.every(event => !event.text?.includes('OLD_UNCERTAIN_SECRET'))).toBe(true);
    const state = (await f.service.handle({ type: 'state', conversationId: f.scope.conversationId })).snapshot!;
    expect(state.messages.some(message => message.content === '已撤回这条记忆的使用。')).toBe(false);
  } finally { release(); }
});
