import type { CompanionConnection } from './store';
import type { CompanionMemoryStore } from './memory-store';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import type { CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMemory } from '../shared/companions';
import { executionMessageReadsetKey, executionSourceInvalidKey } from './execution-source-access';

type Proof = NonNullable<CompanionStorageResponse['executionSources']>[number];
const parse = <T>(value: unknown): T | undefined => { try { return value ? JSON.parse(String(value)) as T : undefined; } catch { return; } };
/** Provenance only. This never reads files, runs a model or changes what ran. */
export class CompanionExecutionSourceStore {
  constructor(private readonly db: CompanionConnection, private readonly memory: CompanionMemoryStore) {}
  bind(messageId: string, value: CompanionExecutionReadset): void {
    const readset = companionExecutionReadsetSchema.parse(value);
    const message = this.db.prepare('SELECT author_id,conversation_id FROM messages WHERE id=?').get(messageId) as { author_id: string; conversation_id: string } | undefined;
    if (!message || message.author_id !== readset.companionId || message.conversation_id !== readset.conversationId || !readset.complete) throw new Error('正式回复的执行读集归属或覆盖不完整。');
    const key = executionMessageReadsetKey(messageId), existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    if (existing && existing.value !== JSON.stringify(readset)) throw new Error('正式回复已经绑定的执行读集不可替换。');
    this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify(readset));
    // Both callers hold the append/final-loop transaction. A grant/source
    // revoked between Main's async check and commit rolls publication back.
    const stored = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) as Record<string, string | number | null>;
    if (readset.sources.some(source => source.id === messageId) || !this.memory.sources.formal(stored)) throw new Error('正式回复的执行依赖在提交前已经变化。');
  }
  resolve(ids: readonly string[], memoryIds: readonly string[] = []): Proof[] {
    return this.memory.sources.withValidation(() => this.resolveWithinValidation(ids, memoryIds));
  }
  private resolveWithinValidation(ids: readonly string[], memoryIds: readonly string[]): Proof[] {
    const proofs = new Map<string, Proof>();
    // One synchronous SQLite request observes one database state. Shared roots
    // can reuse its precise metadata/proof fields, never a later request's data.
    const metadataValues = new Map<string, string | undefined>(), decodedMetadata = new Map<string, unknown>();
    const checkedReadsets = new Map<string, CompanionExecutionReadset | undefined>();
    // Several roots on one page usually share most of their ancestry. Resolve
    // each adjacency list once in this synchronous command, while preserving
    // every root's dependency association for later invalidation/redaction.
    // The maps die at this command boundary and never cache authorization.
    const messagesById = new Map<string, { action_id?: string; author_id: string; conversation_id: string } | undefined>();
    const actionsById = new Map<string, { companion_id: string; conversation_id: string } | undefined>();
    const noteEdges = new Map<string, { messages: string[]; notes: string[] }>();
    const eventEdges = new Map<string, { messages: string[]; events: string[] }>();
    const messageRow = (id: string) => {
      if (!messagesById.has(id)) messagesById.set(id, this.db.prepare('SELECT action_id,author_id,conversation_id FROM messages WHERE id=?').get(id) as { action_id?: string; author_id: string; conversation_id: string } | undefined);
      return messagesById.get(id);
    };
    const actionRow = (id: string) => {
      if (!actionsById.has(id)) actionsById.set(id, this.db.prepare('SELECT companion_id,conversation_id FROM actions WHERE id=?').get(id) as { companion_id: string; conversation_id: string } | undefined);
      return actionsById.get(id);
    };
    const noteReferences = (id: string) => {
      if (!noteEdges.has(id)) noteEdges.set(id, {
        messages: (this.db.prepare('SELECT message_id FROM vcp_note_sources WHERE note_id=?').all(id) as Array<{ message_id: string }>).map(source => source.message_id),
        notes: (this.db.prepare('SELECT source_note_id FROM vcp_note_dependencies WHERE note_id=?').all(id) as Array<{ source_note_id: string }>).map(source => source.source_note_id),
      });
      return noteEdges.get(id)!;
    };
    const metadata = (key: string) => {
      if (metadataValues.has(key)) return metadataValues.get(key);
      // Execution logs can contain megabytes of unrelated tool output. Only
      // the typed dependency readset belongs on this source-validation path.
      const sql = key.startsWith('task-checkpoint/')
        ? "SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.executionReadset') END AS value FROM metadata WHERE key=?"
        : 'SELECT value FROM metadata WHERE key=?';
      const value = (this.db.prepare(sql).get(key) as { value?: string } | undefined)?.value;
      metadataValues.set(key, value); return value;
    };
    const decoded = <T>(key: string): T | undefined => {
      if (!decodedMetadata.has(key)) decodedMetadata.set(key, parse<T>(metadata(key)));
      return decodedMetadata.get(key) as T | undefined;
    };
    for (const root of [...new Set(ids)]) {
      const messages = [root], notes: string[] = [], events: string[] = [], seenMessages = new Set<string>(), seenNotes = new Set<string>(), seenEvents = new Set<string>();
      const include = (proof: Omit<Proof, 'sourceMessageIds'>) => {
        const key = `${proof.kind}:${proof.id}`;
        if (!checkedReadsets.has(key)) {
          const parsed = companionExecutionReadsetSchema.safeParse(proof.executionReadset);
          checkedReadsets.set(key, parsed.success ? parsed.data : undefined);
        }
        proof.executionReadset = checkedReadsets.get(key);
        if (metadata(executionSourceInvalidKey(proof.kind, proof.id))) proof.invalidated = true;
        const previous = proofs.get(key);
        if (previous) { if (!previous.sourceMessageIds.includes(root)) previous.sourceMessageIds.push(root); }
        else proofs.set(key, { ...proof, sourceMessageIds: [root] });
        const readset = proof.executionReadset;
        if (!readset) return;
        messages.push(...readset.sources.map(source => source.id)); notes.push(...readset.memories.map(note => note.id));
        // Frozen task facts follow their original witnesses, never the note's
        // newly edited semantic graph.
        messages.push(...(readset.frozenMemories ?? []).flatMap(note => note.sources.map(source => source.id)));
        for (const read of readset.knowledgeReads) { if (read.sourceType === 'memory') notes.push(read.sourceId); else if (read.sourceType === 'message') messages.push(read.sourceId); }
        for (const topic of readset.topics) events.push(...topic.checkpointEventIds);
      };
      while (messages.length || notes.length || events.length) {
        const id = messages.shift();
        if (id && !seenMessages.has(id)) {
          seenMessages.add(id);
          const message = messageRow(id);
          if (message) {
            // Pre-upgrade completed conversations had no typed proof. Retain
            // their existing ACL/forget behavior; do not invent retrospective
            // evidence or claim their historical inputs were verified here.
            const derived = metadata(executionMessageReadsetKey(id));
            if (derived !== undefined) include({ kind: 'message', id, companionId: message.author_id, conversationId: message.conversation_id, executionReadset: decoded<CompanionExecutionReadset>(executionMessageReadsetKey(id)) });
            if (message.action_id) {
              const action = actionRow(message.action_id);
              const readset = decoded<CompanionExecutionReadset>('task-checkpoint/' + message.action_id);
              if (action) include({ kind: 'action', id: message.action_id, companionId: action.companion_id, conversationId: action.conversation_id, executionReadset: readset });
            }
            const observation = decoded<{ sources?: Array<{ id: string }>; topicCheckpoints?: Array<{ checkpointEventIds: string[] }> }>('memory-world-observation/' + id);
            messages.push(...(observation?.sources ?? []).map(source => source.id));
            for (const reference of observation?.topicCheckpoints ?? []) events.push(...reference.checkpointEventIds);
          }
        }
        const noteId = notes.shift();
        if (noteId && !seenNotes.has(noteId)) {
          seenNotes.add(noteId);
          const edges = noteReferences(noteId);
          messages.push(...edges.messages); notes.push(...edges.notes);
        }
        const eventId = events.shift();
        if (eventId && !seenEvents.has(eventId)) {
          seenEvents.add(eventId);
          if (!eventEdges.has(eventId)) {
            const event = this.db.prepare('SELECT data FROM companion_topic_events WHERE id=?').get(eventId) as { data: string } | undefined;
            const checkpoint = parse<{ sourceMessageIds?: string[]; derivedFromEventIds?: string[]; state?: { __continuity?: { previousCheckpointEventId?: string } } }>(event?.data);
            eventEdges.set(eventId, { messages: checkpoint?.sourceMessageIds ?? [], events: [...checkpoint?.derivedFromEventIds ?? [],
              ...(checkpoint?.state?.__continuity?.previousCheckpointEventId ? [checkpoint.state.__continuity.previousCheckpointEventId] : [])] });
          }
          const edges = eventEdges.get(eventId)!;
          messages.push(...edges.messages); events.push(...edges.events);
        }
      }
    }
    // Callers normally supply note.sources; this is also available for a
    // precise note-only read port without disclosing arbitrary note contents.
    if (memoryIds.length) {
      const sourceIds = [...new Set(memoryIds.flatMap(id => (this.db.prepare('SELECT message_id FROM vcp_note_sources WHERE note_id=?').all(id) as Array<{ message_id: string }>).map(source => source.message_id)))];
      for (const proof of this.resolve(sourceIds)) if (!proofs.has(`${proof.kind}:${proof.id}`)) proofs.set(`${proof.kind}:${proof.id}`, proof);
    }
    return [...proofs.values()].map(proof => {
      if (proof.invalidated || !proof.executionReadset) return proof;
      const digest = proof.kind === 'message' ? this.memory.sources.validatedMessageReadsetDigest(proof.id, proof.executionReadset)
        : this.memory.sources.validatedActionReadsetDigest(proof.id, proof.executionReadset);
      return digest ? { ...proof, storageValidatedReadsetDigest: digest } : proof;
    });
  }
  invalidate(reference: { kind: 'action' | 'message'; id: string; companionId: string }): void {
    this.db.transaction(() => {
      const owner = reference.kind === 'action'
        ? this.db.prepare('SELECT companion_id AS owner FROM actions WHERE id=?').get(reference.id)
        : this.db.prepare('SELECT author_id AS owner FROM messages WHERE id=?').get(reference.id);
      // Reset can remove a source after Main captured its proof. Withdrawal is
      // already complete in that case; the caller still rereads and redacts it.
      if (!owner) return;
      if ((owner as { owner: string }).owner !== reference.companionId) throw new Error('失效来源不属于该伙伴。');
      const key = executionSourceInvalidKey(reference.kind, reference.id);
      if (this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key)) return;
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ invalidatedAt: new Date().toISOString() }));
      // Revocation is rare. Recheck all owners' derived notes, including public
      // observations of the result, and use the normal recursive withdrawal
      // path to retire consolidation/state/index dependencies atomically.
      for (const row of this.db.prepare("SELECT data FROM vcp_memory_notes WHERE json_extract(data,'$.status') NOT IN('forgotten','invalid')").all() as Array<{ data: string }>) {
        const note = JSON.parse(row.data) as CompanionMemory;
        const visible = this.memory.execute({ type: 'memory.records.filter', ...this.memory.sources.ownerScope(note.companionId), ids: [note.id] })?.memories?.length;
        if (!visible) this.memory.withdrawNote(note.id, 'invalid');
      }
      this.memory.invalidateOwner(reference.companionId);
    }).immediate();
  }
}
