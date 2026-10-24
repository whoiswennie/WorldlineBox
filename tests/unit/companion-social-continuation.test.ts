import { expect, it, vi } from 'vitest';
import { assertCompanionSocialTaskRoute, companionSocialDeliveryReceipt, ensureCompanionSocialContinuation } from '../../src/main/companions/social-continuation';
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
it('keeps real independent work out of virtual social persistence and guides without creating or accepting a grant', async () => {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true }));
  const contact = { ...base.contact, requiresCollaboration: true };
  expect(await ensureCompanionSocialContinuation(request, { ...base, contact })).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  for (const operation of ['message', 'social', 'create_group'] as const) {
    expect(() => assertCompanionSocialTaskRoute(contact, operation)).toThrow('独立完成现实子任务');
  }
  expect(() => assertCompanionSocialTaskRoute(contact, 'introduce')).not.toThrow();
  expect(companionSocialDeliveryReceipt('introduce', contact)).toEqual({ socialOnly: true, operation: 'introduce',
    executionGrantCreated: false, collaborationCreated: false, continuationKind: 'none', nextAction: 'collaborate',
    guidance: expect.stringContaining('现实分工尚未登记') });
  for (const route of [{}, { requiresCollaboration: false }]) expect(() => assertCompanionSocialTaskRoute(route, 'message')).not.toThrow();
});
it('reports a saved virtual social goal by its real ID and state without claiming computer authorization', () => {
  expect(companionSocialDeliveryReceipt('message', {}, { id: 'persisted_social', status: 'queued' })).toEqual({
    socialOnly: true, operation: 'message', executionGrantCreated: false, collaborationCreated: false,
    continuationKind: 'virtual_social_activity', continuationId: 'persisted_social', continuationStatus: 'queued',
  });
});
