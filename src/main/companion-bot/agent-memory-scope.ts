import { z } from 'zod';
import type { BotStore } from './store';
import type { BotEvent, BotConversation } from './types';
import type { BotMemoryScope } from './memory-service';

export interface AgentMemorySelection {
  scope: BotMemoryScope;
  crossConversation: boolean;
  sourceConversation: { id: string; title: string; kind: BotConversation['kind'] };
  assertCurrent(): void;
}
const scopeId = z.string().min(1).max(160);
/** The model can choose a known conversation ID, never a memory home, owner,
 * path or another companion. Only the user's direct view can expand scope. */
export class BotAgentMemoryScopes {
  constructor(private readonly store: BotStore) {}
  private origin(event: BotEvent): BotConversation {
    const current = this.store.getEvent(event.id), room = this.store.getConversation(event.conversationId);
    if (!current || !room || room.dissolvedAt || current.companionId !== event.companionId || current.conversationId !== event.conversationId
      || current.aclRevision !== event.aclRevision || room.revision !== event.aclRevision || !room.memberIds.includes(event.companionId)
      || room.securityDomainId !== event.securityDomainId || room.audienceScopeId !== event.audienceScopeId
      || current.securityDomainId !== event.securityDomainId || current.audienceScopeId !== event.audienceScopeId
      || this.store.withdrawnIn(event.companionId, event.securityDomainId, this.store.eventSourceIds(event.id)).size)
      throw new Error('记忆读取的当前主脑身份或受众授权已经失效。');
    return room;
  }
  private canExpand(room: BotConversation): boolean { return room.kind === 'direct' && room.memberIds.includes('user'); }
  resolve(event: BotEvent, requested?: string): AgentMemorySelection {
    const origin = this.origin(event), id = requested === undefined ? origin.id : scopeId.parse(requested);
    const crossConversation = id !== origin.id, target = this.store.getConversation(id);
    if (!target || target.dissolvedAt || !target.memberIds.includes(event.companionId)
      || crossConversation && (!this.canExpand(origin) || !['direct', 'group'].includes(target.kind) || !target.memberIds.includes('user')))
      throw new Error('该记忆会话不属于当前伙伴获准的用户视图；群聊、伙伴私聊和世界频道不能跨域读取。');
    const revision = target.revision, securityDomainId = target.securityDomainId, audienceScopeId = target.audienceScopeId;
    return { scope: { companionId: event.companionId, conversationId: target.id, securityDomainId }, crossConversation,
      sourceConversation: { id: target.id, title: target.title, kind: target.kind },
      assertCurrent: () => {
        this.origin(event); const current = this.store.getConversation(id);
        if (!current || current.dissolvedAt || current.revision !== revision || current.securityDomainId !== securityDomainId || current.audienceScopeId !== audienceScopeId
          || !current.memberIds.includes(event.companionId) || crossConversation && (!current.memberIds.includes('user') || !['direct', 'group'].includes(current.kind)))
          throw new Error('记忆来源会话的成员或受众授权在读取期间发生变化，本次结果不再可用。');
      } };
  }
  list(event: BotEvent, input: { cursor?: string; limit?: number } = {}) {
    const origin = this.origin(event), limit = z.number().int().min(1).max(30).parse(input.limit ?? 15);
    const cursor = input.cursor === undefined ? '' : scopeId.parse(input.cursor);
    if (!this.canExpand(origin)) {
      return { scopes: cursor ? [] : [{ conversationId: origin.id, title: origin.title, kind: origin.kind, current: true }], hasMore: false, access: 'current-conversation' };
    }
    const rows = this.store.taskTransaction(sql => sql.prepare(`SELECT c.id,c.title,c.kind FROM bot_conversations c
      JOIN bot_members self ON self.conversation_id=c.id AND self.member_id=?
      JOIN bot_members owner ON owner.conversation_id=c.id AND owner.member_id='user'
      WHERE c.kind IN ('direct','group') AND c.id>?
      AND NOT EXISTS(SELECT 1 FROM bot_metadata d WHERE d.key='conversation-dissolved:'||c.id AND d.value<>'')
      ORDER BY c.id LIMIT ?`).all(event.companionId, cursor, limit + 1)) as Array<{ id: string; title: string; kind: string }>;
    this.origin(event);
    return { scopes: rows.slice(0, limit).map(room => ({ conversationId: room.id, title: room.title, kind: room.kind, current: room.id === origin.id })),
      hasMore: rows.length > limit, ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}), access: 'owner-conversations' };
  }
  retainSources(event: BotEvent, selected: AgentMemorySelection, result: unknown): void {
    selected.assertCurrent();
    if (!selected.crossConversation || !result || typeof result !== 'object' || (result as { available?: boolean }).available !== true) return;
    const provenance = z.object({ revision: z.string(), sourceEventIds: z.array(z.string().min(1).max(500)).max(128), sourceMessageIds: z.array(z.string().min(1).max(500)).max(1024) })
      .parse((result as { provenance?: unknown }).provenance);
    const ids = [...new Set([...provenance.sourceEventIds, ...provenance.sourceMessageIds])];
    if (this.store.withdrawnIn(event.companionId, selected.scope.securityDomainId, ids).size) throw new Error('目标记忆的来源已经撤回，本次结果不可使用。');
    this.store.taskTransaction(sql => {
      selected.assertCurrent();
      for (const id of ids) sql.prepare('INSERT OR IGNORE INTO bot_peer_bridges VALUES(?,?,?,?,?)')
        .run(event.companionId, selected.scope.securityDomainId, id, event.conversationId, event.replyMessageId);
    });
  }
  /** Host ACL updates use the same dependency graph as explicit forgetting.
   * Returned IDs are host-only; no model can select another memory owner. */
  dependentReplies(conversationId: string): Array<{ conversationId: string; messageId: string }> {
    const room = this.store.getConversation(conversationId); if (!room) return [];
    return this.store.taskTransaction(sql => sql.prepare(`SELECT DISTINCT target_conversation_id AS conversationId,target_message_id AS messageId
      FROM bot_peer_bridges WHERE source_domain=?`).all(room.securityDomainId)) as Array<{ conversationId: string; messageId: string }>;
  }
}
