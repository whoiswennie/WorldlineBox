import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, withCompanionExecutionValidation, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import type { CompanionAction, CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

vi.mock('electron', () => ({ net: { fetch: vi.fn() }, dialog: { showOpenDialog: vi.fn() }, ipcMain: { handle: vi.fn() },
  protocol: { handle: vi.fn() }, shell: { showItemInFolder: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true } }));

it('withholds an unavailable live authority read without permanently withdrawing a healthy action', async () => {
  const scope = { companionId: 'alice', conversationId: 'room' };
  const card: CompanionMessage = { id: 'card', conversationId: scope.conversationId, authorId: scope.companionId,
    sequence: 1, kind: 'text', status: 'sent', createdAt: '2026-10-30T00:00:00Z', content: 'HEALTHY_ACTION_RESULT', attachments: [] };
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'action', ...scope,
    sourceMessageIds: [card.id], executionReadset: captureCompanionExecutionReadset(scope) };
  const subject = Object.assign(Object.create(CompanionService.prototype), {
    storage: { request: async () => { throw new Error('TEMPORARY_WORKER_TRANSPORT_UNAVAILABLE'); } },
  }) as { executionEvidenceValidUncached(value: CompanionExecutionSourceProof, readset: CompanionExecutionSourceProof['executionReadset'], sqlite: boolean, authorityOnly: boolean): Promise<boolean> };
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: [proof] };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'message.get') return { ok: true, message: card };
    throw new Error(`Unexpected storage command ${command.type}`);
  });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, valid: async () => true, revision: () => 0,
    actionAuthority: value => subject.executionEvidenceValidUncached(value, value.executionReadset, true, true),
  })).rejects.toThrow();
  expect(storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
});

it.each(['rejected', 'failed', 'missing', 'wrong-owner', 'duplicate'] as const)('withholds an uncertain capability batch (%s) without permanently withdrawing its source', async mode => {
  const scope = { companionId: 'alice', conversationId: 'room' };
  const card: CompanionMessage = { id: 'card', conversationId: scope.conversationId, authorId: scope.companionId,
    sequence: 1, kind: 'text', status: 'sent', createdAt: '2026-10-30T00:00:00Z', content: 'HEALTHY_CAPABILITY_RESULT', attachments: [] };
  const proof: CompanionExecutionSourceProof = { kind: 'action', id: 'capability', ...scope, sourceMessageIds: [card.id],
    capability: { name: 'agenda', callId: 'call', invocationId: 'run', agendaRunId: 'run', inputHash: 'a'.repeat(64) } };
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      expect(command.type).toBe('execution.capabilities.validate');
      if (mode === 'rejected') throw new Error('TEMPORARY_BATCH_TRANSPORT_UNAVAILABLE');
      if (mode === 'failed') return { ok: false, error: 'TEMPORARY_BATCH_STORAGE_UNAVAILABLE' };
      const row = { id: proof.id, companionId: scope.companionId, conversationId: scope.conversationId, valid: true };
      return { ok: true, capabilityAuthorityResults: mode === 'missing' ? [] : mode === 'duplicate' ? [row, row]
        : [{ ...row, companionId: 'different-owner' }] };
  });
  const subject = Object.assign(Object.create(CompanionService.prototype), { storage: { request }, call: request }) as {
    actionAuthorities(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>> };
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => command.type === 'execution.sources'
    ? { ok: true, executionSources: [proof] } : command.type === 'execution.invalidate' ? { ok: true } : { ok: true, message: card });
  await expect(guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
    storage, valid: async () => true, revision: () => 0, actionAuthorities: values => subject.actionAuthorities(values),
  })).rejects.toThrow();
  expect(request).toHaveBeenCalledOnce();
  expect(storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
});

it('uses one initial and one final real Main capability batch across repeated nested source guards', async () => {
  const scope = { companionId: 'alice', conversationId: 'room' }, identity = {};
  const proofs: CompanionExecutionSourceProof[] = Array.from({ length: 8 }, (_, n) => ({ kind: 'action', id: 'action_' + n, ...scope,
    sourceMessageIds: ['card'], capability: { name: 'agenda', callId: 'call_' + n, invocationId: 'run', agendaRunId: 'run', inputHash: 'a'.repeat(64) } }));
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type !== 'execution.capabilities.validate') throw new Error('Only an authority batch may reach this port.');
    return { ok: true, capabilityAuthorityResults: command.actions.map(action => ({ id: action.id,
      companionId: action.companionId, conversationId: action.conversationId, valid: true })) };
  });
  const subject = Object.assign(Object.create(CompanionService.prototype), { storage: identity, call: request }) as {
    actionAuthorities(proofs: readonly CompanionExecutionSourceProof[]): Promise<ReadonlyMap<string, boolean>> };
  const card: CompanionMessage = { id: 'card', conversationId: scope.conversationId, authorId: scope.companionId,
    sequence: 1, kind: 'text', status: 'sent', createdAt: '2026-10-30T00:00:00Z', content: 'CURRENT_BODY', attachments: [] };
  await withCompanionExecutionValidation(async () => {
    for (let i = 0; i < 30; i++) await guardCompanionExecutionSources({ type: 'message.get', id: card.id }, { ok: true, message: card }, {
      storage: async () => ({ ok: true, executionSources: proofs }), valid: async () => true, identity, revision: () => 0,
      actionAuthorities: values => subject.actionAuthorities(values),
    });
    expect(request).toHaveBeenCalledOnce();
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls.map(([command]) => command.type === 'execution.capabilities.validate' && command.actions.length)).toEqual([8, 8]);
});

it.each([false, true])('admits a visible capability action page in two batches and keeps the fresh final fence (withdraw=%s)', async withdraw => {
  const actions = Array.from({ length: 60 }, (_, index) => ({ id: 'action_' + index, companionId: 'alice', conversationId: 'room',
    title: 'Real capability result', status: 'succeeded', contentAvailable: true,
    capability: { name: 'agenda', callId: 'call_' + index, invocationId: 'run', agendaRunId: 'run', inputHash: 'a'.repeat(64) } })) as CompanionAction[];
  let batches = 0;
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type !== 'execution.capabilities.validate') throw new Error('Only an authority batch may reach this port.');
    batches++;
    return { ok: true, capabilityAuthorityResults: command.actions.map(action => ({ id: action.id,
      companionId: action.companionId, conversationId: action.conversationId, valid: !(withdraw && batches > 1) })) };
  });
  const subject = Object.assign(Object.create(CompanionService.prototype), { storage: {}, call: request }) as {
    projectActionsEvidence(values: readonly CompanionAction[]): Promise<CompanionAction[]> };
  const admission = withCompanionExecutionValidation(() => subject.projectActionsEvidence(actions));
  if (withdraw) await expect(admission).rejects.toThrow('授权已经变化');
  else expect(await admission).toEqual(actions);
  expect(request.mock.calls.map(([command]) => command.type === 'execution.capabilities.validate' && command.actions.length)).toEqual([60, 60]);
});
