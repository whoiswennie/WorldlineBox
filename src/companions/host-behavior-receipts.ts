import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionHostBehaviorReceiptSchema, type CompanionHostBehaviorReceipt } from '../shared/companion-host-behavior';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
/** Reuses the real immutable world-completion receipt. Metadata or a textual
 * claim alone never attests an actor. Every getter checks the current event,
 * original source revision/hash and host-owned world membership again. */
export function readVerifiedHostBehaviorReceipt(db: CompanionConnection, source: Row): CompanionHostBehaviorReceipt | undefined {
  try {
    if (source.author_id !== 'system' || source.kind !== 'notice' || source.status !== 'sent' || Number(source.revision) !== 1) return;
    const found = db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + String(source.id)) as { value: string } | undefined;
    if (!found) return; const receipt = object(JSON.parse(found.value)), experience = object(receipt?.experience);
    if (!receipt || !experience) return;
    const ownerId = receipt?.companionId;
    if (typeof ownerId !== 'string' || receipt?.forConversationId !== `world_${ownerId}` || source.conversation_id !== `world_${ownerId}`
      || receipt.checksum !== hash(String(source.content)) || !experience
      || !db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(ownerId)
      || !db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + String(source.conversation_id))) return;
    const saved = db.prepare('SELECT data FROM companion_world_events WHERE id=? AND sequence=?').get(experience.eventId, experience.eventSequence) as { data: string } | undefined;
    if (!saved) return; const event = object(JSON.parse(saved.data)), content = object(JSON.parse(String(source.content)));
    if (!event || event.actorId !== ownerId || !(event.kind === 'park_walk_complete'
      || event.kind === 'scene_enter' && typeof event.targetId === 'string' && event.targetId !== ownerId)
      || !Array.isArray(content?.items) || content.items.length !== 1 || JSON.stringify(content.items[0]) !== saved.data
      || content.category !== 'experience') return;
    const privateRoom = db.prepare(`SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id AND m.companion_id=?
      WHERE c.kind='private' AND c.private_companion_id=? AND c.dissolved_at IS NULL`).get(ownerId, ownerId) as { id: string } | undefined;
    // openPrivate creates this exact canonical id when it has not been opened
    // yet. This is host policy, never a model-selected recipient or audience.
    const audienceIds = [`world_${ownerId}`, privateRoom?.id ?? `private-${ownerId}`];
    return companionHostBehaviorReceiptSchema.parse({ schema: 'worldlinebox.host-behavior-receipt-v2', ownerId, actorId: ownerId,
      sourceId: source.id, sourceRevision: 1, sourceHash: receipt.checksum, eventId: event.id, eventSequence: event.sequence,
      eventHash: hash(saved.data), kind: event.kind, realm: 'virtual_world', completedAt: event.at, audienceIds });
  } catch { return undefined; }
}
