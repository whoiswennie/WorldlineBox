import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { describe, expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionMemory } from '../../src/shared/companions';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { VcpMemoryDreamWaveRequest, VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';
import { createHash } from 'node:crypto';
import { companionMemoryDescriptorSchema } from '../../src/shared/companion-memory';
import { companionMemoryContextEvidenceSchema } from '../../src/shared/companion-memory-context-evidence';
import { companionMemoryTypeScope } from '../../src/main/companions/memory-type-scope';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const note = (id: string, patch: Partial<CompanionMemory> = {}): CompanionMemory => ({ artifactKind: 'episode_memory' as const,
  id, companionId: 'owner', scopeId: 'source', content: `FACT_${id}`, tags: ['flower'], diaryName: 'journal',
  sourceConversationId: 'private', sourceSequence: 1, sources: [{ messageId: `source_${id}`, conversationId: 'private',
    authorId: 'user', sequence: 1, revision: 1, checksum: createHash('sha256').update(id).digest('hex'), createdAt: '2026-10-23T00:00:00Z' }],
  occurredAt: '2026-10-23T12:00:00+08:00', createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
  origin: 'companion', status: 'indexed', captureMethod: 'automatic', version: 1, ...patch,
});
it.each([{ diaryName: 'missing' }, { tags: ['missing'] }, { from: '2027-01-01', to: '2027-01-02' }, { cursor: 100 }])('does not label a filtered or paginated empty result as an empty whole authorization corpus: %j', async filter => {
  const f = fixture([note('actual')]);
  try {
    const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', ...filter });
    expect(result.memoryPage?.items).toEqual([]);
    expect(result.memoryRetrieval?.authorizedCorpusEmpty).toBeUndefined();
    expect(result.memoryRetrieval?.authorizedCorpusRevision).toBeUndefined();
  } finally { await f.service.close(); }
});
function fixture(notes: CompanionMemory[], options: Pick<ConstructorParameters<typeof CompanionMemoryService>[0], 'maxPendingRecalls' | 'maxPendingRecallsPerOwner' | 'validateAssets' | 'prepareFiles' | 'validateFiles'> = {}) {
  let corpus = notes, revision = 'stable', revocationEpoch = 0;
  const scopes = new Map<string, VcpMemoryNote[]>();
  const client = {
    hasOpenScope: (scope: VcpMemoryScope) => scopes.has(scope.scopeId),
    replace: vi.fn(async (scope: VcpMemoryScope, values: VcpMemoryNote[]) => { scopes.set(scope.scopeId, values); }),
    search: vi.fn(async (scope: VcpMemoryScope, input: { topK?: number }) => ({
      results: (scopes.get(scope.scopeId) ?? []).slice(0, input.topK).map(note => ({ ...note, sourceFile: note.id + '.md', engine: 'river' as const })),
      degraded: false, diagnostics: {},
    })),
    pluginCall: vi.fn(async (scope: VcpMemoryScope) => ({ result: scopes.get(scope.scopeId)?.map(note => note.content).join('\n'), indexed: false,
      contextReferences: scopes.get(scope.scopeId)?.map(note => ({ id: note.id, role: 'returned' as const, textHash: 'text_hash' })) })),
    preprocess: vi.fn(async (scope: VcpMemoryScope, ...input: unknown[]) => {
      void input; // Retain complete recorded arguments for the policy assertions below.
      return { messages: [{ role: 'system', content: scopes.get(scope.scopeId)?.map(note => note.content).join('\n') ?? '' }], events: [],
        contextReferences: scopes.get(scope.scopeId)?.map(note => ({ id: note.id, role: 'focus_input' as const, textHash: 'text_hash' })) };
    }),
    dreamWave: vi.fn(async (scope: VcpMemoryScope, input: VcpMemoryDreamWaveRequest): Promise<VcpMemoryDreamWaveResult> => ({ ...input,
      schema: 'worldlinebox.vcp-dream-wave', boundaries: { recentDays: 7, midDays: 90 },
      stages: { recent: { seeds: [], resonanceL1: [], cascadeL2: [] }, mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
      diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: input.notes.length, indexedCount: scopes.get(scope.scopeId)?.length ?? 0, queries: [] } })),
    interruptScope: vi.fn(async () => undefined),
    purgeScope: vi.fn(async (scope: VcpMemoryScope) => { scopes.delete(scope.scopeId); }),
  };
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type === 'memory.outbox.pending') return { ok: true, memoryOutboxPending: false };
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: '2026-10-23T04:00:00Z', virtualNow: '2026-10-23T04:00:00Z', timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } };
    if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'original', revision, revocationEpoch, notes: corpus } };
    if (command.type === 'memory.lifecycle.state') return { ok: true, memoryLifecycleState: { revocationEpoch } };
    if (command.type === 'memory.records.filter') return { ok: true, memories: corpus.filter(note => command.ids.includes(note.id)) };
    if (command.type === 'memory.records.describe') return { ok: true, memoryDescriptors: corpus.filter(note => command.ids.includes(note.id)).map(note => companionMemoryDescriptorSchema.parse(note)) };
    if (command.type === 'memory.frozen.valid') return { ok: true, memoryFrozenValid: command.memories.every(expected => corpus.some(note => note.id === expected.id
      && expected.sources.every(source => note.sources.some(actual => actual.messageId === source.id && actual.conversationId === source.conversationId
        && actual.checksum === source.checksum && (source.revision === undefined || source.revision === actual.revision))))) };
    if (command.type === 'state') return { ok: true, state: { companions: [{ id: 'owner', name: 'Owner' }] } };
    throw new Error('Unexpected request: ' + command.type);
  });
  const get = vi.fn(async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'fixture' }));
  const service = new CompanionMemoryService({ request: request as never, runtime: controlledMemoryRuntime({ get, close: async () => undefined }),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'controlled-generation', apiKey: 'controlled-key', baseUrl: 'https://fixture.invalid' }), fetchFn: async () => { throw new Error('No network'); },
    changed: () => undefined, report: () => undefined, busy: () => false, ...options });
  return { service, client, scopes, get, request, setRevocationEpoch: (next: number) => { revocationEpoch = next; },
    setCorpus: (notes: CompanionMemory[], nextRevision: string) => { corpus = notes; revision = nextRevision; } };
}

describe('one physical corpus for memory filters, context and citation pages', () => {
  it('checks exact consumed files and revocations without waiting for unrelated notebook imports', async () => {
    const pending = Object.assign(new Error('Other notebooks are still being reconciled'), { code: 'MEMORY_FILES_PENDING' });
    const prepareFiles = vi.fn(async () => { throw pending; }), validateFiles = vi.fn(async () => true);
    const original = note('used'), f = fixture([original], { prepareFiles, validateFiles });
    const scope = { companionId: 'owner', conversationId: 'private' };
    const receipts = [{ companionId: 'owner', noteId: original.id, contentRevision: 1, path: '日记/used.md', contentHash: 'a'.repeat(64) }];
    const context = { revision: 'stable', profileKey: 'fixture', typeScope: companionMemoryTypeScope(), text: original.content, fileReceipts: receipts,
      evidence: { dependencyCoverage: 'complete', dependencies: [{ id: original.id, version: 1 }] } };
    try {
      expect(await f.service.contextValid(scope)).toBe(true);
      expect(await f.service.contextValid(scope, context)).toBe(true);
      expect(prepareFiles).not.toHaveBeenCalled(); expect(validateFiles).toHaveBeenCalledWith('owner', receipts);
      validateFiles.mockResolvedValueOnce(false);
      expect(await f.service.contextValid(scope, context)).toBe(false);
      f.setCorpus([], 'withdrawn');
      expect(await f.service.contextValid(scope, context)).toBe(false);
      // New retrieval and contexts without complete physical receipts still
      // await file discovery: this fix never admits an outdated query graph.
      await expect(f.service.search({ ...scope, query: 'facts' })).rejects.toBe(pending);
      await expect(f.service.contextValid(scope, { ...context, fileReceipts: [] })).rejects.toBe(pending);
    } finally { await f.service.close(); }
  });
  it('reserves bounded queued and running recalls before the asset gate and releases capacity on cancellation', async () => {
    let release!: () => void;
    const gate = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
    const f = fixture([], { maxPendingRecalls: 2, maxPendingRecallsPerOwner: 1, validateAssets: gate });
    const query = { companionId: 'owner', conversationId: 'private', query: 'facts' }, controller = new AbortController();
    const first = f.service.search(query, 'passive', controller.signal), rejected = expect(first).rejects.toThrow();
    try {
      expect(gate).toHaveBeenCalledOnce(); expect(f.service.resourceSnapshot().recallAdmissions).toBe(1);
      await expect(f.service.search(query)).rejects.toMatchObject({ code: 'VCP_MEMORY_NATIVE_CAPACITY' });
      expect(gate).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
      controller.abort(); release(); await rejected;
      expect(f.service.resourceSnapshot()).toMatchObject({ recallAdmissions: 0, recallOwners: 0 });
      gate.mockResolvedValue(); expect((await f.service.search(query)).ok).toBe(true);
    } finally { release?.(); await f.service.close(); }
  });
  it('reprojects a changed query timezone while reusing same-zone clocks and retaining immutable provenance', async () => {
    const original = note('actual', { occurredAt: '2035-03-10T23:30:00Z' }), f = fixture([original]), request = f.request.getMockImplementation()!;
    let timeZone = 'Asia/Shanghai', now = '2035-03-11T00:30:00Z';
    f.request.mockImplementation(command => command.type === 'world.clock'
      ? Promise.resolve({ ok: true, worldClock: { realNow: now, virtualNow: now, timeZone, mode: 'paused', speed: 1, backlog: false } }) : request(command));
    try {
      const query = { companionId: 'owner', conversationId: 'private', query: 'facts' };
      const first = await f.service.search(query);
      const firstScope = f.client.replace.mock.calls.at(-1)![0];
      expect(f.client.replace.mock.calls.at(-1)![1][0]).toMatchObject({ content: original.content, occurredAt: original.occurredAt, hostProjection: { timeZone } });
      now = '2035-03-12T00:30:00Z'; await f.service.search(query);
      expect(f.client.replace.mock.calls.at(-1)![0].scopeId).toBe(firstScope.scopeId);
      timeZone = 'UTC'; await f.service.search(query);
      expect(f.client.replace.mock.calls.at(-1)![0].scopeId).not.toBe(firstScope.scopeId);
      expect(f.client.replace.mock.calls.at(-1)![1][0]?.hostProjection).toEqual({ timeZone: 'UTC' });
      expect(f.client.purgeScope).toHaveBeenCalledWith({ scopeId: firstScope.scopeId }); expect(f.scopes.size).toBe(1);
      expect(await f.service.contextValid(query, first.memoryContext!)).toBe(true);
      expect(await f.service.contextFresh(query, first.memoryContext!)).toBe(false);
    } finally { await f.service.close(); }
  });
  it('refreshes a cross-day prompt without revoking the still-valid corpus and profile provenance', async () => {
    const f = fixture([note('actual')]), originalRequest = f.request.getMockImplementation()!;
    let now = '2026-10-23T04:00:00Z';
    f.request.mockImplementation(command => command.type === 'world.clock'
      ? Promise.resolve({ ok: true, worldClock: { realNow: now, virtualNow: now, timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } }) : originalRequest(command));
    const scope = { companionId: 'owner', conversationId: 'private' }, context = { revision: 'stable', profileKey: 'fixture', typeScope: companionMemoryTypeScope(), evidence: { queryClock: { now, timeZone: 'Asia/Shanghai' } } };
    try {
      expect(await f.service.contextValid(scope, context)).toBe(true); expect(await f.service.contextFresh(scope, context)).toBe(true);
      now = '2026-10-23T04:00:00.500Z'; expect(await f.service.contextFresh(scope, context)).toBe(true);
      now = '2026-10-24T04:00:00Z'; expect(await f.service.contextFresh(scope, context)).toBe(false);
      expect(await f.service.contextValid(scope, context)).toBe(true);
    } finally { await f.service.close(); }
  });
  it.each(['active', 'passive'] as const)('applies all filters before the original %s pipeline', async mode => {
    const f = fixture([...Array.from({ length: 110 }, (_, i) => note('excluded' + i, { tags: ['train'] })),
      note('old', { occurredAt: '2025-01-01T00:00:00Z' }), note('wrongbook', { diaryName: 'other' }), note('wanted')]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts',
        tags: ['flower'], diaryName: 'journal', from: '2026-10-23', to: '2026-10-23', limit: 20 }, mode);
      expect(result.memoryPage?.items.map(hit => hit.memory.id)).toEqual(['wanted']);
      expect(result.memoryContext?.text).toBe('FACT_wanted');
      expect(f.client.replace.mock.calls.every(([, notes]) => notes.map(note => note.id).join(',') === 'wanted')).toBe(true);
      expect(result.memoryContext?.evidence).toMatchObject({ pageMemoryIds: ['wanted'], referenceCoverage: 'observed',
        references: [{ id: 'wanted', version: 1, role: mode === 'active' ? 'returned' : 'focus_input', sources: [{ messageId: 'source_wanted', revision: 1 }] }] });
      if (mode === 'passive') { expect(f.client.search).not.toHaveBeenCalled(); expect(f.client.preprocess).toHaveBeenCalledOnce(); }
      else { expect(f.client.search).toHaveBeenCalledOnce(); expect(f.client.pluginCall).toHaveBeenCalledOnce(); }
      const originalScope = f.client.replace.mock.calls[0]?.[0].scopeId;
      await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts',
        tags: ['flower'], diaryName: 'journal', from: '2026-10-23', to: '2026-10-23', limit: 20 }, mode);
      expect(f.client.replace).toHaveBeenCalledOnce();
      expect(f.scopes.has(originalScope!)).toBe(true);
      expect(f.scopes.size).toBe(1);
    } finally { await f.service.close(); }
  });

  it('limits active tool text and provenance to the requested page', async () => {
    const f = fixture([note('first'), note('second'), note('third')]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', cursor: 1, limit: 1 }, 'active');
      expect(result.memoryPage).toMatchObject({ items: [{ memory: { id: 'second' } }], hasMore: true, nextCursor: 2 });
      expect(result.memoryContext?.text).toBe('FACT_second');
      expect(JSON.stringify(result.memoryContext)).not.toContain('FACT_first');
      expect(result.memoryContext?.evidence?.references?.map(reference => reference.id)).toEqual(['second']);
      expect(result.memoryContext?.evidence).toMatchObject({ candidateOrder: 'independent_native_query', contextOrder: 'original_context_pipeline' });
      expect(f.client.replace.mock.calls[0]?.[1]).toHaveLength(3); expect(f.client.replace.mock.calls[1]?.[1].map(note => note.id)).toEqual(['second']);
      expect(f.scopes.size).toBe(2);
    } finally { await f.service.close(); }
  });

  it('paginates passive observations without rebuilding or pruning the graph when query, limit or cursor changes', async () => {
    const f = fixture([note('first'), note('second'), note('third')]);
    try {
      const scope = { companionId: 'owner', conversationId: 'private' };
      const first = await f.service.search({ ...scope, query: 'facts about flowers', limit: 1 }, 'passive');
      const second = await f.service.search({ ...scope, query: 'another topic', cursor: 1, limit: 1 }, 'passive');
      const third = await f.service.search({ ...scope, query: 'a third topic', cursor: 2, limit: 2 }, 'passive');
      expect(first.memoryPage).toMatchObject({ items: [{ memory: { id: 'first' } }], hasMore: true, nextCursor: 1 });
      expect(second.memoryPage).toMatchObject({ items: [{ memory: { id: 'second' } }], hasMore: true, nextCursor: 2 });
      expect(third.memoryPage).toMatchObject({ items: [{ memory: { id: 'third' } }], hasMore: false });
      for (const result of [first, second, third]) {
        expect(result.memoryContext?.text).toBe('FACT_first\nFACT_second\nFACT_third');
        expect(result.memoryContext?.evidence?.references?.map(reference => reference.id)).toEqual(['first', 'second', 'third']);
        expect(result.memoryContext?.evidence).toMatchObject({ candidateOrder: 'context_observation', contextOrder: 'original_context_pipeline',
          dependencies: [{ id: 'first', version: 1 }, { id: 'second', version: 1 }, { id: 'third', version: 1 }], dependencyCoverage: 'complete' });
        expect(result.memoryRetrieval?.candidateQuerySeparateFromContext).toBe(false);
      }
      expect(second.memoryContext?.evidence?.pageMemoryIds).toEqual(['second']);
      expect(f.client.replace).toHaveBeenCalledOnce();
      expect(f.client.replace.mock.calls[0]![1]).toHaveLength(3);
      expect(f.client.preprocess).toHaveBeenCalledTimes(3);
      expect(new Set(f.client.preprocess.mock.calls.map(([scope]) => scope.scopeId)).size).toBe(1);
      expect(f.client.search).not.toHaveBeenCalled();
      expect(f.client.purgeScope).not.toHaveBeenCalled();
      expect(f.scopes.size).toBe(1);
    } finally { await f.service.close(); }
  });

  it('retains more than one hundred passive graph dependencies and protected notes beyond the diagnostic page', async () => {
    const notes = Array.from({ length: 125 }, (_, index) => note(`protected_${index}`, { diaryName: '日记', captureMethod: 'manual' }));
    const f = fixture(notes), scope = { companionId: 'owner', conversationId: 'private' };
    try {
      const result = await f.service.search({ ...scope, query: 'facts', cursor: 120, limit: 5 }, 'passive');
      expect(result.memoryPage?.items.map(hit => hit.memory.id)).toEqual(notes.slice(120).map(note => note.id));
      expect(result.memoryPage?.hasMore).toBe(false);
      expect(result.memoryContext?.text).toBe(notes.map(note => note.content).join('\n'));
      const evidence = companionMemoryContextEvidenceSchema.parse(result.memoryContext?.evidence);
      expect(evidence.dependencies).toEqual(notes.map(note => ({ id: note.id, version: 1 })));
      expect(evidence.references?.map(reference => reference.id)).toEqual(notes.map(note => note.id));
      expect(evidence.recallPolicy?.protectedNoteIds).toEqual(notes.map(note => note.id));
      expect(evidence.pageMemoryIds).toEqual(notes.slice(120).map(note => note.id));
      expect(f.client.preprocess.mock.calls[0]?.[3]).toMatchObject({ protectedNoteIds: notes.map(note => note.id) });
      expect(f.client.replace.mock.calls[0]?.[1]).toHaveLength(125);
      expect(f.client.search).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });

  it.each(['withdrawal', 'revision'] as const)('differentially updates the passive graph on source %s while rejecting old provenance', async change => {
    const original = [note('first'), note('second'), note('third')], f = fixture(original);
    const scope = { companionId: 'owner', conversationId: 'private' };
    try {
      const previous = await f.service.search({ ...scope, query: 'facts', limit: 1 }, 'passive');
      const previousScope = f.client.replace.mock.calls[0]![0];
      const corrected = note('second', { content: 'CORRECTED_second', version: 2,
        sources: [{ ...original[1]!.sources[0]!, revision: 2, checksum: createHash('sha256').update('corrected_source_hash').digest('hex') }] });
      const next = change === 'withdrawal' ? [original[0]!, original[2]!] : [original[0]!, corrected, original[2]!];
      f.setCorpus(next, `source_${change}`);
      expect(await f.service.contextValid(scope, previous.memoryContext!)).toBe(false);
      const current = await f.service.search({ ...scope, query: 'facts', limit: 1 }, 'passive');
      expect(f.client.replace).toHaveBeenCalledTimes(2);
      expect(f.client.replace.mock.calls[1]![0].scopeId).toBe(previousScope.scopeId);
      expect(f.client.replace.mock.calls[1]![1].map(note => note.id)).toEqual(next.map(note => note.id));
      expect(f.client.purgeScope).not.toHaveBeenCalled();
      expect(f.scopes.size).toBe(1);
      expect(current.memoryContext?.text).toBe(next.map(note => note.content).join('\n'));
      expect(current.memoryContext?.text).not.toContain('FACT_second');
      expect(current.memoryContext?.evidence?.dependencies).toEqual(next.map(note => ({ id: note.id, version: note.version })));
      if (change === 'revision') expect(current.memoryContext?.evidence?.references).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'second', version: 2, sources: [expect.objectContaining({ revision: 2, checksum: createHash('sha256').update('corrected_source_hash').digest('hex') })] }),
      ]));
      expect(f.client.search).not.toHaveBeenCalled();
      await f.service.invalidate('owner');
      expect(f.client.purgeScope).toHaveBeenCalledWith({ scopeId: previousScope.scopeId });
      expect(f.scopes.size).toBe(0);
    } finally { await f.service.close(); }
  });

  it('does not initialize a model when filters exclude the full authorized corpus', async () => {
    const f = fixture([note('other', { tags: ['train'] })]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['flower'] });
      expect(result.memoryPage?.items).toEqual([]); expect(f.get).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });
  it('replaces a bounded filter graph without invalidating detached candidates and clears it on owner withdrawal', async () => {
    const f = fixture([note('flower'), note('train', { tags: ['train'] })]);
    try {
      await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['flower'] });
      const first = f.client.replace.mock.calls[0]![0];
      const train = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['train'] });
      expect(train.memoryContext?.text).toBe('FACT_train');
      expect(f.client.replace.mock.calls[1]?.[0].scopeId).toBe(first.scopeId);
      expect(f.client.replace.mock.calls[1]?.[1].map(note => note.id)).toEqual(['train']);
      expect(f.client.purgeScope).not.toHaveBeenCalled();
      expect(f.scopes.size).toBe(1);
      await f.service.invalidate('owner'); expect(f.scopes.size).toBe(0);
    } finally { await f.service.close(); }
  });

  it('compares actual instants and includes both ends of a civil day', async () => {
    const f = fixture([note('midnight', { occurredAt: '2026-10-22T16:00:00Z' }),
      note('last', { occurredAt: '2026-10-23T15:59:59.999Z' }), note('tomorrow', { occurredAt: '2026-10-23T16:00:00Z' })]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', from: '2026-10-23', to: '2026-10-23' });
      expect(result.memoryPage?.items.map(hit => hit.memory.id)).toEqual(['midnight', 'last']);
      await expect(f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', from: '2026-02-31' })).rejects.toThrow('日期');
      await expect(f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', from: '2026-10-24', to: '2026-10-23' })).rejects.toThrow('起始');
    } finally { await f.service.close(); }
  });
  it.each([
    { zone: 'Asia/Shanghai', from: '2026-11-01', start: '2026-10-31T16:00:00Z', end: '2026-11-01T15:59:59.999Z' },
    { zone: 'UTC', from: '2026-11-01', start: '2026-11-01T00:00:00Z', end: '2026-11-01T23:59:59.999Z' },
    { zone: 'America/New_York', from: '2026-03-08', start: '2026-03-08T05:00:00Z', end: '2026-03-09T03:59:59.999Z' },
    { zone: 'America/New_York', from: '2026-11-01', start: '2026-11-01T04:00:00Z', end: '2026-11-02T04:59:59.999Z' },
  ])('filters $zone calendar days before indexing including DST and month boundaries', async test => {
    const f = fixture([note('start', { occurredAt: test.start }), note('end', { occurredAt: test.end }),
      note('before', { occurredAt: new Date(Date.parse(test.start) - 1).toISOString() }), note('after', { occurredAt: new Date(Date.parse(test.end) + 1).toISOString() })]);
    const request = f.request.getMockImplementation()!;
    f.request.mockImplementation(async command => {
      const response = await request(command); if (response.worldClock) response.worldClock.timeZone = test.zone; return response;
    });
    try {
      const query = { companionId: 'owner', conversationId: 'private', query: 'facts', from: test.from, to: test.from };
      expect((await f.service.search(query)).memoryPage?.items.map(hit => hit.memory.id)).toEqual(['start', 'end']);
      expect(f.client.replace.mock.calls.at(-1)![1].map(value => value.id)).toEqual(['start', 'end']);
      // An explicit offset is an instant, independent of the query calendar.
      const exact = await f.service.search({ ...query, from: test.start, to: test.start });
      expect(exact.memoryPage?.items.map(hit => hit.memory.id)).toEqual(['start']);
    } finally { await f.service.close(); }
  });

  it('binds dream buckets to actual source clocks, immutable bodies and owner-wide receipt versions', async () => {
    const world = note('world', { occurredAt: '2000-01-01T00:00:00Z' });
    world.sources[0]!.worldCreatedAt = '2026-10-22T12:00:00Z';
    const mixed = note('mixed');
    mixed.sources = [{ ...mixed.sources[0]!, worldCreatedAt: '2026-10-22T12:00:00Z' },
      { ...mixed.sources[0]!, messageId: 'another_actual_source', createdAt: '2026-10-23T01:00:00Z' }];
    const f = fixture([world, mixed]);
    try {
      const result = await f.service.dreamWave({ companionId: 'owner', conversationId: 'private', now: '2026-10-23T12:00:00Z', clockDomain: 'world' });
      const [scope, input] = f.client.dreamWave.mock.calls[0]!;
      expect(scope.scopeId).toBe(f.client.replace.mock.calls[0]![0].scopeId);
      expect(input.notes).toEqual([{ id: 'world', version: 1, eventTime: '2026-10-22T12:00:00Z', clockDomain: 'world', contentHash: createHash('sha256').update(world.content).digest('hex') },
        { id: 'mixed', version: 1, eventTime: '2026-10-23T01:00:00Z', clockDomain: 'real', contentHash: createHash('sha256').update(mixed.content).digest('hex') }]);
      expect(f.client.replace.mock.calls[0]![1].map(note => note.metadata)).toEqual(input.notes.map(() => ({ hostArtifactKind: 'episode_memory', hostMemoryOwner: input.owner, hostMemoryVersion: 1 })));
      expect(result.sourceRevision).toBe('stable');
    } finally { await f.service.close(); }
  });
  it('keeps a fixed dream input while tags and unrelated notes advance the owner corpus', async () => {
    const originalNote = note('dream'), f = fixture([originalNote]), original = f.client.dreamWave.getMockImplementation()!;
    f.client.dreamWave.mockImplementation(async (scope, input) => {
      f.setCorpus([note('dream', { tags: ['new_annotation'], version: 2 }), note('later')], 'changed_soft');
      return original(scope, input);
    });
    try {
      const result = await f.service.dreamWave({ companionId: 'owner', conversationId: 'private', now: '2026-10-23T12:00:00Z', clockDomain: 'world' });
      expect(result.sourceRevision).toBe('stable');
      expect(f.client.dreamWave.mock.calls[0]?.[1].notes).toEqual([{ id: 'dream', version: 1, eventTime: originalNote.sources[0]!.createdAt,
        clockDomain: 'real', contentHash: createHash('sha256').update(originalNote.content).digest('hex') }]);
      expect(f.client.replace.mock.calls[0]?.[1].map(note => note.id)).toEqual(['dream']);
      expect(f.client.dreamWave).toHaveBeenCalledOnce();
    } finally { await f.service.close(); }
  });
  it.each(['source', 'source_revision', 'withdrawal', 'profile', 'clock'] as const)('rejects dream publication when the %s receipt changes during native work', async changed => {
    const f = fixture([note('dream')]), original = f.client.dreamWave.getMockImplementation()!;
    f.client.dreamWave.mockImplementation(async (scope, input) => {
      const result = await original(scope, input);
      if (changed === 'source' || changed === 'source_revision') {
        const corrected = note('dream');
        corrected.sources[0]!.revision++;
        if (changed === 'source') corrected.sources[0]!.checksum = createHash('sha256').update('corrected').digest('hex');
        f.setCorpus([corrected], 'changed');
      }
      if (changed === 'withdrawal') f.setRevocationEpoch(1);
      if (changed === 'profile') f.get.mockResolvedValue({ client: f.client as unknown as VcpMemoryClient, profileKey: 'changed' });
      return changed === 'clock' ? { ...result, clockDomain: 'real' } : result;
    });
    try {
      await expect(f.service.dreamWave({ companionId: 'owner', conversationId: 'private', now: '2026-10-23T12:00:00Z', clockDomain: 'world' })).rejects.toThrow(/已经变化|凭证不匹配/u);
    } finally { await f.service.close(); }
  });
});
