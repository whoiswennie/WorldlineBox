import { expect, it } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionMessage } from '../../src/shared/companions';

it('keeps unfinished parallel replies out of ordinary and independent action feedback contexts', () => {
  const message: CompanionMessage = { id: 'user', conversationId: 'room', authorId: 'user', sequence: 1,
    content: '请检查文件', kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-14T10:00:00Z' };
  const drafts: CompanionMessage[] = [
    { ...message, id: 'whole-loop', authorId: 'role', sequence: 2, content: 'UNFINISHED_LOOP', isReplyDraft: true },
    { ...message, id: 'partial', authorId: 'role', sequence: 3, content: 'UNFINISHED_PARTIAL',
      replyDraft: { step: 0, attemptId: 'unfinished-attempt', text: 'UNFINISHED_PARTIAL' } },
  ];
  const input: CompanionReplyInput = {
    companion: { id: 'role', name: '伙伴', description: '', persona: '自然交流', model: '', avatar: 'custom', builtin: false,
      proactive: false, createdAt: message.createdAt },
    conversation: { id: 'room', kind: 'private', title: '伙伴', memberIds: ['role'], pinned: false, muted: false,
      unread: 0, updatedAt: message.createdAt, lastMessage: '' },
    messages: [message, ...drafts], memorySources: drafts, memories: [],
  };
  for (const actionResult of [undefined, { id: 'independent-action', title: '检查', status: 'succeeded' as const,
    sourceMessageId: message.id, content: '实际检查结果' }]) {
    const context = buildCompanionContext({ ...input, actionResult });
    const payload = JSON.parse(context.user);
    expect(payload.messages.map((item: { id: string }) => item.id)).toEqual(['user']);
    expect(payload.memorySources).toEqual([]);
    expect(context.user).not.toContain('UNFINISHED');
    if (actionResult) expect(payload.actionResult.content).toBe('实际检查结果');
  }
});
