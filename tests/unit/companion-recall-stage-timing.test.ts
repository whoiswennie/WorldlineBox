import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryQueryScheduler } from '../../src/main/companions/memory-query-scheduler';
import type { CompanionMemorySearch } from '../../src/shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSchema, conversationSchema, messageSchema } from '../../src/shared/companions';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

function fixture() {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const queries = new CompanionMemoryQueryScheduler({ now: () => now }), sourcesEntered = deferred(), sourcesReleased = deferred();
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type === 'memory.snapshot') {
      sourcesEntered.resolve(); await sourcesReleased.promise;
      return { ok: true, memorySnapshot: { scopeId: 'empty_scope', revision: 'timing_only_empty_view', notes: [] } };
    }
    if (command.type === 'world.clock') return { ok: true, worldClock: { virtualNow: '2026-10-31T00:00:00.000Z', timeZone: 'UTC', mode: 'realtime' } };
    throw new Error('The empty-view timing test must not run a model or other preparation.');
  });
  const onTiming = vi.fn();
  const host = Object.assign(Object.create(CompanionMemoryService.prototype), {
    queries, generations: new Map(), closed: false, options: { request, onTiming },
  }) as { searchView(query: CompanionMemorySearch, mode: 'passive', generation: number, history: [], signal?: AbortSignal,
    onProgress?: undefined, queuedMs?: number): Promise<CompanionStorageResponse> };
  const query: CompanionMemorySearch = { companionId: 'fish', conversationId: 'room', query: 'timing fixture', limit: 12 };
  return { host, query, queries, request, onTiming, sourcesEntered, sourcesReleased, advance: (ms: number) => { now += ms; } };
}

it('counts graph waiting once while retaining nonzero source work in the actual searchView path', async () => {
  const f = fixture(), blockerEntered = deferred(), blockerReleased = deferred();
  const blocker = f.queries.run('fish:owner-v2', async () => { blockerEntered.resolve(); await blockerReleased.promise; }, { priority: 'background' });
  await blockerEntered.promise;
  const result = f.host.searchView(f.query, 'passive', 0, [], undefined, undefined, 40);
  expect(f.queries.snapshot('fish:owner-v2')).toMatchObject({ foreground: 1, running: 'background' });
  f.advance(2000); blockerReleased.resolve(); await f.sourcesEntered.promise;
  f.advance(300); f.sourcesReleased.resolve();
  const response = await result;
  expect(response.memorySearchTimings?.queue).toBe(2040);
  expect(response.memorySearchTimings?.sources).toBe(300);
  expect(Object.values(response.memorySearchTimings!).reduce((sum, value) => sum + value, 0)).toBe(2340);
  expect(f.onTiming.mock.calls.some(([value]) => value.operation === 'memory.search.sources' && value.durationMs >= 2000)).toBe(false);
  await blocker; await f.queries.drainAll();
});

it('keeps queued cancellation immediate and does not report its wait as source work', async () => {
  const f = fixture(), blockerEntered = deferred(), blockerReleased = deferred(), controller = new AbortController();
  const blocker = f.queries.run('fish:owner-v2', async () => { blockerEntered.resolve(); await blockerReleased.promise; }, { priority: 'background' });
  await blockerEntered.promise;
  const result = f.host.searchView(f.query, 'passive', 0, [], controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  f.advance(2000); controller.abort(); await rejected;
  expect(f.request).not.toHaveBeenCalled();
  expect(f.queries.snapshot('fish:owner-v2')).toMatchObject({ foreground: 0, running: 'background' });
  expect(f.onTiming.mock.calls.some(([value]) => value.operation === 'memory.search.sources')).toBe(false);
  blockerReleased.resolve(); await blocker; await f.queries.drainAll();
});

it.each(['prepared', 'filtered', 'cancelled', 'failed'] as const)('records one complete recall wall on %s without allowing an observer to alter it', async outcome => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const controller = new AbortController(), failure = new Error('Source authority unavailable.');
  const createdAt = '2026-10-31T00:00:00.000Z';
  const source = messageSchema.parse({ id: 'source-wall-fixture', sequence: 2, content: 'fixture', kind: 'text', authorId: 'user',
    conversationId: 'room', createdAt, status: 'sent', attachments: [] });
  const onTiming = vi.fn(() => { throw new Error('The diagnostic observer failed.'); });
  const request = vi.fn(async (command: CompanionStorageCommand) => {
    if (command.type === 'memory.sources.filter') {
      now += 70;
      if (outcome === 'failed') throw failure;
      if (outcome === 'cancelled') controller.abort();
      return { ok: true, memorySources: outcome === 'filtered' ? [] : [source] };
    }
    if (command.type === 'memory.status') { now += 30; return { ok: true }; }
    throw new Error('The timing test must not perform another read.');
  });
  const searchScoped = vi.fn(async () => { now += 200; return { ok: true, memoryFilesPending: true }; });
  const host = Object.assign(Object.create(CompanionMemoryService.prototype), {
    options: { request, onTiming }, searchScoped, schedule: vi.fn(),
  }) as CompanionMemoryService;
  const input: Parameters<CompanionMemoryService['recall']>[0] = {
    companion: companionSchema.parse({ id: 'fish', name: 'Timing fixture', description: '', persona: 'Fixture persona.',
      model: '', avatar: 'sister', builtin: false, proactive: false, createdAt }),
    conversation: conversationSchema.parse({ id: 'room', kind: 'private', title: 'Timing fixture', memberIds: ['fish'],
      pinned: false, muted: false, unread: 0, updatedAt: createdAt, lastMessage: '' }),
    messages: [], currentMessage: source,
    config: { apiFormat: 'openai_chat', model: 'timing-fixture', apiKey: '' }, signal: controller.signal,
  };
  const result = host.recall(input);
  if (outcome === 'cancelled') await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  else if (outcome === 'failed') await expect(result).rejects.toBe(failure);
  else await expect(result).resolves.toMatchObject({ memories: [], pending: outcome === 'prepared', degraded: false });
  expect(searchScoped).toHaveBeenCalledTimes(outcome === 'prepared' ? 1 : 0);
  expect(onTiming).toHaveBeenCalledExactlyOnceWith({ operation: 'memory.recall.total', durationMs: outcome === 'prepared' ? 300 : 70,
    sourceMessageHash: createHash('sha256').update(source.id).digest('hex') });
});
