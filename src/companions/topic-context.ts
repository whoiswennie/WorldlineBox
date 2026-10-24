import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionTopicCheckpointSchema, companionTopicSchema, type CompanionTopic, type CompanionTopicState } from '../shared/companion-topic';

type Checkpoint = NonNullable<CompanionTopicState['workingState']>;
type EventRow = { ordinal: number; topic_id: string; reader_id: string; data: string };

/** Validate the immutable ancestry, not just the newest chunk's source list.
 * Source-free moderator settings remain independent. Legacy compactions already
 * recorded their predecessor event, so their ancestry can be checked too. */
function topicAncestry(db: CompanionConnection, topic: CompanionTopic): Set<string> | undefined {
  if (topic.deletedAt) return;
  const allowedTopics = new Set([topic.id]);
  let ancestor = topic.forkedFromTopicId;
  while (ancestor) {
    if (allowedTopics.has(ancestor)) return;
    const found = db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(ancestor, topic.conversationId) as { data: string } | undefined;
    if (!found) return;
    let parent: CompanionTopic;
    try { parent = companionTopicSchema.parse(JSON.parse(found.data)); } catch { return; }
    if (parent.deletedAt || parent.id !== ancestor || parent.conversationId !== topic.conversationId) return;
    allowedTopics.add(parent.id); ancestor = parent.forkedFromTopicId;
  }
  return allowedTopics;
}
export const companionTopicAncestorIds = topicAncestry;
/** Immutable captured checkpoints remain usable after unrelated newer updates,
 * but a deleted ancestor/event or any withdrawn transitive source invalidates
 * the whole captured reference. The current reader never imports another role. */
export function companionTopicCheckpointEventValid(db: CompanionConnection, topic: CompanionTopic, readerId: string,
  eventId: string, sourcesValid: (ids: readonly string[]) => boolean): boolean {
  const allowed = topicAncestry(db, topic);
  const event = db.prepare('SELECT topic_id,reader_id,data FROM companion_topic_events WHERE id=?').get(eventId) as EventRow | undefined;
  if (!allowed || !event || !allowed.has(event.topic_id) || event.reader_id !== '*' && event.reader_id !== readerId) return false;
  try {
    const parsed = companionTopicCheckpointSchema.safeParse(JSON.parse(event.data));
    return parsed.success && parsed.data.sourceEventId === eventId && companionTopicCheckpointValid(db, topic, readerId, parsed.data, sourcesValid);
  } catch { return false; }
}
export function companionTopicCheckpointValid(db: CompanionConnection, topic: CompanionTopic, readerId: string,
  checkpoint: Checkpoint, sourcesValid: (ids: readonly string[]) => boolean): boolean {
  const allowedTopics = topicAncestry(db, topic);
  if (!allowedTopics) return false;
  const queue: Checkpoint[] = [checkpoint], visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    const parent = db.prepare('SELECT rowid AS ordinal,topic_id,reader_id FROM companion_topic_events WHERE id=?').get(current.sourceEventId) as EventRow | undefined;
    if (!parent || !allowedTopics.has(parent.topic_id) || parent.reader_id !== '*' && parent.reader_id !== readerId) return false;
    if (!sourcesValid(current.sourceMessageIds)) return false;
    for (const [id, expected] of Object.entries(current.sourceChecksums ?? {})) {
      const source = db.prepare('SELECT content FROM messages WHERE id=? AND conversation_id=? AND status=?').get(id, topic.conversationId, 'sent') as { content: string } | undefined;
      if (!current.sourceMessageIds.includes(id) || !source || createHash('sha256').update(source.content).digest('hex') !== expected) return false;
    }
    const legacy = current.state?.__continuity as { previousCheckpointEventId?: unknown } | undefined;
    const dependencies = current.derivedFromEventIds ?? (typeof legacy?.previousCheckpointEventId === 'string' ? [legacy.previousCheckpointEventId] : []);
    for (const eventId of dependencies) {
      if (eventId === current.sourceEventId) return false;
      const event = db.prepare('SELECT rowid AS ordinal,topic_id,reader_id,data FROM companion_topic_events WHERE id=?').get(eventId) as EventRow | undefined;
      if (!event || event.ordinal >= parent.ordinal || !allowedTopics.has(event.topic_id) || event.reader_id !== '*' && event.reader_id !== readerId) return false;
      if (visited.has(eventId)) continue;
      visited.add(eventId);
      let parsed: Checkpoint;
      try { parsed = companionTopicCheckpointSchema.parse(JSON.parse(event.data)); } catch { return false; }
      if (parsed.sourceEventId !== eventId) return false;
      queue.push(parsed);
    }
  }
  return true;
}
