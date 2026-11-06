import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { BotService } from '../../src/main/companion-bot/service';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotDshBrain, BotDshLaneBusyError, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';
import { BOT_WORKER_CONCURRENCY_DEFAULT, botRequestSchema } from '../../src/shared/companion-bot';

class Memory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No memory model in scheduling fixture'); }, embedding: async () => { throw Error('No encoder in scheduling fixture'); } }); }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, inputHash: 'fixture', messages: input.messages, metadata: {}, events: [], evidence: '', status: 'ready', omittedChars: 0 };
  }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { ok: true }; }
  override async close() {}
}
function gate() { let resolve!: (value: string) => void; return { promise: new Promise<string>(done => { resolve = done; }), resolve: () => resolve('DONE') }; }
class Brain extends BotDshBrain {
  calls: BotDshRun[] = []; gates = new Map<string, ReturnType<typeof gate>>();
  before: (input: BotDshRun) => void = () => undefined;
  constructor() { super({ getHost: async () => { throw Error('No native Host in scheduling fixture'); } }); }
  override async run(input: BotDshRun) {
    if (input.role !== 'worker') return { status: 'succeeded' as const, text: 'ACK', eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) };
    this.before(input); this.calls.push(input); const held = gate(); this.gates.set(input.laneId, held);
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(input.signal!.reason); input.signal!.addEventListener('abort', abort, { once: true }); if (input.signal!.aborted) abort(); });
    try { return { status: 'succeeded' as const, text: await Promise.race([held.promise, cancelled]), eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) }; }
    finally { input.signal!.removeEventListener('abort', abort); }
  }
  override async cancelDurable() { return { accepted: true, absent: true }; }
  override async close() {}
}
const owned: Array<{ root: string; service?: BotService; store?: BotStore }> = [];
afterEach(async () => {
  for (const entry of owned.splice(0)) {
    await entry.service?.shutdown(); entry.store?.close();
    const target = path.resolve(entry.root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('wlb-worker-concurrency-')) throw Error('Unexpected concurrency fixture directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function until(check: () => boolean, detail = 'task admission') {
  const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error('Timed out: ' + detail); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-worker-concurrency-')), brain = new Brain();
  const service = new BotService({ root, brain, memory: new Memory(root), onEvent: () => undefined,
    activityBudget: { maxTasks: 1000, maxPendingTasks: 1000 },
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1', apiKey: 'fixture' }) });
  owned.push({ root, service }); await service.handle({ type: 'state' });
  const add = (id: string, count: number, concurrency?: number) => {
    service.store.createCompanion({ id, name: id, persona: 'Independent task scheduling fixture.', workerConcurrency: concurrency });
    const room = service.store.openDirect(id), source = service.store.enqueue({ conversationId: room.id, senderId: 'user', sourceMessageId: `source-${id}`, content: 'Run the explicitly requested fixture tasks.' }).events[0]!;
    return { room, tasks: Array.from({ length: count }, (_, index) => service.store.createTask({ id: `${id}-task-${index}`, companionId: id, conversationId: room.id,
      sourceEventId: source.id, goal: 'Independent task ' + index, extra: { workerAccess: 'full' } })) };
  };
  const wake = () => { Reflect.get(service, 'maintainSafely').call(service); };
  return { root, brain, service, add, wake };
}

it('defaults every companion to five and runs two owners independently instead of sharing a global two-task cap', async () => {
  const f = await fixture(), a = f.add('owner-a', 7), b = f.add('owner-b', 7); f.wake();
  await until(() => f.brain.calls.length === 10);
  expect(f.service.store.getCompanion('owner-a')?.workerConcurrency).toBe(BOT_WORKER_CONCURRENCY_DEFAULT);
  for (const owner of ['owner-a', 'owner-b']) expect(f.brain.calls.filter(call => call.laneId.startsWith(`worker-${owner}-`))).toHaveLength(5);
  expect(a.tasks.filter(task => f.service.store.getTask(task.id)?.status === 'queued')).toHaveLength(2);
  expect(b.tasks.filter(task => f.service.store.getTask(task.id)?.status === 'queued')).toHaveLength(2);
});

it('applies changes immediately to future admission without interrupting already-running tasks when lowered', async () => {
  const f = await fixture(), a = f.add('owner-a', 4, 1); f.wake(); await until(() => f.brain.calls.length === 1);
  await f.service.handle({ type: 'companion.update', companionId: 'owner-a', name: 'owner-a', workerConcurrency: 3 });
  await until(() => f.brain.calls.length === 3);
  await f.service.handle({ type: 'companion.update', companionId: 'owner-a', name: 'owner-a', workerConcurrency: 1 });
  expect(a.tasks.filter(task => f.service.store.getTask(task.id)?.status === 'running')).toHaveLength(3);
  const firstThree = [...f.brain.calls];
  for (const call of firstThree.slice(0, 2)) {
    f.brain.gates.get(call.laneId)!.resolve(); await until(() => f.service.store.getTask(call.laneId.slice(7))?.status === 'succeeded');
    f.wake(); expect(f.brain.calls).toHaveLength(3);
  }
  f.brain.gates.get(firstThree[2]!.laneId)!.resolve(); await until(() => f.brain.calls.length === 4);
  expect(f.service.store.workerConcurrency('owner-a')).toBe(1);
});

it('does not let an older owner with over 100 queued tasks starve another companion', async () => {
  const f = await fixture(); f.add('a-bulk-owner', 140, 1); const b = f.add('z-new-owner', 1, 1); f.wake();
  await until(() => f.brain.calls.length === 2);
  expect(f.brain.calls.map(call => call.laneId)).toContain(`worker-${b.tasks[0]!.id}`);
  expect(f.brain.calls.filter(call => call.laneId.startsWith('worker-a-bulk-owner'))).toHaveLength(1);
});

it('reserves owner slots during asynchronous preparation, before the native run is marked running', async () => {
  const f = await fixture(), a = f.add('owner-a', 3, 1), preparation = gate(); let upgrades = 0;
  f.brain.upgradeWorkerAccess = async input => { upgrades++; await preparation.promise; return { sessionId: BotDshBrain.sessionId(input.laneId), eventId: input.eventId, workerAccess: 'full' }; };
  for (const task of a.tasks) f.service.store.updateTask(task.id, { extra: { workerAccess: 'scoped', nativeAttempted: true } });
  f.wake(); await until(() => upgrades === 1); f.wake();
  expect(upgrades).toBe(1); expect(f.brain.calls).toHaveLength(0);
  preparation.resolve(); await until(() => f.brain.calls.length === 1); expect(upgrades).toBe(1);
});

it('keeps true native capacity waits queued beyond five retries, but bounds a hung individual lane', async () => {
  const f = await fixture(), a = f.add('capacity-owner', 1); let attempts = 0;
  f.brain.before = () => { attempts++; throw new BotDshLaneBusyError('Companion native lane capacity is occupied by active tasks.'); };
  for (let count = 1; count <= 7; count++) {
    const task = f.service.store.getTask(a.tasks[0]!.id)!; f.service.store.updateTask(task.id, { extra: { ...task.extra, retryAt: 0 } }); f.wake();
    await until(() => attempts === count && f.service.store.getTask(task.id)?.status === 'queued');
  }
  const queued = f.service.store.getTask(a.tasks[0]!.id)!;
  expect(queued.status).toBe('queued'); expect(queued.extra.retryAttempts).toBeUndefined(); expect(queued.extra.nativeAttempted).toBe(false);
  f.brain.before = () => { attempts++; throw new BotDshLaneBusyError('The companion lane has an active turn.'); };
  for (let count = 8; count <= 12; count++) {
    const task = f.service.store.getTask(queued.id)!; f.service.store.updateTask(task.id, { extra: { ...task.extra, retryAt: 0 } }); f.wake();
    await until(() => attempts === count && ['queued', 'paused'].includes(f.service.store.getTask(task.id)?.status ?? ''));
  }
  expect(f.service.store.getTask(queued.id)?.status).toBe('paused');
});

it('bounds the app resource pool and rotates to the next owner when one slot becomes free', async () => {
  const f = await fixture(); const owners = Array.from({ length: 70 }, (_, index) => `owner-${String(index).padStart(3, '0')}`);
  for (const id of owners) f.add(id, 1); f.wake(); await until(() => f.brain.calls.length === 64);
  expect(new Set(f.brain.calls.map(call => call.laneId)).size).toBe(64);
  f.brain.gates.get(f.brain.calls[0]!.laneId)!.resolve(); await until(() => f.brain.calls.length === 65);
  expect(f.brain.calls.at(-1)?.laneId).toBe('worker-owner-064-task-0');
});

it('migrates legacy companions to five, persists custom limits and validates both public and direct store inputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-worker-concurrency-')), filename = path.join(root, 'bot.sqlite');
  let store = new BotStore(filename); const entry = { root, store }; owned.push(entry);
  store.createCompanion({ id: 'old', name: 'Existing companion', persona: 'KEEP_ORIGINAL_PERSONA' }); store.close();
  const LegacyDatabase = Database as new (filename: string) => { exec(sql: string): void; close(): void };
  const old = new LegacyDatabase(filename); old.exec('ALTER TABLE bot_companions DROP COLUMN worker_concurrency; PRAGMA user_version=18'); old.close();
  store = new BotStore(filename); entry.store = store;
  expect(store.getCompanion('old')).toMatchObject({ name: 'Existing companion', persona: 'KEEP_ORIGINAL_PERSONA', workerConcurrency: 5 });
  store.updateCompanion('old', { name: 'Existing companion', workerConcurrency: 12 }); store.close(); store = new BotStore(filename); entry.store = store;
  expect(store.getCompanion('old')?.workerConcurrency).toBe(12);
  store.updateCompanion('old', { name: 'Renamed companion' }); expect(store.workerConcurrency('old')).toBe(12);
  for (const invalid of [0, -1, 1.5, 33, Infinity, '5']) {
    expect(botRequestSchema.safeParse({ type: 'companion.update', companionId: 'old', name: 'Owner', workerConcurrency: invalid }).success).toBe(false);
    expect(() => store.updateCompanion('old', { name: 'Owner', workerConcurrency: invalid as number })).toThrow();
  }
});
