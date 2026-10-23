import { expect, it, vi } from 'vitest';
import { ensureCompanionSocialContinuation } from '../../src/main/companions/social-continuation';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const source: CompanionMessage = { id: 'original_human_goal', sequence: 1, conversationId: 'private_alice', authorId: 'user', kind: 'text',
  content: '认识几位伙伴一起组织活动，确认后继续玩。', status: 'sent', attachments: [], createdAt: '2026-10-23T00:00:00Z' };
const base = { contact: { allowed: true, intent: 'message' as const, requiresContinuation: true }, companionId: 'alice', source,
  deliveryClientId: 'actual_initial_outbox', operation: 'introduce' as const };
it('uses only the original real source and actual outbox identifier, never a fabricated goal or model history', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true, activityTask: { id: 'durable_goal' } as never }));
  expect(await ensureCompanionSocialContinuation(request, base)).toMatchObject({ id: 'durable_goal' });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'activity.social.ensure', companionId: 'alice', conversationId: source.conversationId,
    sourceMessageId: source.id, deliveryClientId: base.deliveryClientId, operation: 'introduce' });
});
it('keeps one-off notifications and visits on their own existing paths and refuses a peer as human authority', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true }));
  for (const contact of [{ ...base.contact, allowed: false }, { ...base.contact, requiresContinuation: false }, { ...base.contact, intent: 'visit' as const }]) {
    expect(await ensureCompanionSocialContinuation(request, { ...base, contact })).toBeUndefined();
  }
  expect(request).not.toHaveBeenCalled();
  await expect(ensureCompanionSocialContinuation(request, { ...base, source: { ...source, authorId: 'bob' } })).rejects.toThrow('真实用户');
  expect(request).not.toHaveBeenCalled();
});
it('does not report persistence when storage could not save a real continuation', async () => {
  await expect(ensureCompanionSocialContinuation(async () => ({ ok: true }), base)).rejects.toThrow('不能承诺自动跟进');
});
