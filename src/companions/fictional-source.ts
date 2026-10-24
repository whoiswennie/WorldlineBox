import type { CompanionConnection } from './store';
import { executionMessageReadsetKey, executionReadsetFromJson } from './execution-source-access';

/** A private delivery port does not turn activity fiction into a real event.
 * Follow typed host provenance only; message prose never supplies a domain. */
export function companionMessageFictionalLineage(db: CompanionConnection, messageId: string): boolean {
  const pending = [messageId], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
    if (db.prepare("SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id WHERE m.message_id=? AND json_extract(t.data,'$.kind') IN('game','story')").get(id)) return true;
    const stored = db.prepare('SELECT value FROM metadata WHERE key=?').get(executionMessageReadsetKey(id)) as { value: string } | undefined;
    const proof = executionReadsetFromJson(stored?.value);
    if (!proof) continue;
    for (const reference of proof.topics) if (db.prepare("SELECT 1 FROM companion_topics WHERE id=? AND conversation_id=? AND json_extract(data,'$.kind') IN('game','story')").get(reference.topicId, reference.conversationId)) return true;
    pending.push(...proof.sources.map(source => source.id));
  }
  return false;
}
