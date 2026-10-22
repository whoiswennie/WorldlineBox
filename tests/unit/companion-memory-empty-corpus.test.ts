import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
it.each(['active', 'passive'] as const)('returns an actual empty authorized %s corpus without resolving, hashing or initializing the native model', async mode => {
  const get = vi.fn(async () => { throw new Error('An empty corpus must not load the bundled model.'); });
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => {
    expect(command.type).toBe('memory.snapshot');
    return { ok: true, memorySnapshot: { scopeId: 'actual-empty', revision: 'empty-current-ledger', notes: [] } };
  });
  const service = new CompanionMemoryService({ request, runtime: { get, close: async () => undefined },
    configFor: async () => { throw new Error('No model request needed.'); }, fetchFn: vi.fn(), changed: vi.fn(), report: vi.fn(), busy: () => false });
  try {
    const response = await service.search({ companionId: 'owner', conversationId: 'private-owner', query: '早上好' }, mode);
    expect(response).toMatchObject({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: { engine: 'none', resultCount: 0 } });
    expect(response.memoryRetrieval!.stages.slice(1).every(stage => stage.state === 'skipped')).toBe(true);
    expect(get).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
  } finally { await service.close(); }
});
