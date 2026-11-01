import type { CompanionConnection } from './store';
import type { CompanionMemoryStore } from './memory-store';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import type { CompanionStorageResponse } from '../shared/companion-storage';
import { actionSchema, type CompanionAction, type CompanionMemory } from '../shared/companions';
import { executionMessageReadsetKey, executionSourceInvalidKey } from './execution-source-access';
import { CompanionPublishedMessageCertificates } from './published-message-certificates';
import { observePublishedActionDependencyCut, readPublishedActionFrontier, observePublishedDependencyCut, withPublishedDependencyReadWindow } from './published-dependency-index';

type Proof = NonNullable<CompanionStorageResponse['executionSources']>[number];
type MessageObservation = NonNullable<ReturnType<typeof observePublishedDependencyCut>>;
type ActionObservation = NonNullable<ReturnType<typeof observePublishedActionDependencyCut>>;
const parse = <T>(value: unknown): T | undefined => { try { return value ? JSON.parse(String(value)) as T : undefined; } catch { return; } };
/** Provenance only. This never reads files, runs a model or changes what ran. */
export class CompanionExecutionSourceStore {
  private readonly publications: CompanionPublishedMessageCertificates;
  constructor(private readonly db: CompanionConnection, private readonly memory: CompanionMemoryStore) {
    this.publications = new CompanionPublishedMessageCertificates(db, memory);
  }
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
  resolve(ids: readonly string[], memoryIds: readonly string[] = [], expandPublishedSources: readonly Pick<Proof, 'kind' | 'id'>[] = []): Proof[] {
    return this.db.transaction(() => withPublishedDependencyReadWindow(this.db,
      () => this.memory.sources.withValidation(() => this.resolveWithinValidation(ids, memoryIds, expandPublishedSources))))();
  }
  private resolveWithinValidation(ids: readonly string[], memoryIds: readonly string[], expandPublishedSources: readonly Pick<Proof, 'kind' | 'id'>[]): Proof[] {
    const proofs = new Map<string, Proof>();
    const expanded = new Set(expandPublishedSources.map(value => `${value.kind}:${value.id}`));
    // One synchronous SQLite request observes one database state. Shared roots
    // can reuse its precise metadata/proof fields, never a later request's data.
    const metadataValues = new Map<string, string | undefined>(), decodedMetadata = new Map<string, unknown>();
    const checkedReadsets = new Map<string, CompanionExecutionReadset | undefined>();
    const ownedReadsets = new Set<string>();
    // Several roots on one page usually share most of their ancestry. Resolve
    // each adjacency list once in this synchronous command, while preserving
    // every root's dependency association for later invalidation/redaction.
    // The maps die at this command boundary and never cache authorization.
    const messagesById = new Map<string, { action_id?: string; author_id: string; conversation_id: string } | undefined>();
    const actionsById = new Map<string, { companion_id: string; conversation_id: string; capability?: CompanionAction['capability'] } | undefined>();
    const noteEdges = new Map<string, { messages: string[]; notes: string[] }>();
    const eventEdges = new Map<string, { messages: string[]; events: string[] }>();
    const messageRow = (id: string) => {
      if (!messagesById.has(id)) messagesById.set(id, this.db.prepare('SELECT action_id,author_id,conversation_id FROM messages WHERE id=?').get(id) as { action_id?: string; author_id: string; conversation_id: string } | undefined);
      return messagesById.get(id);
    };
    const actionRow = (id: string) => {
      if (!actionsById.has(id)) {
        const found = this.db.prepare("SELECT companion_id,conversation_id,json_extract(data,'$.capability') AS capability FROM actions WHERE id=?").get(id) as {
          companion_id: string; conversation_id: string; capability?: string } | undefined;
        const capability = actionSchema.shape.capability.safeParse(parse(found?.capability));
        actionsById.set(id, found ? { companion_id: found.companion_id, conversation_id: found.conversation_id,
          ...(capability.success && capability.data ? { capability: capability.data } : {}) } : undefined);
      }
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
      let messageHead = 0, noteHead = 0, eventHead = 0;
      const enqueuedMessages = new Set(messages), enqueuedNotes = new Set<string>(), enqueuedEvents = new Set<string>();
      const enqueueMessages = (ids: readonly string[]) => { for (const id of ids) if (!enqueuedMessages.has(id)) { enqueuedMessages.add(id); messages.push(id); } };
      const enqueueNotes = (ids: readonly string[]) => { for (const id of ids) if (!enqueuedNotes.has(id)) { enqueuedNotes.add(id); notes.push(id); } };
      const enqueueEvents = (ids: readonly string[]) => { for (const id of ids) if (!enqueuedEvents.has(id)) { enqueuedEvents.add(id); events.push(id); } };
      const include = (proof: Omit<Proof, 'sourceMessageIds'>, supplied?: MessageObservation | ActionObservation): void => {
        const key = `${proof.kind}:${proof.id}`;
        if (supplied) { checkedReadsets.set(key, supplied.readset); ownedReadsets.add(key); }
        else if (!checkedReadsets.has(key)) {
          const parsed = companionExecutionReadsetSchema.safeParse(proof.executionReadset);
          checkedReadsets.set(key, parsed.success ? parsed.data : undefined);
        }
        proof.executionReadset = checkedReadsets.get(key);
        if (metadata(executionSourceInvalidKey(proof.kind, proof.id))) proof.invalidated = true;
        const cut = !expanded.has(key) && !proof.invalidated && proof.executionReadset ? supplied ?? (proof.kind === 'message'
          ? observePublishedDependencyCut(this.db, proof.id, proof.executionReadset, this.memory.sources.currentExecutionPath())
          : observePublishedActionDependencyCut(this.db, proof.id, proof.executionReadset, this.memory.sources.currentExecutionPath())) : undefined;
        const frontier: Array<{ proof: Omit<Proof, 'sourceMessageIds'>; observation: ActionObservation }> = [];
        let closed = !!cut;
        if (cut) for (const header of cut.volatileActions) {
          const action = actionRow(header.id), current = observePublishedActionDependencyCut(this.db, header.id, undefined, this.memory.sources.currentExecutionPath());
          if (!action || action.capability || action.companion_id !== header.companionId
            || action.conversation_id !== header.conversationId || !current || current.binding !== header.actionBindingHash
            || !current.assetOwners.every(owner => cut.assetOwners.includes(owner))
            || current.readsetDigest !== header.readsetDigest) {
            closed = false; break;
          }
          frontier.push({ proof: { kind: 'action', id: header.id, companionId: action.companion_id, conversationId: action.conversation_id, executionReadset: current.readset }, observation: current });
        }
        if (cut && closed) proof.publishedDependencyCut = { generation: cut.generation, bindingHash: cut.binding,
          assetOwners: [...cut.assetOwners], volatileActions: [...cut.volatileActions] };
        const previous = proofs.get(key);
        if (previous) { if (!previous.sourceMessageIds.includes(root)) previous.sourceMessageIds.push(root); }
        else proofs.set(key, { ...proof, sourceMessageIds: [root] });
        if (cut && closed) {
          // Historical publication is an immutable SQL leaf. Its exact legacy
          // action frontier remains visible to Main's unchanged file/live gates.
          for (const action of frontier) if (!(action.proof.kind === proof.kind && action.proof.id === proof.id)) include(action.proof, action.observation);
          return;
        }
        const readset = proof.executionReadset;
        if (!readset) return;
        enqueueMessages(readset.sources.map(source => source.id)); enqueueNotes(readset.memories.map(note => note.id));
        // Frozen task facts follow their original witnesses, never the note's
        // newly edited semantic graph.
        enqueueMessages((readset.frozenMemories ?? []).flatMap(note => note.sources.map(source => source.id)));
        for (const read of readset.knowledgeReads) { if (read.sourceType === 'memory') enqueueNotes([read.sourceId]); else if (read.sourceType === 'message') enqueueMessages([read.sourceId]); }
        for (const topic of readset.topics) enqueueEvents(topic.checkpointEventIds);
      };
      while (messageHead < messages.length || noteHead < notes.length || eventHead < events.length) {
        const id = messageHead < messages.length ? messages[messageHead++] : undefined;
        if (id && !seenMessages.has(id)) {
          seenMessages.add(id);
          const message = messageRow(id);
          if (message) {
            // Pre-upgrade completed conversations had no typed proof. Retain
            // their existing ACL/forget behavior; do not invent retrospective
            // evidence or claim their historical inputs were verified here.
            const indexed = message.author_id !== 'user' && message.author_id !== 'system' && !message.action_id && !expanded.has('message:' + id)
              ? observePublishedDependencyCut(this.db, id, undefined, this.memory.sources.currentExecutionPath()) : undefined;
            if (indexed) include({ kind: 'message', id, companionId: message.author_id, conversationId: message.conversation_id, executionReadset: indexed.readset }, indexed);
            else {
              const derived = metadata(executionMessageReadsetKey(id));
              if (derived !== undefined) include({ kind: 'message', id, companionId: message.author_id, conversationId: message.conversation_id, executionReadset: decoded<CompanionExecutionReadset>(executionMessageReadsetKey(id)) });
            }
            if (message.action_id) {
              const action = actionRow(message.action_id);
              // Capability cards are traces of their real parent/run, not old
              // DSH tasks. Their typed identity must reach Main's dedicated
              // validator even while running and without a task checkpoint.
              if (action) include({ kind: 'action', id: message.action_id, companionId: action.companion_id, conversationId: action.conversation_id,
                ...(action.capability ? { capability: action.capability }
                  : { executionReadset: decoded<CompanionExecutionReadset>('task-checkpoint/' + message.action_id) }) });
            }
            const observation = decoded<{ sources?: Array<{ id: string }>; topicCheckpoints?: Array<{ checkpointEventIds: string[] }> }>('memory-world-observation/' + id);
            enqueueMessages((observation?.sources ?? []).map(source => source.id));
            for (const reference of observation?.topicCheckpoints ?? []) enqueueEvents(reference.checkpointEventIds);
          }
        }
        const noteId = noteHead < notes.length ? notes[noteHead++] : undefined;
        if (noteId && !seenNotes.has(noteId)) {
          seenNotes.add(noteId);
          const edges = noteReferences(noteId);
          enqueueMessages(edges.messages); enqueueNotes(edges.notes);
        }
        const eventId = eventHead < events.length ? events[eventHead++] : undefined;
        if (eventId && !seenEvents.has(eventId)) {
          seenEvents.add(eventId);
          if (!eventEdges.has(eventId)) {
            const event = this.db.prepare('SELECT data FROM companion_topic_events WHERE id=?').get(eventId) as { data: string } | undefined;
            const checkpoint = parse<{ sourceMessageIds?: string[]; derivedFromEventIds?: string[]; state?: { __continuity?: { previousCheckpointEventId?: string } } }>(event?.data);
            eventEdges.set(eventId, { messages: checkpoint?.sourceMessageIds ?? [], events: [...checkpoint?.derivedFromEventIds ?? [],
              ...(checkpoint?.state?.__continuity?.previousCheckpointEventId ? [checkpoint.state.__continuity.previousCheckpointEventId] : [])] });
          }
          const edges = eventEdges.get(eventId)!;
          enqueueMessages(edges.messages); enqueueEvents(edges.events);
        }
      }
    }
    // Callers normally supply note.sources; this is also available for a
    // precise note-only read port without disclosing arbitrary note contents.
    if (memoryIds.length) {
      const sourceIds = [...new Set(memoryIds.flatMap(id => (this.db.prepare('SELECT message_id FROM vcp_note_sources WHERE note_id=?').all(id) as Array<{ message_id: string }>).map(source => source.message_id)))];
      for (const proof of this.resolve(sourceIds, [], expandPublishedSources)) if (!proofs.has(`${proof.kind}:${proof.id}`)) proofs.set(`${proof.kind}:${proof.id}`, proof);
    }
    const authorityEpochs = new Map<string, number>();
    const observed = [...proofs.values()].map(proof => {
      if (proof.invalidated || !proof.executionReadset) return proof;
      const digest = proof.kind === 'message' ? this.memory.sources.validatedMessageReadsetDigest(proof.id, proof.executionReadset)
        : this.memory.sources.validatedActionReadsetDigest(proof.id, proof.executionReadset);
      if (!digest) return proof;
      // This epoch attests SQL source inputs only. Main must independently
      // check live action collaboration/thought/lease authority on each gate.
      if (!authorityEpochs.has(proof.companionId)) authorityEpochs.set(proof.companionId, this.memory.lifecycleState(proof.companionId).revocationEpoch);
      return { ...proof, storageValidatedReadsetDigest: digest, storageValidatedAuthorityEpoch: authorityEpochs.get(proof.companionId)!,
        ...(proof.kind === 'message' ? this.publications.observe(proof.id, proof.executionReadset, digest)
          : { storageActionBinding: readPublishedActionFrontier(this.db, proof.id, proof.executionReadset) }) };
    });
    // Physical observations are private immutable SQL tuples. Only this exit
    // materializes a mutable external DTO, once per unique proof, after every
    // root has independently checked and retained its exact frontier links.
    return observed.map(proof => ownedReadsets.has(`${proof.kind}:${proof.id}`) ? structuredClone(proof) : proof);
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
      const capability = reference.kind === 'action' && this.db.prepare("SELECT 1 FROM actions WHERE id=? AND json_type(data,'$.capability')='object'").get(reference.id);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify({ invalidatedAt: new Date().toISOString(),
        ...(capability ? { validator: 'capability-v1' } : {}) }));
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
