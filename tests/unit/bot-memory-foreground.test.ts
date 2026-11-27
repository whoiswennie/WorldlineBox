import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotMaintenanceRuntime } from '../../src/main/companion-bot/memory-maintenance-runtime';
import type { BotMemoryWrite } from '../../src/main/companion-bot/memory-service';

function createGate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it('detects a companion’s queued and running foreground work across rooms while other partners stay idle', () => {
  const store = new BotStore(':memory:');
  try {
    for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: 'test' });
    const chat = store.openDirect('alice'), shared = store.createGroup({ title: '群聊', memberIds: ['alice','bob'] });
    expect(store.hasForegroundWork('alice')).toBe(false);
    const first = store.enqueue({ conversationId: chat.id, senderId: 'user', content: '你好', sourceMessageId: 'first' }).events[0]!;
    expect(store.hasForegroundWork('alice')).toBe(true);
    expect(store.hasForegroundWork('bob')).toBe(false);
    const claimed = store.claim({ workerId: 'test' })!;
    expect(store.hasForegroundWork('alice')).toBe(true);
    store.settle({ eventId: first.id, leaseToken: claimed.leaseToken, status: 'done', content: '你好。' });
    expect(store.hasForegroundWork('alice')).toBe(false);
    store.enqueue({ conversationId: shared.id, source: 'gateway', senderId: 'user', content: '再聊个问题。', recipientIds: ['alice'] });
    expect(store.hasForegroundWork('alice')).toBe(true);
    expect(store.hasForegroundWork('bob')).toBe(false);
  } finally { store.close(); }
});

it('lets only room members yield to composition and counts an authored diary once its own receipt is indexed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-companion-idle-'));
  const indexing = createGate();
  const memory = new BotMemoryService({ root, runtime: async () => { throw Error('Unexpected worker'); }, embedding: async () => { throw Error('Unexpected encoder'); } });
  vi.spyOn(memory, 'withdrawnSources').mockResolvedValue({ revision: '0', sourceEventIds: [], sourceMessageIds: [] });
  let indexed = false;
  vi.spyOn(memory, 'remember').mockImplementation(async (_scope, write) => {
    if (write.waitForIndex) { await indexing.promise; indexed = true; return { receipts: [{ state: 'indexed' }], indexed: 1 }; }
    return { state: indexed ? 'indexed' : 'pending' };
  });
  vi.spyOn(memory, 'rememberReceipt').mockImplementation(async () => ({ found: true, receipt: { state: indexed ? 'indexed' : 'pending' } }));
  const foreground = vi.spyOn(BotMaintenanceRuntime.prototype, 'foreground');
  const brain = new BotDshBrain({ getHost: async () => { throw Error('Unexpected model'); } });
  const service = new BotService({ root, memory, brain, prewarmMemory: false,
    model: () => ({ apiFormat: 'openai_chat', apiKey: '', baseUrl: '', model: '' }), onEvent: () => undefined });
  try {
    const state = (await service.handle({ type: 'state' })).snapshot!, room = state.conversations[0]!;
    const companionId = room.memberIds.find(id => id !== 'user')!, scope = { conversationId: room.id, companionId };
    expect(foreground).not.toHaveBeenCalled();
    await service.handle({ type: 'chat.activity', conversationId: room.id });
    expect(foreground.mock.calls).toEqual([[companionId]]);
    await service.handle({ type: 'state', conversationId: room.id });
    expect(foreground).toHaveBeenCalledTimes(1);
    foreground.mockClear();
    const request = { type: 'memory.remember', ...scope, content: '周六再核对清单。', requestId: 'manual-1' } as const;
    const changes = () => service.store.taskTransaction(sql => sql.prepare('SELECT change_id FROM bot_maintenance_changes').all());
    await expect(service.handle(request)).resolves.toMatchObject({ memory: { state: 'pending' } });
    expect(changes()).toEqual([]);
    indexing.resolve();
    await vi.waitFor(() => expect(changes()).toEqual([{ change_id: 'user-memory-manual-1' }]));
    await expect(service.handle(request)).resolves.toMatchObject({ memory: { state: 'indexed' } });
    expect(changes()).toHaveLength(1);
    expect(foreground).not.toHaveBeenCalled();
  } finally { indexing.resolve(); foreground.mockRestore(); await service.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it('admits same- and other-companion turns while history and optional retrieval are still blocked, then records actual answers once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-foreground-memory-'));
  const gate = createGate();
  let blocked = false;
  const memory = new BotMemoryService({ root, runtime: async () => { throw Error('Unexpected worker'); }, embedding: async () => { throw Error('Unexpected encoder'); } });
  Object.assign(memory, { isBusy: () => blocked });
  vi.spyOn(memory, 'withdrawnSources').mockResolvedValue({ revision: '0', sourceEventIds: [], sourceMessageIds: [] });
  const project = vi.spyOn(memory, 'appendHistory').mockImplementation(async () => { blocked = true; await gate.promise; return { archived: true }; });
  const prepare = vi.spyOn(memory, 'prepareTurn').mockImplementation(async ({ scope, requestId, messages }) => {
    if (blocked) await gate.promise;
    return { scope, requestId, messages, nativeContext: '回忆', events: [], metadata: {}, inputHash: 'fixture', status: 'ready' };
  });
  const finish = vi.spyOn(memory, 'finishTurn').mockResolvedValue({ recorded: true });
  const brain = new BotDshBrain({ getHost: async () => { throw Error('Unexpected DSH'); } });
  const dispatch = vi.spyOn(brain, 'run').mockImplementation(async input => ({
    text: '本轮答复', status: 'succeeded', sessionId: input.laneId, eventId: input.eventId,
  }));
  const service = new BotService({ root, memory, brain, prewarmMemory: false,
    model: () => ({ apiFormat: 'openai_chat', apiKey: 'unused', baseUrl: 'http://127.0.0.1', model: 'fixture' }), onEvent: () => undefined });
  try {
    const state = (await service.handle({ type: 'state' })).snapshot!;
    const ids = state.companions.slice(0, 2).map(companion => companion.id);
    const rooms = ids.map(id => service.store.openDirect(id));
    const send = async (room: number, content: string) => {
      const result = await service.handle({ type: 'message.send', conversationId: rooms[room]!.id, content, requestId: content });
      return service.store.eventForReply(result.replyMessageIds![0]!)!.id;
    };
    const seed = await send(0, '初次对话');
    await vi.waitFor(() => expect(project).toHaveBeenCalled(), { timeout: 5000 });
    const followups = await Promise.all([send(0, '当前伙伴的新问题'), send(1, '另一位伙伴的新问题')]);
    await vi.waitFor(() => {
      for (const id of followups) {
        expect(dispatch.mock.calls.find(([input]) => input.eventId === id)?.[0].memoryContext).toBe('');
        expect(service.store.getMetadata('native-memory-prepared:' + id)).toBe('deferred');
      }
    }, { timeout: 2500 });
    expect(prepare.mock.calls.filter(([input]) => followups.includes(input.requestId) && input.onPhase)).toHaveLength(0);
    expect(dispatch.mock.calls.find(([input]) => input.eventId === seed)?.[0].memoryContext).toBe('回忆');
    blocked = false; gate.resolve();
    await vi.waitFor(() => {
      for (const id of [seed, ...followups]) {
        expect(finish.mock.calls.filter(([input, answer, complete]) => input.requestId === id && answer === '本轮答复' && complete)).toHaveLength(1);
        expect(dispatch.mock.calls.filter(([input]) => input.eventId === id)).toHaveLength(1);
      }
    }, { timeout: 10000 });
    expect(prepare).toHaveBeenCalled();
  } finally { blocked = false; gate.resolve(); await service.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 20000);

it.each([true, false])('persists a live note without waiting on a blocked worker and verifies its original native receipt after restart (already busy: %s)', async busy => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-parked-diary-'));
  const gate = createGate();
  let firstBoot = true;
  const committed = new Map<string, BotMemoryWrite>(), answers: Array<Record<string, unknown>> = [];
  const model = () => ({ apiFormat: 'openai_chat' as const, apiKey: 'unused', baseUrl: 'http://127.0.0.1', model: 'fixture' });
  const open = () => {
    const initial = firstBoot, memory = new BotMemoryService({ root, runtime: async () => { throw Error('Unexpected worker'); }, embedding: async () => { throw Error('Unexpected encoder'); } });
    vi.spyOn(memory, 'isBusy').mockImplementation(() => initial && busy);
    vi.spyOn(memory, 'withdrawnSources').mockResolvedValue({ revision: '5', sourceEventIds: [], sourceMessageIds: [] });
    vi.spyOn(memory, 'appendHistory').mockResolvedValue({ archived: true });
    vi.spyOn(memory, 'prepareTurn').mockImplementation(async input => ({ requestId: input.requestId, inputHash: 'fixture', scope: input.scope,
      messages: input.messages, metadata: {}, events: [], nativeContext: '', status: 'ready' }));
    vi.spyOn(memory, 'finishTurn').mockResolvedValue({ recorded: true });
    vi.spyOn(memory, 'rememberReceipt').mockImplementation(async (_scope, input) => {
      if (initial) { await gate.promise; throw new Error('Suspending the first worker'); }
      return committed.has(input.sourceEventId) ? { found: true, receipt: { state: 'indexed' } } : { found: false };
    });
    vi.spyOn(memory, 'remember').mockImplementation(async (_scope, input) => {
      expect(initial).toBe(false); expect(committed.has(input.sourceEventId)).toBe(false);
      committed.set(input.sourceEventId, input); return { state: 'indexed' };
    });
    vi.spyOn(memory, 'close').mockImplementation(async () => { if (initial) gate.resolve(); });
    const brain = new BotDshBrain({ getHost: async () => { throw Error('Unexpected DSH'); } });
    vi.spyOn(brain, 'run').mockImplementation(async input => {
      const args = { content: '周六在北岸集合。', tags: ['观鸟', '北岸'] };
      for (let i = 0; i < 2; i++) {
        const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
          body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId: 'bird-diary', name: 'memory_write', args }) });
        const body = await response.json() as { ok: boolean; result: Record<string, unknown> }; expect(body.ok).toBe(true); answers.push(body.result);
      }
      return { text: '好，周六见。', status: 'succeeded', sessionId: input.laneId, eventId: input.eventId };
    });
    return new BotService({ root, memory, brain, prewarmMemory: false, model, onEvent: () => undefined });
  };
  const service = open(); let restored: BotService | undefined;
  try {
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations[0]!;
    const sent = await service.handle({ type: 'message.send', conversationId: room.id, content: '周六观鸟在北岸集合。', requestId: 'route' });
    const event = service.store.eventForReply(sent.replyMessageIds![0]!)!;
    await vi.waitFor(() => expect(service.store.getEvent(event.id)?.status).toBe('done'), { timeout: 3000 });
    expect(answers).toHaveLength(2); expect(answers[0]).toEqual(answers[1]); expect(answers[0]).toMatchObject({ state: 'queued', indexed: false });
    expect(committed.size).toBe(0);
    const jobId = String(answers[0]!.jobId);
    expect(service.store.getMemoryJob(jobId)?.payload.input).toMatchObject({ content: '周六在北岸集合。', tags: '观鸟,北岸',
      sourceRootEventId: event.id, sourceMessageIds: [event.sourceMessageRecordId, event.replyMessageId], expectedSourceRevision: '5' });
    await service.shutdown(); firstBoot = false;
    restored = open(); await restored.handle({ type: 'state' });
    await vi.waitFor(() => expect(restored!.store.getMemoryJob(jobId)?.status).toBe('done'), { timeout: 8000 });
    expect(committed.size).toBe(1); expect(committed.has(event.id + ':bird-diary')).toBe(true);
    expect(answers).toHaveLength(2);
  } finally { gate.resolve(); await service.shutdown(); await restored?.shutdown(); await rm(root, { recursive: true, force: true }); }
}, 15000);
