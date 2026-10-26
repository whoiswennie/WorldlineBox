import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { companionTopicCheckpointEventValid } from './topic-context';
import type { CompanionTopic } from '../shared/companion-topic';

/** SQLite can prove source/note/topic/grant dependencies. File bytes and current
 * model generations remain a Main-process check before any source is returned. */
export function companionExecutionReadsetValidSync(db: CompanionConnection, value: unknown, owner: string, room: string, ports: {
  sourceValid(owner: string, room: string, id: string, checksum: string): boolean;
  memoryValid(owner: string, id: string, version: number): boolean;
  frozenMemoryValid?(owner: string, memory: NonNullable<CompanionExecutionReadset['frozenMemories']>[number]): boolean;
  topicSourcesValid(owner: string, room: string, ids: readonly string[]): boolean;
}): boolean {
  try {
    const parsed = companionExecutionReadsetSchema.safeParse(value);
    if (!parsed.success || !parsed.data.complete || parsed.data.companionId !== owner || parsed.data.conversationId !== room) return false;
    const readset = parsed.data;
    if (!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(room, owner)) return false;
    if (readset.sources.some(source => !ports.sourceValid(owner, source.conversationId, source.id, source.checksum))
      || readset.memories.some(note => !ports.memoryValid(owner, note.id, note.version))) return false;
    if (readset.frozenMemories?.some(memory => ports.frozenMemoryValid?.(owner, memory) !== true)) return false;
    for (const reference of readset.topics) {
      const found = db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(reference.topicId, reference.conversationId) as { data: string } | undefined;
      const topic = found ? JSON.parse(found.data) as CompanionTopic : undefined;
      if (!topic || !reference.checkpointEventIds.every(id => companionTopicCheckpointEventValid(db, topic, owner, id,
        ids => ports.topicSourcesValid(owner, reference.conversationId, ids)))) return false;
    }
    for (const read of readset.knowledgeReads) {
      if (read.sourceType === 'learning' && !db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1 AND revision=?').get(read.grantId, owner, read.grantRevision)) return false;
      if (read.sourceType === 'memory' && !ports.memoryValid(owner, read.sourceId, Number(read.sourceVersion))) return false;
      if (read.sourceType === 'message' && !ports.sourceValid(owner, read.conversationId, read.sourceId, read.sourceDigest)) return false;
    }
    return true;
  } catch { return false; }
}

export const executionSourceInvalidKey = (kind: 'message' | 'action', id: string) => `execution-source-invalid/${kind}/${id}`;
export const executionMessageReadsetKey = (id: string) => `message-execution-readset/${id}`;
export const executionSourceHash = (content: string) => createHash('sha256').update(content).digest('hex');
export function executionReadsetFromJson(value: string | undefined): CompanionExecutionReadset | undefined {
  if (!value) return;
  try { const parsed = companionExecutionReadsetSchema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : undefined; } catch { return; }
}
