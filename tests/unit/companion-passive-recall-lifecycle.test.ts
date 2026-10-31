import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionService } from '../../src/main/companions/service';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompanionMemoryRuntime } from '../../src/main/companions/vcp-runtime';
import type { Companion, CompanionConversation, CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionMemoryQueryScheduler } from '../../src/main/companions/memory-query-scheduler';
import { createHash } from 'node:crypto';
import type { CompanionMemoryProjectionNote } from '../../src/shared/companion-memory-projection';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
interface LifecyclePort {
  queries: CompanionMemoryQueryScheduler;
  register(owner: string, scopeId: string, client: VcpMemoryClient): void;
  registeredScopes: Map<string, Map<string, VcpMemoryClient>>;
  warmup?: Promise<void>;
  startWarmup(companions: readonly Companion[], rooms: readonly CompanionConversation[]): void;
  startContinuity(): void;
}

it('releases retired model clients from the live scope registry across repeated configuration changes', async () => {
  const f = fixture();
  try {
    let previous: { isClosed: boolean } | undefined;
    for (let index = 0; index < 128; index++) {
      if (previous) previous.isClosed = true;
      const client = { ...f.client, isClosed: false };
      f.port.register('owner', `view_${index.toString(16).padStart(32, '0')}`, client as unknown as VcpMemoryClient);
      previous = client;
      expect(f.port.registeredScopes.get('owner')?.size).toBe(1);
    }
  } finally { await f.service.close(); }
});
function fixture(options: { cacheRoot?: string; scopes?: Map<string, VcpMemoryNote[]>; metadata?: boolean } = {}) {
  let busy = false, blocked = false, revision = 'initial';
  let corpus: CompanionMemory[] = [{ artifactKind: 'episode_memory' as const, id: 'note', companionId: 'owner', scopeId: 'original', content: 'ORIGINAL_SOURCE', tags: ['topic'],
    diaryName: '日记', sourceConversationId: 'private', sourceSequence: 1, sources: [{ messageId: 'source', conversationId: 'private',
      authorId: 'user', sequence: 1, revision: 1, checksum: 'a'.repeat(64), createdAt: '2026-10-23T00:00:00Z' }],
    occurredAt: '2026-10-23T00:00:00Z', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    origin: 'companion', status: 'indexed', captureMethod: 'automatic', version: 1, contentRevision: 1 }];
  const companion = { id: 'owner', name: 'Owner', active: true } as Companion;
  const room = { id: 'private', memberIds: ['owner'], lastMessage: '最近实际发言', updatedAt: '2026-10-26T00:00:00Z' } as CompanionConversation;
  const scopes = options.scopes ?? new Map<string, VcpMemoryNote[]>(), openScopes = new Set<string>();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const projectionState = () => ({ companionId: 'owner', sequence: revision === 'initial' ? 1 : 2, floorSequence: 0, revocationEpoch: 0, resetRevision: 0, externalVersion: 1, generation: 0 });
  const metadata = (): CompanionMemoryProjectionNote[] => corpus.map(note => {
    const { content, ...descriptor } = note;
    return { ...descriptor, contentRevision: note.version, contentHash: hash(content), bodyFingerprint: hash(content),
      projectionFingerprint: hash(JSON.stringify([note.id, note.version, note.tags])), notBeforeSequence: 1 };
  });
  const client = {
    hasOpenScope: (scope: VcpMemoryScope) => openScopes.has(scope.scopeId),
    replace: vi.fn(async (scope: VcpMemoryScope, notes: VcpMemoryNote[]) => { scopes.set(scope.scopeId, structuredClone(notes)); openScopes.add(scope.scopeId); }),
    inspectProjection: vi.fn(async (scope: VcpMemoryScope, descriptors: readonly { id: string; contentHash: string }[]) => {
      const old = scopes.get(scope.scopeId) ?? []; openScopes.add(scope.scopeId);
      return { upsertIds: descriptors.filter(note => !old.some(body => body.id === note.id && hash(body.content) === note.contentHash)).map(note => note.id),
        removedIds: old.filter(note => !descriptors.some(current => current.id === note.id)).map(note => note.id), reused: 0 };
    }),
    applyProjectionDelta: vi.fn(async (scope: VcpMemoryScope, notes: VcpMemoryNote[], removed: string[]) => {
      scopes.set(scope.scopeId, [...scopes.get(scope.scopeId) ?? []].filter(note => !removed.includes(note.id) && !notes.some(current => current.id === note.id)).concat(structuredClone(notes)));
      openScopes.add(scope.scopeId);
    }),
    prepare: vi.fn(async () => ({ ready: true as const, corpusEpoch: 0 })),
    preprocess: vi.fn(async (scope: VcpMemoryScope) => ({ messages: [{ role: 'system', content: scopes.get(scope.scopeId)!.map(note => note.content).join('\n') }],
      events: [], contextReferences: scopes.get(scope.scopeId)!.map(note => ({ id: note.id, role: 'focus_input' as const, textHash: hash(note.content) })) })),
    search: vi.fn(async () => { throw new Error('Passive recall must not prequery candidates.'); }),
    interruptScope: vi.fn(async (scope: VcpMemoryScope) => { openScopes.delete(scope.scopeId); }),
    purgeScope: vi.fn(async (scope: VcpMemoryScope) => { scopes.delete(scope.scopeId); openScopes.delete(scope.scopeId); }),
  };
  const release = vi.fn(async () => undefined);
  const get = vi.fn(async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'fixture', release }));
  const runtime: CompanionMemoryRuntime = { supportsPreparation: true, get,
    ...(options.metadata ? { supportsProjectionDelta: true } : {}),
    prepareEmbedding: vi.fn(async () => undefined),
    describeEmbedding: async () => ({ profileKey: 'fixture' }),
    describeGeneration: async input => ({ ownerId: input.ownerId, profileKey: 'fixture' }),
    acquireGeneration: vi.fn(async input => ({ ...await get(), ownerId: input.ownerId, connectionEpoch: 1, release })),
    interruptOwner: vi.fn(async () => { openScopes.clear(); }), purgeOwner: vi.fn(async (_owner, cleanup) => {
      if (cleanup?.preserveIndexes) for (const pair of cleanup.historicalViews ?? []) { scopes.delete(pair.scopeId); openScopes.delete(pair.scopeId); }
      else { scopes.clear(); openScopes.clear(); }
    }), close: vi.fn(async () => { openScopes.clear(); }) };
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type === 'memory.outbox.pending') return { ok: true, memoryOutboxPending: false };
    if (command.type === 'memory.outbox.claim') return { ok: true };
    if (command.type === 'memory.projection.state') return { ok: true, memoryProjectionState: projectionState() };
    if (command.type === 'memory.projection.release') return { ok: true };
    if (command.type === 'memory.projection.page' || command.type === 'memory.projection.delta') return { ok: true,
      memoryProjectionPage: { state: projectionState(), notes: metadata(), removedIds: [], hasMore: false, nextSequence: projectionState().sequence } };
    if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'original', revision, notes: structuredClone(corpus) } };
    if (command.type === 'memory.records.filter') return { ok: true, memories: structuredClone(corpus.filter(note => command.ids.includes(note.id))) };
    if (command.type === 'memory.records.describe') return { ok: true, memoryDescriptors: metadata().filter(note => command.ids.includes(note.id)) };
    if (command.type === 'memory.frozen.valid') return { ok: true, memoryFrozenValid: command.memories.every(expected => corpus.some(note => note.id === expected.id && note.status !== 'forgotten')) };
    if (command.type === 'state') return { ok: true, state: { companions: [companion], conversations: [room] } };
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: '2026-10-26T00:00:00Z', virtualNow: '2026-10-26T00:00:00Z',
      timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } };
    throw new Error('Unexpected fixture command: ' + command.type);
  });
  const report = vi.fn(), model = vi.fn<typeof fetch>(async () => { throw new Error('This lifecycle test must never call a model.'); });
  const configFor = vi.fn(async () => ({ apiFormat: 'openai_chat' as const, model: 'fixture-model', apiKey: 'fixture-key' }));
  // Controlled canonical ports isolate orchestration only. Real registry/file
  // authority is covered separately; these functions never become production
  // fallback reads and the native encoder is not started by this unit fixture.
  const canonicalInputs = vi.fn(async (_scope: unknown, descriptors: readonly CompanionMemoryProjectionNote[]) => structuredClone(corpus.filter(note => descriptors.some(descriptor => descriptor.id === note.id))));
  const materializeNotes = vi.fn(async (_owner: string, notes: readonly CompanionMemory[]) => ({ notes: [...notes], receipts: notes.map(note => ({ companionId: 'owner', noteId: note.id,
    contentRevision: note.version, path: '/controlled-owner/' + note.id + '.md', contentHash: hash(note.content) })) }));
  const service = new CompanionMemoryService({ request: request as never, runtime, cacheRoot: options.cacheRoot, configFor,
    ...(options.metadata ? { canonicalInputs, materializeNotes } : {}), fetchFn: model, busy: () => busy, blocked: () => blocked, report, changed: () => undefined });
  const port = service as unknown as LifecyclePort;
  const continuity = vi.spyOn(port, 'startContinuity').mockImplementation(() => undefined);
  return { service, port, client, runtime, request, scopes, release, companion, room, report, model, configFor, canonicalInputs, materializeNotes, continuity,
    setBusy: (value: boolean) => { busy = value; }, setBlocked: (value: boolean) => { blocked = value; },
    notes: () => structuredClone(corpus), setCorpus: (notes: CompanionMemory[], nextRevision: string) => { corpus = structuredClone(notes); revision = nextRevision; },
    revise: () => { revision = 'revised'; corpus = corpus.map(note => ({ ...note, content: 'REVISED_SOURCE', version: note.version + 1, contentRevision: (note.contentRevision ?? 1) + 1 })); } };
}

it('warms the recent passive graph through the physical core without model routing or query calls', async () => {
  const f = fixture();
  try {
    const older = { ...f.room, id: 'older', updatedAt: '2026-10-25T00:00:00Z' };
    f.port.startWarmup([f.companion], [older, f.room]);
    await f.port.warmup;
    await Promise.resolve();
    expect(f.request).toHaveBeenCalledWith({ type: 'memory.snapshot', companionId: 'owner', conversationId: 'private', contentKinds: ['episode_memory', 'knowledge', 'procedure'] });
    expect(f.client.prepare).toHaveBeenCalledOnce(); expect(f.client.replace).toHaveBeenCalledOnce();
    expect(f.client.preprocess).not.toHaveBeenCalled(); expect(f.client.search).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
    expect(f.runtime.acquireGeneration).not.toHaveBeenCalled(); expect(f.configFor).not.toHaveBeenCalled();
    expect(f.continuity).toHaveBeenCalledOnce();
    f.port.startWarmup([f.companion], [f.room]); await f.port.warmup;
    expect(f.client.prepare).toHaveBeenCalledOnce(); expect(f.client.replace).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
  } finally { await f.service.close(); }
});

it('primes the default metadata graph once after agenda startup and only rechecks it after an explicit corpus change', async () => {
  const f = fixture({ metadata: true });
  try {
    f.service.setAgendaDriven(vi.fn());
    await f.service.primeIdle(); await Promise.resolve();
    expect(f.client.prepare).toHaveBeenCalledOnce(); expect(f.runtime.prepareEmbedding).toHaveBeenCalledOnce();
    expect(f.client.inspectProjection).toHaveBeenCalledOnce(); expect(f.client.applyProjectionDelta).toHaveBeenCalledOnce();
    expect(f.canonicalInputs).toHaveBeenCalledOnce(); expect(f.materializeNotes).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.snapshot')).toBe(false);
    expect(f.runtime.acquireGeneration).not.toHaveBeenCalled(); expect(f.configFor).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
    const calls = f.request.mock.calls.length;
    await f.service.primeIdle(); await f.service.primeIdle();
    expect(f.request).toHaveBeenCalledTimes(calls); expect(f.client.prepare).toHaveBeenCalledOnce();
    const recalled = await f.service.search({ companionId: 'owner', conversationId: 'private', query: '同一实际话题' }, 'passive');
    expect(recalled.memoryContext?.text).toBe('ORIGINAL_SOURCE');
    expect(f.client.applyProjectionDelta).toHaveBeenCalledOnce(); expect(f.client.replace).not.toHaveBeenCalled();
    expect(f.client.prepare).toHaveBeenCalledOnce(); f.client.preprocess.mockClear();
    f.revise(); f.service.changed('owner'); await f.service.primeIdle();
    expect(f.client.prepare).toHaveBeenCalledTimes(2); expect(f.client.applyProjectionDelta).toHaveBeenCalledTimes(2);
    expect([...f.scopes.values()].flat().map(note => note.content)).toContain('REVISED_SOURCE');
    expect(f.client.preprocess).not.toHaveBeenCalled(); expect(f.client.search).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('defers idle priming while foreground is busy and skips native graph work for a genuinely empty corpus', async () => {
  const f = fixture({ metadata: true });
  try {
    f.setBusy(true); await f.service.primeIdle(); expect(f.runtime.get).not.toHaveBeenCalled();
    f.setBusy(false); f.setCorpus([], 'empty'); await f.service.primeIdle();
    expect(f.client.prepare).not.toHaveBeenCalled(); expect(f.client.applyProjectionDelta).not.toHaveBeenCalled();
    expect(f.client.replace).not.toHaveBeenCalled(); expect(f.canonicalInputs).not.toHaveBeenCalled(); expect(f.model).not.toHaveBeenCalled();
    expect(f.runtime.acquireGeneration).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('interrupts an in-flight idle graph when foreground recall arrives and drains its core lease before returning the query', async () => {
  const f = fixture(), entered = deferred(), held = deferred(); let query: Promise<unknown> | undefined;
  f.client.prepare.mockImplementation(async () => { entered.resolve(); await held.promise; return { ready: true, corpusEpoch: 0 }; });
  f.client.interruptScope.mockImplementation(async () => { held.reject(new Error('actual foreground preemption')); });
  try {
    f.port.startWarmup([f.companion], [f.room]); await entered.promise;
    const warming = f.port.warmup!.catch(() => undefined);
    query = f.service.search({ companionId: 'owner', conversationId: 'private', query: '当前话题' }, 'passive');
    await vi.waitFor(() => expect(f.client.preprocess).toHaveBeenCalledOnce());
    expect((await query as { memoryContext?: { text: string } }).memoryContext?.text).toBe('ORIGINAL_SOURCE'); await warming;
    expect(f.client.interruptScope).toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.runtime.acquireGeneration).not.toHaveBeenCalled(); expect(f.report).not.toHaveBeenCalled();
  } finally { held.resolve(); await Promise.allSettled([query]); await f.service.close(); }
});

it('allows foreground recall on its own graph while a same-owner dream graph is still running', async () => {
  const f = fixture(), entered = deferred(), held = deferred();
  const dreamingClient = f.client as typeof f.client & { dreamWave: (view: unknown, input: { owner: unknown; sourceRevision: string; now: string; clockDomain: string }) => Promise<unknown> };
  dreamingClient.dreamWave = vi.fn(async (_view, input) => {
    entered.resolve(); await held.promise;
    return { schema: 'worldlinebox.vcp-dream-wave', owner: input.owner, sourceRevision: input.sourceRevision,
      now: input.now, clockDomain: input.clockDomain };
  });
  let foreground: Promise<unknown> | undefined;
  const dream = f.service.dreamWave({ companionId: 'owner', conversationId: 'private', now: '2026-10-26T00:00:00Z', clockDomain: 'real' });
  try {
    await entered.promise;
    foreground = f.service.search({ companionId: 'owner', conversationId: 'private', query: 'topic', limit: 12 }, 'passive');
    await vi.waitFor(() => expect(f.client.preprocess).toHaveBeenCalledOnce());
    expect((await foreground as { memoryContext?: { text: string } }).memoryContext?.text).toContain('ORIGINAL_SOURCE');
    // The background barrier has not been released; progress is independent.
    held.resolve(); await dream;
  } finally { held.resolve(); await Promise.allSettled([dream, foreground]); await f.service.close(); }
});

it('does not warm a foreground-busy or blocked owner and skips queued preparation when foreground becomes busy', async () => {
  const f = fixture(), held = deferred(), entered = deferred();
  let lane: Promise<void> | undefined;
  try {
    f.setBusy(true); f.port.startWarmup([f.companion], [f.room]); expect(f.port.warmup).toBeUndefined();
    f.setBusy(false); f.setBlocked(true); f.port.startWarmup([f.companion], [f.room]); expect(f.port.warmup).toBeUndefined();
    f.setBlocked(false);
    lane = f.port.queries.run('owner:owner-v2', async () => { entered.resolve(); await held.promise; }, { priority: 'foreground' });
    await entered.promise;
    f.port.startWarmup([f.companion], [f.room]);
    await vi.waitFor(() => expect(f.port.queries.snapshot('owner:owner-v2').background).toBe(1));
    f.setBusy(true); held.resolve(); await lane; await f.port.warmup;
    expect(f.client.replace).not.toHaveBeenCalled(); expect(f.client.prepare).not.toHaveBeenCalled();
    expect(f.runtime.acquireGeneration).not.toHaveBeenCalled();
  } finally { held.resolve(); await lane; await f.service.close(); }
});

it('cancels a queued warmup during invalidation and drains it without acquiring a stale generation', async () => {
  const f = fixture(), held = deferred(), entered = deferred();
  let lane: Promise<void> | undefined;
  try {
    lane = f.port.queries.run('owner:owner-v2', async () => { entered.resolve(); await held.promise; }, { priority: 'foreground' });
    await entered.promise;
    f.port.startWarmup([f.companion], [f.room]);
    const warmup = f.port.warmup!.catch(() => undefined), invalidated = f.service.invalidate('owner');
    held.resolve(); await Promise.all([lane, warmup, invalidated]);
    expect(f.client.replace).not.toHaveBeenCalled(); expect(f.runtime.acquireGeneration).not.toHaveBeenCalled();
    expect(f.runtime.purgeOwner).toHaveBeenCalledOnce();
    expect(f.port.queries.snapshot('owner:owner-v2')).toEqual({ foreground: 0, background: 0 });
  } finally { held.resolve(); await lane; await f.service.close(); }
});

it('holds the next generation behind withdrawal while an interrupted warmup releases its old lease', async () => {
  const f = fixture(), preparation = deferred(), entered = deferred(), purge = deferred(), purging = deferred();
  f.client.prepare.mockImplementation(async () => { entered.resolve(); await preparation.promise; return { ready: true, corpusEpoch: 0 }; });
  f.client.interruptScope.mockImplementation(async () => { preparation.reject(new Error('Actual scope interruption')); });
  vi.mocked(f.runtime.purgeOwner!).mockImplementation(async () => { purging.resolve(); await purge.promise; f.scopes.clear(); });
  try {
    f.port.startWarmup([f.companion], [f.room]); await entered.promise;
    const warming = f.port.warmup!.catch(() => undefined), invalidation = f.service.invalidate('owner');
    const query = f.service.search({ companionId: 'owner', conversationId: 'private', query: '本轮当前话题' }, 'passive');
    await purging.promise;
    expect(f.client.preprocess).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
    purge.resolve(); await invalidation; await warming;
    const result = await query;
    expect(result.memoryContext?.text).toBe('ORIGINAL_SOURCE'); expect(f.client.preprocess).toHaveBeenCalledOnce();
    expect(f.client.replace).toHaveBeenCalledTimes(2); expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.report).not.toHaveBeenCalled();
  } finally { preparation.resolve(); purge.resolve(); await f.service.close(); }
});

it('closes an executing warmup by interrupting its real scope and draining the lane before closing the runtime', async () => {
  const f = fixture(), preparation = deferred(), entered = deferred();
  f.client.prepare.mockImplementation(async () => { entered.resolve(); await preparation.promise; return { ready: true, corpusEpoch: 0 }; });
  f.client.interruptScope.mockImplementation(async () => { preparation.reject(new Error('Actual close interruption')); });
  try {
    f.port.startWarmup([f.companion], [f.room]); await entered.promise;
    await f.service.close();
    expect(f.release).toHaveBeenCalledOnce(); expect(f.runtime.close).toHaveBeenCalledOnce();
    expect(f.port.queries.snapshot('owner:owner-v2')).toEqual({ foreground: 0, background: 0 });
    expect(f.report).not.toHaveBeenCalled(); expect(f.continuity).not.toHaveBeenCalled();
  } finally { preparation.resolve(); }
});

it('retries a changed source with its complete revised graph and never publishes the first focused result', async () => {
  const f = fixture(), preprocess = f.client.preprocess.getMockImplementation()!;
  f.client.preprocess.mockImplementationOnce(async scope => { const old = await preprocess(scope); f.revise(); return old; });
  try {
    const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: '当前来源' }, 'passive');
    expect(result.memoryContext?.text).toBe('REVISED_SOURCE');
    expect(result.memoryContext?.revision).toBe('revised');
    expect(result.memoryContext?.evidence).toMatchObject({ dependencies: [{ id: 'note', version: 2 }], dependencyCoverage: 'complete',
      references: [{ id: 'note', version: 2, role: 'focus_input' }] });
    expect(f.client.preprocess).toHaveBeenCalledTimes(2); expect(f.client.replace).toHaveBeenCalledTimes(2);
    expect(f.client.purgeScope).not.toHaveBeenCalled(); expect(f.client.search).not.toHaveBeenCalled();
    expect(f.client.replace.mock.calls[1]![0].scopeId).toBe(f.client.replace.mock.calls[0]![0].scopeId);
  } finally { await f.service.close(); }
});

it('keeps a clean persistent index after revision, rejects the old context, and synchronizes revised authorization before recall on reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-passive-reopen-'));
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-passive-reopen-')) throw new Error('Unexpected lifecycle cleanup target.');
  const scopes = new Map<string, VcpMemoryNote[]>(), first = fixture({ cacheRoot: root, scopes });
  let reopened: ReturnType<typeof fixture> | undefined;
  const query = { companionId: 'owner', conversationId: 'private', query: '当前约定' };
  try {
    const initial = first.notes()[0]!;
    first.setCorpus([initial, { ...initial, id: 'revoked', content: 'REVOKED_OLD_SOURCE' }], 'initial');
    const old = await first.service.search(query, 'passive');
    const scopeId = first.client.replace.mock.calls[0]![0].scopeId;
    const current = [{ ...initial, content: 'REVISED_SOURCE', version: 2 }];
    first.setCorpus(current, 'revised');
    await first.service.invalidate('owner', ['canonical-owner'], { preserveIndexes: true });
    expect(first.runtime.purgeOwner).toHaveBeenCalledWith('owner', { preserveIndexes: true, historicalViews: [] });
    expect(scopes.get(scopeId)).toHaveLength(2); // Persistent files survive reader retirement.
    expect(await first.service.contextValid(query, old.memoryContext)).toBe(false);
    expect(first.client.purgeScope).not.toHaveBeenCalled();
    await first.service.close();

    reopened = fixture({ cacheRoot: root, scopes }); reopened.setCorpus(current, 'revised');
    expect(await reopened.service.contextValid(query, old.memoryContext)).toBe(false);
    const result = await reopened.service.search(query, 'passive');
    expect(reopened.client.replace).toHaveBeenCalledOnce();
    expect(reopened.client.replace.mock.calls[0]![0].scopeId).toBe(scopeId);
    expect(reopened.client.replace.mock.calls[0]![1]).toMatchObject([{ id: 'note', content: 'REVISED_SOURCE', metadata: { hostMemoryVersion: 2 } }]);
    expect(reopened.client.replace.mock.invocationCallOrder[0]).toBeLessThan(reopened.client.preprocess.mock.invocationCallOrder[0]!);
    expect(result.memoryContext?.text).toBe('REVISED_SOURCE'); expect(JSON.stringify(result)).not.toContain('REVOKED_OLD_SOURCE');
    expect(result.memoryContext?.evidence?.dependencies).toEqual([{ id: 'note', version: 2 }]);
    expect(scopes.get(scopeId)).toHaveLength(1); expect(reopened.client.purgeScope).not.toHaveBeenCalled();
    await reopened.service.invalidate('owner', ['canonical-owner']);
    expect(reopened.runtime.purgeOwner).toHaveBeenLastCalledWith('owner', expect.objectContaining({ canonicalScopes: expect.arrayContaining(['canonical-owner', scopeId]) }));
    expect(scopes.size).toBe(0);
  } finally {
    await reopened?.service.close(); await first.service.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['memory.revise', true], ['memory.organize', true], ['memory.consolidate', true], ['memory.library.organize', true], ['memory.tags.complete', true],
  ['memory.forget', false], ['memory.library.delete', false],
] as const)('routes Main %s invalidation to preserveIndexes=%s only for ordinary revision maintenance', async (type, preserve) => {
  const invalidate = vi.fn(async () => undefined), schedule = vi.fn(), request = vi.fn(async () => ({ ok: true,
    memoryInvalidatedCompanionIds: ['owner'], memoryInvalidatedScopeIds: ['canonical-owner'] }));
  const host = Object.create(CompanionService.prototype) as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  Object.assign(host, { storage: { request }, resettingCompanions: new Set(), sourceValidationRevision: 0, evidenceRevision: 0,
    memory: { invalidate, schedule }, memoryLibrary: { invalidate: vi.fn(async () => undefined), purgeRevoked: vi.fn(async () => ({ removed: 0, conflicts: [], pending: false })) }, options: { report: vi.fn() },
    // This test starts after the write-authority gate, and isolates the real
    // Main invalidation policy from independent semantic write validation.
    checkedMemoryWrite: vi.fn(async () => undefined) });
  const command = { type, companionId: 'owner', conversationId: 'private' } as CompanionStorageCommand;
  await host.call(command);
  expect(invalidate).toHaveBeenCalledWith('owner', ['canonical-owner'], { preserveIndexes: preserve });
});
