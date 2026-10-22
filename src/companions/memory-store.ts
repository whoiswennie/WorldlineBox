import { createHash, randomUUID } from 'node:crypto';
import { companionMemoryCandidateSchema, companionMemorySearchSchema, companionMemoryForgetSchema, type CompanionMemoryCandidate, type CompanionMemoryJob, type CompanionMemorySearch, type CompanionMemoryPage } from '../shared/companion-memory';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, SaveCompanionMemory } from '../shared/companion-storage';
import type { CompanionStateProposal } from '../shared/companion-state';
import type { CompanionConnection } from './store';
import { CompanionSourceAccess, companionSourceChecksum, type CompanionSourceScope as Scope } from './source-access';
import { retireFactMemory } from './memory-migration';
import { initializeMemoryProcessingJournal, memoryProcessingStatus } from './memory-processing-store';
type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const rows = (value: unknown[]) => value.map(row);
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
const stamp = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Host journal ledger, evidence and delivery. Memory retrieval belongs exclusively to VCP. */
export class CompanionMemoryStore {
    private readonly invalidatedOwners = new Set<string>();
    private readonly invalidatedScopes = new Set<string>();
    invalidateOwner(id: string): void {
        if (this.invalidatedOwners.has(id)) return;
        this.invalidatedOwners.add(id);
        this.db.prepare('INSERT INTO vcp_memory_management_epochs VALUES(?,1) ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1').run(id);
        for (const scope of rows(this.db.prepare('SELECT scope_id FROM vcp_memory_scopes WHERE companion_id=?').all(id))) this.invalidatedScopes.add(String(scope.scope_id));
    }
    takeInvalidatedOwners(): string[] { const ids = [...this.invalidatedOwners]; this.invalidatedOwners.clear(); return ids; }
    takeInvalidatedScopes(): string[] { const ids = [...this.invalidatedScopes]; this.invalidatedScopes.clear(); return ids; }
    readonly sources: CompanionSourceAccess;
    constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage, private readonly applyState?: (scope: Scope, proposal: CompanionStateProposal) => void, private readonly observeNote?: (note: CompanionMemory) => void, private readonly withdrawStateSources?: (companionId: string, sourceIds: string[]) => void) { this.sources = new CompanionSourceAccess(db, getMessage); }
    initialize(): void {
        this.sources.initialize();
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vcp_memory_scopes(scope_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vcp_memory_notes(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL,scope_id TEXT NOT NULL REFERENCES vcp_memory_scopes(scope_id),identity_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(companion_id,identity_key));
      CREATE INDEX IF NOT EXISTS vcp_note_scope ON vcp_memory_notes(companion_id,conversation_id);
      CREATE INDEX IF NOT EXISTS vcp_note_live_owner ON vcp_memory_notes(companion_id,json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS vcp_note_sources(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),revision INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(note_id,message_id));
      CREATE INDEX IF NOT EXISTS vcp_note_source_message ON vcp_note_sources(message_id,note_id);
      CREATE TABLE IF NOT EXISTS vcp_note_source_history(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(note_id,message_id));
      CREATE INDEX IF NOT EXISTS vcp_note_history_message ON vcp_note_source_history(message_id,note_id);
      INSERT OR IGNORE INTO vcp_note_source_history SELECT note_id,message_id FROM vcp_note_sources;
      CREATE TABLE IF NOT EXISTS vcp_note_dependencies(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,source_note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id),version INTEGER NOT NULL,PRIMARY KEY(note_id,source_note_id));
      CREATE INDEX IF NOT EXISTS vcp_note_dependency_source ON vcp_note_dependencies(source_note_id,note_id);
      CREATE TABLE IF NOT EXISTS vcp_capture_jobs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),source_sequence INTEGER NOT NULL,through_sequence INTEGER NOT NULL,source_checksum TEXT NOT NULL,source_revision INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(companion_id,message_id,source_revision,source_checksum));
      CREATE INDEX IF NOT EXISTS vcp_capture_claim ON vcp_capture_jobs(status,next_attempt,ordinal);
      CREATE TABLE IF NOT EXISTS vcp_memory_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,scope_id TEXT NOT NULL,note_id TEXT NOT NULL,note_version INTEGER NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(note_id,note_version,operation));
      CREATE INDEX IF NOT EXISTS vcp_memory_outbox_claim ON vcp_memory_outbox(status,next_attempt,ordinal);
      CREATE INDEX IF NOT EXISTS vcp_memory_outbox_owner_ordinal ON vcp_memory_outbox(companion_id,ordinal);
      CREATE INDEX IF NOT EXISTS vcp_note_library_key ON vcp_memory_notes(companion_id,id);
      CREATE TABLE IF NOT EXISTS vcp_memory_management_epochs(companion_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vcp_memory_management_totals(companion_id TEXT PRIMARY KEY,total INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS vcp_management_note_insert AFTER INSERT ON vcp_memory_notes WHEN json_extract(NEW.data,'$.status') IN('queued','indexed') BEGIN
        INSERT INTO vcp_memory_management_totals VALUES(NEW.companion_id,1) ON CONFLICT(companion_id) DO UPDATE SET total=total+1;
      END;
      CREATE TRIGGER IF NOT EXISTS vcp_management_note_update AFTER UPDATE OF data ON vcp_memory_notes
        WHEN (json_extract(NEW.data,'$.status') IN('queued','indexed')) != (json_extract(OLD.data,'$.status') IN('queued','indexed')) BEGIN
        INSERT INTO vcp_memory_management_totals VALUES(NEW.companion_id,0) ON CONFLICT(companion_id) DO NOTHING;
        UPDATE vcp_memory_management_totals SET total=MAX(0,total+(json_extract(NEW.data,'$.status') IN('queued','indexed'))-(json_extract(OLD.data,'$.status') IN('queued','indexed'))) WHERE companion_id=NEW.companion_id;
      END;
      CREATE TRIGGER IF NOT EXISTS vcp_management_note_delete AFTER DELETE ON vcp_memory_notes WHEN json_extract(OLD.data,'$.status') IN('queued','indexed') BEGIN
        UPDATE vcp_memory_management_totals SET total=MAX(0,total-1) WHERE companion_id=OLD.companion_id;
      END;
      CREATE TRIGGER IF NOT EXISTS vcp_management_membership_delete AFTER DELETE ON conversation_members BEGIN
        INSERT INTO vcp_memory_management_epochs VALUES(OLD.companion_id,1) ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS vcp_management_membership_insert AFTER INSERT ON conversation_members BEGIN
        INSERT INTO vcp_memory_management_epochs VALUES(NEW.companion_id,1) ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TRIGGER IF NOT EXISTS vcp_management_conversation_dissolve AFTER UPDATE OF dissolved_at ON conversations WHEN NEW.dissolved_at IS NOT OLD.dissolved_at BEGIN
        INSERT INTO vcp_memory_management_epochs SELECT companion_id,1 FROM conversation_members WHERE conversation_id=NEW.id
          ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1;
      END;
      CREATE TABLE IF NOT EXISTS vcp_operation_receipts(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,response TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata(key,value) VALUES('vcp-capture-backfill-through','0');
      INSERT OR IGNORE INTO metadata(key,value) SELECT 'vcp-capture-backfill-target',CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages;
    `);
        if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='vcp-management-totals-ready'").get()) this.db.transaction(() => {
            this.db.prepare("INSERT OR REPLACE INTO vcp_memory_management_totals SELECT companion_id,COUNT(*) FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed') GROUP BY companion_id").run();
            this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('vcp-management-totals-ready','1')").run();
        }).immediate();
        retireFactMemory(this.db);
        initializeMemoryProcessingJournal(this.db, ['capture', 'index']);
    }
    private scope(owner: string, conversationId: string): string {
        const id = 'scope_' + hash([owner, conversationId]).slice(0, 48);
        this.db.prepare("INSERT OR IGNORE INTO vcp_memory_scopes VALUES(?,?,?,1,'ready',?)").run(id, owner, conversationId, stamp());
        return id;
    }
    private load(id: string): CompanionMemory {
        const found = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(id);
        if (!found)
            throw new Error('VCP 日记不存在。');
        return json<CompanionMemory>(row(found).data);
    }
    private persist(note: CompanionMemory, identity?: string): void {
        if (identity)
            this.db.prepare('INSERT INTO vcp_memory_notes VALUES(?,?,?,?,?,?)').run(note.id, note.companionId, note.sourceConversationId, note.scopeId, identity, JSON.stringify(note));
        else
            this.db.prepare('UPDATE vcp_memory_notes SET data=? WHERE id=?').run(JSON.stringify(note), note.id);
        this.db.prepare('DELETE FROM vcp_note_sources WHERE note_id=?').run(note.id);
        for (const source of note.sources) {
            this.db.prepare('INSERT INTO vcp_note_sources VALUES(?,?,?,?)').run(note.id, source.messageId, source.revision, source.checksum);
            this.db.prepare('INSERT OR IGNORE INTO vcp_note_source_history VALUES(?,?)').run(note.id, source.messageId);
        }
    }
    private enqueue(note: CompanionMemory, operation: 'remember' | 'forget'): void {
        this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version<? AND status!='running'").run(note.id, note.version);
        this.db.prepare('INSERT OR IGNORE INTO vcp_memory_outbox(id,companion_id,scope_id,note_id,note_version,operation,data) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), note.companionId, note.scopeId, note.id, note.version, operation, JSON.stringify({ noteId: note.id, version: note.version }));
        this.db.prepare("UPDATE vcp_memory_scopes SET revision=revision+1,state='dirty',updated_at=? WHERE scope_id=?").run(stamp(), note.scopeId);
    }
    private visible(scope: Scope, note: CompanionMemory, visited = new Set<string>()): boolean {
        const room = this.sources.requireScope(scope);
        if (visited.has(note.id))
            return false;
        visited.add(note.id);
        if (note.companionId !== scope.companionId || ['forgotten', 'invalid'].includes(note.status) || (room.kind === 'group' || this.sources.worldScope(scope.conversationId)) && note.sourceConversationId !== scope.conversationId || !note.sources.length
            || this.sources.captureHeld(note.companionId, note.sourceConversationId))
            return false;
        if (this.sources.blockedTag({ ...scope, conversationId: note.sourceConversationId }, note.tags, note.sourceSequence))
            return false;
        if (!note.sources.every(reference => { const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reference.messageId); return source && Number(row(source).revision ?? 1) === reference.revision && companionSourceChecksum(String(row(source).content)) === reference.checksum && this.sources.visible(scope, row(source)); }))
            return false;
        return rows(this.db.prepare('SELECT source_note_id,version FROM vcp_note_dependencies WHERE note_id=?').all(note.id)).every(dependency => { const source = this.load(String(dependency.source_note_id)); return source.version === Number(dependency.version) && this.visible(scope, source, new Set(visited)); });
    }
    sourcesFilter(scope: Scope, ids: string[]): CompanionMessage[] { return this.sources.filter(scope, ids); }
    observeSource(messageId: string, companionId: string): void { this.sources.observe(messageId, companionId); }
    /** Host-only completed-world receipt; ordinary world_query observations remain opt-in. */
    enqueueWorldExperience(messageId: string, companionId: string): void {
        const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
        const metadata = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + messageId);
        if (!found || !metadata) throw new Error('实际生活经历缺少世界凭证。');
        const source = row(found), worldRoom = 'world_' + companionId;
        const receipt = json<{ companionId: string; forConversationId: string; checksum: string;
            experience?: { eventId: string; eventSequence: number } }>(row(metadata).value);
        const experience = receipt.experience;
        const saved = experience && this.db.prepare('SELECT data FROM companion_world_events WHERE id=? AND sequence=?').get(experience.eventId, experience.eventSequence);
        const event = saved ? json<{ id: string; actorId?: string; targetId?: string; kind: string }>(row(saved).data) : undefined;
        const content = json<{ items?: unknown[] }>(source.content);
        if (receipt.companionId !== companionId || receipt.forConversationId !== worldRoom || source.conversation_id !== worldRoom
            || source.author_id !== 'system' || source.kind !== 'notice' || source.status !== 'sent'
            || !this.sources.worldScope(worldRoom) || receipt.checksum !== companionSourceChecksum(String(source.content))
            || !event || event.actorId !== companionId || !(event.kind === 'park_walk_complete'
                || event.kind === 'scene_enter' && event.targetId && event.targetId !== companionId)
            || JSON.stringify(content.items?.[0]) !== String(row(saved!).data)) throw new Error('实际生活经历与世界已发生事件不一致。');
        const scope = { companionId, conversationId: worldRoom };
        if (this.sources.captureHeld(companionId, worldRoom) || !this.sources.visible(scope, source)) return;
        this.db.prepare('INSERT OR IGNORE INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)')
            .run(randomUUID(), companionId, worldRoom, messageId, source.sequence, source.sequence, receipt.checksum, source.revision ?? 1);
    }
    enqueueMessage(messageId: string, finalizedLoop = false, historical = false): void {
        if (this.sources.managementSource(messageId)) return;
        if (this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('memory-world-observation/' + messageId))
            return;
        const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
        if (!found)
            return;
        const source = row(found);
        if ((!finalizedLoop && !this.sources.formal(source)) || source.status !== 'sent' || !String(source.content).trim())
            return;
        const checksum = companionSourceChecksum(String(source.content));
        if (Number(source.revision ?? 1) > 1) for (const observer of rows(this.db.prepare('SELECT companion_id FROM vcp_source_observers WHERE message_id=?').all(messageId))) {
            const owner = String(observer.companion_id);
            this.invalidateOwner(owner); this.withdrawStateSources?.(owner, [messageId]);
        }
        this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL WHERE message_id=? AND (source_checksum!=? OR source_revision!=?)").run(messageId, checksum, source.revision ?? 1);
        for (const reference of rows(this.db.prepare('SELECT note_id,checksum,revision FROM vcp_note_sources WHERE message_id=?').all(messageId)))
            if (reference.checksum !== checksum || Number(reference.revision) !== Number(source.revision ?? 1))
                this.withdrawNote(String(reference.note_id), 'invalid');
        const room = row(this.db.prepare('SELECT * FROM conversations WHERE id=?').get(source.conversation_id));
        const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + messageId);
        for (const member of rows(this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=?').all(source.conversation_id))) {
            const owner = String(member.companion_id);
            // History cannot assert that today's group member witnessed an earlier message.
            if (historical && room.kind !== 'private' && !this.db.prepare('SELECT 1 FROM vcp_source_observers WHERE message_id=? AND companion_id=?').get(messageId, owner))
                continue;
            if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(owner))
                continue;
            const boundary = this.db.prepare('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(owner);
            if (boundary && Number(source.sequence) <= Number(row(boundary).through_sequence))
                continue;
            this.sources.observe(messageId, owner);
            if (this.sources.captureHeld(owner, String(source.conversation_id))) continue;
            if (this.sources.forgotten({ companionId: owner, conversationId: String(source.conversation_id) }, source))
                continue;
            this.db.prepare('INSERT OR IGNORE INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), owner, source.conversation_id, messageId, source.sequence, publication ? Math.max(Number(source.sequence), Number(row(publication).value) + 1) : source.sequence, checksum, source.revision ?? 1);
        }
    }
    backfill(limit = 200): boolean {
        return this.db.transaction(() => {
            const through = Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-capture-backfill-through'").get()).value), target = Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-capture-backfill-target'").get()).value);
            const batch = rows(this.db.prepare('SELECT id,sequence FROM messages WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?').all(through, target, limit));
            for (const source of batch)
                this.enqueueMessage(String(source.id), false, true);
            const next = batch.length === limit ? Number(batch.at(-1)!.sequence) : target;
            this.db.prepare("UPDATE metadata SET value=? WHERE key='vcp-capture-backfill-through'").run(String(next));
            return next >= target;
        }).immediate();
    }
    claim(companionId?: string, leaseMs = 120000): CompanionMemoryJob | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.db.prepare("UPDATE vcp_capture_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            const found = this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j JOIN companions c ON c.id=j.companion_id WHERE j.status IN('pending','failed') AND j.next_attempt<=? AND j.attempts<8 AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1 AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=j.companion_id AND r.status!='completed') AND NOT EXISTS(SELECT 1 FROM vcp_source_policy_holds h WHERE h.companion_id=j.companion_id AND h.conversation_id IN(j.conversation_id,'*') AND h.released_at IS NULL) ${companionId ? 'AND j.companion_id=?' : ''} ORDER BY j.ordinal LIMIT 1`).get(...(companionId ? [now, companionId] : [now]));
            if (!found)
                return;
            const job = row(found), token = randomUUID(), batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE companion_id=? AND conversation_id=? AND status IN('pending','failed') AND next_attempt<=? AND attempts<8 ORDER BY source_sequence,ordinal LIMIT 8").all(job.companion_id, job.conversation_id, now));
            for (const source of batch)
                this.db.prepare("UPDATE vcp_capture_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, source.id);
            return { id: String(job.id), companionId: String(job.companion_id), conversationId: String(job.conversation_id), sourceMessageIds: batch.map(source => String(source.message_id)), throughSequence: Math.max(...batch.map(source => Number(source.through_sequence))), leaseToken: token, attempts: Number(job.attempts) + 1, sourceChecksums: Object.fromEntries(batch.map(source => [String(source.message_id), String(source.source_checksum)])), sourceRevisions: Object.fromEntries(batch.map(source => [String(source.message_id), Number(source.source_revision)])) };
        }).immediate();
    }
    private leased(table: 'vcp_capture_jobs' | 'vcp_memory_outbox', id: string, token: string): Row { const found = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND status='running' AND lease_token=? AND lease_until>?`).get(id, token, Date.now()); if (!found)
        throw new Error('VCP 投递租约已失效。'); return row(found); }
    complete(id: string, token: string, notes: CompanionMemoryCandidate[], stateProposal?: CompanionStateProposal, expectedProhibitionRevision?: string): CompanionMemory[] {
        return this.db.transaction(() => {
            const job = this.leased('vcp_capture_jobs', id, token), batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token)), sourceIds = new Set(batch.map(source => String(source.message_id)));
            const scope = { companionId: String(job.companion_id), conversationId: String(job.conversation_id), beforeSequence: Math.max(...batch.map(source => Number(source.through_sequence))) };
            this.sources.assertProhibitionRevision(scope, expectedProhibitionRevision);
            for (const source of batch) {
                const current = this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.message_id);
                if (!current || Number(row(current).revision ?? 1) !== Number(source.source_revision) || companionSourceChecksum(String(row(current).content)) !== source.source_checksum)
                    throw new Error('日记来源已修订。');
            }
            const result: CompanionMemory[] = [];
            for (const note of notes) {
                if (note.sourceMessageIds.some(source => !sourceIds.has(source)))
                    throw new Error('日记只能使用本批来源。');
                const saved = this.record(scope, note);
                if (saved)
                    result.push(saved);
            }
            if (stateProposal && !stateProposal.sourceMessageIds.every(source => sourceIds.has(source))) throw new Error('状态提议只能使用本批正式来源。');
            if (stateProposal && this.sources.filter(scope, stateProposal.sourceMessageIds).length === stateProposal.sourceMessageIds.length)
                this.applyState?.(scope, stateProposal);
            this.db.prepare("UPDATE vcp_capture_jobs SET status='done',error=NULL,lease_token=NULL,lease_until=NULL WHERE lease_token=?").run(token);
            return result;
        }).immediate();
    }
    fail(id: string, token: string, error: string, retryAfterMs = 30000): void { this.leased('vcp_capture_jobs', id, token); this.db.prepare("UPDATE vcp_capture_jobs SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE lease_token=?").run(error, Date.now() + retryAfterMs, token); }
    retry(companionId?: string): void { for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox'])
        this.db.prepare(`UPDATE ${table} SET status='pending',attempts=0,next_attempt=0,error=NULL WHERE status='failed' ${companionId ? 'AND companion_id=?' : ''}`).run(...(companionId ? [companionId] : [])); }
    record(scope: Scope, input: CompanionMemoryCandidate, revision?: {
        id: string;
        expectedVersion: number;
    }, captureMethod: 'automatic' | 'manual' = 'automatic', expectedProhibitionRevision?: string): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const draft = companionMemoryCandidateSchema.parse(input);
            this.sources.requireScope(scope);
            const available = this.sources.filter(scope, draft.sourceMessageIds);
            if (available.length !== new Set(draft.sourceMessageIds).size)
                throw new Error('日记来源不可见、已撤回或尚未正式发送。');
            const references = available.map(source => this.sources.reference(row(this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.id))));
            const domains = references.map(source => this.sources.logicalDomain(source.messageId));
            if (new Set(domains).size !== 1)
                throw new Error('不同来源可见域不能混写同一篇日记。');
            for (const source of available) {
                if (draft.sourceChecksums?.[source.id] && draft.sourceChecksums[source.id] !== companionSourceChecksum(source.content))
                    throw new Error('日记来源已修订。');
                if (!draft.evidence.some(evidence => evidence.sourceMessageId === source.id && source.content.includes(evidence.quote)))
                    throw new Error('每个日记来源都需要逐字证据。');
            }
            if (draft.evidence.some(evidence => !available.some(source => source.id === evidence.sourceMessageId && source.content.includes(evidence.quote))))
                throw new Error('日记证据不是来源原文。');
            const conversationId = domains[0]!, sourceSequence = Math.max(...references.map(source => source.sequence));
            this.sources.assertProhibitionRevision({ ...scope, conversationId }, expectedProhibitionRevision);
            if (this.sources.captureHeld(scope.companionId, conversationId)) throw new Error('此可见域仍有旧版持续遗忘限制，请先在记忆管理中确认处理。');
            if (this.sources.blockedTag({ ...scope, conversationId }, draft.tags, sourceSequence))
                throw new Error('该日记涉及已禁止记录的内容。');
            const previous = revision ? this.load(revision.id) : undefined;
            if (previous && (!this.visible(scope, previous) || previous.version !== revision!.expectedVersion || previous.sourceConversationId !== conversationId))
                throw new Error('日记版本或可见域已变化，请重新读取。');
            const scopeId = this.scope(scope.companionId, conversationId), identity = hash([scopeId, draft.content, draft.tags, references.map(source => [source.messageId, source.revision, source.checksum]), draft.occurredAt ?? '', draft.relatedMemoryIds]);
            const existing = !previous && this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? AND identity_key=?').get(scope.companionId, identity);
            if (existing) {
                const note = json<CompanionMemory>(row(existing).data);
                if (this.visible(scope, note))
                    return note;
                throw new Error('该日记来源已失效或已遗忘。');
            }
            const note: CompanionMemory = { id: previous?.id ?? 'note_' + identity.slice(0, 48), companionId: scope.companionId, scopeId, content: draft.content, tags: draft.tags, occurredAt: draft.occurredAt ?? references.at(-1)?.worldCreatedAt ?? references.at(-1)?.createdAt, diaryName: draft.diaryName ?? '经历', metadata: { ...draft.metadata, learnedEntranceSourceId: draft.learnedEntranceSourceId, sourceMessageIds: references.map(source => source.messageId) }, sourceMessageId: references[0]!.messageId, sourceConversationId: conversationId, sources: references, sourceSequence, createdAt: previous?.createdAt ?? stamp(), updatedAt: stamp(), origin: references.some(source => source.authorId === 'user') ? 'user' : 'companion', status: 'queued', version: (previous?.version ?? 0) + 1, captureMethod };
            const dependencies = draft.relatedMemoryIds.map(id => this.load(id));
            if (dependencies.some(source => !this.visible(scope, source) || source.sourceConversationId !== conversationId || source.id === note.id))
                throw new Error('整理来源不属于同一可见域。');
            this.persist(note, previous ? undefined : identity);
            this.db.prepare('DELETE FROM vcp_note_dependencies WHERE note_id=?').run(note.id);
            for (const source of dependencies)
                this.db.prepare('INSERT INTO vcp_note_dependencies VALUES(?,?,?)').run(note.id, source.id, source.version);
            this.enqueue(note, 'remember');
            if (previous) {
                this.invalidateOwner(note.companionId);
                this.invalidateDependents(note.id);
            }
            this.observeNote?.(note);
            return note;
        }).immediate();
    }
    private invalidateDependents(id: string, visited = new Set<string>()): void { if (visited.has(id))
        return; visited.add(id); for (const dependency of rows(this.db.prepare('SELECT note_id FROM vcp_note_dependencies WHERE source_note_id=?').all(id)))
        this.withdrawNote(String(dependency.note_id), 'invalid', visited); }
    withdrawNote(id: string, status: 'forgotten' | 'invalid', visited = new Set<string>()): void {
        this.db.transaction(() => {
            const note = this.load(id);
            if (['forgotten', 'invalid'].includes(note.status)) return;
            const sourceIds = note.sources.map(source => source.messageId);
            this.invalidateOwner(note.companionId);
            note.status = status;
            note.version++;
            note.updatedAt = stamp();
            note.content = status === 'forgotten' ? '已遗忘的日记' : '来源已失效的日记';
            note.tags = [];
            note.sources = [];
            delete note.metadata;
            delete note.sourceMessageId;
            this.persist(note);
            this.enqueue(note, 'forget');
            this.withdrawStateSources?.(note.companionId, sourceIds);
            this.invalidateDependents(id, visited);
        }).immediate();
    }
    resetOwner(owner: string, limit: number): number { const notes = rows(this.db.prepare("SELECT id FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') LIMIT ?").all(owner, limit)); for (const note of notes)
        this.withdrawNote(String(note.id), 'forgotten'); return notes.length; }
    rebuildIndex(companionId?: string): number { return this.db.transaction(() => { const found = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed')" + (companionId ? ' AND companion_id=?' : '')).all(...(companionId ? [companionId] : []))); for (const entry of found) {
        const note = json<CompanionMemory>(entry.data);
        this.invalidateOwner(note.companionId);
        note.status = 'queued';
        this.persist(note);
        this.enqueue(note, 'remember');
        this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version=? AND operation='remember' AND status!='running'").run(note.id, note.version);
    } return found.length; }).immediate(); }
    read(scope: Scope, id: string, limit = 30, cursor = 0): NonNullable<CompanionStorageResponse['memoryRead']> { const note = this.load(id); if (!this.visible(scope, note))
        throw new Error('日记来源失效或不属于当前可见范围。'); const next = cursor + limit; return { memory: note, sources: this.sources.filter(scope, note.sources.slice(cursor, next).map(source => source.messageId)), related: [], hasMore: next < note.sources.length, nextSourceCursor: next < note.sources.length ? next : undefined }; }
    inspect(scope: Scope, id: string, limit = 30, cursor = 0) { return this.read(scope, id, limit, cursor); }
    list(companionId: string): CompanionMemory[] { return rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') ORDER BY rowid DESC").all(companionId)).map(found => json<CompanionMemory>(found.data)); }
    browse(input: CompanionMemorySearch): CompanionMemoryPage { const query = companionMemorySearchSchema.parse(input); this.sources.requireScope(query); if (query.query.trim())
        throw new Error('正文搜索必须由 VCP 执行。'); const available = this.list(query.companionId).filter(note => this.visible(query, note) && (!query.diaryName || note.diaryName === query.diaryName) && query.tags.every(tag => note.tags.includes(tag)) && (!query.from || (note.occurredAt ?? note.createdAt) >= query.from) && (!query.to || (note.occurredAt ?? note.createdAt) <= query.to)); const cursor = query.cursor ?? 0; return { items: available.slice(cursor, cursor + query.limit).map(memory => ({ memory, reasons: ['journal-list'], path: [memory.id] })), hasMore: available.length > cursor + query.limit, nextCursor: available.length > cursor + query.limit ? cursor + query.limit : undefined }; }
    snapshot(scope: Scope): NonNullable<CompanionStorageResponse['memorySnapshot']> { this.sources.requireScope(scope); const notes = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status')='indexed' ORDER BY id").all(scope.companionId)).map(found => json<CompanionMemory>(found.data)).filter(note => this.visible(scope, note)); const revision = hash([scope.companionId, scope.conversationId, scope.beforeSequence ?? null, notes.map(note => [note.id, note.version, note.sources.map(source => [source.messageId, source.revision, source.checksum])])]); return { scopeId: 'view_' + revision.slice(0, 48), revision, notes }; }
    domains(scope: Scope): NonNullable<CompanionStorageResponse['memoryDomains']> { const room = this.sources.requireScope(scope); return rows(this.db.prepare(`SELECT * FROM vcp_memory_scopes WHERE companion_id=? ${room.kind === 'group' ? 'AND conversation_id=?' : ''} ORDER BY scope_id`).all(...(room.kind === 'group' ? [scope.companionId, scope.conversationId] : [scope.companionId]))).map(domain => ({ scopeId: String(domain.scope_id), companionId: String(domain.companion_id), conversationId: String(domain.conversation_id), revision: Number(domain.revision), state: domain.state as 'dirty' | 'ready', updatedAt: String(domain.updated_at) })); }
    forget(input: Extract<CompanionStorageCommand, {
        type: 'memory.forget';
    }>): number {
        const command = companionMemoryForgetSchema.parse(input);
        return this.db.transaction(() => {
            const room = this.sources.requireScope(command);
            this.invalidateOwner(command.companionId);
            if (!command.id && !command.sourceMessageIds.length && !command.tag)
                throw new Error('请指定需要遗忘的日记、来源或标签。');
            if (command.requestMessageId && !this.sources.filter(command, [command.requestMessageId]).some(source => source.authorId === 'user'))
                throw new Error('遗忘请求不是当前可见的用户来源。');
            const notes = this.list(command.companionId).filter(note => this.visible(command, note) && (command.id ? note.id === command.id : command.sourceMessageIds.length ? note.sources.some(source => command.sourceMessageIds.includes(source.messageId)) : note.tags.includes(command.tag!)));
            const sourceIds = [...new Set([...command.sourceMessageIds, ...notes.flatMap(note => [
                ...note.sources.map(source => source.messageId),
                ...rows(this.db.prepare('SELECT message_id FROM vcp_note_source_history WHERE note_id=?').all(note.id)).map(source => String(source.message_id)),
            ])])];
            if (command.sourceMessageIds.length && this.sources.filter(command, command.sourceMessageIds).length !== command.sourceMessageIds.length)
                throw new Error('遗忘来源不可访问。');
            this.sources.block(command.companionId, sourceIds);
            if (command.tag) {
                const ruleId = randomUUID();
                this.db.prepare('INSERT INTO vcp_source_prohibitions VALUES(?,?,?,?,?,?)').run(ruleId, command.companionId,
                  command.persistent && room.kind === 'private' ? '*' : command.conversationId, command.tag,
                  command.beforeSequence ?? Number(row(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM messages').get()).n), Number(command.persistent));
                if (command.requestMessageId) {
                    this.db.prepare('INSERT INTO vcp_source_prohibition_requests VALUES(?,?)').run(ruleId, command.requestMessageId);
                    this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL,error=NULL WHERE message_id=? AND companion_id=?").run(command.requestMessageId, command.companionId);
                }
            }
            if (sourceIds.length)
                for (const entry of rows(this.db.prepare('SELECT DISTINCT note_id FROM vcp_note_sources WHERE message_id IN (' + sourceIds.map(() => '?').join(',') + ')').all(...sourceIds))) {
                    const note = this.load(String(entry.note_id));
                    if (note.companionId === command.companionId)
                        this.withdrawNote(note.id, 'forgotten');
                }
            this.withdrawStateSources?.(command.companionId, sourceIds);
            return notes.length;
        }).immediate();
    }
    delete(id: string): void { const note = this.load(id); this.forget({ type: 'memory.forget', companionId: note.companionId, conversationId: note.sourceConversationId, id }); }
    organize(scope: Scope, ids: string[], tags: string[], expectedProhibitionRevision?: string): CompanionMemory[] { return this.db.transaction(() => ids.map(id => { const note = this.load(id); this.sources.assertProhibitionRevision({ ...scope, conversationId: note.sourceConversationId }, expectedProhibitionRevision); if (!this.visible(scope, note))
        throw new Error('日记不可见。'); if (this.sources.blockedTag({ ...scope, conversationId: note.sourceConversationId }, tags, note.sourceSequence))
        throw new Error('禁止记录该标签。'); this.invalidateOwner(note.companionId); note.tags = [...tags]; note.version++; note.status = 'queued'; note.updatedAt = stamp(); this.persist(note); this.enqueue(note, 'remember'); this.invalidateDependents(note.id); return note; })).immediate(); }
    rehomeConversation(oldId: string, newId: string): void { this.db.prepare('UPDATE vcp_capture_jobs SET conversation_id=? WHERE conversation_id=?').run(newId, oldId); for (const entry of rows(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE conversation_id=?').all(oldId)))
        this.withdrawNote(json<CompanionMemory>(entry.data).id, 'invalid'); }
    claimOutbox(companionId?: string, leaseMs = 120000): NonNullable<CompanionStorageResponse['memoryOutbox']> | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            const found = this.db.prepare(`SELECT o.* FROM vcp_memory_outbox o WHERE o.status IN('pending','failed') AND o.next_attempt<=? AND o.attempts<8 AND NOT EXISTS(SELECT 1 FROM vcp_memory_outbox active WHERE active.scope_id=o.scope_id AND active.status='running' AND active.lease_until>?) ${companionId ? 'AND o.companion_id=?' : ''} ORDER BY o.ordinal LIMIT 1`).get(...(companionId ? [now, now, companionId] : [now, now]));
            if (!found)
                return;
            const entry = row(found), note = this.load(String(entry.note_id));
            if (note.version !== Number(entry.note_version)) {
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                return;
            }
            if (entry.operation === 'remember' && !this.visible({ companionId: note.companionId, conversationId: note.sourceConversationId }, note)) {
                this.withdrawNote(note.id, 'invalid');
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                return;
            }
            const token = randomUUID();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, entry.id);
            return { id: String(entry.id), companionId: note.companionId, scopeId: note.scopeId, noteId: note.id, noteVersion: note.version, operation: entry.operation as 'remember' | 'forget', note, leaseToken: token, attempts: Number(entry.attempts) + 1 };
        }).immediate();
    }
    completeOutbox(id: string, token: string, indexed: boolean, sourceFile?: string): void { this.db.transaction(() => { const entry = this.leased('vcp_memory_outbox', id, token), note = this.load(String(entry.note_id)); if (entry.operation === 'remember' && note.version === Number(entry.note_version) && this.visible({ companionId: note.companionId, conversationId: note.sourceConversationId }, note)) {
        if (!indexed)
            throw new Error('VCP 尚未确认索引完成。');
        note.status = 'indexed';
        note.sourceFile = sourceFile;
        note.updatedAt = stamp();
        this.persist(note);
    } this.db.prepare("UPDATE vcp_memory_outbox SET status='done',error=NULL,lease_token=NULL,lease_until=NULL WHERE id=?").run(id); if (!this.db.prepare("SELECT 1 FROM vcp_memory_outbox WHERE scope_id=? AND status!='done' LIMIT 1").get(note.scopeId))
        this.db.prepare("UPDATE vcp_memory_scopes SET state='ready',updated_at=? WHERE scope_id=?").run(stamp(), note.scopeId); }).immediate(); }
    failOutbox(id: string, token: string, error: string, retryAfterMs = 30000): void { this.leased('vcp_memory_outbox', id, token); this.db.prepare("UPDATE vcp_memory_outbox SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(error, Date.now() + retryAfterMs, id); }
    policies(companionId: string): NonNullable<CompanionStorageResponse['memoryPolicies']> {
        if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId)) throw new Error('伙伴不存在。');
        const legacy: NonNullable<CompanionStorageResponse['memoryPolicies']> = rows(this.db.prepare('SELECT * FROM vcp_source_policy_holds WHERE companion_id=? ORDER BY created_at,id').all(companionId)).map(rule => ({
            id: String(rule.id), companionId, conversationId: String(rule.conversation_id), reason: 'legacy-selector',
            requestMessageId: rule.request_message_id ? String(rule.request_message_id) : undefined,
            requestSnippet: String(rule.request_snippet), blocked: rule.released_at === null, createdAt: String(rule.created_at),
            releasedAt: rule.released_at ? String(rule.released_at) : undefined,
        }));
        const topics: NonNullable<CompanionStorageResponse['memoryPolicies']> = rows(this.db.prepare(`SELECT p.*,r.released_at,
          (SELECT q.message_id FROM vcp_source_prohibition_requests q WHERE q.prohibition_id=p.id ORDER BY q.message_id LIMIT 1) AS request_message_id,
          COALESCE((SELECT m.created_at FROM messages m JOIN vcp_source_prohibition_requests q ON q.message_id=m.id WHERE q.prohibition_id=p.id ORDER BY m.sequence LIMIT 1),
            (SELECT m.created_at FROM messages m WHERE m.sequence=p.through_sequence)) AS created_at
          FROM vcp_source_prohibitions p LEFT JOIN vcp_source_prohibition_releases r ON r.prohibition_id=p.id
          WHERE p.companion_id=? AND (p.persistent=1 OR r.prohibition_id IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM vcp_source_policy_tags t WHERE t.prohibition_id=p.id) ORDER BY p.id`).all(companionId)).map(rule => ({
            id: String(rule.id), companionId, conversationId: String(rule.conversation_id), reason: 'persistent-topic', tags: [String(rule.tag)],
            requestMessageId: rule.request_message_id ? String(rule.request_message_id) : undefined, requestSnippet: '',
            blocked: !!rule.persistent, createdAt: rule.created_at ? String(rule.created_at) : new Date(0).toISOString(),
            releasedAt: rule.released_at ? String(rule.released_at) : undefined,
        }));
        return [...legacy, ...topics];
    }
    releasePolicy(companionId: string, id: string): NonNullable<CompanionStorageResponse['memoryPolicies']> {
        return this.db.transaction(() => {
            const policy = this.policies(companionId).find(rule => rule.id === id);
            if (!policy) throw new Error('遗忘限制不属于该伙伴。');
            if (policy.reason === 'persistent-topic') {
                // Retain the old topic boundary. Release authorizes future inputs, not restoration of old evidence.
                if (policy.blocked) {
                    this.db.prepare('UPDATE vcp_source_prohibitions SET persistent=0,through_sequence=(SELECT COALESCE(MAX(sequence),0) FROM messages) WHERE companion_id=? AND id=?').run(companionId, id);
                    this.db.prepare('INSERT INTO vcp_source_prohibition_releases VALUES(?,?)').run(id, stamp());
                }
            } else {
                this.db.prepare('UPDATE vcp_source_policy_holds SET released_at=COALESCE(released_at,?) WHERE companion_id=? AND id=?').run(stamp(), companionId, id);
                this.db.prepare('DELETE FROM vcp_source_prohibitions WHERE id IN(SELECT prohibition_id FROM vcp_source_policy_tags WHERE policy_id=?)').run(id);
                // Revisit history under the new policy. Individual forgotten sources remain permanently blocked.
                this.db.prepare("UPDATE metadata SET value='0' WHERE key='vcp-capture-backfill-through'").run();
                this.db.prepare("UPDATE metadata SET value=(SELECT CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages) WHERE key='vcp-capture-backfill-target'").run();
            }
            this.invalidateOwner(companionId);
            return this.policies(companionId);
        }).immediate();
    }
    status(companionId: string, conversationId?: string): NonNullable<CompanionStorageResponse['memoryStatus']> {
        const filter = conversationId ? ' AND conversation_id=?' : '', values = conversationId ? [companionId, conversationId] : [companionId];
        const jobs = rows(this.db.prepare('SELECT status,COUNT(*) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter + ' GROUP BY status').all(...values));
        const count = (status: string) => Number(jobs.find(job => job.status === status)?.n ?? 0);
        const notes = rows(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=?' + filter).all(...values)).map(found => json<CompanionMemory>(found.data));
        const lastCapture = this.db.prepare('SELECT error FROM vcp_capture_jobs WHERE companion_id=?' + filter + " AND status='failed' ORDER BY ordinal DESC LIMIT 1").get(...values);
        const outboxFilter = conversationId ? ' AND note_id IN(SELECT id FROM vcp_memory_notes WHERE conversation_id=?)' : '';
        const lastDelivery = this.db.prepare('SELECT error FROM vcp_memory_outbox WHERE companion_id=?' + outboxFilter + " AND status='failed' ORDER BY ordinal DESC LIMIT 1").get(...values);
        const deliveryFailures = Number(row(this.db.prepare('SELECT count(*) AS n FROM vcp_memory_outbox WHERE companion_id=?' + outboxFilter + " AND status='failed'").get(...values)).n);
        const messageWatermark = Number(row(this.db.prepare('SELECT COALESCE(MAX(source_sequence),0) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter).get(...values)).n);
        const pending = row(this.db.prepare('SELECT MIN(source_sequence) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter + " AND status!='done'").get(...values)).n;
        const last = lastDelivery ?? lastCapture;
        return {
            pending: count('pending'), running: count('running'), failed: count('failed') + deliveryFailures, completed: count('done'),
            memories: notes.filter(note => !['invalid', 'forgotten'].includes(note.status)).length,
            forgotten: notes.filter(note => note.status === 'forgotten').length,
            indexed: notes.filter(note => note.status === 'indexed').length, pendingIndex: notes.filter(note => note.status === 'queued').length,
            messageWatermark, captureWatermark: pending === null ? messageWatermark : Math.max(0, Number(pending) - 1),
            backfillThrough: Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-capture-backfill-through'").get()).value),
            backfillTarget: Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-capture-backfill-target'").get()).value),
            ...(last ? { lastError: String(row(last).error) } : {}),
        };
    }
    saveManual(draft: SaveCompanionMemory, run: () => CompanionMemory): CompanionMemory {
        const command = { ...draft, type: 'memory.save' };
        return this.operation(command, () => ({ ok: true, memories: [run()] })).memories![0]!;
    }
    prohibitionPolicyForNotes(scope: Scope, noteIds: readonly string[]): Pick<CompanionStorageResponse, 'memoryProhibitions' | 'memoryProhibitionRevision'> {
        this.sources.requireScope(scope);
        const domains = new Set([scope.conversationId]);
        for (const id of noteIds) {
            const note = this.load(id);
            if (note.companionId !== scope.companionId) throw new Error('禁记核对日记不属于该伙伴。');
            // Rules must include a newly prohibited domain even if that rule now hides its old notes.
            domains.add(note.sourceConversationId);
        }
        const policies = new Map<string, NonNullable<CompanionStorageResponse['memoryProhibitions']>[number]>();
        for (const conversationId of domains) for (const policy of this.sources.prohibitions({ ...scope, conversationId })) policies.set(policy.id, policy);
        const memoryProhibitions = [...policies.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        return { memoryProhibitions, memoryProhibitionRevision: hash(memoryProhibitions) };
    }
    private writePolicy(command: Extract<CompanionStorageCommand, { type: 'memory.prohibitions' }>): CompanionStorageResponse {
        this.sources.requireScope(command);
        if ([command.noteId, command.sourceMessageIds, command.worldJobId].filter(Boolean).length > 1) throw new Error('请选择日记、正式来源或世界任务核对禁记范围。');
        if (command.worldJobId) {
            const found = this.db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(command.worldJobId);
            if (!found) throw new Error('世界后台任务不存在。');
            const job = json<{ companionId: string; conversationId: string; kind: string; sourceMemoryIds: string[] }>(row(found).data);
            if (job.companionId !== command.companionId || job.conversationId !== command.conversationId) throw new Error('世界后台任务不属于此禁记核对范围。');
            return { ok: true, ...this.prohibitionPolicyForNotes(command, job.kind === 'dream' ? job.sourceMemoryIds : []) };
        }
        let conversationId = command.conversationId;
        if (command.noteId) {
            const note = this.load(command.noteId);
            if (!this.visible(command, note)) throw new Error('日记不可见。');
            conversationId = note.sourceConversationId;
        } else if (command.sourceMessageIds) {
            const available = this.sources.filter(command, command.sourceMessageIds);
            if (available.length !== new Set(command.sourceMessageIds).size) throw new Error('禁记核对来源不可见。');
            const domains = new Set(available.map(source => this.sources.logicalDomain(source.id)));
            if (domains.size !== 1) throw new Error('不同来源可见域不能混写同一篇日记。');
            conversationId = [...domains][0]!;
        }
        const scope = { ...command, conversationId };
        return { ok: true, memoryProhibitions: this.sources.prohibitions(scope), memoryProhibitionRevision: this.sources.prohibitionRevision(scope), memoryProhibitionConversationId: conversationId };
    }
    private operation(command: { companionId: string; conversationId: string; operationId?: string; expectedProhibitionRevision?: string }, run: () => CompanionStorageResponse): CompanionStorageResponse {
        if (!command.operationId) return run();
        return this.db.transaction(() => {
            const { operationId, expectedProhibitionRevision, ...payload } = command;
            const signature = hash(payload);
            const found = this.db.prepare('SELECT * FROM vcp_operation_receipts WHERE id=?').get(operationId);
            if (found) {
                const receipt = row(found);
                if (receipt.companion_id !== command.companionId || receipt.conversation_id !== command.conversationId || receipt.payload_hash !== signature) throw new Error('记忆操作身份已被不同请求使用。');
                const response = json<{ ok: boolean; notes: Array<{ id: string; version: number }> }>(receipt.response);
                const memories = response.notes.map(previous => {
                    const current = this.load(previous.id);
                    this.sources.assertProhibitionRevision({ ...command, conversationId: current.sourceConversationId }, expectedProhibitionRevision);
                    if (current.version !== previous.version || !this.visible(command, current)) throw new Error('记忆操作的已提交结果或来源已变化。');
                    return current;
                });
                return { ok: response.ok, memories };
            }
            const response = run();
            this.db.prepare('INSERT INTO vcp_operation_receipts VALUES(?,?,?,?,?)').run(operationId, command.companionId, command.conversationId, signature,
              JSON.stringify({ ok: response.ok, notes: (response.memories ?? []).map(note => ({ id: note.id, version: note.version })) }));
            return response;
        }).immediate();
    }
    private libraryVisible(owner: string, note: CompanionMemory): boolean {
        try { return note.companionId === owner && this.visible({ companionId: owner, conversationId: note.sourceConversationId }, note); }
        catch { return false; }
    }
    private libraryIndexState(owner: string): NonNullable<CompanionStorageResponse['memoryLibraryIndexState']> {
        if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)) throw new Error('伙伴不存在。');
        const epoch = this.db.prepare('SELECT revision FROM vcp_memory_management_epochs WHERE companion_id=?').get(owner);
        return { resetRevision: epoch ? Number(row(epoch).revision) : 0,
            throughOrdinal: Number(row(this.db.prepare('SELECT COALESCE(MAX(ordinal),0) AS n FROM vcp_memory_outbox WHERE companion_id=?').get(owner)).n),
            total: Number(row(this.db.prepare('SELECT COALESCE((SELECT total FROM vcp_memory_management_totals WHERE companion_id=?),0) AS n').get(owner)).n) };
    }
    private libraryFence(owner: string, revision: number, throughOrdinal: number): void {
        const current = this.libraryIndexState(owner);
        if (current.resetRevision !== revision || throughOrdinal > current.throughOrdinal) throw new Error('管理索引来源或权限已变化，请重建授权索引。');
    }
    execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
        switch (command.type) {
            case 'memory.search': throw new Error('记忆检索只能由 VCP 执行。');
            case 'memory.operation.inspect': {
                const receipt = this.db.prepare('SELECT response FROM vcp_operation_receipts WHERE id=? AND companion_id=?').get(command.operationId, command.companionId);
                const references = receipt ? json<{ notes: Array<{ id: string }> }>(row(receipt).response).notes : [];
                const notes = references.map(reference => this.load(reference.id));
                return { ok: true, memories: notes.map(note => {
                    if (this.visible({ companionId: command.companionId, conversationId: note.sourceConversationId }, note)) return note;
                    if (!['forgotten', 'invalid'].includes(note.status) && !this.sources.captureHeld(command.companionId, note.sourceConversationId)) this.withdrawNote(note.id, 'invalid');
                    // A durable receipt must still identify an old export for removal without disclosing revoked text.
                    return { ...this.load(note.id), content: '[来源已撤回]', tags: [], sources: [], sourceMessageId: undefined,
                        sourceSequence: 0, metadata: undefined, diaryName: undefined, occurredAt: undefined,
                        status: note.status === 'forgotten' ? 'forgotten' as const : 'invalid' as const };
                }) };
            }
            case 'memory.library.page': {
                const limit = command.limit ?? 64, cursor = command.cursor ?? 0;
                const found = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') IN('queued','indexed') ORDER BY id LIMIT ? OFFSET ?").all(command.companionId, limit + 1, cursor));
                const notes = found.slice(0, limit).map(entry => json<CompanionMemory>(entry.data)).filter(note => this.libraryVisible(command.companionId, note));
                return { ok: true, memoryPage: { items: notes.map(memory => ({ memory, reasons: ['library-projection'], path: [memory.id] })), hasMore: found.length > limit, ...(found.length > limit ? { nextCursor: cursor + limit } : {}) } };
            }
            case 'memory.library.index-state': return { ok: true, memoryLibraryIndexState: this.libraryIndexState(command.companionId) };
            case 'memory.library.index-page': return this.db.transaction(() => {
                this.libraryFence(command.companionId, command.resetRevision, command.throughOrdinal);
                const found = rows(this.db.prepare(`SELECT n.id,n.data FROM vcp_memory_notes n WHERE n.companion_id=? AND n.id>? AND json_extract(n.data,'$.status') IN('queued','indexed')
                  AND EXISTS(SELECT 1 FROM vcp_memory_outbox o WHERE o.note_id=n.id AND o.note_version=json_extract(n.data,'$.version') AND o.operation='remember' AND o.ordinal<=?) ORDER BY n.id LIMIT ?`)
                  .all(command.companionId, command.afterId ?? '', command.throughOrdinal, (command.limit ?? 64) + 1));
                const page = found.slice(0, command.limit ?? 64), hasMore = found.length > page.length;
                return { ok: true, memoryLibraryIndexPage: { notes: page.map(entry => json<CompanionMemory>(entry.data)).filter(note => this.libraryVisible(command.companionId, note)),
                    hasMore, ...(hasMore && page.length ? { nextId: String(page.at(-1)!.id) } : {}) } };
            }).immediate();
            case 'memory.library.changes': return this.db.transaction(() => {
                this.libraryFence(command.companionId, command.resetRevision, command.throughOrdinal);
                const found = rows(this.db.prepare('SELECT ordinal,note_id,note_version,operation FROM vcp_memory_outbox WHERE companion_id=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?')
                  .all(command.companionId, command.afterOrdinal, command.throughOrdinal, (command.limit ?? 64) + 1));
                const page = found.slice(0, command.limit ?? 64), changes: NonNullable<CompanionStorageResponse['memoryLibraryChanges']>['changes'] = [];
                for (const entry of page) {
                    const note = this.load(String(entry.note_id));
                    if (note.version !== Number(entry.note_version)) continue;
                    const live = entry.operation === 'remember' && this.libraryVisible(command.companionId, note);
                    changes.push({ ordinal: Number(entry.ordinal), noteId: note.id, version: note.version, operation: live ? 'remember' : 'forget', ...(live ? { note } : {}) });
                }
                return { ok: true, memoryLibraryChanges: { changes, nextOrdinal: page.length ? Number(page.at(-1)!.ordinal) : command.throughOrdinal, hasMore: found.length > page.length } };
            }).immediate();
            case 'memory.library.read': {
                if (!this.db.prepare('SELECT 1 FROM vcp_memory_notes WHERE id=?').get(command.id)) return { ok: true };
                const note = this.load(command.id);
                if (note.companionId !== command.companionId) throw new Error('日记不属于此伙伴。');
                const scope = { companionId: command.companionId, conversationId: note.sourceConversationId };
                if (!this.libraryVisible(command.companionId, note)) return { ok: true };
                return { ok: true, memoryRead: this.read(scope, note.id, command.sourceLimit, command.sourceCursor) };
            }
            case 'memory.library.delete': return this.db.transaction(() => {
                const note = this.load(command.id);
                if (note.companionId !== command.companionId || note.version !== command.expectedVersion) throw new Error('日记所属伙伴或版本已变化，请重新读取。');
                return { ok: true, forgottenCount: this.forget({ type: 'memory.forget', companionId: note.companionId, conversationId: note.sourceConversationId, id: note.id }) };
            }).immediate();
            case 'memory.library.organize': return this.db.transaction(() => {
                const note = this.load(command.id), scope = { companionId: command.companionId, conversationId: note.sourceConversationId };
                if (note.companionId !== command.companionId || note.version !== command.expectedVersion || !this.visible(scope, note)) throw new Error('日记所属伙伴、版本或来源已变化，请重新读取。');
                const expected = 'expectedProhibitionRevision' in command && typeof command.expectedProhibitionRevision === 'string' ? command.expectedProhibitionRevision : undefined;
                this.sources.assertProhibitionRevision(scope, expected);
                if (this.sources.blockedTag(scope, command.tags, note.sourceSequence)) throw new Error('禁止记录该标签。');
                this.invalidateOwner(note.companionId);
                note.tags = [...command.tags]; note.diaryName = command.diaryName; note.version++; note.updatedAt = stamp(); note.status = 'queued';
                if (command.autoTags !== undefined) note.metadata = { ...note.metadata, autoTags: command.autoTags };
                this.persist(note); this.enqueue(note, 'remember'); this.invalidateDependents(note.id);
                return { ok: true, memories: [note] };
            }).immediate();
            case 'memory.browse': return { ok: true, memoryPage: this.browse(command) };
            case 'memory.sources.filter': return { ok: true, memorySources: this.sourcesFilter(command, command.ids) };
            case 'memory.records.filter': return { ok: true, memories: command.ids.map(id => { try {
                    return this.load(id);
                }
                catch {
                    return undefined;
                } }).filter((note): note is CompanionMemory => !!note && this.visible(command, note)) };
            case 'memory.read':
            case 'memory.inspect': return { ok: true, memoryRead: this.read(command, command.id, command.sourceLimit, command.sourceCursor) };
            case 'memory.domains': return { ok: true, memoryDomains: this.domains(command) };
            case 'memory.snapshot': return { ok: true, memorySnapshot: this.snapshot(command) };
            case 'memory.prohibitions': return this.writePolicy(command);
            case 'memory.record': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, undefined, 'automatic', command.expectedProhibitionRevision); return { ok: true, memories: note ? [note] : [] }; });
            }
            case 'memory.revise': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, { id: command.id, expectedVersion: command.expectedVersion }, 'automatic', command.expectedProhibitionRevision); return { ok: true, memories: note ? [note] : [] }; });
            }
            case 'memory.organize': return this.operation(command, () => ({ ok: true, memories: this.organize(command, command.ids, command.tags ?? [], command.expectedProhibitionRevision) }));
            case 'memory.forget': return { ok: true, forgottenCount: this.forget(command) };
            case 'memory.status': return { ok: true, memoryStatus: this.status(command.companionId, command.conversationId) };
            case 'memory.processing.status': return { ok: true, memoryProcessing: memoryProcessingStatus(this.db, command.companionId, command.limit, command.filter, item => {
                try {
                    if (item.noteId) { const note = this.load(item.noteId); return item.sourceRevision === String(note.version) && this.visible({ companionId: command.companionId, conversationId: note.sourceConversationId }, note) ? note.content : undefined; }
                    if (item.sourceMessageId && item.conversationId) {
                        const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(item.sourceMessageId);
                        return source && item.sourceRevision === `${row(source).revision ?? 1}:${companionSourceChecksum(String(row(source).content))}` && this.sources.visible({ companionId: command.companionId, conversationId: item.conversationId }, row(source)) ? String(row(source).content) : undefined;
                    }
                } catch { /* Withdrawn or no-longer-visible evidence has no preview. */ }
                return undefined;
            }) };
            case 'memory.policy.list': return { ok: true, memoryPolicies: this.policies(command.companionId) };
            case 'memory.policy.release': return { ok: true, memoryPolicies: this.releasePolicy(command.companionId, command.id) };
            case 'memory.jobs.backfill': return { ok: true, backfillComplete: this.backfill(command.limit) };
            case 'memory.index.rebuild': return { ok: true, rebuiltCount: this.rebuildIndex(command.companionId) };
            case 'memory.jobs.claim': return { ok: true, memoryJob: this.claim(command.companionId, command.leaseMs) };
            case 'memory.jobs.complete': return { ok: true, memories: this.complete(command.id, command.leaseToken, command.notes, command.stateProposal, command.expectedProhibitionRevision) };
            case 'memory.jobs.fail':
                this.fail(command.id, command.leaseToken, command.error, command.retryAfterMs);
                return { ok: true };
            case 'memory.jobs.retry':
            case 'memory.outbox.retry':
                this.retry(command.companionId);
                return { ok: true };
            case 'memory.outbox.claim': return { ok: true, memoryOutbox: this.claimOutbox(command.companionId, command.leaseMs) };
            case 'memory.outbox.complete':
                this.completeOutbox(command.id, command.leaseToken, command.indexed, command.sourceFile);
                return { ok: true };
            case 'memory.outbox.fail':
                this.failOutbox(command.id, command.leaseToken, command.error, command.retryAfterMs);
                return { ok: true };
            default: return undefined;
        }
    }
}
