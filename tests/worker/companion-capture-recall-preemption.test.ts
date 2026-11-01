import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionValidationUnavailableError } from '../../src/main/companions/validation-unavailable';

const cleanups: Array<() => Promise<void>> = [];
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function bounded<T>(label: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled capture stage did not settle: ' + label)), 4000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

/** Native/provider operations are controlled; the real searchView, graph lane,
 * parent capture/defer path and SQLite job-cohort transitions remain intact. */
class Client extends VcpMemoryClient {
  override readonly supportsDetachedRecall = false;
  readonly entered = gate(); readonly releaseNative = gate();
  readonly scopedNotes = new Map<string, VcpMemoryNote[]>();
  blockedScope?: string;
  block = true;
  constructor(root: string) { super({ dataRoot: root, vendorRoot: 'unused-vendor', workerPath: 'unused-worker',
    embedding: { baseUrl: 'http://127.0.0.1/unused-embedding', model: 'controlled', apiKey: 'controlled', dimension: 768 } }); }
  override hasOpenScope = () => true;
  override remember = vi.fn(async (_scope: VcpMemoryScope, note: VcpMemoryNote) => ({ id: note.id, indexed: true as const }));
  override replace = vi.fn(async (scope: VcpMemoryScope, notes: VcpMemoryNote[]) => {
    // Alice has two corpus notes but one actual active hit: this blocks the
    // real page-context replace before searchView's old late abort listener.
    if (this.block && notes.length === 1) { this.blockedScope = scope.scopeId; this.entered.release(); await this.releaseNative.promise; }
    this.scopedNotes.set(scope.scopeId, [...notes]); return { replaced: true as const, count: notes.length };
  });
  override search = vi.fn(async (scope: VcpMemoryScope) => {
    const first = this.scopedNotes.get(scope.scopeId)?.[0];
    return { results: first ? [{ ...first, score: 0.9, sourceFile: 'memories/' + first.id + '.md', engine: 'river' as const }] : [], diagnostics: { jointUsed: true }, degraded: false };
  });
  override preprocess = vi.fn(async () => ({ messages: [], events: [], contextReferences: [], contextReferenceCoverage: 'observed' as const }));
  override pluginCall = vi.fn(async () => ({ result: '', indexed: true, contextReferences: [], contextReferenceCoverage: 'observed' as const }));
  override interruptScope = vi.fn(async (scope: VcpMemoryScope, _options?: { preservePrepared?: boolean }) => {
    void _options;
    if (scope.scopeId === this.blockedScope) await this.releaseNative.promise; // A real retirement acknowledgement, not caller abortRace.
  });
  override purgeScope = vi.fn(async () => undefined);
  override close = vi.fn(async () => undefined);
}

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now(); vi.setSystemTime(now - 30 * 60000);
  const files = managedMemoryFiles(), store = files.store, root = files.root, filename = path.join(root, 'state.sqlite');
  const rooms = new Map(['alice', 'bob'].map(owner => [owner, store.openPrivate(owner).id]));
  for (const owner of rooms.keys()) {
    const conversationId = rooms.get(owner)!, source = store.appendMessage({ conversationId, authorId: 'user', content: owner + ' 的真实旧来源。', replyDirective: 'none' });
    store.request({ type: 'memory.record', companionId: owner, conversationId, candidate: { artifactKind: 'episode_memory', content: owner + ' 的已收录经历。', sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: [] } });
  }
  const extra = store.appendMessage({ conversationId: rooms.get('alice')!, authorId: 'user', content: '同批另一条真实来源。', replyDirective: 'none' });
  store.request({ type: 'memory.record', companionId: 'alice', conversationId: rooms.get('alice')!, candidate: { artifactKind: 'episode_memory', content: '第二项不同的已收录经历。', sourceMessageIds: [extra.id], evidence: [{ sourceMessageId: extra.id, quote: extra.content }], tags: [] } });
  for (;;) { const outbox = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!outbox) break; store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }
  await files.publish('alice'); await files.publish('bob'); vi.setSystemTime(now);
  const clients = new Map(['alice', 'bob'].map(owner => [owner, new Client(path.join(root, owner))])); clients.get('bob')!.block = false;
  const commands: CompanionStorageCommand[] = [], paid = gate(), releasePaid = gate(); let paidSignal: AbortSignal | null | undefined;
  const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
    paidSignal = init?.signal; paid.release(); await releasePaid.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes: [] }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  let intercept: ((command: CompanionStorageCommand) => void) | undefined;
  const runtime = controlledMemoryRuntime({ get: async scope => ({ client: clients.get(scope!.ownerId)!, profileKey: 'controlled-profile' }), close: async () => undefined });
  const service = new CompanionMemoryService({ request: async command => {
    commands.push(command);
    intercept?.(command);
    if (command.type === 'memory.revision.read') return { ok: true, memories: [await files.history.read(command, command.id, command.contentRevision)] };
    return store.request(command);
  },
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'controlled-model', apiKey: 'controlled-key', baseUrl: 'https://never-called.invalid' }),
    runtime, fetchFn, changed: vi.fn(), report: vi.fn(), busy: () => false });
  service.setAgendaDriven(vi.fn());
  // The independent monthly timeline is outside these two capture tests.
  vi.spyOn(service as unknown as { runContinuity(): Promise<boolean> }, 'runContinuity').mockResolvedValue(false);
  const db = new (Database as { new(filename: string): CompanionConnection })(filename);
  const rows = () => db.prepare('SELECT id,message_id,source_sequence,source_checksum,source_revision,status,attempts,failure_count,cycle_failure_count,admission_deferred FROM vcp_capture_jobs WHERE companion_id=? ORDER BY ordinal').all('alice') as Array<{ id: string; message_id: string; source_sequence: number; source_checksum: string; source_revision: number; status: string; attempts: number; failure_count: number; cycle_failure_count: number; admission_deferred: number }>;
  const query = (owner: string) => ({ companionId: owner, conversationId: rooms.get(owner)!, query: '当前真实前台话题。', limit: 8 });
  const tickets = () => (service as unknown as { captureRecalls: Map<string, Set<{ controller: AbortController; parent: AbortSignal }>> }).captureRecalls.get('alice');
  cleanups.push(async () => { for (const client of clients.values()) client.releaseNative.release(); releasePaid.release(); await service.close(); db.close(); await files.close(); });
  return { service, store, clients, commands, fetchFn, paid, releasePaid, rows, query, tickets, paidSignal: () => paidSignal,
    intercept: (hook?: typeof intercept) => { intercept = hook; },
    proposals: () => db.prepare('SELECT job_id,data FROM companion_capture_proposals WHERE companion_id=?').all('alice') as Array<{ job_id: string; data: string }> };
}

it('preempts only an unsent same-owner capture, waits for the real native settle, durably defers without quality debt, and later completes one paid journal without interrupting it', async () => {
  const f = await fixture(), parent = new AbortController(), before = f.rows(), alice = f.clients.get('alice')!;
  const background = f.service.runAgendaQuantum('alice', parent.signal); await bounded('background native entry', alice.entered.promise);
  const ticket = [...f.tickets()!][0]!;
  await bounded('independent bob foreground', f.service.search(f.query('bob'), 'passive')); expect(ticket.controller.signal.aborted).toBe(false);
  const first = new AbortController(), second = new AbortController(); let foregroundDone = 0;
  const foreground = [first, second].map(controller => f.service.search(f.query('alice'), 'passive', controller.signal).then(value => { foregroundDone++; return value; }));
  await vi.waitFor(() => expect(ticket.controller.signal.reason).toMatchObject({ reason: 'foreground_priority' }));
  expect(alice.interruptScope).toHaveBeenCalledWith({ scopeId: alice.blockedScope }, { preservePrepared: true });
  expect(parent.signal.aborted).toBe(false); expect(foregroundDone).toBe(0); expect(f.fetchFn).not.toHaveBeenCalled();
  alice.releaseNative.release(); await bounded('both alice foregrounds', Promise.all(foreground));
  expect((await bounded('capture defer', background)).outcome).toBe('waiting'); expect(first.signal.aborted || second.signal.aborted).toBe(false);
  const deferred = f.rows(); expect(deferred).toHaveLength(before.length);
  expect(deferred.map(({ status, attempts, admission_deferred, ...row }) => { void status; void attempts; void admission_deferred; return row; })).toEqual(before.map(({ status, attempts, admission_deferred, ...row }) => { void status; void attempts; void admission_deferred; return row; }));
  expect(deferred.every(row => row.status === 'pending' && row.admission_deferred === 1 && row.failure_count === 0 && row.cycle_failure_count === 0)).toBe(true);
  expect(f.commands.some(command => command.type === 'memory.jobs.defer')).toBe(true);
  expect(f.commands.some(command => command.type === 'memory.jobs.fail')).toBe(false);
  f.store.request({ type: 'memory.jobs.retry-admission', companionId: 'alice' }); alice.block = false;
  const resumed = f.service.runAgendaQuantum('alice', parent.signal);
  await bounded('paid journal entry', Promise.race([f.paid.promise, resumed.then(result => { throw new Error('Capture ended before provider entry: ' + JSON.stringify({ result, commands: f.commands.slice(-12).map(command => command.type) })); })]));
  expect(f.tickets()).toBeUndefined(); expect(f.fetchFn).toHaveBeenCalledTimes(1);
  await bounded('foreground during paid journal', f.service.search(f.query('alice'), 'passive')); expect(f.paidSignal()?.aborted).toBe(false);
  f.releasePaid.release(); expect((await bounded('paid journal complete', resumed)).outcome).toBe('completed');
  expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.rows().every(row => row.status === 'done' && row.failure_count === 0 && row.cycle_failure_count === 0)).toBe(true);
});

it('keeps an explicit parent cancellation cancelled instead of misclassifying it as a foreground deferral', async () => {
  const f = await fixture(), parent = new AbortController(), alice = f.clients.get('alice')!;
  const background = f.service.runAgendaQuantum('alice', parent.signal); await alice.entered.promise;
  const ticket = [...f.tickets()!][0]!, foreground = f.service.search(f.query('alice'), 'passive');
  await vi.waitFor(() => expect(ticket.controller.signal.reason).toMatchObject({ reason: 'foreground_priority' }));
  parent.abort(); alice.releaseNative.release(); expect((await background).outcome).toBe('cancelled');
  expect((await foreground).ok).toBe(true);
  expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.commands.some(command => command.type === 'memory.jobs.defer')).toBe(false);
  expect(f.commands.some(command => command.type === 'memory.jobs.fail' && command.failureKind === 'cancelled')).toBe(true);
  expect(f.rows().every(row => row.status === 'cancelled' && row.failure_count === 0)).toBe(true);
});

it('defers an actual host outage at commit without quality debt and reuses the already paid durable proposal', async () => {
  const f = await fixture(), before = f.rows(); f.clients.get('alice')!.block = false;
  let fail = true;
  f.intercept(command => { if (command.type === 'memory.jobs.complete' && fail) throw new CompanionValidationUnavailableError('Host storage is temporarily unavailable.'); });
  const first = f.service.runAgendaQuantum('alice', new AbortController().signal);
  await bounded('paid journal before host outage', f.paid.promise); f.releasePaid.release();
  expect((await bounded('host wait disposition', first)).outcome).toBe('waiting');
  expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.proposals()).toHaveLength(1);
  const waiting = f.rows();
  expect(waiting.map(row => [row.id, row.failure_count, row.cycle_failure_count])).toEqual(before.map(row => [row.id, row.failure_count, row.cycle_failure_count]));
  expect(waiting.every(row => row.status === 'pending' && row.admission_deferred === 1)).toBe(true);
  expect(f.commands.some(command => command.type === 'memory.jobs.fail' && command.failureKind === 'waiting' && command.preserveProposal)).toBe(true);
  fail = false; f.store.request({ type: 'memory.jobs.retry-admission', companionId: 'alice' });
  expect((await bounded('paid proposal actual recovery', f.service.runAgendaQuantum('alice', new AbortController().signal))).outcome).toBe('completed');
  expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.proposals()).toHaveLength(0);
  expect(f.rows().every(row => row.status === 'done' && row.failure_count === 0 && row.cycle_failure_count === 0)).toBe(true);
});
