import { expect, it, vi } from 'vitest';
import { companionDshInboxContext, controlCompanionDsh, CompanionDshWakeHub } from '../../src/main/companions/background-dsh';
import { companionDshControlSchema } from '../../src/shared/companion-dsh-background';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

it('excludes live and finished capability cards from the DSH inbox and refuses mailbox controls even with a real native taskId', async () => {
  const checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: 'own_room', sourceMessageId: 'source', messageId: 'reply', status: 'running', turns: [], supplements: [] };
  const actual: CompanionAction = { id: 'actual_dsh', companionId: 'alice', conversationId: 'own_room', parentMessageId: 'reply', sourceMessageId: 'source',
    title: '原生DSH任务', status: 'running', taskId: 'actual_native_id', createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z' };
  const capability = { name: 'think', callId: 'think_call', invocationId: 'actual_invocation', inputHash: 'a'.repeat(64) };
  const live: CompanionAction = { ...actual, id: 'live_capability', capability }, finished: CompanionAction = { ...live, id: 'finished_capability', status: 'succeeded' };
  const actions = [live, actual, finished], commands: CompanionStorageCommand[] = [];
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command);
    if (command.type === 'action.get') return { ok: true, action: actions.find(action => action.id === command.id) };
    if (command.type === 'action.mail.read') return { ok: true, dshMailbox: { items: [], nextAfter: 0, hasMore: false } };
    throw Error('Unexpected mailbox mutation: ' + command.type);
  });
  const valid = vi.fn(async () => true), send = vi.fn(async () => undefined), cancel = vi.fn(async () => undefined);
  expect(await companionDshInboxContext(checkpoint, actions, request, valid)).toEqual([]);
  expect(valid).toHaveBeenCalledExactlyOnceWith(actual);
  expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ type: 'action.mail.read', actionIds: [actual.id] });
  valid.mockClear(); commands.splice(0);
  for (const operation of [
    { operation: 'status', actionIds: [live.id] }, { operation: 'wait', actionIds: [live.id], timeoutMs: 1000 },
    { operation: 'send', actionId: live.id, message: '不能把这个送进能力过程卡。' }, { operation: 'cancel', actionId: live.id },
  ]) {
    await expect(controlCompanionDsh({ checkpoint, operation: companionDshControlSchema.parse(operation), effectId: 'controlled_call', signal: new AbortController().signal },
      { request, hub: new CompanionDshWakeHub(), valid, send, cancel })).rejects.toThrow('能力过程卡');
  }
  expect(commands.every(command => command.type === 'action.get')).toBe(true); expect(valid).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
});
