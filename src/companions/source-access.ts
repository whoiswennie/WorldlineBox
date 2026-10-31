import { createHash } from 'node:crypto';
import { readVerifiedHostBehaviorReceipt } from './host-behavior-receipts';
import type { CompanionConnection } from './store';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { z } from 'zod';
import type { companionMemorySourceSchema, companionMemoryProhibitionSchema } from '../shared/companion-memory';
import { companionExecutionReadsetValidSync, executionMessageReadsetKey, executionReadsetFromJson, executionSourceInvalidKey } from './execution-source-access';
import { companionTopicCheckpointEventValid } from './topic-context';
import type { CompanionTopic } from '../shared/companion-topic';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';
export type CompanionSourceScope = {
    companionId: string;
    conversationId: string;
    beforeSequence?: number;
};
type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
export const companionSourceChecksum = (content: string) => createHash('sha256').update(content).digest('hex');
/** Message evidence and authorization only. No memory retrieval, facts or vector state. */
export class CompanionSourceAccess {
    private readonly executionPath = new Set<string>();
    private readonly statements = new Map<string, ReturnType<CompanionConnection['prepare']>>();
    private validation?: { stamp: string; values: Map<string, boolean>; active: Set<string> };
    constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage,
      private readonly memoryValid?: (owner: string, id: string, version: number, scope?: CompanionSourceScope) => boolean,
      private readonly sourcesBlocked?: (owner: string, ids: readonly string[]) => void) { }
    /** Reuse only compiled static SQL on this connection. Statement results,
     * bindings and authorization proofs are never retained by this cache. */
    private statement(sql: string): ReturnType<CompanionConnection['prepare']> {
        const existing = this.statements.get(sql);
        if (existing) {
            this.statements.delete(sql); this.statements.set(sql, existing);
            return existing;
        }
        const prepared = this.db.prepare(sql);
        if (this.statements.size >= 64) {
            const oldest = this.statements.keys().next().value;
            if (oldest !== undefined) this.statements.delete(oldest);
        }
        this.statements.set(sql, prepared);
        return prepared;
    }
    /** One synchronous top-level read owns this memo. Local and other-connection
     * writes invalidate completed results; it never survives a public read. */
    private validationStamp(): string {
        const changes = this.statement('SELECT total_changes() AS n').get() as { n: number };
        const version = this.statement('PRAGMA data_version').get() as { data_version: number };
        return `${changes.n}:${version.data_version}`;
    }
    /** Share completed proofs only inside one synchronous storage command.
     * Nested guards reuse it; the finally boundary never retains it for async
     * continuations or a later command. Every memo still rechecks DB mutation. */
    withValidation<T>(operation: () => T): T {
        if (this.validation) return operation();
        this.validation = { stamp: this.validationStamp(), values: new Map(), active: new Set() };
        try { return operation(); } finally { this.validation = undefined; }
    }
    private memo(key: string, operation: () => boolean, cycle = false): boolean {
        return this.withValidation(() => {
            const state = this.validation!, stamp = this.validationStamp();
            if (stamp !== state.stamp) { state.values.clear(); state.stamp = stamp; }
            // Active dependency paths always win over a completed cache value.
            if (state.active.has(key)) return cycle;
            const known = state.values.get(key); if (known !== undefined) return known;
            state.active.add(key);
            try {
                const result = operation(), current = this.validationStamp();
                if (current === stamp) state.values.set(key, result);
                else { state.values.clear(); state.stamp = current; }
                return result;
            } finally { state.active.delete(key); }
        });
    }
    private sourceKey(scope: CompanionSourceScope, source: Row): string {
        return JSON.stringify([scope.companionId, scope.conversationId, scope.beforeSequence ?? null, source.id, source.revision ?? 1,
          source.status, source.conversation_id, companionSourceChecksum(String(source.content))]);
    }
    /** Every row field consumed by formal/forgotten admission, including
     * detached rows passed by nested guards within the same SQL snapshot. */
    private sourceBindingKey(source: Row): string {
        return JSON.stringify([source.id, source.author_id, source.conversation_id, source.sequence, source.revision ?? 1,
          source.status, source.kind, source.action_id ?? null, source.reply_to_id ?? null,
          companionSourceChecksum(String(source.content)), source.request_fingerprint ?? null]);
    }
    /** Note dependencies and execution sources share one read-local validation
     * session, including mutation invalidation and active-path cycle rejection. */
    validateMemory(scope: CompanionSourceScope, note: Pick<CompanionMemory, 'id' | 'version' | 'companionId' | 'sourceConversationId'>, validate: () => boolean): boolean {
        return this.memo(JSON.stringify(['memory-visible', scope.companionId, scope.conversationId, scope.beforeSequence ?? null,
          note.id, note.version, note.companionId, note.sourceConversationId]), validate);
    }
    /** Historical passive input survives ordinary edits; original source
     * witnesses and explicit withdrawal remain authoritative. */
    frozenMemoryValid(scope: CompanionSourceScope, memory: NonNullable<CompanionExecutionReadset['frozenMemories']>[number]): boolean {
        return this.memo(JSON.stringify(['frozen-memory', scope.companionId, scope.conversationId, scope.beforeSequence ?? null, memory]), () => {
            try {
                this.requireScope(scope);
                const found = this.statement('SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=?').get(memory.id, scope.companionId);
                if (!found) return false;
                const note = json<{ status: string }>(row(found).data);
                if (!memory.sources.length) return false;
                if (memory.version !== undefined) {
                    const captured = this.statement('SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?').get(memory.id, memory.version);
                    if (memory.contentRevision === undefined || !captured || Number(row(captured).content_revision) !== memory.contentRevision) return false;
                }
                if (note.status === 'forgotten') {
                    // A source selector retires the latest mixed note, while
                    // an older body using only unrelated lawful sources may
                    // remain a valid fixed task input. Explicit note/tag forget
                    // retracts every revision in the history authority table.
                    const historical = memory.contentRevision === undefined ? undefined : this.statement(
                        "SELECT state FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?")
                        .get(scope.companionId, memory.id, memory.contentRevision);
                    if (!historical || row(historical).state === 'retracted') return false;
                }
                if (memory.contentRevision !== undefined) {
                    const saved = this.statement('SELECT data FROM companion_memory_content_revisions WHERE note_id=? AND companion_id=? AND content_revision=?')
                        .get(memory.id, scope.companionId, memory.contentRevision);
                    if (!saved) return false;
                    const revision = json<{ memory: CompanionMemory; dependencies: Array<{ id: string; contentRevision: number }> }>(row(saved).data);
                    const refs = revision.memory.sources;
                    if (refs.length !== memory.sources.length || refs.some(source => !memory.sources.some(reference => reference.id === source.messageId
                        && reference.conversationId === source.conversationId && reference.checksum === source.checksum))) return false;
                    for (const dependency of revision.dependencies) {
                        const stored = this.statement('SELECT data FROM companion_memory_content_revisions WHERE note_id=? AND companion_id=? AND content_revision=?')
                            .get(dependency.id, scope.companionId, dependency.contentRevision);
                        if (!stored) return false;
                        const historical = json<{ memory: CompanionMemory }>(row(stored).data).memory;
                        if (!this.frozenMemoryValid(scope, { id: dependency.id, contentRevision: dependency.contentRevision,
                            sources: historical.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum,
                                ...(memory.sources.some(reference => reference.revision !== undefined) ? { revision: source.revision } : {}) })) })) return false;
                    }
                }
                for (const reference of memory.sources) {
                    if (!this.statement('SELECT 1 FROM vcp_note_source_history WHERE note_id=? AND message_id=?').get(memory.id, reference.id)) return false;
                    const source = this.statement('SELECT * FROM messages WHERE id=?').get(reference.id);
                    if (!source || row(source).conversation_id !== reference.conversationId
                        || (reference.revision !== undefined && Number(row(source).revision ?? 1) !== reference.revision)
                        || companionSourceChecksum(String(row(source).content)) !== reference.checksum) return false;
                    const entrance = { ...scope, conversationId: reference.conversationId };
                    this.requireScope(entrance);
                    if (!this.visible(entrance, row(source))) return false;
                }
                return true;
            } catch { return false; }
        });
    }
    /** Attest only a current stored message's exact typed readset. Main still
     * checks async file/model/context dependencies and its mutation generation. */
    validatedMessageReadsetDigest(id: string, expected: CompanionExecutionReadset): string | undefined {
        return this.withValidation(() => {
            const before = this.validationStamp();
            const source = this.statement('SELECT * FROM messages WHERE id=?').get(id);
            const stored = this.statement('SELECT value FROM metadata WHERE key=?').get(executionMessageReadsetKey(id));
            const readset = stored ? executionReadsetFromJson(String(row(stored).value)) : undefined;
            const bytes = JSON.stringify(expected);
            if (!source || row(source).author_id !== expected.companionId || row(source).conversation_id !== expected.conversationId
                || !readset || JSON.stringify(readset) !== bytes || !this.formal(row(source))) return;
            if (!this.readsetScopeValid(readset) || before !== this.validationStamp()) return;
            return companionSourceChecksum(bytes);
        });
    }
    /** Exact action checkpoint projection, with the same SQL source/cursor
     * checks as completed messages. Main still validates live collaboration,
     * thought leases, model/context and external-file dependencies. */
    validatedActionReadsetDigest(id: string, expected: CompanionExecutionReadset): string | undefined {
        return this.withValidation(() => {
            const before = this.validationStamp();
            const action = this.statement('SELECT companion_id,conversation_id,status FROM actions WHERE id=?').get(id);
            const stored = this.statement("SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.executionReadset') END AS value FROM metadata WHERE key=?").get('task-checkpoint/' + id);
            const readset = stored ? executionReadsetFromJson(row(stored).value == null ? undefined : String(row(stored).value)) : undefined;
            const bytes = JSON.stringify(expected);
            if (!action || row(action).companion_id !== expected.companionId || row(action).conversation_id !== expected.conversationId
                || !['succeeded', 'failed', 'cancelled'].includes(String(row(action).status)) || !readset || JSON.stringify(readset) !== bytes
                || !this.executionValid('action', id, expected.companionId, expected.conversationId, readset)
                || !this.readsetScopeValid(readset) || before !== this.validationStamp()) return;
            return companionSourceChecksum(bytes);
        });
    }
    private readsetScopeValid(readset: CompanionExecutionReadset): boolean {
            // Match Main's exact SQLite ports, including each room entrance
            // and the captured memory cursor. An owner entrance alone cannot
            // certify a departed source room or a note newer than that cursor.
            for (const reference of readset.sources) {
                const scope = { companionId: readset.companionId, conversationId: reference.conversationId };
                const current = this.statement('SELECT * FROM messages WHERE id=?').get(reference.id);
                if (!current || row(current).conversation_id !== reference.conversationId
                    || companionSourceChecksum(String(row(current).content)) !== reference.checksum) return false;
                try { this.requireScope(scope); } catch { return false; }
                if (!this.visible(scope, row(current))) return false;
            }
            const memoryScope = { companionId: readset.companionId, conversationId: readset.conversationId, beforeSequence: readset.beforeSequence };
            if (readset.memoryReads?.some(memory => !this.frozenMemoryValid(memoryScope, memory))) return false;
            if (readset.memories.some(note => !readset.memoryReads?.some(read => read.id === note.id && read.version === note.version)
              && this.memoryValid?.(readset.companionId, note.id, note.version, memoryScope) !== true)) return false;
            if (readset.frozenMemories?.some(memory => !this.frozenMemoryValid(memoryScope, memory))) return false;
            for (const reference of readset.topics) {
                const scope = { companionId: readset.companionId, conversationId: reference.conversationId };
                try { this.requireScope(scope); } catch { return false; }
                const found = this.statement('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(reference.topicId, reference.conversationId);
                const topic = found ? json<CompanionTopic>(row(found).data) : undefined;
                if (!topic || topic.deletedAt || !topic.participantIds.includes(readset.companionId) && !topic.invitedIds.includes(readset.companionId)
                    || !this.checkpointSourcesValid(scope, reference.sourceMessageIds)) return false;
            }
            return true;
    }
    private executionValid(kind: 'action' | 'message', id: string, owner: string, room: string, readset: unknown): boolean {
        const key = `${kind}:${id}`;
        if (this.executionPath.has(key) || this.statement('SELECT 1 FROM metadata WHERE key=?').get(executionSourceInvalidKey(kind, id))) return false;
        return this.memo(JSON.stringify(['execution', kind, id, owner, room, companionSourceChecksum(JSON.stringify(readset) ?? '')]), () => {
        this.executionPath.add(key);
        try { return companionExecutionReadsetValidSync(this.db, readset, owner, room, {
            sourceValid: (owner, sourceRoom, sourceId, checksum) => {
                const source = this.statement('SELECT * FROM messages WHERE id=?').get(sourceId);
                return !!source && String(row(source).conversation_id) === sourceRoom && companionSourceChecksum(String(row(source).content)) === checksum && this.visible(this.ownerScope(owner), row(source));
            }, memoryValid: (owner, id, version) => this.memoryValid?.(owner, id, version) === true,
            frozenMemoryValid: (owner, memory) => this.frozenMemoryValid({ companionId: owner, conversationId: room }, memory),
            topicSourcesValid: (owner, conversationId, ids) => this.checkpointSourcesValid({ companionId: owner, conversationId }, ids),
        }); } finally { this.executionPath.delete(key); }
        });
    }
    initialize(): void {
        this.statements.clear();
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vcp_source_observers(message_id TEXT NOT NULL REFERENCES messages(id),companion_id TEXT NOT NULL REFERENCES companions(id),PRIMARY KEY(message_id,companion_id));
      CREATE TABLE IF NOT EXISTS vcp_source_blocks(message_id TEXT NOT NULL REFERENCES messages(id),companion_id TEXT NOT NULL REFERENCES companions(id),created_at TEXT NOT NULL,PRIMARY KEY(message_id,companion_id));
      CREATE TABLE IF NOT EXISTS vcp_source_prohibitions(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,tag TEXT NOT NULL,through_sequence INTEGER NOT NULL,persistent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vcp_source_prohibition_requests(prohibition_id TEXT NOT NULL REFERENCES vcp_source_prohibitions(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(prohibition_id,message_id));
      CREATE TABLE IF NOT EXISTS vcp_source_prohibition_releases(prohibition_id TEXT PRIMARY KEY REFERENCES vcp_source_prohibitions(id) ON DELETE CASCADE,released_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS vcp_source_management_message ON vcp_source_prohibition_requests(message_id);
      CREATE INDEX IF NOT EXISTS vcp_source_observer_owner ON vcp_source_observers(companion_id,message_id);
      CREATE INDEX IF NOT EXISTS vcp_source_prohibition_owner ON vcp_source_prohibitions(companion_id,conversation_id);
    `);
    }
    requireScope(scope: CompanionSourceScope): Row {
        if (!this.statement('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId))
            throw new Error('伙伴不存在。');
        const conversation = this.statement('SELECT * FROM conversations WHERE id=?').get(scope.conversationId);
        if (!conversation || !this.statement('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId))
            throw new Error('伙伴不是聊天成员。');
        return row(conversation);
    }
    /** Existing host-owned entrance, never opens or creates a conversation. */
    ownerScope(companionId: string): CompanionSourceScope {
        const found = this.statement(`SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id=c.id
          WHERE m.companion_id=? ORDER BY CASE WHEN c.id=? THEN 0 WHEN c.kind='private' THEN 1 ELSE 2 END,c.rowid LIMIT 1`)
            .get(companionId, 'world_' + companionId);
        return { companionId, conversationId: found ? String(row(found).id) : 'world_' + companionId };
    }
    observe(messageId: string, companionId: string): void {
        this.statement('INSERT OR IGNORE INTO vcp_source_observers(message_id,companion_id) VALUES(?,?)').run(messageId, companionId);
    }
    worldScope(conversationId: string): boolean { return !!this.statement('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + conversationId); }
    managementSource(messageId: string): boolean { return !!this.statement('SELECT 1 FROM vcp_source_prohibition_requests WHERE message_id=? LIMIT 1').get(messageId); }
    logicalDomain(messageId: string): string {
        const observation = this.statement('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + messageId);
        if (observation) return json<{ forConversationId: string }>(row(observation).value).forConversationId;
        const source = this.statement('SELECT conversation_id FROM messages WHERE id=?').get(messageId);
        if (!source) throw new Error('记忆来源不存在。');
        return String(row(source).conversation_id);
    }
    formal(source: Row): boolean {
        // An earlier completed result must never certify its own active
        // message/action dependency. These guards precede even a memo hit.
        if (this.executionPath.has('message:' + source.id)
            || source.action_id && this.executionPath.has('action:' + source.action_id)) return false;
        return this.memo('formal:' + this.sourceBindingKey(source), () => this.formalValue(source));
    }
    private formalValue(source: Row): boolean {
        const derived = this.statement('SELECT value FROM metadata WHERE key=?').get(executionMessageReadsetKey(String(source.id)));
        if (derived && !this.executionValid('message', String(source.id), String(source.author_id), String(source.conversation_id), executionReadsetFromJson(String(row(derived).value)))) return false;
        if (this.statement('SELECT 1 FROM metadata WHERE key=?').get(executionSourceInvalidKey('message', String(source.id)))) return false;
        const manual = this.statement('SELECT value FROM metadata WHERE key=?').get('vcp-manual-input/' + source.id);
        if (manual)
            return source.author_id === 'user' && source.kind === 'notice' && source.status === 'sent'
                && json<{
                    checksum: string;
                }>(row(manual).value).checksum === companionSourceChecksum(String(source.content));
        const observation = this.statement('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + source.id);
        if (observation)
            return source.author_id === 'system' && source.kind === 'notice'
                && json<{
                    checksum: string;
                }>(row(observation).value).checksum === companionSourceChecksum(String(source.content));
        if (source.status !== 'sent' || source.author_id === 'system' || source.kind === 'notice')
            return false;
        if (source.kind === 'action' || source.action_id) {
            const action = source.action_id ? this.statement('SELECT data,status FROM actions WHERE id=?').get(source.action_id) : undefined;
            if (!action || !['succeeded', 'failed', 'cancelled'].includes(String(row(action).status)))
                return false;
            const result = json<{
                id: string; companionId: string; conversationId: string;
                result?: string;
                error?: string;
                capability?: unknown;
            }>(row(action).data);
            if (result.id !== source.action_id) return false;
            // A visible tool-process card is not itself an experience source.
            // Memory may use the parent's formal reply or an actual admitted
            // result, never a capability trace with an invented DSH proof.
            if (result.capability) return false;
            const checkpoint = this.statement("SELECT CASE WHEN json_valid(value) THEN json_extract(value,'$.executionReadset') END AS value FROM metadata WHERE key=?").get('task-checkpoint/' + result.id);
            const readset = checkpoint ? executionReadsetFromJson(row(checkpoint).value == null ? undefined : String(row(checkpoint).value)) : undefined;
            return !!(result.result || result.error) && this.executionValid('action', result.id, result.companionId, result.conversationId, readset);
        }
        // A completed loop can contain the entire model context and tool log.
        // Source admission needs its status only, never those historical bytes.
        const loop = this.statement("SELECT json_extract(value,'$.status') AS status FROM metadata WHERE key=?").get('message-loop/' + source.id);
        if (loop)
            return row(loop).status === 'done';
        const fingerprint = source.request_fingerprint ? json<{
            loopStep?: number;
        }>(source.request_fingerprint) : undefined;
        return fingerprint?.loopStep === undefined;
    }
    reference(source: Row): z.infer<typeof companionMemorySourceSchema> {
        const hostBehavior = readVerifiedHostBehaviorReceipt(this.db, source);
        const manual = this.statement('SELECT 1 FROM metadata WHERE key=?').get('vcp-manual-input/' + source.id);
        const observation = this.statement('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + source.id);
        const publication = this.statement('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + source.id);
        const worldTime = this.statement('SELECT world_at FROM companion_message_times WHERE message_id=?').get(source.id);
        const assetReadId = observation ? json<{ assetRead?: string }>(row(observation).value).assetRead : undefined;
        const assetRead = assetReadId ? this.statement('SELECT 1 FROM companion_learning_reads WHERE source_message_id=? AND id=?').get(source.id, assetReadId) : undefined;
        return { sourceType: manual ? 'manual_input' : assetRead ? 'asset_read' : observation ? 'world_observation' : 'message', messageId: String(source.id), conversationId: String(source.conversation_id),
            sequence: Number(source.sequence), authorId: String(source.author_id), revision: Number(source.revision ?? 1),
            checksum: companionSourceChecksum(String(source.content)), createdAt: String(source.created_at),
            ...(worldTime ? { worldCreatedAt: String(row(worldTime).world_at) } : {}), ...(publication ? { publishedAfterSequence: Number(row(publication).value) } : {}),
            ...(hostBehavior ? { hostBehavior } : {}) };
    }
    blockedTag(scope: CompanionSourceScope, tags: readonly string[], sequence: number): boolean {
        return this.statement('SELECT tag,through_sequence,persistent FROM vcp_source_prohibitions WHERE companion_id=? AND (conversation_id=? OR conversation_id=\'*\')').all(scope.companionId, scope.conversationId)
            .some(value => {
            const rule = row(value);
            return (rule.persistent || sequence <= Number(rule.through_sequence))
                && tags.some(tag => tag.normalize('NFKC').toLocaleLowerCase() === String(rule.tag).normalize('NFKC').toLocaleLowerCase());
        });
    }
    prohibitions(scope: CompanionSourceScope): Array<z.infer<typeof companionMemoryProhibitionSchema>> {
        try { this.requireScope(scope); }
        catch (error) {
            // A departed room still identifies the policies of this owner's
            // actually captured sources. Public callers validate their current
            // entrance before requesting this internal provenance lookup.
            this.requireScope(this.ownerScope(scope.companionId));
            if (!this.statement('SELECT 1 FROM vcp_memory_scopes WHERE companion_id=? AND conversation_id=?').get(scope.companionId, scope.conversationId)) throw error;
        }
        return this.statement("SELECT id,tag,conversation_id,through_sequence,persistent FROM vcp_source_prohibitions WHERE companion_id=? AND conversation_id IN(?,'*') ORDER BY id").all(scope.companionId, scope.conversationId)
            .map(value => {
                const rule = row(value);
                return { id: String(rule.id), tags: [String(rule.tag)], conversationId: String(rule.conversation_id),
                    persistent: !!rule.persistent, throughSequence: Number(rule.through_sequence) };
            });
    }
    prohibitionRevision(scope: CompanionSourceScope): string {
        return createHash('sha256').update(JSON.stringify(this.prohibitions(scope))).digest('hex');
    }
    assertProhibitionRevision(scope: CompanionSourceScope, expected?: string): void {
        if (expected !== undefined && expected !== this.prohibitionRevision(scope)) throw new Error('记忆禁记规则已变化，请重新核对主题范围。');
    }
    forgotten(scope: CompanionSourceScope, source: Row, visited = new Set<string>()): boolean {
        if (visited.has(String(source.id))) return true;
        // Withdrawal follows this owner's original source ancestry. A reader's
        // current entrance/cursor does not change whether it was forgotten.
        return this.memo(JSON.stringify(['forgotten', scope.companionId, this.sourceBindingKey(source)]), () => this.forgottenValue(scope, source, visited), true);
    }
    private forgottenValue(scope: CompanionSourceScope, source: Row, visited: Set<string>): boolean {
        const id = String(source.id);
        if (visited.has(id))
            return true;
        visited.add(id);
        if (this.statement('SELECT 1 FROM vcp_source_blocks WHERE message_id=? AND companion_id=?').get(id, scope.companionId))
            return true;
        const blocked = this.statement('SELECT tag,through_sequence,persistent FROM vcp_source_prohibitions p WHERE companion_id=? AND (conversation_id=? OR conversation_id=\'*\') AND NOT EXISTS(SELECT 1 FROM vcp_source_prohibition_requests r WHERE r.prohibition_id=p.id AND r.message_id=?)').all(scope.companionId, source.conversation_id, id)
            .some(value => {
            const rule = row(value);
            return (rule.persistent || Number(source.sequence) <= Number(rule.through_sequence))
                && String(source.content).normalize('NFKC').toLocaleLowerCase().includes(String(rule.tag).normalize('NFKC').toLocaleLowerCase());
        });
        if (blocked)
            return true;
        const ancestors = new Set<string>();
        if (source.author_id !== 'user' && source.reply_to_id)
            ancestors.add(String(source.reply_to_id));
        if (source.author_id !== 'user') {
            const loop = this.statement("SELECT json_extract(value,'$.sourceMessageId') AS source_message_id FROM metadata WHERE key=?").get('message-loop/' + id);
            if (loop)
                if (typeof row(loop).source_message_id === 'string') ancestors.add(String(row(loop).source_message_id));
        }
        if (source.action_id) {
            const action = this.statement('SELECT data FROM actions WHERE id=?').get(source.action_id);
            if (action)
                ancestors.add(json<{
                    sourceMessageId: string;
                }>(row(action).data).sourceMessageId);
        }
        for (const ancestorId of ancestors) {
            const ancestor = this.statement('SELECT * FROM messages WHERE id=?').get(ancestorId);
            if (ancestor && this.forgotten(scope, row(ancestor), new Set(visited)))
                return true;
        }
        return false;
    }
    visible(scope: CompanionSourceScope, source: Row, visited = new Set<string>(), sharedCheckpoint = false): boolean {
        if (visited.has(String(source.id))) return false;
        return this.memo('visible:' + this.sourceKey(scope, source) + ':' + sharedCheckpoint, () => this.visibleValue(scope, source, visited, sharedCheckpoint));
    }
    private visibleValue(scope: CompanionSourceScope, source: Row, visited: Set<string>, sharedCheckpoint: boolean): boolean {
        this.requireScope(scope);
        const id = String(source.id);
        if (visited.has(id))
            return false;
        visited.add(id);
        if (this.statement(`SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id
          WHERE m.message_id=? AND json_extract(t.data,'$.deletedAt') IS NOT NULL`).get(id)) return false;
        const observationRow = this.statement('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + id);
        const observation = observationRow ? json<{
            companionId: string;
            forConversationId: string;
            throughSequence?: number;
            assetRead?: string;
            topicCheckpoints?: Array<{ conversationId: string; topicId: string; readerId: string; checkpointEventIds: string[] }>;
            observation?: { category?: string };
            sources: Array<{
                id: string;
                conversationId: string;
                checksum: string;
            }>;
        }>(row(observationRow).value) : undefined;
        // Index receipts can contain topic summaries and this reader's working
        // state without raw-message references. Deletion revokes that old body;
        // sanitized actual participation receipts remain separate experiences.
        if (observation?.observation?.category === 'topics' && !Array.isArray(observation.topicCheckpoints)) return false;
        if (observation?.observation?.category === 'topics' && this.statement(`SELECT 1 FROM json_each(?, '$.items') item
          JOIN companion_topics topic ON topic.id=json_extract(item.value,'$.topicId')
          WHERE json_extract(topic.data,'$.deletedAt') IS NOT NULL LIMIT 1`).get(source.content)) return false;
        if (observation?.assetRead && !this.statement("SELECT 1 FROM companion_learning_reads r JOIN companion_learning_grants g ON g.id=r.grant_id WHERE r.id=? AND r.source_message_id=? AND r.companion_id=? AND r.status='read' AND g.enabled=1").get(observation.assetRead, id, scope.companionId)) return false;
        for (const reference of observation?.topicCheckpoints ?? []) {
            if (reference.readerId !== scope.companionId || reference.readerId !== observation!.companionId) return false;
            try {
                const topicScope = { companionId: scope.companionId, conversationId: reference.conversationId };
                this.requireScope(topicScope);
                const found = this.statement('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(reference.topicId, reference.conversationId);
                const topic = found ? json<CompanionTopic>(row(found).data) : undefined;
                if (!topic || !reference.checkpointEventIds.length || !reference.checkpointEventIds.every(eventId => companionTopicCheckpointEventValid(this.db, topic, scope.companionId, eventId,
                    ids => ids.every(sourceId => {
                        const source = this.statement('SELECT * FROM messages WHERE id=?').get(sourceId);
                        return !!source && this.visible(topicScope, row(source), new Set(visited), true);
                    })))) return false;
            } catch { return false; }
        }
        if (observation && (observation.companionId !== scope.companionId
            || observation.sources.some(reference => {
                const original = this.statement('SELECT * FROM messages WHERE id=?').get(reference.id);
                return !original || companionSourceChecksum(String(row(original).content)) !== reference.checksum
                    || !this.visible(scope, row(original), new Set(visited));
            })))
            return false;
        const currentObservation = !!observation && observation.forConversationId === scope.conversationId
            && (scope.beforeSequence === undefined || observation.throughSequence !== undefined && observation.throughSequence <= scope.beforeSequence);
        if (this.statement("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(source.author_id)
            || this.statement("SELECT 1 FROM companion_reset_rooms s JOIN companion_reset_jobs j ON j.id=s.job_id WHERE s.conversation_id=? AND j.status!='completed' LIMIT 1").get(source.conversation_id)
            || this.statement('SELECT 1 FROM companion_reset_messages WHERE message_id=? LIMIT 1').get(id))
            return false;
        const boundary = this.statement('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(scope.companionId);
        if (boundary && Number(source.sequence) <= Number(row(boundary).through_sequence))
            return false;
        if (this.statement("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(scope.companionId))
            return false;
        if (!currentObservation && scope.beforeSequence !== undefined && Number(source.sequence) > scope.beforeSequence)
            return false;
        const publication = this.statement('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + id);
        if (scope.beforeSequence !== undefined && publication && scope.beforeSequence <= Number(row(publication).value))
            return false;
        // Conversation is an interaction entrance, not a second identity. The
        // persisted observer is the proof this owner actually witnessed a source;
        // joining a room later must never make its old messages knowable.
        if (!sharedCheckpoint && !this.statement('SELECT 1 FROM vcp_source_observers WHERE message_id=? AND companion_id=?').get(id, scope.companionId))
            return false;
        return this.formal(source) && !this.forgotten(scope, source);
    }
    /** Topic ACL grants the derived checkpoint, never the original messages.
     * Late invitees may read shared stages without witnessing old raw chat;
     * their own withdrawals and all source lifecycle checks still apply. */
    checkpointSourcesValid(scope: CompanionSourceScope, ids: readonly string[]): boolean {
        return this.withValidation(() => {
        this.requireScope(scope);
        return ids.every(id => {
            const source = this.statement('SELECT * FROM messages WHERE id=?').get(id);
            return !!source && this.visible(scope, row(source), new Set<string>(), true);
        });
        });
    }
    filter(scope: CompanionSourceScope, ids: readonly string[]): CompanionMessage[] {
        return this.withValidation(() => {
        this.requireScope(scope);
        return [...new Set(ids)].flatMap(id => {
            const source = this.statement('SELECT * FROM messages WHERE id=?').get(id);
            return source && this.visible(scope, row(source)) ? [this.getMessage(id)] : [];
        });
        });
    }
    block(companionId: string, ids: readonly string[]): void {
      this.db.transaction(() => {
        const changed: string[] = [];
        for (const id of new Set(ids))
            if (this.statement('INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(id, companionId, new Date().toISOString()).changes) changed.push(id);
        if (changed.length) this.sourcesBlocked?.(companionId, changed);
      }).immediate();
    }
}
