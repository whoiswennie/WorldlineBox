import type { CompanionAction, CompanionConversation } from '../shared/companions';
import type { CompanionConnection } from './store';

/** Canonical room identity shared by the full UI projection and the narrow
 * capability authority port. The world-room marker, not the room title or
 * member count, decides whether a private port belongs to peers. */
export function companionConversationIdentity(db: CompanionConnection, room: Pick<CompanionConversation, 'id' | 'kind'>) {
  const members = db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=? ORDER BY rowid').all(room.id) as Array<{ companion_id: string }>;
  return { ...room, memberIds: members.map(value => value.companion_id),
    peerOnly: !!db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + room.id) };
}

/** These aliases are literals owned by the caller, never user/provider input.
 * Scope is proved by the real source room and invocation, not the tool name,
 * current history page, or whether the reply bubble has already been mounted. */
function conversationCapabilitySql(alias: string): string {
  const field = (name: string) => `json_extract(${alias}.data,'$.${name}')`;
  const invocation = field('capability.invocationId'), parent = field('parentMessageId');
  const prefix = `(s.id||':'||${alias}.companion_id)`;
  const loopKey = `CASE WHEN ${invocation}=${prefix} THEN 'loop/'||s.id||'/'||${alias}.companion_id
    WHEN substr(${invocation},1,length(${prefix})+1)=${prefix}||':' THEN 'loop/'||s.id||'/'||${alias}.companion_id||'/invocation/'||substr(${invocation},length(${prefix})+2) END`;
  return `COALESCE(${field('capability.audience')},'conversation')!='agenda'
    AND EXISTS(SELECT 1 FROM messages s JOIN metadata l ON l.key=${loopKey}
      WHERE s.id=${field('sourceMessageId')} AND s.conversation_id=${alias}.conversation_id AND s.status='sent' AND s.kind='text'
        AND json_extract(l.value,'$.conversationId')=${alias}.conversation_id
        AND json_extract(l.value,'$.companionId')=${alias}.companion_id AND json_extract(l.value,'$.sourceMessageId')=s.id
        AND (${parent} IS NULL OR (json_extract(l.value,'$.messageId')=${parent}
          AND EXISTS(SELECT 1 FROM messages p WHERE p.id=${parent} AND p.conversation_id=${alias}.conversation_id AND p.author_id=${alias}.companion_id))))`;
}

/** Internal autonomous traces remain queryable from the agenda action ledger.
 * Existing rows receive the same read-only projection; no historical rewrite. */
export function companionCapabilityAudience(db: CompanionConnection, action: Pick<CompanionAction, 'companionId' | 'conversationId' | 'capability' | 'sourceMessageId' | 'parentMessageId'>): 'conversation' | 'agenda' | undefined {
  if (!action.capability) return;
  const result = db.prepare(`SELECT CASE WHEN ${conversationCapabilitySql('cap')} THEN 1 ELSE 0 END AS related
    FROM (SELECT ? AS data,? AS companion_id,? AS conversation_id) cap`).get(JSON.stringify(action), action.companionId, action.conversationId) as { related: number };
  return result.related ? 'conversation' : 'agenda';
}

/** One predicate for page boundaries, search, unread and recent previews. */
export function companionConversationMessageScopeSql(messageAlias: string): string {
  return `NOT EXISTS(SELECT 1 FROM actions cap WHERE cap.id=${messageAlias}.action_id AND json_type(cap.data,'$.capability')='object'
    AND (cap.conversation_id!=${messageAlias}.conversation_id OR cap.companion_id!=${messageAlias}.author_id OR NOT (${conversationCapabilitySql('cap')})))`;
}
