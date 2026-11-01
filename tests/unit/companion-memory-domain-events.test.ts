import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { COMPANIONS_CHANGED_CHANNEL, companionChangeEventSchema, type CompanionMemoryChangeEvent } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: {}, ipcMain: {}, protocol: {}, shell: {}, safeStorage: {} }));

it('accepts only explicit body-neutral memory events and preserves malformed/unknown full-refresh fallback', () => {
  for (const change of ['status', 'content']) {
    expect(companionChangeEventSchema.safeParse({ kind: 'memory', change, companionIds: [] }).success).toBe(true);
    expect(companionChangeEventSchema.safeParse({ kind: 'memory', change, companionIds: ['alice'] }).success).toBe(true);
  }
  for (const event of [undefined, { kind: 'unknown' }, { kind: 'memory' }, { kind: 'memory', change: 'withdrawal', companionIds: ['alice'] },
    { kind: 'memory', change: 'content', companionIds: ['bad/id'] }, { kind: 'memory', change: 'status', companionIds: [], authority: true }])
    expect(companionChangeEventSchema.safeParse(event).success).toBe(false);
});

it('keeps authority changed() hard while corpusChanged() emits only a scoped memory event with identical next-read bookkeeping', () => {
  const full = vi.fn(), soft = vi.fn<(event: CompanionMemoryChangeEvent) => void>(), wake = vi.fn(), schedule = vi.fn(), warmedViews = new Map([['alice', true]]);
  const memory = Object.assign(Object.create(CompanionMemoryService.prototype), {
    closed: false, warmedViews, options: { changed: full, memoryChanged: soft }, agendaWake: wake, schedule,
  }) as CompanionMemoryService;
  memory.corpusChanged('alice');
  expect(soft).toHaveBeenCalledExactlyOnceWith({ kind: 'memory', change: 'content', companionIds: ['alice'] }); expect(full).not.toHaveBeenCalled();
  expect(warmedViews.has('alice')).toBe(false); expect(wake).toHaveBeenCalledWith('alice'); expect(schedule).toHaveBeenCalledOnce();
  memory.changed('alice');
  expect(full).toHaveBeenCalledExactlyOnceWith(); expect(soft).toHaveBeenCalledOnce(); expect(schedule).toHaveBeenCalledTimes(2);
});

it('broadcasts memory-domain events only to memory-capable renderers while preserving full/progress world notifications', () => {
  const send = vi.fn(), world = vi.fn();
  const service = Object.assign(Object.create(CompanionService.prototype), {
    closed: false, options: { window: () => ({ isDestroyed: () => false, webContents: { send } }), onChanged: world },
  }) as unknown as { changed(kind?: 'progress' | CompanionMemoryChangeEvent): void };
  const event: CompanionMemoryChangeEvent = { kind: 'memory', change: 'status', companionIds: ['alice'] };
  service.changed(event); expect(send).toHaveBeenCalledExactlyOnceWith(COMPANIONS_CHANGED_CHANNEL, event); expect(world).not.toHaveBeenCalled();
  service.changed(); service.changed('progress');
  expect(world).toHaveBeenCalledTimes(2); expect(send.mock.calls.slice(1)).toEqual([
    [COMPANIONS_CHANGED_CHANNEL, undefined], [COMPANIONS_CHANGED_CHANNEL, { kind: 'progress' }],
  ]);
});

it.each(['none', 'queued', 'queued-only', 'source', 'invalid', 'mixed', 'reset'] as const)('routes a memory response through the full authority path whenever %s authority flags are present', async authority => {
  const corpus = vi.fn(), hard = vi.fn(), invalidate = vi.fn(async () => undefined), send = vi.fn();
  const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true,
    ...(authority !== 'queued-only' ? { memoryChangedCompanionIds: ['alice'] } : {}),
    ...(['queued', 'queued-only', 'mixed', 'reset'].includes(authority) ? { memorySourcePublicationQueuedCompanionIds: ['alice'] } : {}),
    ...(authority === 'source' || authority === 'mixed' ? { memorySourceChangedCompanionIds: ['alice'] } : {}),
    ...(authority === 'invalid' ? { memoryInvalidatedCompanionIds: ['alice'], memoryInvalidatedScopeIds: ['scope'] } : {}) }));
  const service = Object.assign(Object.create(CompanionService.prototype), {
    closed: false, storage: { request }, options: { window: () => ({ isDestroyed: () => false, webContents: { send } }), report: vi.fn() },
    resettingCompanions: new Set<string>(authority === 'reset' ? ['alice'] : []), sourceValidationRevision: 0, evidenceRevision: 0, wakeMemoryFiles: vi.fn(),
    memory: { changed: hard, corpusChanged: corpus, invalidate }, memoryManagement: { invalidate: vi.fn(async () => undefined) },
  }) as unknown as { call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> };
  expect((await service.call({ type: 'state', includeConversations: false })).ok).toBe(true);
  if (authority === 'none' || authority === 'queued' || authority === 'queued-only') {
    if (authority === 'queued-only') expect(corpus).not.toHaveBeenCalled(); else expect(corpus).toHaveBeenCalledExactlyOnceWith('alice');
    expect(hard).not.toHaveBeenCalled();
    if (authority === 'none') expect(send).not.toHaveBeenCalled();
    else expect(send).toHaveBeenCalledExactlyOnceWith(COMPANIONS_CHANGED_CHANNEL, { kind: 'memory', change: 'content', companionIds: ['alice'] });
  }
  else {
    expect(hard).toHaveBeenCalledExactlyOnceWith('alice'); expect(corpus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(COMPANIONS_CHANGED_CHANNEL, undefined);
  }
  if (authority === 'invalid') expect(invalidate).toHaveBeenCalledWith('alice', ['scope'], { preserveIndexes: false });
});
