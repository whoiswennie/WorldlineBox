import { expect, it, vi } from 'vitest';
import { CompanionService } from '../../src/main/companions/service';
import { memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import { CompanionValidationUnavailableError } from '../../src/main/companions/validation-unavailable';
import type { CompanionChangeEvent, CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const message: CompanionMessage = { id: 'delta-leaf', conversationId: 'delta-room', topicId: 'delta-topic', authorId: 'user',
  sequence: 3, revision: 1, kind: 'text', status: 'sent', content: '已保存的普通消息', createdAt: '2026-11-01T00:00:00Z',
  attachments: [{ id: 'delta-file', name: 'example.txt', mime: 'text/plain', size: 4 }] };
function harness() {
  const trace: string[] = [], changes: Array<CompanionChangeEvent | undefined> = [], identity = {};
  let current = structuredClone(message), afterRead: (() => void) | undefined, responseOk = true;
  const call = vi.fn((command: CompanionStorageCommand): Promise<CompanionStorageResponse> => withCompanionExecutionValidation(async () => {
    if (command.type !== 'messages') throw new Error('Only the exact ordinary message read is permitted.');
    trace.push('read');
    const snapshot = structuredClone(current);
    await memoCompanionExecutionWitnesses(['exact-user-leaf'], { identity, scope: 'transcript-test-current-leaf', phase: 'sql-authority', revision: () => 0,
      read: async () => new Map([['exact-user-leaf', snapshot]]), verify: async () => {
        trace.push('final');
        if (JSON.stringify(current) !== JSON.stringify(snapshot)) throw new CompanionValidationUnavailableError('来源在最终围栏前改变。');
      } });
    afterRead?.();
    return { ok: responseOk, messages: [snapshot] };
  }));
  const service = Object.create(CompanionService.prototype) as CompanionService;
  const hostChanged = vi.fn();
  Object.assign(service, { closed: false, transcriptAuthorityRevision: 0, call, options: { onChanged: hostChanged,
    window: () => ({ isDestroyed: () => false, webContents: { send: (_channel: string, change?: CompanionChangeEvent) => { trace.push('emit'); changes.push(change); } } }) } });
  const publish = (value: CompanionMessage | undefined = message, revision = 0) => (Reflect.get(service, 'publishTranscriptAppend') as
    (message: CompanionMessage | undefined, revision: number) => Promise<void>).call(service, value, revision);
  return { service, call, changes, trace, publish, hostChanged, set: (value: CompanionMessage) => { current = value; },
    afterRead: (run: () => void) => { afterRead = run; }, deny: () => { responseOk = false; } };
}

it('emits a committed delta only after its independent exact-row user-reader gate has finalized', async () => {
  const f = harness(), outerIdentity = {};
  await withCompanionExecutionValidation(async () => {
    await memoCompanionExecutionWitnesses(['parent'], { identity: outerIdentity, scope: 'transcript-parent', revision: () => 0,
      read: async () => new Map([['parent', true]]), verify: async () => { f.trace.push('parent-final'); } });
    await f.publish(); expect(f.trace).toEqual(['read', 'final', 'emit']);
  });
  expect(f.trace).toEqual(['read', 'final', 'emit', 'parent-final']);
  expect(f.call).toHaveBeenCalledExactlyOnceWith({ type: 'messages', conversationId: message.conversationId, topicId: message.topicId,
    around: message.id, limit: 1 });
  expect(f.changes).toEqual([{ kind: 'transcript', change: 'append', message }]);
});

it('falls back to full for a late body/attachment withdrawal even when no Main changed counter has advanced', async () => {
  const f = harness(); f.afterRead(() => f.set({ ...message, attachments: [], content: '已改写' }));
  await expect(f.publish()).resolves.toBeUndefined();
  expect(f.trace).toEqual(['read', 'final', 'emit']); expect(f.changes).toEqual([undefined]);
});

it('preserves full invalidation for concurrent hard changes, denied reads and coded unknown availability', async () => {
  const hard = harness(); hard.afterRead(() => Reflect.set(hard.service, 'transcriptAuthorityRevision', 1));
  await hard.publish(); expect(hard.changes).toEqual([undefined]);
  const denied = harness(); denied.deny(); await denied.publish(); expect(denied.changes).toEqual([undefined]);
  const unknown = harness(); unknown.call.mockRejectedValue(new CompanionValidationUnavailableError('已派发但尚未确认，不能重放。'));
  await expect(unknown.publish()).resolves.toBeUndefined(); expect(unknown.changes).toEqual([undefined]); expect(unknown.call).toHaveBeenCalledTimes(1);
});

it.each(['revision', 'topic', 'attachment', 'body'] as const)('does not publish an append whose current %s tuple differs', async field => {
  const f = harness();
  f.set(field === 'revision' ? { ...message, revision: 2 } : field === 'topic' ? { ...message, topicId: 'different-topic' }
    : field === 'attachment' ? { ...message, attachments: [] } : { ...message, content: '正文已改变' });
  await f.publish(); expect(f.changes).toEqual([undefined]);
});

it('does not attempt a delta read for an unsupported action or an absent acknowledgement', async () => {
  const f = harness(); await f.publish({ ...message, actionId: 'action-card' });
  await (Reflect.get(f.service, 'publishTranscriptAppend') as (value: CompanionMessage | undefined, revision: number) => Promise<void>)
    .call(f.service, undefined, 0);
  expect(f.call).not.toHaveBeenCalled(); expect(f.changes).toEqual([undefined, undefined]);
});
