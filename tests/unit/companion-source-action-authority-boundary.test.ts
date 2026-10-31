import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const scope = { companionId: 'alice', conversationId: 'room' };
const card: CompanionMessage = { id: 'card', conversationId: scope.conversationId, authorId: scope.companionId,
  sequence: 1, kind: 'text', status: 'sent', createdAt: '2026-10-30T00:00:00Z', content: 'CURRENT_AUTHORIZED_BODY', attachments: [] };

it.each([true, false].flatMap(capability => [true, false].map(batch => ({ capability, batch }))))('rechecks live action authority after asynchronous closure even without an SQL content epoch (%j)', async ({ capability, batch }) => {
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'action', ...scope, sourceMessageIds: [card.id],
    ...(capability ? { capability: { name: 'agenda', callId: 'call', invocationId: 'run', agendaRunId: 'run', inputHash: 'a'.repeat(64) } }
      : { executionReadset: captureCompanionExecutionReadset(scope) }) };
  let authorized = true, generation = 0;
  const authority = vi.fn(async () => authorized);
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof] };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'message.get') return { ok: true, message: card };
    throw new Error(`Unexpected storage command ${command.type}`);
  });
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, revision: () => generation,
    ...(batch ? { actionAuthorities: async (proofs: readonly CompanionExecutionSourceProof[]) => new Map(await Promise.all(proofs.map(async proof => [proof.id, await authority()] as const))) }
      : { actionAuthority: authority }),
    valid: async () => { await Promise.resolve(); authorized = false; generation += 2; return true; },
  });
  expect(authority).toHaveBeenCalledTimes(2);
  expect(result.message?.content).toBe('');
  expect(result.message?.sourceUnavailable).toBe('execution_source_changed');
  expect(storage.mock.calls.filter(([command]) => command.type === 'execution.invalidate')).toHaveLength(1);
});

it.each([false, true])('does not revive an initially unauthorized action when later authority becomes available (batch=%s)', async batch => {
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'action', ...scope, sourceMessageIds: [card.id],
    executionReadset: captureCompanionExecutionReadset(scope) };
  const valid = vi.fn(async () => true);
  const authority = vi.fn(async () => false).mockResolvedValueOnce(false).mockResolvedValue(true);
  const storage = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'execution.sources'
    ? { ok: true, executionSources: [proof] } : command.type === 'execution.invalidate' ? { ok: true } : { ok: true, message: card };
  const result = await guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, valid, revision: () => 0,
    ...(batch ? { actionAuthorities: async (proofs: readonly CompanionExecutionSourceProof[]) => new Map(await Promise.all(proofs.map(async proof => [proof.id, await authority()] as const))) }
      : { actionAuthority: authority }),
  });
  expect(valid).not.toHaveBeenCalled();
  expect(result.message?.content).toBe('');
});

it.each(['initial', 'final'] as const)('never tombstones a healthy action when the %s batch is unavailable', async phase => {
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'action', ...scope, sourceMessageIds: [card.id], executionReadset: captureCompanionExecutionReadset(scope) };
  let batches = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof] };
    throw new Error('An unavailable authority batch must not permanently invalidate a source.');
  });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, valid: async () => true, revision: () => 0,
    actionAuthorities: async proofs => {
      if (++batches === (phase === 'initial' ? 1 : 2)) throw new Error('TEMPORARY_AUTHORITY_BATCH_UNAVAILABLE');
      return new Map(proofs.map(proof => [proof.id, true]));
    },
  })).rejects.toThrow('TEMPORARY_AUTHORITY_BATCH_UNAVAILABLE');
  expect(storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
});

it.each(['initial', 'final'] as const)('treats missing results in the %s batch as uncertainty rather than a verified withdrawal', async phase => {
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'action', ...scope, sourceMessageIds: [card.id], executionReadset: captureCompanionExecutionReadset(scope) };
  let batches = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'execution.sources'
    ? { ok: true, executionSources: [proof] } : command.type === 'execution.invalidate' ? { ok: true } : { ok: true, message: card });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, valid: async () => true, revision: () => 0,
    actionAuthorities: async proofs => ++batches === (phase === 'initial' ? 1 : 2) ? new Map() : new Map(proofs.map(proof => [proof.id, true])),
  })).rejects.toThrow();
  expect(storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
});
