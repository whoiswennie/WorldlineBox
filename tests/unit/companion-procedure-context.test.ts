import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { projectCompanionMemoryContextForModel } from '../../src/main/companions/memory-model-context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMemoryProcedureContext } from '../../src/shared/companion-procedure';

const scope = { companionId: 'alice', conversationId: 'private_alice' }, sourceText = 'actual objectively checked task outcome';
const checksum = createHash('sha256').update(sourceText).digest('hex');
const status: CompanionMemoryProcedureContext = { memoryId: 'method_one', contentRevision: 1, state: 'validated', successes: 1, failures: 0,
  evidence: [{ actionId: 'HOST_PRIVATE_ACTION', sourceMessageId: 'HOST_PRIVATE_OUTCOME', conversationId: scope.conversationId, checksum,
    contentRevision: 1, outcome: 'passed', recordedAt: '2026-10-26T12:00:00Z' }] };
const context = () => ({ text: '原生聚焦只返回方法正文。', revision: 'body_snapshot', profileKey: 'test_profile', proceduralStatus: [structuredClone(status)],
  evidence: { capturedAt: '2026-10-26T12:01:00Z', corpusHash: 'body_hash', snapshotPolicy: 'task_passive_v1', dependencyCoverage: 'complete',
    dependencies: [{ id: 'method_one', version: 1 }], frozenDependencies: [{ id: 'method_one', sources: [{ id: 'original_method_source', conversationId: scope.conversationId, checksum: 'a'.repeat(64) }] }] } });

it('shows typed host practice state while keeping outcome IDs and checksums outside the model projection', () => {
  const actual = context(), projected = projectCompanionMemoryContextForModel({ system: 'role', user: JSON.stringify({ memoryRecall: { context: actual } }) });
  const value = JSON.parse(projected.user).memoryRecall.context;
  expect(value.text).toBe(actual.text); expect(value.proceduralStatus).toEqual([{ memoryId: 'method_one', contentRevision: 1, state: 'validated', successes: 1, failures: 0 }]);
  expect(projected.user).not.toContain('HOST_PRIVATE_ACTION'); expect(projected.user).not.toContain('HOST_PRIVATE_OUTCOME'); expect(projected.user).not.toContain(checksum);
  expect(value.proceduralStatusMeaning).toContain('不代表全面熟练'); expect(actual.proceduralStatus[0]!.evidence).toHaveLength(1);
});

it('captures practice outcomes in addition to frozen method bodies and rejects their withdrawal independently', async () => {
  const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: context() } }) } });
  expect(readset.complete).toBe(true); expect(readset.frozenMemories).toHaveLength(1);
  expect(readset.sources).toEqual([{ id: 'HOST_PRIVATE_OUTCOME', conversationId: scope.conversationId, checksum }]);
  let withdrawn = false;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.frozen.valid'
    ? { ok: true, memoryFrozenValid: true } : command.type === 'memory.sources.filter' ? { ok: true, memorySources: withdrawn ? []
      : [{ id: 'HOST_PRIVATE_OUTCOME', conversationId: scope.conversationId, content: sourceText }] as CompanionStorageResponse['memorySources'] } : { ok: true });
  expect(await verifyCompanionExecutionReadset(readset, scope, { request })).toBe(true);
  withdrawn = true; expect(await verifyCompanionExecutionReadset(readset, scope, { request })).toBe(false);
});

it('rechecks exact trial receipts before accepting a frozen context and fails closed on revoked practice', async () => {
  let withdrawn = false, receiptValid = true;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'memory.frozen.valid') return { ok: true, memoryFrozenValid: true };
    if (command.type === 'memory.sources.filter') return { ok: true, memorySources: withdrawn ? []
      : [{ id: 'HOST_PRIVATE_OUTCOME', conversationId: scope.conversationId, content: sourceText }] as CompanionStorageResponse['memorySources'] };
    if (command.type === 'memory.revision.read') return { ok: true, memories: [{ id: 'method_one', procedure: { validation: { evidence: receiptValid ? status.evidence : [] } } }] as CompanionStorageResponse['memories'] };
    return { ok: true };
  });
  const memory = new CompanionMemoryService({ request, configFor: async () => ({ model: 'unit', apiFormat: 'openai_chat', apiKey: 'unit' }),
    fetchFn: fetch, changed: () => undefined, report: () => undefined, busy: () => false });
  try {
    expect(await memory.contextValid(scope, context())).toBe(true);
    withdrawn = true; expect(await memory.contextValid(scope, context())).toBe(false);
    withdrawn = false; receiptValid = false; expect(await memory.contextValid(scope, context())).toBe(false);
  } finally { await memory.close(); }
});

it('does not accept fabricated validated counters or arbitrary nested procedure-shaped JSON as dependencies', () => {
  const malformed = context(); malformed.proceduralStatus[0]!.evidence = [];
  const invalid = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: malformed } }) } });
  expect(invalid.complete).toBe(false);
  const untrusted = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ metadata: { memoryContext: context() } }) } });
  expect(untrusted.sources).toEqual([]);
});

it('retains a file-only durable guard even when frozen memory dependencies are already complete', async () => {
  const receipt = { companionId: scope.companionId, noteId: 'method_one', contentRevision: 1, path: '日记/method_one.md', contentHash: checksum };
  const native = { ...context(), fileReceipts: [receipt] };
  const captured = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: native } }) } });
  expect(captured.complete).toBe(true); expect(captured.contexts).toMatchObject([{ fileReceiptOnly: true, fileReceipts: [receipt] }]);
  const projected = projectCompanionMemoryContextForModel({ system: 'role', user: JSON.stringify({ memoryContext: native }) });
  expect(projected.user).not.toContain('method_one.md');
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'memory.frozen.valid' ? { ok: true, memoryFrozenValid: true }
    : { ok: true, memorySources: [{ id: 'HOST_PRIVATE_OUTCOME', conversationId: scope.conversationId, content: sourceText }] as CompanionStorageResponse['memorySources'] };
  const contextValid = vi.fn(async () => false);
  expect(await verifyCompanionExecutionReadset(captured, scope, { request, contextValid })).toBe(false);
  expect(contextValid).toHaveBeenCalledWith(scope, captured.contexts[0]);
});
