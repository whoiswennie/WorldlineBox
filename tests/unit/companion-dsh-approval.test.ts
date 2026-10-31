import { expect, it, vi } from 'vitest';
import { companionDshPendingApproval, companionDshReceipt } from '../../src/shared/companion-dsh-receipt';
import { companionProgressEvent } from '../../src/shared/companion-progress';
import type { CompanionAction } from '../../src/shared/companions';
import { controlCompanionDsh, CompanionDshWakeHub } from '../../src/main/companions/background-dsh';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const action: CompanionAction = { id: 'action', companionId: 'fish', conversationId: 'room', title: '查看视频',
  status: 'running', createdAt: '', updatedAt: '', events: [] };
const event = (sequence: number, type: 'approval_required' | 'approval_decided', requestId: string, outcome?: string) => companionProgressEvent({
  sequence, type, taskId: 'task', receivedAt: '', stage: 'message', summary: type === 'approval_required' ? '等待你在 DSH 中确认权限' : '本次权限已确认',
  text: JSON.stringify({ requestId, reason: '启动浏览器需要确认权限', outcome }),
})!;

it('preserves actual native approval identity and exposes waiting rather than continued execution', () => {
  const pending = { ...action, events: [event(2, 'approval_required', 'approval-a')] };
  expect(pending.events[0]?.type).toBe('approval_required');
  expect(companionDshReceipt(pending)).toMatchObject({ status: 'running', executionState: 'awaiting_approval',
    pendingApproval: { requestId: 'approval-a', reason: '启动浏览器需要确认权限' } });
});
it('clears only the corresponding decided request and ignores untrusted prose or malformed outcomes', () => {
  const pending = { ...action, events: [event(1, 'approval_required', 'approval-a'), event(2, 'approval_required', 'approval-b'),
    event(3, 'approval_decided', 'approval-b', 'allowed-once'), event(4, 'approval_decided', 'approval-a', 'arbitrary')] };
  expect(companionDshPendingApproval(pending)?.requestId).toBe('approval-a');
  pending.events.push(event(5, 'approval_decided', 'approval-a', 'rejected'));
  expect(companionDshPendingApproval(pending)).toBeUndefined();
  expect(companionDshReceipt(pending).executionState).toBe('running');
  expect(companionDshPendingApproval({ ...action, events: [{ sequence: 1, type: 'message', summary: '等待审批', receivedAt: '' }] })).toBeUndefined();
});
it('does not leave a completed or cancelled task awaiting permission', () => {
  for (const status of ['cancelled', 'succeeded', 'failed', 'interrupted'] as const)
    expect(companionDshPendingApproval({ ...action, status, events: [event(1, 'approval_required', 'approval-a')] })).toBeUndefined();
});
it('reports the approval blocker to the main brain without running, sending or approving an operation', async () => {
  const pending = { ...action, parentMessageId: 'reply', events: [event(1, 'approval_required', 'approval-a')] };
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'action.get') return { ok: true, action: pending };
    if (command.type === 'action.mail.read') return { ok: true, dshMailbox: { items: [], nextAfter: 0, hasMore: false } };
    throw new Error('Unexpected side effect: ' + command.type);
  });
  const send = vi.fn(), cancel = vi.fn();
  const result = await controlCompanionDsh({ checkpoint: { companionId: 'fish', conversationId: 'room', sourceMessageId: 'source',
    messageId: 'reply', status: 'running', turns: [], supplements: [] }, operation: { operation: 'status', actionIds: ['action'], after: 0 },
    effectId: 'status-call', signal: new AbortController().signal }, { request, hub: new CompanionDshWakeHub(), valid: async () => true, send, cancel });
  expect(result).toMatchObject({ tasks: [{ executionState: 'awaiting_approval' }], instruction: expect.stringContaining('并没有持续推进') });
  expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
