import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { describe, expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionMemory } from '../../src/shared/companions';
import type { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import type { VcpMemoryDreamWaveRequest, VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';
import { createHash } from 'node:crypto';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

const note = (id: string, patch: Partial<CompanionMemory> = {}): CompanionMemory => ({
  id, companionId: 'owner', scopeId: 'source', content: `FACT_${id}`, tags: ['flower'], diaryName: 'journal',
  sourceConversationId: 'private', sourceSequence: 1, sources: [{ messageId: `source_${id}`, conversationId: 'private',
    authorId: 'user', sequence: 1, revision: 1, checksum: `hash_${id}`, createdAt: '2026-10-23T00:00:00Z' }],
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
function fixture(notes: CompanionMemory[]) {
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
    preprocess: vi.fn(async (scope: VcpMemoryScope) => ({ messages: [{ role: 'system', content: scopes.get(scope.scopeId)?.map(note => note.content).join('\n') ?? '' }], events: [],
      contextReferences: scopes.get(scope.scopeId)?.map(note => ({ id: note.id, role: 'focus_input' as const, textHash: 'text_hash' })) })),
    dreamWave: vi.fn(async (scope: VcpMemoryScope, input: VcpMemoryDreamWaveRequest): Promise<VcpMemoryDreamWaveResult> => ({ ...input,
      schema: 'worldlinebox.vcp-dream-wave', boundaries: { recentDays: 7, midDays: 90 },
      stages: { recent: { seeds: [], resonanceL1: [], cascadeL2: [] }, mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
      diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: input.notes.length, indexedCount: scopes.get(scope.scopeId)?.length ?? 0, queries: [] } })),
    interruptScope: vi.fn(async () => undefined),
    purgeScope: vi.fn(async (scope: VcpMemoryScope) => { scopes.delete(scope.scopeId); }),
  };
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: '2026-10-23T04:00:00Z', virtualNow: '2026-10-23T04:00:00Z', timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } };
    if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'original', revision: 'stable', notes } };
    if (command.type === 'state') return { ok: true, state: { companions: [{ id: 'owner', name: 'Owner' }] } };
    throw new Error('Unexpected request: ' + command.type);
  });
  const get = vi.fn(async () => ({ client: client as unknown as VcpMemoryClient, profileKey: 'fixture' }));
  const service = new CompanionMemoryService({ request: request as never, runtime: controlledMemoryRuntime({ get, close: async () => undefined }),
    configFor: async () => ({ apiFormat: 'openai_chat', model: 'controlled-generation', apiKey: 'controlled-key', baseUrl: 'https://fixture.invalid' }), fetchFn: async () => { throw new Error('No network'); },
    changed: () => undefined, report: () => undefined, busy: () => false });
  return { service, client, scopes, get, request };
}

describe('one physical corpus for memory filters, context and citation pages', () => {
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
    const scope = { companionId: 'owner', conversationId: 'private' }, context = { revision: 'stable', profileKey: 'fixture', evidence: { queryClock: { now, timeZone: 'Asia/Shanghai' } } };
    try {
      expect(await f.service.contextValid(scope, context)).toBe(true); expect(await f.service.contextFresh(scope, context)).toBe(true);
      now = '2026-10-23T04:00:00.500Z'; expect(await f.service.contextFresh(scope, context)).toBe(true);
      now = '2026-10-24T04:00:00Z'; expect(await f.service.contextFresh(scope, context)).toBe(false);
      expect(await f.service.contextValid(scope, context)).toBe(true);
    } finally { await f.service.close(); }
  });
  it.each(['active', 'passive'] as const)('applies all filters before native top-K and %s context', async mode => {
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
      const originalScope = f.client.replace.mock.calls[0]?.[0].scopeId;
      await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts',
        tags: ['flower'], diaryName: 'journal', from: '2026-10-23', to: '2026-10-23', limit: 20 }, mode);
      expect(f.client.replace).toHaveBeenCalledOnce();
      expect(f.scopes.has(originalScope!)).toBe(true);
      expect(f.scopes.size).toBe(1);
    } finally { await f.service.close(); }
  });

  it.each(['active', 'passive'] as const)('limits %s text and provenance to the requested page', async mode => {
    const f = fixture([note('first'), note('second'), note('third')]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', cursor: 1, limit: 1 }, mode);
      expect(result.memoryPage).toMatchObject({ items: [{ memory: { id: 'second' } }], hasMore: true, nextCursor: 2 });
      expect(result.memoryContext?.text).toBe('FACT_second');
      expect(JSON.stringify(result.memoryContext)).not.toContain('FACT_first');
      expect(result.memoryContext?.evidence?.references?.map(reference => reference.id)).toEqual(['second']);
      expect(result.memoryContext?.evidence).toMatchObject({ candidateOrder: 'independent_native_query', contextOrder: 'original_context_pipeline' });
      expect(f.client.replace.mock.calls[0]?.[1]).toHaveLength(3); expect(f.client.replace.mock.calls[1]?.[1].map(note => note.id)).toEqual(['second']);
      expect(f.scopes.size).toBe(2);
    } finally { await f.service.close(); }
  });

  it('does not initialize a model when filters exclude the full authorized corpus', async () => {
    const f = fixture([note('other', { tags: ['train'] })]);
    try {
      const result = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['flower'] });
      expect(result.memoryPage?.items).toEqual([]); expect(f.get).not.toHaveBeenCalled();
    } finally { await f.service.close(); }
  });
  it('rebuilds a bounded filter lane when a new filter removes earlier notes and clears every lane on owner withdrawal', async () => {
    const f = fixture([note('flower'), note('train', { tags: ['train'] })]);
    try {
      await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['flower'] });
      const first = f.client.replace.mock.calls[0]![0];
      const train = await f.service.search({ companionId: 'owner', conversationId: 'private', query: 'facts', tags: ['train'] });
      expect(train.memoryContext?.text).toBe('FACT_train');
      expect(f.client.replace.mock.calls[1]?.[0].scopeId).not.toBe(first.scopeId);
      expect(f.client.purgeScope).toHaveBeenCalledWith({ scopeId: first.scopeId });
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
      expect(f.client.replace.mock.calls[0]![1].map(note => note.metadata)).toEqual(input.notes.map(() => ({ hostMemoryOwner: input.owner, hostMemoryVersion: 1 })));
      expect(result.sourceRevision).toBe('stable');
    } finally { await f.service.close(); }
  });
  it.each(['source', 'profile', 'clock'] as const)('rejects dream publication when the %s receipt changes during native work', async changed => {
    const f = fixture([note('dream')]), original = f.client.dreamWave.getMockImplementation()!;
    f.client.dreamWave.mockImplementation(async (scope, input) => {
      const result = await original(scope, input);
      if (changed === 'source') f.request.mockImplementation(async command => command.type === 'memory.snapshot'
        ? { ok: true, memorySnapshot: { scopeId: 'original', revision: 'changed', notes: [note('dream', { version: 2 })] } }
        : { ok: true, state: { companions: [{ id: 'owner', name: 'Owner' }] } } as never);
      if (changed === 'profile') f.get.mockResolvedValue({ client: f.client as unknown as VcpMemoryClient, profileKey: 'changed' });
      return changed === 'clock' ? { ...result, clockDomain: 'real' } : result;
    });
    try {
      await expect(f.service.dreamWave({ companionId: 'owner', conversationId: 'private', now: '2026-10-23T12:00:00Z', clockDomain: 'world' })).rejects.toThrow(/已经变化|凭证不匹配/u);
    } finally { await f.service.close(); }
  });
});
