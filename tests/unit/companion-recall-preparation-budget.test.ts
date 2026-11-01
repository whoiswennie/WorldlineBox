import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, ipcMain: {}, protocol: {}, dialog: {}, shell: {}, safeStorage: {} }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(search: () => Promise<CompanionStorageResponse>) {
  const release = vi.fn(), acquire = vi.fn(() => release);
  const call = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.library.scope.read') return { ok: true, conversation: { id: 'room', kind: 'private', title: '', memberIds: ['alice'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: new Date().toISOString() } };
    if (command.type === 'memory.lifecycle.state') return { ok: true, memoryLifecycleState: { companionId: 'alice', revocationEpoch: 0, ledgerSequence: 0 } };
    if (command.type === 'memory.recall.authority') return { ok: true, memoryRecallAuthorityStamp: 'authority' };
    if (command.type === 'memory.corpus.stamp') return { ok: true, memoryCorpusStamp: 'corpus' };
    if (command.type === 'memory.status') return { ok: true };
    throw new Error('unexpected command');
  };
  const host = Object.assign(Object.create(CompanionService.prototype), { closed: false, initialization: Promise.resolve(), call,
    storage: { acquireForegroundPreparation: acquire }, memory: { search }, options: { window: () => undefined, report: vi.fn() } }) as CompanionService;
  return { host, acquire, release };
}

it.each(['active', 'passive'] as const)('keeps the manual %s recall budget until its real finite final fence completes', async mode => {
  const entered = deferred(), continueFinal = deferred(), identity = {};
  const f = fixture(async () => {
    await memoCompanionExecutionWitnesses(['body'], { identity, scope: 'actual-body', revision: () => 0, read: async () => new Map([['body', 'exact']]),
      verify: async () => { entered.resolve(); await continueFinal.promise; } });
    return { ok: true };
  });
  const pending = f.host.handle({ type: 'memory.recall.test', companionId: 'alice', mode, query: '本轮真实话题', limit: 8 });
  try {
    await entered.promise; expect(f.acquire).toHaveBeenCalledOnce(); expect(f.release).not.toHaveBeenCalled();
    continueFinal.resolve(); expect((await pending).ok).toBe(true); expect(f.release).toHaveBeenCalledOnce();
  } finally { continueFinal.resolve(); }
});

it.each(['search', 'final', 'cancel'] as const)('releases the manual recall preparation budget after %s failure', async failure => {
  const controller = new AbortController(), identity = {};
  const f = fixture(async () => {
    if (failure === 'search') throw new Error('search failed');
    await memoCompanionExecutionWitnesses(['body'], { identity, scope: 'actual-body', revision: () => 0, read: async () => new Map([['body', 'exact']]),
      verify: async () => { if (failure === 'cancel') controller.abort(new Error('user cancelled')); throw new Error('final failed'); } });
    return { ok: true };
  });
  await expect(withCompanionExecutionValidation(() => f.host.handle({ type: 'memory.recall.test', companionId: 'alice', mode: 'active', query: '本轮真实话题', limit: 8 }), controller.signal)).rejects.toThrow();
  expect(f.acquire).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});
