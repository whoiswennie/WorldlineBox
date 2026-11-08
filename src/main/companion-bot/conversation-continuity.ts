import { z } from 'zod';
import type { BotStore } from './store';
import type { BotEvent, BotMessage } from './types';
import { BotAgentMemoryScopes, type AgentMemorySelection } from './agent-memory-scope';
import { botMessageEvidence } from '../../shared/bot-message-content';
import { botLocalTimestamp } from './context';

const id = z.string().min(1).max(160);
export const botConversationReadSchema = z.strictObject({
  operation: z.enum(['list', 'read', 'message']), conversationId: id.optional(), cursor: id.optional(),
  before: z.number().int().min(1).optional(), messageId: id.optional(), offset: z.number().int().min(0).max(1000000).optional(),
  limit: z.number().int().min(1).max(1200).optional(),
});
export type BotConversationRead = z.infer<typeof botConversationReadSchema>;
type PublishedRow = { id: string; projection_sequence: number; published_at: number };

/** A companion's actual published conversations, read on demand from SQLite.
 * This is independent of VCP projection/semantic-index completion. It does not
 * merge another participant's private Worker notices into a shared transcript. */
export class BotConversationContinuity {
  constructor(private readonly store: BotStore) {}
  private scopes() { return new BotAgentMemoryScopes(this.store); }
  activity(event: BotEvent) {
    const room = this.store.getConversation(event.conversationId);
    if (room?.kind !== 'direct' || !room.memberIds.includes('user')) return undefined;
    return { authority: 'published-chat-journal' as const, companionId: event.companionId, readTool: 'agent_conversations' as const,
      conversations: this.scopes().recentScopes(event, { limit: 6 }).filter(room => !room.current).slice(0, 5)
        .map(room => ({ ...room, createdAt: botLocalTimestamp(room.createdAt) })),
      meaning: '这是你本人参与的其他聊天的最新已发布消息索引；未处理事件或记忆尚未索引，不表示对方没有回复。需要内容时用read核实。' };
  }
  private published(event: BotEvent, selection: AgentMemorySelection, messageId: string): { message: BotMessage; publication: PublishedRow } {
    selection.assertCurrent();
    const publication = this.store.taskTransaction(sql => sql.prepare(`SELECT m.id,p.sequence AS projection_sequence,p.timestamp AS published_at
      FROM bot_history_projection p JOIN bot_messages m ON m.id=p.message_id
      WHERE m.id=? AND m.conversation_id=? AND m.status='sent' AND m.kind='message' AND m.sender_type IN ('user','companion')
      AND m.sender_id<>'task-service' AND NOT EXISTS(SELECT 1 FROM bot_inbox source WHERE source.source_record_id=m.id AND source.source='task')`)
      .get(messageId, selection.scope.conversationId)) as PublishedRow | undefined;
    const message = publication && this.store.getMessage(publication.id);
    if (!message || !publication || !selection.crossConversation && message.sequence > event.sourceMessageSequence
      || !this.store.isMessageVisibleToCompanion(message.id, selection.scope.companionId)
      || this.store.withdrawnIn(selection.scope.companionId, selection.scope.securityDomainId, [message.id]).size)
      throw new Error('该消息不属于本伙伴可回查的已发布聊天内容。');
    return { message, publication };
  }
  private retain(event: BotEvent, selection: AgentMemorySelection, ids: string[]) {
    this.scopes().retainSources(event, selection, { available: true,
      provenance: { revision: '0', sourceEventIds: [], sourceMessageIds: ids } });
  }
  read(event: BotEvent, input: BotConversationRead) {
    const scopes = this.scopes();
    if (input.operation === 'list') {
      const result = scopes.list(event, { cursor: input.cursor, limit: Math.min(input.limit ?? 15, 30) });
      return { ...result, recent: scopes.recentScopes(event, { limit: 6 }), source: 'published-chat-journal', readTool: 'agent_conversations' };
    }
    if (!input.conversationId) throw new Error('请先选择实际会话编号，再回查该会话。');
    const selected = scopes.resolve(event, input.conversationId);
    if (input.operation === 'message') {
      if (!input.messageId) throw new Error('完整消息回查需要消息编号。');
      const { message, publication } = this.published(event, selected, input.messageId), chars = Array.from(botMessageEvidence(message));
      const offset = input.offset ?? 0, end = Math.min(chars.length, offset + Math.min(input.limit ?? 1000, 1200));
      this.retain(event, selected, [message.id]); selected.assertCurrent();
      return { sourceConversation: selected.sourceConversation, source: 'published-chat-journal', senderId: message.senderId, senderName: message.senderName,
        messageId: message.id, publicationSequence: publication.projection_sequence, publishedAt: botLocalTimestamp(new Date(publication.published_at).toISOString()),
        offset, totalChars: chars.length, text: chars.slice(offset, end).join(''), nextOffset: end < chars.length ? end : undefined, complete: end >= chars.length };
    }
    const limit = Math.min(input.limit ?? 10, 20);
    const rows = this.store.taskTransaction(sql => sql.prepare(`SELECT m.id,p.sequence AS projection_sequence,p.timestamp AS published_at
      FROM bot_history_projection p JOIN bot_messages m ON m.id=p.message_id
      WHERE p.conversation_id=? AND p.sequence<? AND m.status='sent' AND m.kind='message' AND m.sender_type IN ('user','companion')
      AND (?=1 OR m.sequence<=?)
      AND m.sender_id<>'task-service' AND NOT EXISTS(SELECT 1 FROM bot_inbox source WHERE source.source_record_id=m.id AND source.source='task')
      ORDER BY p.sequence DESC LIMIT ?`).all(selected.scope.conversationId, input.before ?? Number.MAX_SAFE_INTEGER,
        selected.crossConversation ? 1 : 0, event.sourceMessageSequence, limit + 1)) as PublishedRow[];
    const page = rows.slice(0, limit), messages = page.flatMap(row => {
      // A revoked source stays out even while its public journal row is retained.
      if (this.store.withdrawnIn(selected.scope.companionId, selected.scope.securityDomainId, [row.id]).size) return [];
      const { message } = this.published(event, selected, row.id), chars = Array.from(botMessageEvidence(message)), shown = chars.slice(0, 800).join('');
      return [{ id: message.id, senderId: message.senderId, senderName: message.senderName, senderType: message.senderType,
        content: shown, contentIsPreview: chars.length > 800, totalChars: chars.length,
        publicationSequence: row.projection_sequence, publishedAt: botLocalTimestamp(new Date(row.published_at).toISOString()),
        ...(chars.length > 800 ? { readArgs: { operation: 'message', conversationId: selected.scope.conversationId, messageId: message.id, offset: 0 } } : {}) }];
    }).reverse();
    this.retain(event, selected, messages.map(message => message.id)); selected.assertCurrent();
    return { sourceConversation: selected.sourceConversation, source: 'published-chat-journal', companionId: event.companionId,
      messages, hasMore: rows.length > limit, ...(rows.length > limit ? { nextBefore: page.at(-1)!.projection_sequence } : {}),
      meaning: '仅包含已真实发布的用户和伙伴聊天；这是此时可见的消息页，不是任务执行或其他房间无消息的证明。' };
  }
}
