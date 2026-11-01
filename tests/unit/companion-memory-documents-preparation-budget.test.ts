import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { memoCompanionExecutionWitnesses } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMemoryDocumentCommand } from '../../src/shared/companion-memory-documents';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, ipcMain: {}, protocol: {}, dialog: {}, shell: {}, safeStorage: {} }));

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handle: (command: CompanionMemoryDocumentCommand) => Promise<CompanionWorkspaceResponse>) {
  const release = vi.fn(), acquire = vi.fn(() => release), jobs = new Set<Promise<unknown>>();
  const host = Object.assign(Object.create(CompanionService.prototype), {
    closed: false, initialization: Promise.resolve(), memoryDocuments: { handle }, memoryDocumentJobs: jobs,
    storage: { acquireForegroundPreparation: acquire },
  }) as CompanionService;
  return { host, acquire, release, jobs };
}
const list = { type: 'memory.documents.list' as const, companionId: 'alice', directory: '', limit: 64 };

it('holds the document page budget from its actual open through the fresh finite final fence', async () => {
  const entered = deferred(), continueFinal = deferred(), identity = {};
  const f = fixture(async command => {
    expect(command).toEqual(list);
    expect(f.acquire).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    await memoCompanionExecutionWitnesses(['canonical-page'], { identity, scope: 'document-page', revision: () => 0,
      read: async () => new Map([['canonical-page', 'exact-bytes']]),
      verify: async () => { entered.resolve(); await continueFinal.promise; } });
    return { ok: true };
  });
  const pending = f.host.manageMemoryDocuments(list);
  try {
    await entered.promise;
    expect(f.jobs.size).toBe(1);
    expect(f.release).not.toHaveBeenCalled();
    continueFinal.resolve();
    expect((await pending).ok).toBe(true);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.jobs.size).toBe(0);
  } finally { continueFinal.resolve(); }
});

it('releases the document budget and tracked job after an open or final authority failure', async () => {
  for (const phase of ['open', 'final'] as const) {
    const identity = {};
    const f = fixture(command => {
      expect(command).toEqual(list);
      expect(f.acquire).toHaveBeenCalledOnce();
      if (phase === 'open') throw new Error('open unavailable');
      return memoCompanionExecutionWitnesses(['canonical-page'], { identity, scope: 'document-page', revision: () => 0,
        read: async () => new Map([['canonical-page', 'exact-bytes']]),
        verify: async () => { expect(f.release).not.toHaveBeenCalled(); throw new Error('authority withdrawn'); },
      }).then(() => ({ ok: true }));
    });
    await expect(f.host.manageMemoryDocuments(list)).rejects.toThrow(phase === 'open' ? 'open unavailable' : 'authority withdrawn');
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.jobs.size).toBe(0);
  }
});
