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
export interface AgentReadableConversationPredicate { sql: string; args: string[] }
export interface AgentRecentMemoryScope {
  conversationId: string; title: string; kind: BotConversation['kind']; current: boolean;
  lastMessageId: string; senderId: string; senderName: string; createdAt: string; projectionSequence: number;
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
  /** Shared by memory and live-history discovery. The caller supplies a host
   * SQL alias, never model input. A peer is observable only with exactly two
   * real, non-retired companions; sharing a DSH host grants no other access. */
  readableConversationPredicate(event: BotEvent, alias = 'c'): AgentReadableConversationPredicate {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) throw new Error('会话查询别名无效。');
    const origin = this.origin(event), member = `${alias}.id`;
    const ownerRoom = `(${alias}.kind IN ('direct','group') AND EXISTS(SELECT 1 FROM bot_members owner
      WHERE owner.conversation_id=${member} AND owner.member_id='user'))`;
    // BotStore derives userRole='observer' from this exact peer membership
    // shape. The companion join additionally rejects orphaned legacy members.
    const peerRoom = `(${alias}.kind='peer' AND (SELECT COUNT(*) FROM bot_members peer WHERE peer.conversation_id=${member})=2
      AND NOT EXISTS(SELECT 1 FROM bot_members peer LEFT JOIN bot_companions actor ON actor.id=peer.member_id
        WHERE peer.conversation_id=${member} AND (peer.member_id='user' OR actor.id IS NULL
          OR peer.member_id='default-companion' AND EXISTS(SELECT 1 FROM bot_metadata retired
            WHERE retired.key='development-default-cleanup' AND retired.value<>''))))`;
    return { sql: `EXISTS(SELECT 1 FROM bot_members self WHERE self.conversation_id=${member} AND self.member_id=?)
      AND NOT EXISTS(SELECT 1 FROM bot_metadata dissolved WHERE dissolved.key='conversation-dissolved:'||${member} AND dissolved.value<>'')
      AND ${this.canExpand(origin) ? `(${ownerRoom} OR ${peerRoom})` : `${member}=?`}`,
      args: this.canExpand(origin) ? [event.companionId] : [event.companionId, origin.id] };
  }
  resolve(event: BotEvent, requested?: string): AgentMemorySelection {
    const predicate = this.readableConversationPredicate(event), id = requested === undefined ? event.conversationId : scopeId.parse(requested);
    const origin = this.origin(event);
    const crossConversation = id !== origin.id, target = this.store.getConversation(id);
    if (!target || target.dissolvedAt || !target.memberIds.includes(event.companionId)
      || crossConversation && target.kind === 'peer' && target.userRole !== 'observer'
      || !this.store.taskTransaction(sql => sql.prepare(`SELECT 1 FROM bot_conversations c WHERE c.id=? AND ${predicate.sql}`).get(id, ...predicate.args)))
      throw new Error('该记忆会话不属于当前伙伴获准的用户视图；只能从用户私聊回查本人参与的合法会话。');
    const revision = target.revision, securityDomainId = target.securityDomainId, audienceScopeId = target.audienceScopeId;
    return { scope: { companionId: event.companionId, conversationId: target.id, securityDomainId }, crossConversation,
      sourceConversation: { id: target.id, title: target.title, kind: target.kind },
      assertCurrent: () => {
        const currentPredicate = this.readableConversationPredicate(event), current = this.store.getConversation(id);
        if (!current || current.dissolvedAt || current.revision !== revision || current.securityDomainId !== securityDomainId || current.audienceScopeId !== audienceScopeId
          || !current.memberIds.includes(event.companionId) || crossConversation && current.kind === 'peer' && current.userRole !== 'observer'
          || !this.store.taskTransaction(sql => sql.prepare(`SELECT 1 FROM bot_conversations c WHERE c.id=? AND ${currentPredicate.sql}`).get(id, ...currentPredicate.args)))
          throw new Error('记忆来源会话的成员或受众授权在读取期间发生变化，本次结果不再可用。');
      } };
  }
  list(event: BotEvent, input: { cursor?: string; limit?: number } = {}) {
    const origin = this.origin(event), limit = z.number().int().min(1).max(30).parse(input.limit ?? 15);
    const cursor = input.cursor === undefined ? '' : scopeId.parse(input.cursor);
    if (!this.canExpand(origin)) {
      return { scopes: cursor ? [] : [{ conversationId: origin.id, title: origin.title, kind: origin.kind, current: true }], hasMore: false, access: 'current-conversation' };
    }
    const predicate = this.readableConversationPredicate(event);
    const rows = this.store.taskTransaction(sql => sql.prepare(`SELECT c.id,c.title,c.kind FROM bot_conversations c
      WHERE ${predicate.sql} AND c.id>? ORDER BY c.id LIMIT ?`).all(...predicate.args, cursor, limit + 1)) as Array<{ id: string; title: string; kind: BotConversation['kind'] }>;
    this.origin(event);
    return { scopes: rows.slice(0, limit).map(room => ({ conversationId: room.id, title: room.title, kind: room.kind, current: room.id === origin.id })),
      hasMore: rows.length > limit, ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}), access: 'owner-conversations' };
  }
  /** Metadata-only hint for recent public activity, ordered by actual
   * publication rather than preallocated UI placeholder IDs. Full text still
   * requires resolve() and the scoped history read/provenance path. */
  recentScopes(event: BotEvent, input: { limit?: number } = {}): AgentRecentMemoryScope[] {
    const limit = z.number().int().min(1).max(30).parse(input.limit ?? 5), predicate = this.readableConversationPredicate(event);
    const rows = this.store.taskTransaction(sql => sql.prepare(`SELECT c.id AS conversationId,c.title,c.kind,
      m.id AS lastMessageId,m.sender_id AS senderId,m.sender_name AS senderName,p.timestamp AS publishedAt,p.sequence AS projectionSequence
      FROM bot_conversations c JOIN bot_history_projection p ON p.sequence=(
        SELECT MAX(latest.sequence) FROM bot_history_projection latest JOIN bot_messages public ON public.id=latest.message_id
        WHERE latest.conversation_id=c.id AND public.status='sent' AND (length(public.content)>0 OR public.attachments_json<>'[]')
        AND public.sender_id<>'task-service' AND public.kind NOT IN ('task_done','task_progress','attention')
        AND NOT EXISTS(SELECT 1 FROM bot_inbox internal WHERE internal.source_record_id=public.id AND internal.source='task'))
      JOIN bot_messages m ON m.id=p.message_id WHERE ${predicate.sql} ORDER BY p.sequence DESC LIMIT ?`)
      .all(...predicate.args, limit)) as Array<Omit<AgentRecentMemoryScope, 'current' | 'createdAt'> & { publishedAt: number }>;
    const visible = rows.filter(row => {
      const room = this.store.getConversation(row.conversationId);
      return room && !this.store.withdrawnIn(event.companionId, room.securityDomainId, [row.lastMessageId]).size;
    });
    this.origin(event);
    return visible.map(({ publishedAt, ...row }) => ({ ...row, createdAt: new Date(publishedAt).toISOString(), current: row.conversationId === event.conversationId }));
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
