import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { restoredCompanionTaskRecall } from '../../src/main/companions/task-passive-recall';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemory } from '../../src/shared/companions';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const scope = { companionId: 'owner', conversationId: 'private', beforeSequence: 40 };
const complete = { text: '先前由真实获权来源聚焦的本任务回忆。', revision: 'old-corpus', profileKey: 'old-model-profile',
  evidence: { capturedAt: '2026-10-26T00:00:00Z', corpusHash: 'old', queryClock: { now: '2026-10-26T00:00:00Z', timeZone: 'Asia/Shanghai', domain: 'world' as const },
    dependencyCoverage: 'complete' as const, dependencies: [{ id: 'memory_a', version: 2 }] } };
const frozen = { ...complete, evidence: { ...complete.evidence, snapshotPolicy: 'task_passive_v1' as const,
  frozenDependencies: [{ id: 'memory_a', sources: [{ id: 'original_source', conversationId: 'private', checksum: 'a'.repeat(64) }] }] } };
function fixture() {
  let notes = [{ id: 'memory_a', companionId: 'owner', version: 2 }] as CompanionMemory[];
  let frozenValid = true;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.records.filter') return { ok: true, memories: notes };
    if (command.type === 'memory.frozen.valid') return { ok: true, memoryFrozenValid: frozenValid };
    if (command.type === 'world.clock') return { ok: true, worldClock: { realNow: '2026-10-28T00:00:00Z', virtualNow: '2026-10-28T00:00:00Z', timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } };
    if (command.type === 'memory.snapshot') return { ok: true, memorySnapshot: { scopeId: 'actual', revision: 'new-unrelated-corpus', notes } };
    throw Error('Unexpected test command: ' + command.type);
  });
  const get = vi.fn(async () => { throw Error('Saved task validation must not open or prepare an embedding runtime'); });
  const service = new CompanionMemoryService({ request, runtime: { get, describeEmbedding: async () => ({ profileKey: 'current-profile' }), close: async () => undefined },
    configFor: async () => { throw Error('Saved context validation must not call a model'); },
    fetchFn: async () => { throw Error('Saved context validation must not call a provider'); }, busy: () => true, report: () => undefined, changed: () => undefined });
  return { service, request, get, notes: (next: CompanionMemory[]) => { notes = next; }, frozenValid: (next: boolean) => { frozenValid = next; } };
}

it('keeps frozen passive facts after ordinary revision while explicit tools retain exact note versions', async () => {
  const f = fixture();
  try {
    f.notes([{ id: 'memory_a', companionId: 'owner', version: 3 }] as CompanionMemory[]);
    expect(await f.service.contextValid(scope, frozen)).toBe(true);
    expect(await f.service.contextValid(scope, complete)).toBe(false);
    const proof = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: frozen } }) } });
    expect(proof).toMatchObject({ complete: true, memories: [], frozenMemories: frozen.evidence.frozenDependencies, contexts: [] });
    expect(await verifyCompanionExecutionReadset(proof, scope, { request: f.request })).toBe(true);
    const active = captureCompanionExecutionReadset(scope, { turns: [{ text: '', rawText: '', calls: [{ id: 'explicit_read', name: 'memory', arguments: '{"action":"search"}' }],
      results: [{ callId: 'explicit_read', content: JSON.stringify({ ok: true, memoryContext: frozen }) }] }] });
    expect(active.frozenMemories).toBeUndefined(); expect(active.memories).toEqual([{ id: 'memory_a', version: 2 }]);
    expect(await verifyCompanionExecutionReadset(active, scope, { request: f.request })).toBe(false);
    f.frozenValid(false);
    expect(await f.service.contextValid(scope, frozen)).toBe(false);
    expect(await verifyCompanionExecutionReadset(proof, scope, { request: f.request })).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('rejects a frozen marker with missing or truncated original dependency closure', async () => {
  const f = fixture();
  try {
    for (const frozenDependencies of [undefined, [], [{ id: 'memory_a', sources: [] }]]) {
      expect(await f.service.contextValid(scope, { ...frozen, evidence: { ...frozen.evidence, frozenDependencies } })).toBe(false);
      expect(captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: { ...frozen,
        evidence: { ...frozen.evidence, frozenDependencies } } } }) } }).complete).toBe(false);
    }
    expect(f.request).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('reuses a complete task receipt across unrelated corpus, model and day changes, while future opportunities remain time aware', async () => {
  const f = fixture();
  try {
    expect(await f.service.contextValid(scope, complete)).toBe(true);
    expect(await f.service.contextFresh(scope, complete)).toBe(false);
    expect(f.request).toHaveBeenCalledWith({ type: 'memory.records.filter', ...scope, ids: ['memory_a'] });
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.snapshot')).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('keeps the frozen passive task snapshot across a new day without consulting a clock or corpus', async () => {
  const f = fixture();
  try {
    expect(await f.service.contextFresh(scope, frozen)).toBe(true);
    expect(f.request.mock.calls.map(([command]) => command.type)).toEqual(['memory.frozen.valid']);
    expect(f.get).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it.each(['version', 'owner', 'withdrawn'] as const)('rejects %s changes to actual captured dependencies without semantic recall', async kind => {
  const f = fixture();
  try {
    f.notes(kind === 'withdrawn' ? [] : [{ id: 'memory_a', companionId: kind === 'owner' ? 'other' : 'owner', version: kind === 'version' ? 3 : 2 }] as CompanionMemory[]);
    expect(await f.service.contextValid(scope, complete)).toBe(false); expect(f.get).not.toHaveBeenCalled();
  } finally { await f.service.close(); }
});

it('never promotes malformed or incomplete legacy evidence to a complete dependency closure', async () => {
  const f = fixture();
  try {
    expect(await f.service.contextValid(scope, { ...complete, evidence: { dependencyCoverage: 'complete' } })).toBe(false);
    expect(await f.service.contextValid(scope, { ...complete, evidence: { referenceCoverage: 'partial', references: [] } })).toBe(false);
    expect(f.request.mock.calls.some(([command]) => command.type === 'memory.snapshot')).toBe(true);
  } finally { await f.service.close(); }
});

it('restores the existing task receipt after durable serialization and keeps withdrawn/legacy tasks from starting another passive round', () => {
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'owner', conversationId: 'private', sourceMessageId: 'source', status: 'running', supplements: [], turns: [] };
  expect(restoredCompanionTaskRecall(checkpoint)).toBeUndefined();
  checkpoint.context = { system: '系统提示词', user: JSON.stringify({ memoryRecall: { context: complete, reasons: [], pending: false, degraded: false } }) };
  const restored = restoredCompanionTaskRecall(JSON.parse(JSON.stringify(checkpoint)));
  expect(restored?.context).toEqual(complete);
  checkpoint.context.user = JSON.stringify({ memoryRecall: { invalidatedDuringTask: true, reasons: [] } });
  expect(restoredCompanionTaskRecall(checkpoint)).toMatchObject({ memories: [], sources: [], reasons: [], pending: false });
  checkpoint.context.user = JSON.stringify({ taskRequest: { prompt: '旧版保存的真实任务' } });
  expect(restoredCompanionTaskRecall(checkpoint)).toBeDefined();
});
