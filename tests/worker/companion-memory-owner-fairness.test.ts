import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope, VcpMemoryTimelineArtifacts, VcpMemoryTimelineRequest } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Orchestration port only: no real model/encoder claim is made by these tests. */
class TimelinePort extends VcpMemoryClient {
  readonly artifacts = new Map<string, VcpMemoryTimelineArtifacts>();
  constructor(root: string) { super({ dataRoot: root, vendorRoot: 'unused', workerPath: 'unused',
    embedding: { baseUrl: 'http://127.0.0.1/unused', apiKey: 'unused', model: 'synthetic', dimension: 4 } }); }
  override remember = vi.fn(async (_scope: VcpMemoryScope, note: VcpMemoryNote) => ({ id: note.id, indexed: true as const }));
  override forget = vi.fn(async (_scope: VcpMemoryScope, id: string) => ({ id, deleted: true as const }));
  override replace = vi.fn(async (_scope: VcpMemoryScope, notes: VcpMemoryNote[]) => ({ replaced: true as const, count: notes.length }));
  override search = vi.fn(async () => ({ results: [], degraded: false, diagnostics: {} }));
  override pluginCall = vi.fn(async () => ({ result: '', indexed: true }));
  override capabilities = vi.fn(async () => ({ plugins: {}, timelineGenerationConfigured: true, coldKnowledge: false }));
  override exportTimelineArtifacts = vi.fn(async (scope: VcpMemoryScope, sourceRevision: string): Promise<VcpMemoryTimelineArtifacts> =>
    ({ ...(this.artifacts.get(scope.scopeId) ?? { schema: 'worldlinebox.vcp-timeline-artifacts' as const, agents: [] }), sourceRevision }));
  override importTimelineArtifacts = vi.fn(async (scope: VcpMemoryScope, _revision: string, artifacts: VcpMemoryTimelineArtifacts) => {
    this.artifacts.set(scope.scopeId, structuredClone(artifacts)); return { acceptedMonths: 0, skippedMonths: 0 };
  });
  override timeline = vi.fn(async (scope: VcpMemoryScope, request: VcpMemoryTimelineRequest) => {
    const artifacts = this.artifacts.get(scope.scopeId) ?? { schema: 'worldlinebox.vcp-timeline-artifacts' as const, sourceRevision: '', agents: [] };
    if (request.operation === 'generateTimelines') artifacts.agents = [{ agentName: request.agentName!,
      months: [...(artifacts.agents[0]?.months ?? []), { month: String(request.options!.startMonth), sourceDigest: '0'.repeat(64), content: 'Controlled timeline port output.' }] }];
    if (request.operation === 'generateSummaries') for (const agent of artifacts.agents) for (const month of agent.months) month.summary = 'Controlled summary port output.';
    this.artifacts.set(scope.scopeId, artifacts); return { ok: true };
  });
  override purgeScope = vi.fn(async () => undefined);
  override interruptScope = vi.fn(async () => undefined);
  override close = vi.fn(async () => undefined);
}

const fixtures: Array<{ root: string; store: CompanionsStore; service: CompanionMemoryService }> = [];
beforeEach(() => {
  // Capture eligibility uses real host timestamps as well as scheduler timers.
  // Keep them on the same isolated clock and pass the natural quiet interval.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime('2026-10-27T10:00:00Z');
});
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.close(); fixture.store.close();
    if (path.dirname(fixture.root) !== path.resolve(tmpdir()) || !path.basename(fixture.root).startsWith('worldline-memory-owner-fairness-')) throw new Error('Unexpected cleanup root');
    removeOwnedDirectorySync(fixture.root);
  }
  vi.useRealTimers();
});

function fixture(count: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'worldline-memory-owner-fairness-'));
  const seeds: CompanionSeed[] = Array.from({ length: count }, (_, index) => ({ id: 'owner-' + index, name: 'Owner ' + index,
    persona: '来源调度机制测试', description: '', model: '', avatar: 'sister', active: true, proactive: false }));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds);
  const rooms = seeds.map(seed => store.openPrivate(seed.id));
  const requests: CompanionStorageCommand[] = [], blocked = new Set<string>(), badConfig = new Set<string>(), snapshots: string[] = [];
  let busy = false;
  const configFor = vi.fn(async (owner: { id: string }) => {
    if (badConfig.has(owner.id)) throw new Error('Controlled missing configuration');
    return { apiFormat: 'openai_chat' as const, model: 'controlled-no-network', apiKey: 'unused', baseUrl: 'https://unused.invalid' };
  });
  const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body)), input = JSON.parse(request.messages[1].content);
    expect(input.purpose).toBe('vcp_experience_journal');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notes: [] }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const client = new TimelinePort(root), reports = vi.fn(), published = vi.fn();
  const service = new CompanionMemoryService({ request: async command => {
    requests.push(structuredClone(command)); if (command.type === 'memory.snapshot') snapshots.push(command.companionId);
    return store.request(command);
  }, configFor, fetchFn, blocked: id => blocked.has(id), busy: () => busy,
  runtime: controlledMemoryRuntime({ get: async () => ({ client, profileKey: 'owner-fairness-v1' }), close: () => client.close() }),
  cacheRoot: path.join(root, 'views'), changed: () => undefined, report: reports,
  onTimelineArtifacts: published });
  fixtures.push({ root, store, service });
  return { root, store, service, seeds, rooms, requests, blocked, badConfig, configFor, fetchFn, client, reports, snapshots, published,
    setBusy: (value: boolean) => { busy = value; } };
}

async function pass(service: CompanionMemoryService, milliseconds = 30_001) {
  await vi.advanceTimersByTimeAsync(milliseconds);
  // Wait for the real scheduler's current asynchronous SQLite/filesystem work;
  // the fixture never calls private process/runContinuity or claims on its behalf.
  const pending = service as unknown as { running?: Promise<void>; continuity?: { promise: Promise<void> }; continuityCandidates: Map<string, unknown> };
  await pending.running; await pending.continuity?.promise;
  expect(pending.continuityCandidates.size).toBeLessThanOrEqual(256);
}
function source(f: ReturnType<typeof fixture>, ownerIndex: number) {
  return f.store.appendMessage({ conversationId: f.rooms[ownerIndex]!.id, authorId: 'user', content: '实际待整理来源 ' + ownerIndex, replyDirective: 'none' });
}
function indexed(f: ReturnType<typeof fixture>, ownerIndex: number, occurredAt?: string) {
  const message = source(f, ownerIndex);
  const note = f.store.request({ type: 'memory.record', companionId: f.seeds[ownerIndex]!.id, conversationId: message.conversationId,
    candidate: { artifactKind: 'episode_memory' as const, content: message.content, sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }],
      tags: [], ...(occurredAt ? { occurredAt } : {}) } }).memories![0]!;
  const outbox = f.store.request({ type: 'memory.outbox.claim', companionId: f.seeds[ownerIndex]!.id }).memoryOutbox!;
  f.store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true });
  // This exact source body and full quotation were proactively recorded. The
  // host settles coverage without leasing or paying for duplicate extraction.
  expect(f.store.request({ type: 'memory.jobs.claim', companionId: f.seeds[ownerIndex]!.id }).memoryJob).toBeUndefined();
  expect(f.store.request({ type: 'memory.status', companionId: f.seeds[ownerIndex]!.id }).memoryStatus).toMatchObject({ pending: 0, running: 0 });
  return note;
}

describe('automatic memory fairness across the complete active owner directory', () => {
  it.each([33, 65])('eventually captures actual queued work of owner %i when the earlier owners have no jobs', async count => {
    const f = fixture(count), owner = f.seeds.at(-1)!.id, message = source(f, count - 1);
    f.service.schedule(0);
    for (let round = 0; round < 5; round++) await pass(f.service);
    const status = f.store.request({ type: 'memory.status', companionId: owner }).memoryStatus!;
    expect(status).toMatchObject({ pending: 0, running: 0, completed: 1 });
    expect(f.requests.some(command => command.type === 'memory.jobs.claim' && command.companionId === owner)).toBe(true);
    expect(f.requests.find(command => command.type === 'memory.jobs.complete')).toMatchObject({ notes: [] });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.fetchFn.mock.calls[0])).toContain(message.content);
  });

  it('advances past blocked and unconfigured owners rather than restarting the same prefix', async () => {
    const f = fixture(65), owner = f.seeds[64]!.id;
    for (let index = 0; index < 16; index++) f.blocked.add(f.seeds[index]!.id);
    for (let index = 16; index < 32; index++) f.badConfig.add(f.seeds[index]!.id);
    source(f, 64); f.service.schedule(0);
    for (let round = 0; round < 5; round++) await pass(f.service);
    expect(f.store.request({ type: 'memory.status', companionId: owner }).memoryStatus).toMatchObject({ pending: 0, completed: 1 });
    expect(f.configFor.mock.calls.some(([role]) => f.blocked.has(role.id))).toBe(false);
    expect(f.requests.some(command => command.type === 'memory.jobs.claim' && command.companionId !== undefined && f.badConfig.has(command.companionId))).toBe(false);
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('maintains busy foreground work with bounded capture concurrency and no duplicate or starved later owner', async () => {
    const f = fixture(65); f.setBusy(true);
    const messages = [62, 63, 64].map(index => source(f, index));
    const respond = f.fetchFn.getMockImplementation()!;
    let live = 0, maximum = 0;
    f.fetchFn.mockImplementation(async (...args) => {
      live++; maximum = Math.max(maximum, live);
      try { return await respond(...args); } finally { live--; }
    });
    f.service.schedule(0); await pass(f.service, 1);
    expect(f.fetchFn).not.toHaveBeenCalled();
    for (let round = 0; round < 8 && f.fetchFn.mock.calls.length < 3; round++) {
      await pass(f.service, 15_001);
      expect(maximum).toBeLessThanOrEqual(2);
    }
    expect(f.fetchFn).toHaveBeenCalledTimes(3);
    expect(live).toBe(0); expect(maximum).toBeGreaterThan(0);
    expect(f.requests.filter(command => command.type === 'memory.jobs.complete')).toHaveLength(3);
    for (const message of messages) expect(f.fetchFn.mock.calls.filter(call => JSON.stringify(call).includes(message.content))).toHaveLength(1);
    for (const index of [62, 63, 64]) expect(f.store.request({ type: 'memory.status', companionId: f.seeds[index]!.id }).memoryStatus).toMatchObject({ pending: 0, completed: 1 });
  });

  it('preserves the two-owner capture concurrency limit with actual leased SQLite jobs', async () => {
    const f = fixture(3), releases: Array<() => void> = [];
    let live = 0, maximum = 0, releasing = false;
    f.fetchFn.mockImplementation(async () => {
      live++; maximum = Math.max(maximum, live);
      if (!releasing) await new Promise<void>(resolve => releases.push(resolve)); live--;
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"notes":[]}' } }] }));
    });
    try {
      for (let index = 0; index < 3; index++) source(f, index);
      f.service.schedule(0); await vi.advanceTimersByTimeAsync(1);
      expect(f.fetchFn).not.toHaveBeenCalled();
      // The pre-quiet poll legitimately checks pending work but cannot lease
      // it. Count only the next admission after the natural quiet deadline.
      await vi.advanceTimersByTimeAsync(59_998);
      expect(f.fetchFn).not.toHaveBeenCalled();
      const beforeEligible = f.requests.length;
      await vi.advanceTimersByTimeAsync(2);
      await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(2));
      expect(f.requests.slice(beforeEligible).filter(command => command.type === 'memory.jobs.claim')).toHaveLength(2);
      releases.splice(0).forEach(release => release());
      await vi.waitFor(() => expect(f.fetchFn).toHaveBeenCalledTimes(3));
      releases.splice(0).forEach(release => release()); await pass(f.service, 1);
      expect(maximum).toBe(2);
      for (let index = 0; index < 3; index++) expect(f.store.request({ type: 'memory.status', companionId: f.seeds[index]!.id }).memoryStatus).toMatchObject({ pending: 0, completed: 1 });
    } finally {
      // Failure must not strand this deliberately held provider and poison all
      // later fixtures while service.close waits for the real leased work.
      releasing = true; releases.splice(0).forEach(release => release());
    }
  });

  it('uses the current active directory after removals and a newly activated owner', async () => {
    const f = fixture(65); source(f, 64); f.service.schedule(0); await pass(f.service, 1);
    for (let index = 0; index < 32; index++) f.store.setCompanionActive(f.seeds[index]!.id, false);
    const created = f.store.createCompanion({ name: 'New owner', persona: '来源调度机制测试', description: '', model: '', avatar: 'sister', proactive: false });
    f.store.setCompanionActive(created.id, true); const room = f.store.openPrivate(created.id);
    f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '新加入的真实待整理来源', replyDirective: 'none' });
    const before = f.requests.length;
    for (let round = 0; round < 5; round++) await pass(f.service);
    for (const owner of [f.seeds[64]!.id, created.id]) expect(f.store.request({ type: 'memory.status', companionId: owner }).memoryStatus).toMatchObject({ pending: 0, completed: 1 });
    expect(f.requests.slice(before).some(command => command.type === 'memory.jobs.claim' && command.companionId !== undefined && /^owner-(?:[0-9]|[12][0-9]|3[01])$/u.test(command.companionId))).toBe(false);
  });

  it('does not let 256 previously checked visible owners permanently exclude another existing indexed owner', async () => {
    const f = fixture(257); indexed(f, 0);
    // Public pin controls place the target after all256 other real entrances;
    // no private queue or source state is injected.
    for (let index = 1; index < 257; index++) f.store.request({ type: 'conversation.update', id: f.rooms[index]!.id, pinned: true });
    f.service.schedule(0);
    for (let round = 0; round < 75 && !f.published.mock.calls.length; round++) await pass(f.service);
    expect(f.client.timeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'generateTimelines', owner: expect.objectContaining({ companionId: 'owner-0' }) }));
    expect(f.published).toHaveBeenCalledTimes(1);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });

  it('reaches both the visible owner excluded by the old 256 retained slots and a later hidden actual entrance', async () => {
    const f = fixture(257), owner = f.seeds.at(-1)!.id;
    // Existing indexed history, with no pending capture/outbox wake, exercises
    // the normal periodic startup scan rather than a fixture-created shortcut.
    indexed(f, 0); indexed(f, 256); f.store.deleteConversation(f.rooms[256]!.id, 'hide');
    expect(f.store.state().conversations.some(room => room.id === f.rooms[256]!.id)).toBe(false);
    expect(f.store.request({ type: 'memory.snapshot', companionId: owner, conversationId: f.rooms[256]!.id }).memorySnapshot?.notes).toHaveLength(1);
    f.snapshots.length = 0; f.service.schedule(0);
    for (let round = 0; round < 75 && f.published.mock.calls.length < 2; round++) await pass(f.service);
    expect(f.client.timeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'generateTimelines', owner: expect.objectContaining({ companionId: 'owner-0' }) }));
    expect(f.snapshots).toContain(owner);
    expect(f.client.timeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'generateTimelines', owner: expect.objectContaining({ companionId: owner }) }));
    expect(f.published).toHaveBeenCalledTimes(2);
    expect(f.reports).not.toHaveBeenCalled();
  });

  it('reconsiders an unfinished later month without occupying a permanent queue slot or generating more than one month per idle pass', async () => {
    const f = fixture(1); indexed(f, 0, '2026-08-02T10:00:00Z'); indexed(f, 0, '2026-09-02T10:00:00Z');
    f.store.deleteConversation(f.rooms[0]!.id, 'hide'); f.service.schedule(0);
    for (let round = 0; round < 3; round++) {
      const before = f.client.timeline.mock.calls.filter(([, request]) => request.operation === 'generateTimelines').length;
      await pass(f.service);
      expect(f.client.timeline.mock.calls.filter(([, request]) => request.operation === 'generateTimelines').length - before).toBeLessThanOrEqual(1);
    }
    expect(f.client.timeline.mock.calls.filter(([, request]) => request.operation === 'generateTimelines').map(([, request]) => request.options!.startMonth)).toEqual(['2026-08', '2026-09']);
    const checked = f.client.timeline.mock.calls.length;
    await pass(f.service); expect(f.client.timeline).toHaveBeenCalledTimes(checked);
    expect(f.reports).not.toHaveBeenCalled();
  });

  it('automatically re-enters a hidden existing entrance after a failed month reaches its unchanged retry cooldown', async () => {
    vi.useRealTimers(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const f = fixture(1); indexed(f, 0, '2026-08-02T10:00:00Z'); f.store.deleteConversation(f.rooms[0]!.id, 'hide');
    f.client.timeline.mockImplementationOnce(async () => { throw new Error('Controlled temporary timeline failure'); });
    f.service.schedule(0); await pass(f.service, 1);
    expect(f.client.timeline).toHaveBeenCalledTimes(1); expect(f.reports).toHaveBeenCalledTimes(1);
    expect(f.published).not.toHaveBeenCalled();
    await pass(f.service, 30_001); expect(f.client.timeline).toHaveBeenCalledTimes(1);
    await pass(f.service, 300_001);
    expect(f.client.timeline.mock.calls.filter(([, request]) => request.operation === 'generateTimelines')).toHaveLength(2);
    expect(f.published).toHaveBeenCalledTimes(1);
    expect(f.store.request({ type: 'memory.snapshot', companionId: f.seeds[0]!.id, conversationId: f.rooms[0]!.id }).memorySnapshot?.notes).toHaveLength(1);
  });

  it('releases an inactive queued owner and admits the same actual owner again after reactivation', async () => {
    const f = fixture(40); indexed(f, 20); f.service.schedule(0); await pass(f.service, 1);
    const queued = () => (f.service as unknown as { continuityCandidates: Map<string, { companionId: string }> }).continuityCandidates;
    expect([...queued().values()].some(scope => scope.companionId === 'owner-20')).toBe(true);
    f.store.setCompanionActive('owner-20', false); await pass(f.service);
    expect([...queued().values()].some(scope => scope.companionId === 'owner-20')).toBe(false);
    expect(f.client.timeline).not.toHaveBeenCalled();
    f.store.setCompanionActive('owner-20', true);
    for (let round = 0; round < 15 && !f.published.mock.calls.length; round++) await pass(f.service);
    expect(f.client.timeline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operation: 'generateTimelines', owner: expect.objectContaining({ companionId: 'owner-20' }) }));
    expect(f.published).toHaveBeenCalledTimes(1); expect(f.reports).not.toHaveBeenCalled();
  });
});
