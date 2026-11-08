import { z } from 'zod';
import { BotAgentMemoryScopes } from './agent-memory-scope';
import { isBotParticipantRequest } from './participant-request';
import type { BotStore } from './store';
import type { BotEvent, BotEventStatus } from './types';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
function parsed(value: unknown): Row { try { return object(JSON.parse(String(value))); } catch { return {}; } }
const id = z.string().min(1).max(160);
const selection = z.object({ companionId: id.optional(), limit: z.number().int().min(1).max(30).optional(), before: z.number().int().positive().optional() });

export interface BotContactStatusItem {
  available: boolean; reason?: string; contactId: string; sourceMessageId: string; sequence: number;
  requesterId: string; recipientId: string; destination: 'peer' | 'user-direct' | 'unknown';
  sourceAccess?: 'owner-source' | 'relay-local';
  source?: { conversationId: string; eventId: string; messageId: string };
  relay?: { conversationId: string; messageId: string; createdAt: string; state: 'published' };
  recipientEvent?: { id: string; status: BotEventStatus; receivedAt: string };
  peerReply?: { state: 'published' | 'not-observed' | 'unknown'; messageId?: string; createdAt?: string };
  userDirectDelivery?: { state: 'published' | 'delivered' | 'not-observed' | 'not-requested' | 'unknown';
    messageId?: string; conversationId?: string; createdAt?: string; deliveredAt?: string; userRead: 'unknown' };
}
export interface BotContactStatusResult {
  available: boolean; reason?: string; items: BotContactStatusItem[]; hasMore: boolean; nextBefore?: number;
}

/** Metadata-only contact receipts. Shared DSH execution is not a permission
 * to inspect the recipient's user-private transcript. No query below selects
 * message content from that room, and no observation creates a grant, sends a
 * message, resumes an event or changes the original delivery journal. */
export class BotContactStatus {
  private readonly scopes: BotAgentMemoryScopes;
  constructor(private readonly store: BotStore) { this.scopes = new BotAgentMemoryScopes(store); }

  list(event: BotEvent, input: { companionId?: string; limit?: number; before?: number } = {}): BotContactStatusResult {
    const options = selection.parse(input), limit = options.limit ?? 15;
    return this.store.taskTransaction(sql => {
      let current;
      try { current = this.scopes.resolve(event); current.assertCurrent(); }
      catch { return { available: false, reason: 'current-audience-unavailable', items: [], hasMore: false }; }
      if (this.store.getCompanion(event.companionId)?.enabled === false) return { available: false, reason: 'requester-disabled', items: [], hasMore: false };
      const room = this.store.getConversation(event.conversationId)!;
      const expands = room.kind === 'direct' && room.memberIds.includes('user');
      // Exact committed contact receipts anchor discovery, including legacy
      // contacts whose target event or reply grant was never recorded. A relay
      // has one stable UI sequence; unrelated later peer messages cannot alter
      // pagination or masquerade as an answer to this specific contact.
      const rows = sql.prepare(`SELECT receipt.key AS receipt_key,receipt.value AS receipt_json,source.id AS source_event_id,
        relay.id AS relay_id,relay.sequence AS relay_sequence,relay.conversation_id AS relay_conversation_id,
        relay.sender_id AS relay_sender_id,relay.status AS relay_status,relay.created_at AS relay_created_at,
        json_extract(CASE WHEN json_valid(receipt.value) THEN receipt.value ELSE '{}' END,'$.recipientId') AS recipient_id,
        recipient.id AS recipient_event_id
        FROM bot_metadata receipt JOIN bot_inbox source ON substr(receipt.key,1,length('peer-contact-receipt:'||source.id||':'))='peer-contact-receipt:'||source.id||':'
        JOIN bot_conversations original ON original.id=source.conversation_id
        JOIN bot_messages relay ON relay.id=json_extract(CASE WHEN json_valid(receipt.value) THEN receipt.value ELSE '{}' END,'$.messageId')
        LEFT JOIN bot_inbox recipient ON recipient.source_record_id=relay.id
          AND recipient.companion_id=json_extract(CASE WHEN json_valid(receipt.value) THEN receipt.value ELSE '{}' END,'$.recipientId')
        WHERE receipt.key>='peer-contact-receipt:' AND receipt.key<'peer-contact-receipt;'
          AND source.companion_id=? AND relay.sender_id=? AND relay.sequence<?
          AND ${expands ? "original.kind IN ('direct','group','peer')" : "(source.conversation_id=? OR ?='peer' AND relay.conversation_id=?)"}
          ${options.companionId ? "AND json_extract(CASE WHEN json_valid(receipt.value) THEN receipt.value ELSE '{}' END,'$.recipientId')=?" : ''}
        ORDER BY relay.sequence DESC,receipt.key DESC LIMIT ?`)
        .all(event.companionId, event.companionId, options.before ?? Number.MAX_SAFE_INTEGER,
          ...(expands ? [] : [room.id, room.kind, room.id]), ...(options.companionId ? [options.companionId] : []), limit + 1) as Row[];
      const items = rows.slice(0, limit).map(row => this.inspect(event, row));
      try { current.assertCurrent(); }
      catch { return { available: false, reason: 'current-audience-unavailable', items: [], hasMore: false }; }
      return { available: true, items, hasMore: rows.length > limit, ...(rows.length > limit ? { nextBefore: items.at(-1)!.sequence } : {}) };
    });
  }

  private inspect(current: BotEvent, row: Row): BotContactStatusItem {
    const receipt = parsed(row.receipt_json), recipientId = String(row.recipient_id ?? '');
    const item: BotContactStatusItem = { available: false, contactId: String(row.relay_id), sourceMessageId: String(row.relay_id),
      sequence: Number(row.relay_sequence), requesterId: current.companionId, recipientId,
      destination: receipt.destination === 'user' ? 'user-direct' : receipt.destination === 'peer' ? 'peer' : 'unknown' };
    const unavailable = (reason: string) => ({ ...item, available: false, reason });
    const source = this.store.getEvent(String(row.source_event_id)), relayRoom = this.store.getConversation(String(row.relay_conversation_id));
    const sourceRoom = source && this.store.getConversation(source.conversationId);
    const recipient = row.recipient_event_id ? this.store.getEvent(String(row.recipient_event_id)) : undefined;
    if (!source || !sourceRoom || !relayRoom || receipt.messageId !== row.relay_id || receipt.conversationId !== relayRoom.id
      || receipt.recipientId !== recipientId || recipientId === current.companionId || row.relay_sender_id !== current.companionId || row.relay_status !== 'sent') return unavailable('contact-receipt-invalid');
    if (!this.store.getCompanion(recipientId) || this.store.getCompanion(recipientId)?.enabled === false
      || this.store.getCompanion(source.companionId)?.enabled === false
      || source.senderType === 'companion' && this.store.getCompanion(source.senderId)?.enabled === false) return unavailable('contact-participant-disabled');
    if (source.companionId !== current.companionId || sourceRoom.dissolvedAt || sourceRoom.revision !== source.aclRevision
      || sourceRoom.securityDomainId !== source.securityDomainId || sourceRoom.audienceScopeId !== source.audienceScopeId
      || !isBotParticipantRequest(source, sourceRoom) || !sourceRoom.memberIds.includes(current.companionId)
      || relayRoom.dissolvedAt || !relayRoom.memberIds.includes(current.companionId) || !relayRoom.memberIds.includes(recipientId)) return unavailable('source-authority-unavailable');
    if (relayRoom.kind === 'peer' && (relayRoom.memberIds.length !== 2 || relayRoom.userRole !== 'observer')) return unavailable('contact-audience-unavailable');
    if (this.store.withdrawnIn(source.companionId, source.securityDomainId, this.store.eventSourceIds(source.id)).size
      || this.store.withdrawnIn(current.companionId, relayRoom.securityDomainId, [String(row.relay_id)]).size
      || recipient && this.store.withdrawnIn(recipientId, relayRoom.securityDomainId, this.store.eventSourceIds(recipient.id)).size) return unavailable('contact-source-withdrawn');
    let ownerSource = false;
    try { const selected = this.scopes.resolve(current, source.conversationId); selected.assertCurrent(); ownerSource = true; } catch { /* A real peer may inspect only its local relay metadata. */ }
    if (!ownerSource && (this.store.getConversation(current.conversationId)?.kind !== 'peer' || relayRoom.id !== current.conversationId)) return unavailable('source-audience-unavailable');
    item.sourceAccess = ownerSource ? 'owner-source' : 'relay-local';
    if (ownerSource) item.source = { conversationId: source.conversationId, eventId: source.id, messageId: source.sourceMessageRecordId };
    item.relay = { conversationId: relayRoom.id, messageId: String(row.relay_id), createdAt: String(row.relay_created_at), state: 'published' };
    if (recipient) {
      const prefix = `peer-contact:${source.id}:`;
      if (recipient.source !== 'companion' || recipient.senderId !== current.companionId || recipient.companionId !== recipientId
        || recipient.conversationId !== relayRoom.id || recipient.causationId !== source.id || recipient.correlationId !== source.correlationId
        || recipient.securityDomainId !== relayRoom.securityDomainId || recipient.audienceScopeId !== relayRoom.audienceScopeId
        || recipient.aclRevision !== relayRoom.revision || !recipient.sourceMessageId.startsWith(prefix)
        || `peer-contact-receipt:${source.id}:${recipient.sourceMessageId.slice(prefix.length)}` !== row.receipt_key) return unavailable('contact-lineage-unavailable');
      item.recipientEvent = { id: recipient.id, status: recipient.status, receivedAt: recipient.receivedAt };
      item.peerReply = this.peerReply(current, recipient);
      item.userDirectDelivery = this.userDelivery(source, recipient, receipt.destination);
    } else {
      item.peerReply = { state: 'unknown' };
      item.userDirectDelivery = { state: receipt.destination === 'peer' ? 'not-requested' : 'unknown', userRead: 'unknown' };
    }
    item.available = true; return item;
  }

  private peerReply(requester: BotEvent, recipient: BotEvent): NonNullable<BotContactStatusItem['peerReply']> {
    const found = this.store.taskTransaction(sql => sql.prepare(`SELECT m.id,m.created_at FROM bot_messages m
      WHERE m.conversation_id=? AND m.sender_id=? AND m.status='sent' AND m.kind='message'
        AND (length(trim(m.content))>0 OR m.attachments_json<>'[]')
        AND EXISTS(SELECT 1 FROM bot_outbox o WHERE o.message_id=m.id AND o.event_id=? AND o.conversation_id=m.conversation_id)
        AND (m.id=? OR EXISTS(SELECT 1 FROM bot_publications p WHERE p.event_id=? AND p.message_id=m.id))
      ORDER BY CASE WHEN m.id=? THEN 0 ELSE 1 END,m.sequence DESC LIMIT 1`)
      .get(recipient.conversationId, recipient.companionId, recipient.id, recipient.replyMessageId, recipient.id, recipient.replyMessageId)) as Row | undefined;
    if (!found) return { state: 'not-observed' };
    if (!this.store.isMessageVisibleToCompanion(String(found.id), requester.companionId)
      || this.store.withdrawnIn(requester.companionId, recipient.securityDomainId, [String(found.id)]).size) return { state: 'unknown' };
    return { state: 'published', messageId: String(found.id), createdAt: String(found.created_at) };
  }

  private userDelivery(source: BotEvent, recipient: BotEvent, destination: unknown): NonNullable<BotContactStatusItem['userDirectDelivery']> {
    const unknown = { state: 'unknown' as const, userRead: 'unknown' as const };
    if (destination === 'peer') return { state: 'not-requested', userRead: 'unknown' };
    if (destination !== 'user') return unknown;
    const raw = this.store.getMetadata(`peer-user-reply-grant:${recipient.id}`);
    if (!raw) return unknown;
    const grant = parsed(raw);
    if (grant.sourceEventId !== source.id || grant.relayMessageId !== recipient.sourceMessageRecordId || grant.peerConversationId !== recipient.conversationId
      || grant.recipientId !== recipient.companionId || grant.requesterId !== source.companionId || grant.correlationId !== source.correlationId
      || grant.sourceAclRevision !== source.aclRevision) return unknown;
    const result = object(object(grant.reply).result);
    if (!Object.keys(result).length) return { state: 'not-observed', userRead: 'unknown' };
    if (result.sent !== true || result.senderId !== recipient.companionId || result.recipientId !== 'user'
      || typeof result.messageId !== 'string' || typeof result.conversationId !== 'string') return unknown;
    // Read only delivery metadata in the other companion's private room. The
    // full text and attachments of that room never enter this Router's view.
    const published = this.store.taskTransaction(sql => sql.prepare(`SELECT m.id,m.conversation_id,m.created_at,o.status AS outbox_status,o.delivered_at
      FROM bot_messages m JOIN bot_conversations c ON c.id=m.conversation_id
      JOIN bot_outbox o ON o.message_id=m.id AND o.event_id=? AND o.conversation_id=m.conversation_id
      WHERE m.id=? AND m.conversation_id=? AND m.sender_id=? AND m.sender_type='companion' AND m.status='sent'
        AND c.kind='direct' AND (SELECT COUNT(*) FROM bot_members member WHERE member.conversation_id=c.id)=2
        AND EXISTS(SELECT 1 FROM bot_members member WHERE member.conversation_id=c.id AND member.member_id='user')
        AND EXISTS(SELECT 1 FROM bot_members member WHERE member.conversation_id=c.id AND member.member_id=?)
        AND NOT EXISTS(SELECT 1 FROM bot_metadata dissolved WHERE dissolved.key='conversation-dissolved:'||c.id AND dissolved.value<>'')`)
      .get(recipient.id, result.messageId, result.conversationId, recipient.companionId, recipient.companionId)) as Row | undefined;
    if (!published) return unknown;
    const direct = this.store.getConversation(String(published.conversation_id))!;
    if (this.store.withdrawnIn(recipient.companionId, direct.securityDomainId, [String(published.id)]).size) return unknown;
    return { state: published.outbox_status === 'delivered' && typeof published.delivered_at === 'string' ? 'delivered' : 'published',
      messageId: String(published.id), conversationId: String(published.conversation_id), createdAt: String(published.created_at),
      ...(published.outbox_status === 'delivered' && typeof published.delivered_at === 'string' ? { deliveredAt: published.delivered_at } : {}), userRead: 'unknown' };
  }
}
