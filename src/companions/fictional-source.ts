import type { CompanionConnection } from './store';
import { executionMessageReadsetKey, executionReadsetFromJson } from './execution-source-access';

const queries = {
  messageTopic: "SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id WHERE m.message_id=? AND json_extract(t.data,'$.kind') IN('game','story')",
  readset: 'SELECT value FROM metadata WHERE key=?',
  referencedTopic: "SELECT 1 FROM companion_topics WHERE id=? AND conversation_id=? AND json_extract(data,'$.kind') IN('game','story')",
} as const;
type Statements = Partial<Record<keyof typeof queries, ReturnType<CompanionConnection['prepare']>>>;
const statements = new WeakMap<CompanionConnection, Statements>();
/** Compiled SQL only. Keep the supplied connection (including its host fence),
 * execute fresh bindings on every call, and retain no lineage results. */
function statement(db: CompanionConnection, name: keyof typeof queries) {
  let owned = statements.get(db);
  if (!owned) { owned = {}; statements.set(db, owned); }
  const known = owned[name]; if (known) return known;
  const prepared = db.prepare(queries[name]); owned[name] = prepared; return prepared;
}

/** A private delivery port does not turn activity fiction into a real event.
 * Follow typed host provenance only; message prose never supplies a domain. */
export function companionMessageFictionalLineage(db: CompanionConnection, messageId: string): boolean {
  const pending = [messageId], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!; if (seen.has(id)) continue; seen.add(id);
    if (statement(db, 'messageTopic').get(id)) return true;
    const stored = statement(db, 'readset').get(executionMessageReadsetKey(id)) as { value: string } | undefined;
    const proof = executionReadsetFromJson(stored?.value);
    if (!proof) continue;
    for (const reference of proof.topics) if (statement(db, 'referencedTopic').get(reference.topicId, reference.conversationId)) return true;
    pending.push(...proof.sources.map(source => source.id));
  }
  return false;
}
