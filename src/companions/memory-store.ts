import { createHash, randomUUID } from 'node:crypto';
import { companionMemoryCandidateSchema, companionMemoryConsolidateSchema, companionMemorySearchSchema, companionMemoryForgetSchema, type CompanionMemoryCandidate, type CompanionMemoryJob, type CompanionMemorySearch, type CompanionMemoryPage, type CompanionMemoryWriteReadReferences } from '../shared/companion-memory';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, SaveCompanionMemory } from '../shared/companion-storage';
import type { CompanionStateProposal } from '../shared/companion-state';
import type { CompanionConnection } from './store';
import { CompanionSourceAccess, companionSourceChecksum, type CompanionSourceScope as Scope } from './source-access';
import { initializeMemoryProcessingJournal, memoryProcessingStatus } from './memory-processing-store';
import { CompanionCharacterDevelopmentStore } from './character-development-store';
import { CompanionMemoryConsolidationStore } from './memory-consolidation-store';
import type { CompanionMemoryStateIntegration } from './state-store';
import { normalizeCompanionCharacterDiary } from '../shared/companion-character-development';
import { initializeTopicParticipationReceipts, topicParticipationMemoryContent, topicParticipationMemoryTags, type TopicParticipationReceipt } from './topic-participation';
import { companionAutomaticConsolidationHasNovelty } from '../shared/companion-memory-novelty';
import { companionMemoryDateRange } from '../shared/companion-memory-time';
import { companionMessageFictionalLineage } from './fictional-source';
import { CompanionMemoryLedger, type CompanionMemoryWriteCause } from './memory-ledger';
import { CompanionMemoryEpisodes } from './memory-episodes';
import { resolveCompanionMemoryPolicy, CompanionMemoryPolicyUnavailableError } from './memory-policy-files';
import { CompanionMemoryProcedureStore } from './memory-procedure-store';
import { unverifiedCompanionMemoryProcedure, type CompanionMemoryProcedureValidation } from '../shared/companion-procedure';
import { CompanionMemorySourceOutboxStore } from './memory-source-outbox';
import { CompanionMemoryHistoryOutboxStore, retractCompanionMemoryHistorySources, forgetCompanionMemoryHistoryNote } from './memory-history-outbox';
import { CompanionMemoryProjectionStore } from './memory-projection-store';
import { companionCaptureProposalSchema, type CompanionCaptureProposal } from '../shared/companion-memory';
type Row = Record<string, string | number | null>;
type MemoryMetadata = Omit<CompanionMemory, 'content'>;
type HostClassification = { consolidation?: true | 'source_version_graph'; automaticConsolidation?: true; sleepReflection?: true;
  sleepWorldJobId?: string; worldJobId?: string; sleepEpisodeId?: string; maintenanceMode?: 'sleep' | 'background'; maintenanceSessionId?: string;
  dreamMode?: 'sleep_dream' | 'rehearsal_dream'; captureEpisodeId?: string };
/** Host-only, body-free authority for one fresh extraction of a retired derivative. */
type CaptureReconsideration = { sourceRevision: number; sourceChecksum: string; invalidNotes: Array<{ id: string; version: number }>;
  retiredNotes?: Array<{ id: string; version: number }>;
  causes: string[]; blockedLeaseToken?: string };
const hostClassificationKeys = ['consolidation', 'automaticConsolidation', 'sleepReflection', 'sleepWorldJobId', 'worldJobId', 'sleepEpisodeId', 'maintenanceMode', 'maintenanceSessionId', 'dreamMode', 'captureEpisodeId'] as const;
const row = (value: unknown) => value as Row;
const rows = (value: unknown[]) => value.map(row);
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
const stamp = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Host journal ledger, evidence and delivery. Memory retrieval belongs exclusively to VCP. */
export class CompanionMemoryStore {
    private deletedTopicSource(messageId: string): boolean {
        return !!this.db.prepare(`SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id
          WHERE m.message_id=? AND json_extract(t.data,'$.deletedAt') IS NOT NULL`).get(messageId);
    }
    /** Fictional identities and secrets belong to their topic, never the global VCP ledger. */
    private fictionalSource(messageId: string, visited = new Set<string>()): boolean {
        if (visited.has(messageId) || visited.size >= 64) return true;
        visited.add(messageId);
        if (companionMessageFictionalLineage(this.db, messageId)) return true;
        const receipt = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + messageId);
        if (!receipt) return false;
        const observation = json<{observation?:{category?:string};sources?:Array<{id:string}>}>(row(receipt).value);
        return observation.observation?.category === 'topics' || !!observation.sources?.some(source => this.fictionalSource(source.id, new Set(visited)));
    }
    private rejectFictionalSources(ids: readonly string[]): void {
        if (ids.some(id => this.fictionalSource(id))) throw new Error('游戏与故事中的角色、秘密和情节不能写入全局记忆。请在普通对话中记录真实参与的体验。');
    }
    private validateParticipationCandidate(companionId:string,sources:readonly CompanionMessage[],draft:ReturnType<typeof companionMemoryCandidateSchema.parse>):void {
        for(const source of sources){
            const found=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/'+source.id);
            const receiptId=found?json<{topicParticipation?:string}>(row(found).value).topicParticipation:undefined;
            if(!receiptId) continue;
            const saved=this.db.prepare('SELECT data FROM companion_topic_participation_receipts WHERE id=? AND companion_id=?').get(receiptId,companionId);
            const receipt=saved?json<TopicParticipationReceipt>(row(saved).data):undefined;
            const expected=receipt?{topicParticipation:receipt.id,topicId:receipt.topicId,participationAction:receipt.action,trust:receipt.trust}:undefined;
            if(!receipt||sources.length!==1||draft.content!==topicParticipationMemoryContent(receipt)||draft.diaryName!=='活动体验'||draft.occurredAt!==receipt.occurredAt||draft.selfDevelopment||draft.relatedMemoryIds.length||draft.learnedEntranceSourceId
              ||JSON.stringify([...draft.tags].sort())!==JSON.stringify(topicParticipationMemoryTags(receipt).sort())
              ||!expected||Object.keys(draft.metadata??{}).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>draft.metadata?.[key]!==value))
                throw Error('话题参与凭证只能保存宿主核验的实际参与事实，不能改写为游戏角色、秘密或现实知识。');
        }
    }
    private retireFictionalCaptureJobs(): void {
        this.db.prepare(`UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL,error=NULL
          WHERE status IN('pending','failed','running') AND EXISTS(SELECT 1 FROM companion_message_topics m JOIN companion_topics t ON t.id=m.topic_id
            WHERE m.message_id=vcp_capture_jobs.message_id AND (json_extract(t.data,'$.kind') IN('game','story') OR json_extract(t.data,'$.deletedAt') IS NOT NULL))`).run();
    }
    private readonly invalidatedOwners = new Set<string>();
    private readonly invalidatedScopes = new Set<string>();
    private readonly changedOwners = new Set<string>();
    private readonly statusNoteCounts = new Map<string, { owner: string; stamp: string; value: { memories: number; forgotten: number; indexed: number; pendingIndex: number } }>();
    invalidateOwner(id: string, cause?: CompanionMemoryWriteCause): void {
        for (const [key, entry] of this.statusNoteCounts) if (entry.owner === id) this.statusNoteCounts.delete(key);
        this.projection.invalidate(id);
        if (this.invalidatedOwners.has(id)) {
            if (cause) this.ledger.change(id, 'revoke', undefined, undefined, undefined, cause);
            return;
        }
        this.invalidatedOwners.add(id);
        this.ledger.change(id, 'revoke', undefined, undefined, undefined, cause);
        this.db.prepare('INSERT INTO vcp_memory_management_epochs VALUES(?,1) ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1').run(id);
        for (const scope of rows(this.db.prepare('SELECT scope_id FROM vcp_memory_scopes WHERE companion_id=?').all(id))) this.invalidatedScopes.add(String(scope.scope_id));
    }
    takeInvalidatedOwners(): string[] { const ids = [...this.invalidatedOwners]; this.invalidatedOwners.clear(); return ids; }
    takeInvalidatedScopes(): string[] { const ids = [...this.invalidatedScopes]; this.invalidatedScopes.clear(); return ids; }
    takeChangedOwners(): string[] { const ids = [...this.changedOwners]; this.changedOwners.clear(); return ids; }
    takeSourceOutboxOwners(): string[] { return this.sourceOutbox.takeChangedOwners(); }
    lifecycleState(companionId: string) {
        const state = this.ledger.state(companionId), next = this.episodes.nextAt(companionId);
        return { ...state, ...(next !== undefined ? { nextCaptureAt: new Date(next).toISOString() } : {}) };
    }
    lifecycleChanges(companionId: string, afterSequence: number, limit: number) { return this.ledger.changes(companionId, afterSequence, limit); }
    private readRevision(scope: Scope, id: string, contentRevision: number,
      state = { active: new Set<string>(), memo: new Map<string, CompanionMemory>() }): CompanionMemory {
        this.sources.requireScope(scope);
        const key = id + ':' + contentRevision;
        const checked = state.memo.get(key); if (checked) return checked;
        if (state.active.has(key) || state.memo.size + state.active.size >= 10_000) throw new Error('历史记忆依赖无法核验。');
        const root = !state.active.size && !state.memo.size;
        state.active.add(key);
        try {
            const revision = this.ledger.readBody(scope.companionId, id, contentRevision);
            if (!revision || revision.memory.sources.some(source => this.fictionalSource(source.messageId))
              || root && !this.sources.frozenMemoryValid(scope, { id, contentRevision, sources: revision.memory.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }))
                throw new Error('历史记忆已遗忘、来源撤回或不属于当前伙伴。');
            // frozenMemoryValid checks the exact root's entire immutable ACL
            // closure once; this unique walk additionally excludes fiction.
            for (const dependency of revision.dependencies) this.readRevision(scope, dependency.id, dependency.contentRevision, state);
            state.memo.set(key, revision.memory); return revision.memory;
        } finally { state.active.delete(key); }
    }
    readonly sources: CompanionSourceAccess;
    private readonly development: CompanionCharacterDevelopmentStore;
    private readonly consolidation: CompanionMemoryConsolidationStore;
    private readonly ledger: CompanionMemoryLedger;
    private readonly episodes: CompanionMemoryEpisodes;
    private readonly procedures: CompanionMemoryProcedureStore;
    private readonly sourceOutbox: CompanionMemorySourceOutboxStore;
    private readonly historyOutbox: CompanionMemoryHistoryOutboxStore;
    private readonly projection: CompanionMemoryProjectionStore;
    constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage, private readonly applyState?: (scope: Scope, proposal: CompanionStateProposal) => void, private readonly observeNote?: (note: CompanionMemory) => void, private readonly withdrawStateSources?: (companionId: string, sourceIds: string[]) => void,
      private readonly applyIntegration?: (scope: Scope, input: CompanionMemoryStateIntegration) => void,
      private readonly withdrawStateMemories?: (companionId: string, versions: Array<{ id: string; version: number }>) => void,
      private readonly memoryTimeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
        this.ledger = new CompanionMemoryLedger(db);
        this.projection = new CompanionMemoryProjectionStore(db, { requireScope: scope => this.sources.requireScope(scope),
          visible: (scope, note) => this.visible(scope, note), lifecycle: owner => this.ledger.state(owner) });
        this.episodes = new CompanionMemoryEpisodes(db);
        this.sources = new CompanionSourceAccess(db, getMessage, (owner, id, version, scope) => {
          try { const note = this.load(id); return note.companionId === owner && (note.version === version || this.ledger.versionRevision(id, version) === note.contentRevision)
            && this.visible(scope ?? this.sources.ownerScope(owner), note); } catch { return false; }
        }, (owner, ids) => { this.invalidateOwner(owner, { operation: 'source_revoke', eventId: 'source-block/' + randomUUID(), sourceMessageIds: [...ids] });
          retractCompanionMemoryHistorySources(this.db, owner, ids);
          this.sourceOutbox.retract(owner, ids); this.refreshProcedures(owner, ids); }); this.development = new CompanionCharacterDevelopmentStore(db, (scope, note) => this.visible(scope, note));
        this.historyOutbox = new CompanionMemoryHistoryOutboxStore(db, { ownerScope: owner => this.sources.ownerScope(owner),
          authorize: (scope, id, revision) => { try { this.readRevision(scope, id, revision); return true; } catch { return false; } },
          annotations: (scope, id, revision) => ({ procedureValidation: this.project(this.readRevision(scope, id, revision), scope).procedure?.validation }) });
        this.sourceOutbox = new CompanionMemorySourceOutboxStore(db, (owner, id) => {
          const source = this.sources.filter(this.sources.ownerScope(owner), [id])[0];
          if (!source) return;
          const current = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
          return current ? { ...this.sources.reference(row(current)), content: source.content } : undefined;
        });
        this.procedures = new CompanionMemoryProcedureStore(db, { load: (owner, id, version) => this.capturedMemory(owner, id, version),
          visibleSources: (scope, ids) => this.sourcesFilter(scope, ids) });
        this.consolidation = new CompanionMemoryConsolidationStore(db, {
          load: id => this.load(id), valid: note => this.visible(this.sources.ownerScope(note.companionId), note),
          persist: (note, cause) => this.persist(note, undefined, undefined, cause), enqueue: (note, operation) => this.enqueue(note, operation), invalidate: owner => this.changedOwners.add(owner),
          withdraw: id => this.withdrawNote(id, 'invalid'),
          record: (command, automatic) => this.recordJournal(command, command.candidate, undefined, 'automatic', command.expectedProhibitionRevision,
            false, { consolidation: 'source_version_graph', ...automatic }),
        });
      }
    initialize(): void {
        this.sources.initialize();
        this.consolidation.initialize();
        initializeTopicParticipationReceipts(this.db);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vcp_memory_scopes(scope_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,revision INTEGER NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vcp_memory_notes(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL,scope_id TEXT NOT NULL REFERENCES vcp_memory_scopes(scope_id),identity_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(companion_id,identity_key));
      CREATE INDEX IF NOT EXISTS vcp_note_scope ON vcp_memory_notes(companion_id,conversation_id);
      CREATE INDEX IF NOT EXISTS vcp_note_live_owner ON vcp_memory_notes(companion_id,json_extract(data,'$.status'));
      CREATE INDEX IF NOT EXISTS vcp_note_reset_pending ON vcp_memory_notes(companion_id,id) WHERE json_extract(data,'$.status') NOT IN('forgotten','invalid');
      CREATE TABLE IF NOT EXISTS vcp_note_sources(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),revision INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(note_id,message_id));
      CREATE INDEX IF NOT EXISTS vcp_note_source_message ON vcp_note_sources(message_id,note_id);
      CREATE TABLE IF NOT EXISTS vcp_note_source_history(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(note_id,message_id));
      CREATE INDEX IF NOT EXISTS vcp_note_history_message ON vcp_note_source_history(message_id,note_id);
      CREATE TABLE IF NOT EXISTS vcp_note_dependencies(note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id) ON DELETE CASCADE,source_note_id TEXT NOT NULL REFERENCES vcp_memory_notes(id),version INTEGER NOT NULL,PRIMARY KEY(note_id,source_note_id));
      CREATE INDEX IF NOT EXISTS vcp_note_dependency_source ON vcp_note_dependencies(source_note_id,note_id);
      CREATE TABLE IF NOT EXISTS vcp_capture_jobs(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),source_sequence INTEGER NOT NULL,through_sequence INTEGER NOT NULL,source_checksum TEXT NOT NULL,source_revision INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,completed_batch_id TEXT,output_note_versions TEXT,created_at TEXT,updated_at TEXT,UNIQUE(companion_id,message_id,source_revision,source_checksum));
      CREATE INDEX IF NOT EXISTS vcp_capture_claim ON vcp_capture_jobs(status,next_attempt,ordinal);
      CREATE TABLE IF NOT EXISTS companion_capture_proposals(job_id TEXT PRIMARY KEY REFERENCES vcp_capture_jobs(id) ON DELETE CASCADE,companion_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_capture_proposals_owner ON companion_capture_proposals(companion_id);
      CREATE TRIGGER IF NOT EXISTS companion_capture_proposal_settled AFTER UPDATE OF status ON vcp_capture_jobs WHEN NEW.status IN('done','cancelled','stale') BEGIN
        DELETE FROM companion_capture_proposals WHERE job_id=NEW.id;
      END;
      CREATE TABLE IF NOT EXISTS vcp_memory_outbox(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,scope_id TEXT NOT NULL,note_id TEXT NOT NULL,note_version INTEGER NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until INTEGER,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT,updated_at TEXT,UNIQUE(note_id,note_version,operation));
      CREATE INDEX IF NOT EXISTS vcp_memory_outbox_claim ON vcp_memory_outbox(status,next_attempt,ordinal);
      CREATE INDEX IF NOT EXISTS vcp_memory_outbox_owner_ordinal ON vcp_memory_outbox(companion_id,ordinal);
      CREATE INDEX IF NOT EXISTS vcp_memory_outbox_owner_ready ON vcp_memory_outbox(companion_id,status,next_attempt,ordinal);
      CREATE TABLE IF NOT EXISTS companion_memory_delivery_owners(companion_id TEXT PRIMARY KEY,last_service INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS companion_memory_delivery_fair ON companion_memory_delivery_owners(last_service,companion_id);
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
    `);
        if (!rows(this.db.prepare('PRAGMA table_info(vcp_capture_jobs)').all()).some(column => column.name === 'admission_deferred'))
            this.db.exec('ALTER TABLE vcp_capture_jobs ADD COLUMN admission_deferred INTEGER NOT NULL DEFAULT 0');
        this.ledger.initialize();
        this.projection.initialize();
        this.procedures.initialize();
        this.sourceOutbox.initialize();
        this.episodes.initialize();
        if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='vcp-management-totals-ready'").get()) this.db.transaction(() => {
            this.db.prepare("INSERT OR REPLACE INTO vcp_memory_management_totals SELECT companion_id,COUNT(*) FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed') GROUP BY companion_id").run();
            this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('vcp-management-totals-ready','1')").run();
        }).immediate();
        this.development.initialize();
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
    private persist(note: CompanionMemory, identity?: string, dependencies?: Array<{ id: string; contentRevision: number }>, cause?: CompanionMemoryWriteCause): void {
        const previousValue = this.db.prepare('SELECT data FROM vcp_memory_notes WHERE id=?').get(note.id);
        const previous = previousValue ? json<CompanionMemory>(row(previousValue).data) : undefined;
        const kind = this.ledger.stamp(note, previous, dependencies);
        if (identity)
            this.db.prepare('INSERT INTO vcp_memory_notes VALUES(?,?,?,?,?,?)').run(note.id, note.companionId, note.sourceConversationId, note.scopeId, identity, JSON.stringify(note));
        else
            this.db.prepare('UPDATE vcp_memory_notes SET data=? WHERE id=?').run(JSON.stringify(note), note.id);
        this.ledger.recordVersion(note);
        this.sourceOutbox.publish(note);
        this.db.prepare('DELETE FROM vcp_note_sources WHERE note_id=?').run(note.id);
        for (const source of note.sources) {
            this.db.prepare('INSERT INTO vcp_note_sources VALUES(?,?,?,?)').run(note.id, source.messageId, source.revision, source.checksum);
            this.db.prepare('INSERT OR IGNORE INTO vcp_note_source_history VALUES(?,?)').run(note.id, source.messageId);
        }
        if (kind) { this.ledger.change(note.companionId, kind, note, previous, dependencies, cause); this.changedOwners.add(note.companionId); }
    }
    /** Captured CAS versions survive annotation-only revisions; content changes
     * still require a fresh explicit read before validating a new practice. */
    capturedMemory(owner: string, id: string, version: number): CompanionMemory | undefined {
        try { const note = this.load(id); return note.companionId === owner && (note.version === version || this.ledger.versionRevision(id, version) === note.contentRevision)
          && this.visible(this.sources.ownerScope(owner), note) ? note : undefined; } catch { return undefined; }
    }
    private project(note: CompanionMemory, scope: Scope): CompanionMemory {
        return note.procedure ? { ...note, procedure: { ...note.procedure, validation: this.procedures.validation(note, scope) } } : note;
    }
    private annotateProcedure(id: string, contentRevision: number, validation: CompanionMemoryProcedureValidation): CompanionMemory | undefined {
        const note = this.load(id);
        if (!note.procedure || note.contentRevision !== contentRevision || !this.visible(this.sources.ownerScope(note.companionId), note)) return;
        if (JSON.stringify(note.procedure.validation) === JSON.stringify(validation)) return note;
        const evidence = validation.evidence.at(-1) ?? note.procedure.validation.evidence.at(-1);
        note.procedure = { ...note.procedure, validation }; note.version++; note.updatedAt = stamp(); note.status = 'queued';
        this.persist(note, undefined, undefined, { operation: 'annotation', ...(evidence ? { eventId: 'procedure-action/' + evidence.actionId,
          actionId: evidence.actionId, sourceMessageIds: [evidence.sourceMessageId] } : {}) }); this.enqueue(note, 'remember'); return note;
    }
    private refreshProcedures(owner: string, sourceIds: readonly string[]): void {
        for (const changed of this.procedures.refresh(owner, sourceIds)) this.annotateProcedure(changed.noteId, changed.contentRevision, changed.validation);
    }
    private enqueue(note: CompanionMemory, operation: 'remember' | 'forget'): void {
        this.db.prepare('INSERT OR IGNORE INTO companion_memory_delivery_owners(companion_id) VALUES(?)').run(note.companionId);
        if (operation === 'remember') {
            this.rejectFictionalSources(note.sources.map(source => source.messageId));
            if(typeof note.metadata?.topicParticipation==='string'){
                const saved=this.db.prepare('SELECT data FROM companion_topic_participation_receipts WHERE id=? AND companion_id=?').get(note.metadata.topicParticipation,note.companionId);
                const receipt=saved?json<TopicParticipationReceipt>(row(saved).data):undefined;
                if(!receipt||note.content!==topicParticipationMemoryContent(receipt)||note.diaryName!=='活动体验'||note.occurredAt!==receipt.occurredAt
                  ||JSON.stringify([...note.tags].sort())!==JSON.stringify(topicParticipationMemoryTags(receipt).sort())) throw Error('宿主参与体验只能保留实际参与事实与原始事件标签，不能改写为现实知识。');
            }
        }
        this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version<? AND status!='running'").run(note.id, note.version);
        this.db.prepare('INSERT OR IGNORE INTO vcp_memory_outbox(id,companion_id,scope_id,note_id,note_version,operation,data) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), note.companionId, note.scopeId, note.id, note.version, operation, JSON.stringify({ noteId: note.id, version: note.version }));
        this.db.prepare("UPDATE vcp_memory_scopes SET revision=revision+1,state='dirty',updated_at=? WHERE scope_id=?").run(stamp(), note.scopeId);
    }
    private visible(scope: Scope, note: MemoryMetadata, visited = new Set<string>()): boolean {
        if (visited.has(note.id))
            return false;
        return this.sources.validateMemory(scope, note, () => this.visibleValue(scope, note, visited));
    }
    private visibleValue(scope: Scope, note: MemoryMetadata, visited: Set<string>): boolean {
        this.sources.requireScope(scope);
        visited.add(note.id);
        if (note.companionId !== scope.companionId || ['forgotten', 'invalid'].includes(note.status) || !note.sources.length
            || note.sources.some(source => this.fictionalSource(source.messageId)))
            return false;
        if (this.sources.blockedTag({ ...scope, conversationId: note.sourceConversationId }, note.tags, note.sourceSequence))
            return false;
        if (!note.sources.every(reference => { const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reference.messageId); return source && Number(row(source).revision ?? 1) === reference.revision && companionSourceChecksum(String(row(source).content)) === reference.checksum && this.sources.visible(scope, row(source)); }))
            return false;
        return rows(this.db.prepare('SELECT source_note_id,version FROM vcp_note_dependencies WHERE note_id=?').all(note.id)).every(dependency => { const source = this.load(String(dependency.source_note_id)); return source.contentRevision === Number(dependency.version) && this.visible(scope, source, new Set(visited)); });
    }
    sourcesFilter(scope: Scope, ids: string[]): CompanionMessage[] { return this.sources.filter(scope, ids); }
    observeSource(messageId: string, companionId: string): void { this.sources.observe(messageId, companionId); }
    /** A deterministic activity memory from a persisted transition, with no fictional content. */
    recordTopicParticipation(messageId:string,companionId:string):CompanionMemory|undefined {
        const found=this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId),metadata=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/'+messageId);
        if(!found||!metadata) throw Error('话题参与体验缺少宿主凭证。');
        const source=row(found),proof=json<{companionId:string;forConversationId:string;checksum:string;topicParticipation?:string}>(row(metadata).value);
        const saved=proof.topicParticipation?this.db.prepare('SELECT data FROM companion_topic_participation_receipts WHERE id=? AND companion_id=?').get(proof.topicParticipation,companionId):undefined;
        const receipt=saved?json<TopicParticipationReceipt>(row(saved).data):undefined,worldRoom='world_'+companionId;
        const payload=json<{items?:unknown[]}>(source.content);
        if(!receipt||receipt.trust!=='actual_participation_only'||proof.companionId!==companionId||proof.forConversationId!==worldRoom||source.conversation_id!==worldRoom||source.author_id!=='system'||source.kind!=='notice'||source.status!=='sent'
          ||proof.checksum!==companionSourceChecksum(String(source.content))||JSON.stringify(payload.items?.[0])!==JSON.stringify(receipt)) throw Error('话题参与体验与实际事件不一致。');
        const scope={companionId,conversationId:worldRoom},tags=topicParticipationMemoryTags(receipt);
        if(this.sources.blockedTag(scope,tags,Number(source.sequence))||!this.sources.visible(scope,source)) return;
        return this.record(scope,{content:topicParticipationMemoryContent(receipt),tags,diaryName:'活动体验',occurredAt:receipt.occurredAt,
          sourceMessageIds:[messageId],evidence:[{sourceMessageId:messageId,quote:String(source.content)}],metadata:{topicParticipation:receipt.id,topicId:receipt.topicId,participationAction:receipt.action,trust:receipt.trust}});
    }
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
        if (!this.sources.visible(scope, source)) return;
        this.db.prepare('INSERT OR IGNORE INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)')
            .run(randomUUID(), companionId, worldRoom, messageId, source.sequence, source.sequence, receipt.checksum, source.revision ?? 1);
        this.observeCapture(companionId, worldRoom, messageId, Date.now());
    }
    enqueueMessage(messageId: string, finalizedLoop = false): void {
        if (this.fictionalSource(messageId) || this.deletedTopicSource(messageId)) return;
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
            this.invalidateOwner(owner, { operation: 'source_revoke', eventId: 'source-revision/' + messageId + '/' + source.revision, sourceMessageIds: [messageId], conversationId: String(source.conversation_id) }); this.withdrawStateSources?.(owner, [messageId]);
            this.sourceOutbox.changedSource(owner, messageId);
            this.refreshProcedures(owner, [messageId]);
        }
        this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL WHERE message_id=? AND (source_checksum!=? OR source_revision!=?)").run(messageId, checksum, source.revision ?? 1);
        for (const reference of rows(this.db.prepare('SELECT note_id,checksum,revision FROM vcp_note_sources WHERE message_id=?').all(messageId)))
            if (reference.checksum !== checksum || Number(reference.revision) !== Number(source.revision ?? 1))
                this.withdrawNote(String(reference.note_id), 'invalid');
        const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + messageId);
        for (const member of rows(this.db.prepare('SELECT companion_id FROM conversation_members WHERE conversation_id=?').all(source.conversation_id))) {
            const owner = String(member.companion_id);
            if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(owner))
                continue;
            const boundary = this.db.prepare('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(owner);
            if (boundary && Number(source.sequence) <= Number(row(boundary).through_sequence))
                continue;
            this.sources.observe(messageId, owner);
            if (this.sources.forgotten({ companionId: owner, conversationId: String(source.conversation_id) }, source))
                continue;
            this.db.prepare('INSERT OR IGNORE INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), owner, source.conversation_id, messageId, source.sequence, publication ? Math.max(Number(source.sequence), Number(row(publication).value) + 1) : source.sequence, checksum, source.revision ?? 1);
            this.observeCapture(owner, String(source.conversation_id), messageId, Date.now());
        }
    }
    private observeCapture(owner: string, room: string, messageId: string, at?: number): void {
        const source = this.db.prepare(`SELECT id,companion_id,conversation_id,message_id FROM vcp_capture_jobs WHERE companion_id=? AND conversation_id=? AND message_id=?
          ORDER BY ordinal DESC LIMIT 1`).get(owner, room, messageId) as { id: string; companion_id: string; conversation_id: string; message_id: string } | undefined;
        if (source) try { this.episodes.observe(source, at); }
        catch (error) { if (!(error instanceof CompanionMemoryPolicyUnavailableError)) throw error; }
    }
    private reconsiderationKey(job: Row): string { return 'vcp-capture-reconsideration/' + job.companion_id + '/' + job.id; }
    private reconsideration(job: Row): CaptureReconsideration | undefined {
        const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(this.reconsiderationKey(job));
        if (!found) return;
        const intent = json<CaptureReconsideration>(row(found).value);
        return intent.sourceRevision === Number(job.source_revision) && intent.sourceChecksum === job.source_checksum ? intent : undefined;
    }
    private saveReconsideration(job: Row, intent?: CaptureReconsideration): void {
        if (intent) this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(this.reconsiderationKey(job), JSON.stringify(intent));
        else this.db.prepare('DELETE FROM metadata WHERE key=?').run(this.reconsiderationKey(job));
    }
    private reconsiderationSourceValid(job: Row): boolean {
        const scope = this.sources.ownerScope(String(job.companion_id));
        const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(job.message_id);
        if (!found || Number(row(found).revision ?? 1) !== Number(job.source_revision)
          || companionSourceChecksum(String(row(found).content)) !== job.source_checksum
          || this.fictionalSource(String(job.message_id)) || this.deletedTopicSource(String(job.message_id))) return false;
        if (!this.db.prepare(`SELECT 1 FROM companions p JOIN conversation_members m ON m.companion_id=p.id
          JOIN conversations c ON c.id=m.conversation_id WHERE p.id=? AND p.deleted_at IS NULL AND c.id=?`).get(scope.companionId, scope.conversationId)) return false;
        return this.sources.filter(scope, [String(job.message_id)]).length === 1;
    }
    private reconsiderationReady(job: Row): boolean {
        // Losing the original interaction entrance does not revoke a witnessed
        // personal memory. Keep its intent durable, but do not invent a new room
        // in which the ordinary capture pipeline could execute that job.
        if (!this.db.prepare(`SELECT 1 FROM companions p JOIN conversation_members m ON m.companion_id=p.id
          JOIN conversations c ON c.id=m.conversation_id WHERE p.id=? AND p.deleted_at IS NULL AND c.id=?`).get(job.companion_id, job.conversation_id)) return false;
        return true;
    }
    private liveReconsideration(job: Row, intent: CaptureReconsideration): boolean {
        return this.reconsiderationSourceValid(job) && (intent.invalidNotes.some(reference => {
            const note = this.load(reference.id);
            return note.companionId === job.companion_id && note.status === 'invalid' && note.version === reference.version;
        }) || (intent.retiredNotes ?? []).some(reference => {
            const note = this.load(reference.id);
            return note.companionId === job.companion_id && note.status === 'forgotten' && note.version === reference.version;
        }));
    }
    private captureReady(job: Row): boolean {
        if (this.db.prepare('SELECT 1 FROM vcp_source_blocks WHERE companion_id=? AND message_id=?').get(job.companion_id, job.message_id)) {
            // A withdrawn source is retained as raw audit material, never a new
            // model job. This also covers ordinary jobs without a retry intent.
            this.saveReconsideration(job);
            this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL,output_note_versions='[]' WHERE id=?").run(job.id);
            return false;
        }
        const intent = this.reconsideration(job);
        if (!intent) return true;
        if (!this.liveReconsideration(job, intent)) {
            this.saveReconsideration(job);
            this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL,output_note_versions='[]' WHERE id=?").run(job.id);
            return false;
        }
        return this.reconsiderationReady(job);
    }
    private reconsiderRetiredNote(note: CompanionMemory, cause: string, currentSourceIds?: readonly string[]): void {
        for (const job of rows(this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j JOIN vcp_note_source_history h ON h.message_id=j.message_id
          WHERE h.note_id=? AND j.companion_id=?`).all(note.id, note.companionId))) {
            // History is a forget barrier, not a reconstruction readset. On the
            // first withdrawal only the just-retired version's actual sources
            // can receive a new extraction intent.
            if (currentSourceIds && !currentSourceIds.includes(String(job.message_id))) continue;
            const prior = this.reconsideration(job);
            // A new parent change may supersede an in-flight reconsideration, but
            // cannot re-open a historical tombstone whose intent was already consumed.
            const references = note.status === 'invalid' ? prior?.invalidNotes : prior?.retiredNotes;
            const knownNote = references?.some(reference => reference.id === note.id && reference.version === note.version);
            const newCause = !prior?.causes.includes(cause);
            if ((!currentSourceIds && !knownNote) || !newCause && knownNote || !this.reconsiderationSourceValid(job)) continue;
            const changed = [...(references ?? []).filter(reference => reference.id !== note.id), { id: note.id, version: note.version }];
            this.saveReconsideration(job, { sourceRevision: Number(job.source_revision), sourceChecksum: String(job.source_checksum),
              invalidNotes: note.status === 'invalid' ? changed : prior?.invalidNotes ?? [],
              ...(note.status === 'forgotten' ? { retiredNotes: changed } : prior?.retiredNotes ? { retiredNotes: prior.retiredNotes } : {}),
              causes: newCause ? [...(prior?.causes ?? []), cause] : prior!.causes, ...(job.status === 'running' ? { blockedLeaseToken: String(job.lease_token) } : {}) });
            if (job.status !== 'running' && newCause) this.db.prepare(`UPDATE vcp_capture_jobs SET status='pending',attempts=0,next_attempt=0,error=NULL,
              lease_token=NULL,lease_until=NULL,completed_batch_id=NULL,output_note_versions=NULL WHERE id=?`).run(job.id);
        }
    }
    /** Settle an obsolete response without consuming its notes or state proposal. */
    private releaseSupersededCapture(token: string): void {
        for (const job of rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token))) {
            const intent = this.reconsideration(job);
            const retained = intent && this.liveReconsideration(job, intent);
            this.db.prepare(`UPDATE vcp_capture_jobs SET status=?,attempts=?,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL,
              completed_batch_id=NULL,output_note_versions=NULL WHERE id=?`).run(intent && !retained ? 'done' : 'pending',
              intent?.blockedLeaseToken === token ? 0 : Number(job.attempts), job.id);
            if (intent) this.saveReconsideration(job, retained ? { ...intent, blockedLeaseToken: undefined } : undefined);
        }
    }
    private pruneReconsiderations(companionId?: string): void {
        const prefix = 'vcp-capture-reconsideration/' + (companionId ? companionId + '/' : '');
        for (const entry of rows(this.db.prepare('SELECT key FROM metadata WHERE key>=? AND key<?').all(prefix, prefix + '\uffff'))) {
            const id = String(entry.key).split('/').at(-1)!;
            const found = this.db.prepare('SELECT * FROM vcp_capture_jobs WHERE id=?').get(id);
            const job = found ? row(found) : undefined, intent = job && this.reconsideration(job);
            if (job && intent && this.liveReconsideration(job, intent)) continue;
            if (job?.status === 'running') this.releaseSupersededCapture(String(job.lease_token));
            if (job) this.db.prepare("UPDATE vcp_capture_jobs SET status='done',lease_token=NULL,lease_until=NULL,output_note_versions='[]' WHERE id=?").run(job.id);
            this.db.prepare('DELETE FROM metadata WHERE key=?').run(entry.key);
        }
    }
    private settleCaptureCoverage(job: Row): boolean {
        const coverage = this.ledger.coverage(String(job.companion_id), { message_id: String(job.message_id), source_revision: Number(job.source_revision), source_checksum: String(job.source_checksum) });
        if (!coverage || this.reconsideration(job)) return false;
        const note = this.load(coverage.noteId);
        if (note.contentRevision !== coverage.contentRevision || !this.visible(this.sources.ownerScope(note.companionId), note)) return false;
        this.db.prepare("UPDATE vcp_capture_jobs SET status='done',output_note_versions=?,completed_batch_id=id WHERE id=?")
            .run(JSON.stringify([{ id: note.id, version: note.version }]), job.id);
        return true;
    }
    claim(companionId?: string, leaseMs = 120000, force = false): CompanionMemoryJob | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.retireFictionalCaptureJobs();
            for (const job of rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_until<=?").all(now))) {
                const intent = this.reconsideration(job);
                if (intent && (intent.blockedLeaseToken === job.lease_token || !this.liveReconsideration(job, intent))) this.releaseSupersededCapture(String(job.lease_token));
            }
            this.db.prepare("UPDATE vcp_capture_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            const candidates = this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j JOIN companions c ON c.id=j.companion_id WHERE j.status IN('pending','failed') AND j.next_attempt<=? AND j.attempts<8 AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1 AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=j.companion_id AND r.status!='completed') ${companionId ? 'AND j.companion_id=?' : ''} AND j.ordinal>? ORDER BY j.ordinal LIMIT 8`);
            let found: Row | undefined, after = 0;
            for (;;) {
                const page = rows(candidates.all(now, ...(companionId ? [companionId] : []), after));
                found = page.find(job => {
                    let capture;
                    try { capture = resolveCompanionMemoryPolicy(this.db, String(job.companion_id)).policy.capture; }
                    catch (error) { if (error instanceof CompanionMemoryPolicyUnavailableError) return false; throw error; }
                    if (!this.captureReady(job)) return false;
                    if (this.settleCaptureCoverage(job)) return false;
                    const episode = this.episodes.observe({ id: String(job.id), companion_id: String(job.companion_id), conversation_id: String(job.conversation_id), message_id: String(job.message_id) }, undefined, capture);
                    return force || !!this.reconsideration(job) || this.episodes.due(episode, capture) <= now;
                });
                if (found || page.length < 8) break;
                after = Number(page.at(-1)!.ordinal);
            }
            if (!found)
                return;
            const job = found, token = randomUUID(), reconsidering = !!this.reconsideration(job);
            let capture;
            try { capture = resolveCompanionMemoryPolicy(this.db, String(job.companion_id)).policy.capture; }
            catch (error) { if (error instanceof CompanionMemoryPolicyUnavailableError) return; throw error; }
            // A policy outage must not lose raw intake. Once repaired, restore
            // bounded pending mappings from original timestamps before sealing.
            for (const pending of rows(this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j WHERE j.companion_id=? AND j.conversation_id=?
              AND j.status IN('pending','failed') AND NOT EXISTS(SELECT 1 FROM companion_memory_episode_sources s WHERE s.job_id=j.id)
              ORDER BY j.source_sequence,j.ordinal LIMIT 12`).all(job.companion_id, job.conversation_id)))
                this.episodes.observe({ id: String(pending.id), companion_id: String(pending.companion_id), conversation_id: String(pending.conversation_id), message_id: String(pending.message_id) }, undefined, capture);
            const episode = this.episodes.observe({ id: String(job.id), companion_id: String(job.companion_id), conversation_id: String(job.conversation_id), message_id: String(job.message_id) }, undefined, capture);
            if (!force && !reconsidering && this.episodes.due(episode, capture) > now) return;
            // A historical extraction cannot replay state, while a fresh source
            // must retain its normal state processing. Never mix those batches.
            const cohort = this.db.prepare(`SELECT * FROM vcp_capture_jobs j WHERE companion_id=? AND conversation_id=? AND status IN('pending','failed')
              AND next_attempt<=? AND attempts<8 AND EXISTS(SELECT 1 FROM metadata m WHERE m.key='vcp-capture-reconsideration/'||j.companion_id||'/'||j.id)=?
              AND id IN(SELECT job_id FROM companion_memory_episode_sources WHERE episode_id=?)
              AND id!=? AND (source_sequence>? OR source_sequence=? AND ordinal>?) ORDER BY source_sequence,ordinal LIMIT 12`);
            const batch = [job]; let sequence = -1, ordinal = 0;
            while (batch.length < capture.batchSize) {
                const page = rows(cohort.all(job.companion_id, job.conversation_id, now, Number(reconsidering), episode.id, job.id, sequence, sequence, ordinal));
                for (const source of page) if (batch.length < capture.batchSize && this.captureReady(source) && !this.settleCaptureCoverage(source)) batch.push(source);
                if (page.length < 12) break;
                sequence = Number(page.at(-1)!.source_sequence); ordinal = Number(page.at(-1)!.ordinal);
            }
            batch.sort((a, b) => Number(a.source_sequence) - Number(b.source_sequence) || Number(a.ordinal) - Number(b.ordinal));
            this.episodes.seal(episode.id);
            for (const source of batch)
                this.db.prepare("UPDATE vcp_capture_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1,admission_deferred=0 WHERE id=?").run(token, now + leaseMs, source.id);
            return { id: String(job.id), companionId: String(job.companion_id), conversationId: String(job.conversation_id), episodeId: episode.id, sourceMessageIds: batch.map(source => String(source.message_id)), throughSequence: Math.max(...batch.map(source => Number(source.through_sequence))), leaseToken: token, attempts: Number(job.attempts) + 1, sourceChecksums: Object.fromEntries(batch.map(source => [String(source.message_id), String(source.source_checksum)])), sourceRevisions: Object.fromEntries(batch.map(source => [String(source.message_id), Number(source.source_revision)])) };
        }).immediate();
    }
    captureEligibility(companionId: string, now = Date.now()): { eligible: number; nextAt?: string } { return this.episodes.eligibility(companionId, now); }
    private captureContributions(command: Extract<CompanionStorageCommand, { type: 'memory.jobs.contributions' }>): NonNullable<CompanionStorageResponse['memoryCaptureContributions']> {
        const job = this.leased('vcp_capture_jobs', command.id, command.leaseToken);
        if (job.companion_id !== command.companionId) throw new Error('来源贡献不属于本次伙伴的实际编码租约。');
        const batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(command.leaseToken));
        const scope = { companionId: command.companionId, conversationId: String(job.conversation_id),
            beforeSequence: Math.max(...batch.map(source => Number(source.through_sequence))) };
        this.sources.requireScope(scope);
        for (const source of batch) {
            const current = this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.message_id);
            if (source.companion_id !== scope.companionId || source.conversation_id !== scope.conversationId || !current
                || Number(row(current).revision ?? 1) !== Number(source.source_revision)
                || companionSourceChecksum(String(row(current).content)) !== source.source_checksum || !this.sources.visible(scope, row(current)))
                throw new Error('编码来源已修订、撤回或不属于本次实际可见域。');
        }
        const limit = command.limit ?? 32;
        const found = rows(this.db.prepare(`SELECT DISTINCT n.id,n.data FROM vcp_note_sources s INDEXED BY vcp_note_source_message
            JOIN vcp_capture_jobs j ON j.message_id=s.message_id AND j.source_revision=s.revision AND j.source_checksum=s.checksum
            JOIN vcp_memory_notes n ON n.id=s.note_id AND n.companion_id=j.companion_id
            WHERE j.lease_token=? AND j.status='running' AND n.companion_id=? AND n.id>?
              AND json_extract(n.data,'$.status') IN('queued','indexed') ORDER BY n.id LIMIT ?`)
            .all(command.leaseToken, scope.companionId, command.afterId ?? '', limit + 1));
        const selected = found.slice(0, limit), items = selected.map(entry => json<CompanionMemory>(entry.data))
            .filter(note => this.visible(scope, note)).map(note => this.project(note, scope));
        return { items, hasMore: found.length > limit, ...(found.length > limit && selected.length ? { nextId: String(selected.at(-1)!.id) } : {}) };
    }
    private leased(table: 'vcp_capture_jobs' | 'vcp_memory_outbox', id: string, token: string): Row { const found = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND status='running' AND lease_token=? AND lease_until>?`).get(id, token, Date.now()); if (!found)
        throw new Error('VCP 投递租约已失效。'); return row(found); }
    complete(id: string, token: string, notes: CompanionMemoryCandidate[], stateProposal?: CompanionStateProposal, expectedProhibitionRevision?: string, expectedStateRevision?: number,
        readMemories?: Array<{ id: string; version: number; contentRevision: number }>): CompanionMemory[] {
        if (notes.length > 100) throw new Error('单批日记候选不能超过100条。');
        return this.db.transaction(() => {
            const job = this.leased('vcp_capture_jobs', id, token), batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token)), sourceIds = new Set(batch.map(source => String(source.message_id)));
            const reconsiderations = batch.flatMap(source => { const intent = this.reconsideration(source); return intent ? [{ source, intent }] : []; });
            if (reconsiderations.some(({ intent }) => intent.blockedLeaseToken === token)) {
                this.releaseSupersededCapture(token); return [];
            }
            if (reconsiderations.some(({ source, intent }) => !this.liveReconsideration(source, intent))) {
                this.releaseSupersededCapture(token); this.pruneReconsiderations(String(job.companion_id)); return [];
            }
            if (reconsiderations.some(({ source }) => !this.reconsiderationReady(source))) { this.releaseSupersededCapture(token); return []; }
            if (batch.some(source => this.fictionalSource(String(source.message_id)) || this.deletedTopicSource(String(source.message_id)))) {
                // A topic association can be restored while an older capture is in flight.
                // Discard that model output and its state proposal together.
                this.db.prepare("UPDATE vcp_capture_jobs SET status='done',error=NULL,lease_token=NULL,lease_until=NULL,output_note_versions='[]' WHERE lease_token=?").run(token);
                for (const source of batch) this.saveReconsideration(source);
                return [];
            }
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
                if (readMemories) for (const id of note.relatedMemoryIds ?? []) {
                    const captured = readMemories.find(reference => reference.id === id), current = this.load(id);
                    if (!captured || this.ledger.versionRevision(id, captured.version) !== captured.contentRevision
                        || current.companionId !== scope.companionId || current.contentRevision !== captured.contentRevision || !this.visible(scope, current))
                        throw new Error('本次编码实际读过的关联正文或权限已变化；保留来源等待重新核验，不能绑定未读的新版本。');
                }
                let candidate = note;
                let target: { id: string; expectedVersion: number } | undefined;
                if (note.encoding && note.encoding.action !== 'create') {
                    const previous = this.load(note.encoding.targetId!);
                    const capturedVersion = note.encoding.expectedVersion!, sameBody = previous.version === capturedVersion
                      || this.ledger.versionRevision(previous.id, capturedVersion) === previous.contentRevision;
                    if (!this.visible(scope, previous) || !sameBody || previous.sourceConversationId !== scope.conversationId
                      || previous.metadata?.consolidation || previous.metadata?.dream || previous.metadata?.simulation) throw new Error('延续或纠正的原始日记版本已变化，请重新读取。');
                    const annotations = this.ledger.versionAnnotations(previous.id, capturedVersion), rebased = previous.version !== capturedVersion;
                    const retained = this.sources.filter(scope, previous.sources.map(source => source.messageId));
                    if (retained.length !== previous.sources.length) throw new Error('延续日记的历史来源已失效。');
                    const dependencies = rows(this.db.prepare('SELECT source_note_id FROM vcp_note_dependencies WHERE note_id=?').all(previous.id)).map(value => String(value.source_note_id));
                    const allIds = [...new Set([...previous.sources.map(source => source.messageId), ...note.sourceMessageIds])];
                    if (allIds.length > 100) throw new Error('事件来源超过单篇上限，请保留原文并建立有据后续日记。');
                    candidate = { ...note, encoding: { ...note.encoding, expectedVersion: previous.version }, sourceMessageIds: allIds, sourceChecksums: { ...Object.fromEntries(retained.map(source => [source.id, companionSourceChecksum(source.content)])), ...note.sourceChecksums },
                      evidence: [...retained.filter(source => !note.sourceMessageIds.includes(source.id)).map(source => ({ sourceMessageId: source.id, quote: source.content.slice(0, 16000) })), ...note.evidence],
                      relatedMemoryIds: [...new Set([...dependencies, ...(note.relatedMemoryIds ?? []).filter(id => id !== previous.id)])] };
                    if (rebased && annotations) candidate = { ...candidate,
                      tags: [...new Set([...previous.tags, ...(note.tags ?? []).filter(tag => !annotations.tags.includes(tag))])],
                      diaryName: note.diaryName === undefined || note.diaryName === annotations.diaryName ? previous.diaryName : note.diaryName,
                      metadata: { ...note.metadata, ...(note.metadata?.autoTags === undefined || note.metadata.autoTags === annotations.autoTags
                        ? { autoTags: previous.metadata?.autoTags } : {}) } };
                    target = { id: previous.id, expectedVersion: previous.version };
                }
                const saved = this.recordJournal(scope, candidate, target, 'automatic', undefined, false, undefined,
                  new Map(reconsiderations.flatMap(({ intent }) => intent.invalidNotes.map(reference => [reference.id, reference.version] as const))),
                  { eventId: 'capture/' + id, operation: note.encoding?.action === 'correct' ? 'correct' : target ? 'append' : 'capture' }, undefined,
                  new Map(reconsiderations.flatMap(({ intent }) => (intent.retiredNotes ?? []).map(reference => [reference.id, reference.version] as const))));
                if (saved)
                    result.push(saved);
            }
            if (!reconsiderations.length && stateProposal && !stateProposal.sourceMessageIds.every(source => sourceIds.has(source))) throw new Error('状态提议只能使用本批正式来源。');
            if (!reconsiderations.length && stateProposal && this.sources.filter(scope, stateProposal.sourceMessageIds).length === stateProposal.sourceMessageIds.length) {
                const current = this.db.prepare("SELECT json_extract(data,'$.revision') AS revision FROM companion_runtime_states WHERE companion_id=?").get(scope.companionId) as { revision: number } | undefined;
                const skipped = expectedStateRevision !== undefined && (current?.revision ?? 1) !== expectedStateRevision;
                if (skipped) this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('vcp-capture-state-skipped/' + id,
                  JSON.stringify({ reason: 'state_revision_changed', expectedRevision: expectedStateRevision, currentRevision: current?.revision ?? 1, at: stamp() }));
                else if (result.length && !(stateProposal.appraisals ?? []).some(appraisal => appraisal.target === 'user'))
                    this.integrateState(scope, result, stateProposal, { eventKey: 'capture:' + id, kind: 'capture', expectedRevision: expectedStateRevision });
                else this.applyState?.(scope, stateProposal);
            }
            const outputs = [...new Map(result.map(note => [note.id + ':' + note.version, { id: note.id, version: note.version }])).values()];
            this.db.prepare("UPDATE vcp_capture_jobs SET status='done',error=NULL,lease_token=NULL,lease_until=NULL,completed_batch_id=?,output_note_versions=? WHERE lease_token=?")
                .run(id, JSON.stringify(outputs), token);
            for (const source of batch) this.saveReconsideration(source);
            return result;
        }).immediate();
    }
    fail(id: string, token: string, error: string, retryAfterMs = 30000, preserveProposal = false): void { this.db.transaction(() => {
        this.leased('vcp_capture_jobs', id, token);
        const batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token));
        if (batch.some(job => this.reconsideration(job)?.blockedLeaseToken === token)) { this.releaseSupersededCapture(token); return; }
        if (!preserveProposal) this.db.prepare('DELETE FROM companion_capture_proposals WHERE job_id=?').run(id);
        this.db.prepare("UPDATE vcp_capture_jobs SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL,admission_deferred=0 WHERE lease_token=?").run(error, Date.now() + retryAfterMs, token);
    }).immediate(); }
    /** Unsent host admission preserves the whole leased cohort and its debt. */
    defer(id: string, token: string, error: string, retryAfterMs = 30000): void { this.db.transaction(() => {
        this.leased('vcp_capture_jobs', id, token);
        const batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token));
        if (batch.some(job => this.reconsideration(job)?.blockedLeaseToken === token)) { this.releaseSupersededCapture(token); return; }
        this.db.prepare("UPDATE vcp_capture_jobs SET status='pending',attempts=MAX(0,attempts-1),error=?,next_attempt=?,lease_token=NULL,lease_until=NULL,admission_deferred=1 WHERE status='running' AND lease_token=?")
            .run(error, Date.now() + retryAfterMs, token);
    }).immediate(); }
    retryAdmission(companionId?: string): void {
        this.db.prepare(`UPDATE vcp_capture_jobs SET next_attempt=0,error=NULL,admission_deferred=0
          WHERE status='pending' AND admission_deferred=1 ${companionId ? 'AND companion_id=?' : ''}`).run(...(companionId ? [companionId] : []));
    }
    private captureProposal(id: string, token: string, input?: CompanionCaptureProposal): CompanionCaptureProposal | undefined {
        return this.db.transaction(() => {
            const job = this.leased('vcp_capture_jobs', id, token);
            const batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=? ORDER BY source_sequence,ordinal").all(token));
            const current = batch.map(source => ({ id: String(source.message_id), revision: Number(source.source_revision), checksum: String(source.source_checksum) }));
            const proposed = input ?? (() => { const found = this.db.prepare('SELECT data FROM companion_capture_proposals WHERE job_id=? AND companion_id=?').get(id, job.companion_id);
                return found ? companionCaptureProposalSchema.parse(json(row(found).data)) : undefined; })();
            const scope = { companionId: String(job.companion_id), conversationId: String(job.conversation_id), beforeSequence: Math.max(...batch.map(source => Number(source.through_sequence))) };
            const visible = this.sources.filter(scope, current.map(source => source.id));
            const actualSources = rows(this.db.prepare('SELECT id,revision,content FROM messages WHERE id IN(SELECT value FROM json_each(?))').all(JSON.stringify(current.map(source => source.id))));
            if (proposed && JSON.stringify(current) !== JSON.stringify(proposed.sourceVersions)
              || visible.length !== current.length || current.some(expected => !actualSources.some(source => source.id === expected.id
                && Number(source.revision ?? 1) === expected.revision && companionSourceChecksum(String(source.content)) === expected.checksum))) {
                this.db.prepare('DELETE FROM companion_capture_proposals WHERE job_id=?').run(id);
                throw new Error('未发布日记提案的原始来源、权限或实际编码批次已经变化。');
            }
            if (!proposed) return;
            if (input) {
                const serialized = JSON.stringify(companionCaptureProposalSchema.parse(input));
                if (Buffer.byteLength(serialized, 'utf8') > 1_048_576) throw new Error('未发布日记提案超过本轮持久检查点预算，来源尚未完成。');
                this.db.prepare('INSERT INTO companion_capture_proposals(job_id,companion_id,data) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data')
                    .run(id, job.companion_id, serialized);
            }
            return proposed;
        }).immediate();
    }
    /** Only committed, still-authorized VCP notes can substantiate a present integration event. */
    integrateState(scope: Scope, notes: readonly CompanionMemory[], proposal: CompanionStateProposal,
      event: Pick<CompanionMemoryStateIntegration, 'eventKey' | 'kind' | 'expectedRevision'>): void {
        if (!notes.length) throw new Error('记忆整合状态需要本次实际保存的新笔记。');
        const current = notes.map(note => { const actual = this.load(note.id); if (actual.version !== note.version || !this.visible(scope, actual)) throw new Error('整合所依赖的笔记已经变化。'); return actual; });
        const ids = [...new Set(proposal.sourceMessageIds)], sources = this.sources.filter(scope, ids);
        if (sources.length !== ids.length || ids.some(id => !current.some(note => note.sources.some(source => source.messageId === id)))
          || proposal.evidence.some(evidence => !ids.includes(evidence.sourceMessageId) || !sources.some(source => source.id === evidence.sourceMessageId && source.content.includes(evidence.quote)))
          || ids.some(id => !proposal.evidence.some(evidence => evidence.sourceMessageId === id))) throw new Error('整合状态缺少本次笔记的真实逐字来源。');
        if ((proposal.appraisals ?? []).some(appraisal => appraisal.target === 'user')) throw new Error('记忆整合不能重放用户关系评价。');
        if (this.applyIntegration) this.applyIntegration(scope, { ...event, reason: proposal.reason, expression: proposal.expression,
          focus: proposal.focus, appraisals: proposal.appraisals ?? [], sourceMessageIds: ids,
          memoryVersions: current.map(note => ({ id: note.id, version: note.version })) });
        else if (event.kind === 'capture') this.applyState?.(scope, proposal);
    }
    retry(companionId?: string): void { this.retryAdmission(companionId); for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox'])
        this.db.prepare(`UPDATE ${table} SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL
          WHERE (status='failed' OR status='pending' AND attempts>=8 OR status='running' AND attempts>=8 AND lease_until<=?)
          ${companionId ? 'AND companion_id=?' : ''}`).run(Date.now(), ...(companionId ? [companionId] : [])); }
    recordPrivateConsolidation(scope: Scope, candidate: CompanionMemoryCandidate, worldJobId: string, leaseToken: string): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const found = this.db.prepare("SELECT data,lease_until FROM companion_world_jobs WHERE id=? AND companion_id=? AND kind='dream' AND status='running'").get(worldJobId, scope.companionId);
            if (!found) throw new Error('私人睡眠整理必须属于当前真实梦任务。');
            const job = json<{ companionId: string; conversationId: string; leaseToken?: string; sleepEpisodeId?: string;
              maintenanceMode?: 'sleep' | 'background'; maintenanceSessionId?: string; dreamMode?: 'sleep_dream' | 'rehearsal_dream';
              memoryVersions?: Array<{ id: string; version: number; contentRevision?: number }> }>(row(found).data);
            if (job.leaseToken !== leaseToken || String(row(found).lease_until) < stamp() || job.conversationId !== scope.conversationId) throw new Error('私人睡眠整理租约或消息入口已变化。');
            const room = this.sources.requireScope(scope);
            if (room.kind !== 'private' && scope.conversationId !== 'world_' + scope.companionId) throw new Error('跨经历反思只能发布到本人私人入口。');
            const versions = new Map(job.memoryVersions?.map(memory => [memory.id, memory]));
            const related = candidate.relatedMemoryIds ?? [];
            if (!related.length || related.some(id => !versions.has(id))) throw new Error('私人整理缺少本轮实际读取的记忆版本。');
            const seeds = related.map(id => this.load(id));
            const ownerScope = this.sources.ownerScope(scope.companionId);
            if (seeds.some(seed => { const expected = versions.get(seed.id)!; return seed.companionId !== scope.companionId
              || (expected.contentRevision !== undefined ? seed.contentRevision !== expected.contentRevision : seed.version !== expected.version)
              || !this.visible(ownerScope, seed); })) throw new Error('私人整理的种子已经变化。');
            const sourceIds = new Set(seeds.flatMap(seed => seed.sources.map(source => source.messageId)));
            if (candidate.sourceMessageIds.some(id => !sourceIds.has(id))) throw new Error('私人整理不能引入本轮未读取的来源。');
            return this.recordJournal(scope, candidate, undefined, 'automatic', undefined, true,
              { consolidation: true, sleepReflection: candidate.metadata?.dream !== true ? true : undefined, sleepWorldJobId: worldJobId, worldJobId,
                ...(job.sleepEpisodeId ? { sleepEpisodeId: job.sleepEpisodeId } : {}), ...(job.maintenanceMode ? { maintenanceMode: job.maintenanceMode } : {}),
                ...(job.maintenanceSessionId ? { maintenanceSessionId: job.maintenanceSessionId } : {}),
                ...(candidate.metadata?.dream === true ? { dreamMode: job.dreamMode ?? (job.maintenanceMode === 'background' ? 'rehearsal_dream' : 'sleep_dream') } : {}) });
        }).immediate();
    }
    /** Automatic merges are admitted only by the current real sleep lease and
     * its immutable seed readset. The outer world transaction commits the job
     * and pending index together; publication retains the original evidence. */
    recordSleepConsolidation(scope: Scope, input: { inputs: Array<{ id: string; version: number }>; candidate: CompanionMemoryCandidate },
      worldJobId: string, leaseToken: string): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const plan = companionMemoryConsolidateSchema.parse(input);
            const found = this.db.prepare("SELECT data,lease_until FROM companion_world_jobs WHERE id=? AND companion_id=? AND kind='dream' AND status='running'").get(worldJobId, scope.companionId);
            if (!found) throw new Error('自动记忆整合必须属于当前真实睡眠任务。');
            const job = json<{ conversationId: string; leaseToken?: string; maintenanceMode?: 'sleep' | 'background'; maintenanceSessionId?: string; seedMemoryVersions?: Array<{ id: string; version: number; contentRevision?: number }>; maintenanceMemoryVersions?: Array<{ id: string; version: number; contentRevision?: number }> }>(row(found).data);
            if (job.leaseToken !== leaseToken || String(row(found).lease_until) < stamp() || job.conversationId !== scope.conversationId) throw new Error('自动记忆整合的睡眠租约或入口已变化。');
            const versions = new Map((job.maintenanceMemoryVersions ?? job.seedMemoryVersions)?.map(note => [note.id, note]));
            if (plan.inputs.some(note => { const expected = versions.get(note.id), actual = this.load(note.id); return !expected
              || (expected.contentRevision !== undefined ? actual.contentRevision !== expected.contentRevision : note.version !== expected.version);
            })) throw new Error('自动整合只能使用本轮准确读取的真实种子版本。');
            const originals = plan.inputs.map(note => this.load(note.id)), ownerScope = this.sources.ownerScope(scope.companionId);
            if (originals.some(note => note.procedure)) throw new Error('方法记忆保留独立的修订与实践验证，不参与自动摘要归档。');
            if (originals.some((note, index) => note.companionId !== scope.companionId || note.version !== plan.inputs[index]!.version
              || note.status !== 'indexed' || note.archivedAt || note.metadata?.dream || note.metadata?.simulation
              || note.metadata?.characterDevelopment !== undefined || !this.visible(ownerScope, note))) throw new Error('自动整合的原始记忆已经变化或不是可整合的实际经历。');
            if (plan.candidate.selfDevelopment || plan.candidate.metadata?.characterDevelopment !== undefined
              || plan.candidate.metadata?.dream || plan.candidate.metadata?.simulation) throw new Error('自动整合不能改写成长档案或把虚构内容发布为真实经历。');
            if (new Set(originals.map(note => note.sourceConversationId)).size !== 1) throw new Error('自动整合不能混合不同来源可见域。');
            if (!companionAutomaticConsolidationHasNovelty(originals)) throw new Error('自动整合需要原始日记的新信息，不能反复归档旧摘要或同源反思。');
            const sources = new Map(originals.flatMap(note => note.sources).map(source => [source.messageId, source]));
            if (plan.candidate.sourceMessageIds.length !== sources.size || plan.candidate.sourceMessageIds.some(id => !sources.has(id))) throw new Error('自动整合必须完整保留选定记忆的原始来源。');
            const candidate = { ...plan.candidate, relatedMemoryIds: plan.inputs.map(note => note.id),
              sourceChecksums: Object.fromEntries([...sources].map(([id, source]) => [id, source.checksum])),
              metadata: plan.candidate.metadata };
            return this.operation({ ...scope, operationId: 'sleep_merge_' + hash([worldJobId, plan]).slice(0, 48) }, () => {
                const note = this.consolidation.prepare({ type: 'memory.consolidate', ...scope, inputs: plan.inputs, candidate },
                  { automaticConsolidation: true, sleepWorldJobId: worldJobId, ...(job.maintenanceMode ? { maintenanceMode: job.maintenanceMode } : {}),
                    ...(job.maintenanceSessionId ? { maintenanceSessionId: job.maintenanceSessionId } : {}) });
                return { ok: true, memories: note ? [note] : [] };
            }).memories?.[0];
        }).immediate();
    }
    record(scope: Scope, input: CompanionMemoryCandidate, revision?: { id: string; expectedVersion: number },
      captureMethod: 'automatic' | 'manual' = 'automatic', expectedProhibitionRevision?: string, readMemories?: CompanionMemoryWriteReadReferences): CompanionMemory | undefined {
        return this.recordJournal(scope, input, revision, captureMethod, expectedProhibitionRevision, false, undefined, undefined, undefined, readMemories);
    }
    private recordJournal(scope: Scope, input: CompanionMemoryCandidate, revision?: {
        id: string;
        expectedVersion: number;
    }, captureMethod: 'automatic' | 'manual' = 'automatic', expectedProhibitionRevision?: string, privateConsolidation = false, hostClassification?: HostClassification,
      reconsideredInvalidNotes?: ReadonlyMap<string, number>, writeCause?: CompanionMemoryWriteCause, readMemories?: CompanionMemoryWriteReadReferences,
      reconsideredRetiredNotes?: ReadonlyMap<string, number>): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const draft = companionMemoryCandidateSchema.parse(normalizeCompanionCharacterDiary(input));
            if (draft.encoding && draft.encoding.action !== 'create' && (!revision || revision.id !== draft.encoding.targetId || revision.expectedVersion !== draft.encoding.expectedVersion))
                throw new Error('延续或纠正必须通过固定目标版本的编码提交。');
            // Free metadata is not an alternate host authority. Only the
            // verified sleep lease and actual consolidation path below may
            // classify a note as processed/derived or associate a sleep job.
            // Keep dream/simulation markers conservative: declaring fiction
            // never turns it into an original factual source.
            const metadata = { ...draft.metadata };
            for (const key of hostClassificationKeys) delete metadata[key];
            delete metadata.procedure; delete metadata.validation; delete metadata.procedureValidation;
            draft.metadata = { ...metadata, ...hostClassification };
            this.sources.requireScope(scope);
            const available = this.sources.filter(privateConsolidation ? this.sources.ownerScope(scope.companionId) : scope, draft.sourceMessageIds);
            if (available.length !== new Set(draft.sourceMessageIds).size)
                throw new Error('日记来源不可见、已撤回或尚未正式发送。');
            this.rejectFictionalSources(available.map(source => source.id));
            this.validateParticipationCandidate(scope.companionId,available,draft);
            if (!privateConsolidation && !hostClassification) {
                const episodeIds = rows(this.db.prepare(`SELECT DISTINCT s.episode_id FROM companion_memory_episode_sources s JOIN vcp_capture_jobs j ON j.id=s.job_id
                  WHERE j.companion_id=? AND j.message_id IN(${available.map(() => '?').join(',')})`).all(scope.companionId, ...available.map(source => source.id))).map(value => String(value.episode_id));
                if (episodeIds.length === 1) draft.metadata = { ...draft.metadata, captureEpisodeId: episodeIds[0] };
            }
            const references = available.map(source => this.sources.reference(row(this.db.prepare('SELECT * FROM messages WHERE id=?').get(source.id))));
            const domains = references.map(source => this.sources.logicalDomain(source.messageId));
            if (new Set(domains).size !== 1 && !privateConsolidation)
                throw new Error('不同来源可见域不能混写同一篇日记。');
            for (const source of available) {
                if (draft.sourceChecksums?.[source.id] && draft.sourceChecksums[source.id] !== companionSourceChecksum(source.content))
                    throw new Error('日记来源已修订。');
                if (!draft.evidence.some(evidence => evidence.sourceMessageId === source.id && source.content.includes(evidence.quote)))
                    throw new Error('每个日记来源都需要逐字证据。');
            }
            if (draft.evidence.some(evidence => !available.some(source => source.id === evidence.sourceMessageId && source.content.includes(evidence.quote))))
                throw new Error('日记证据不是来源原文。');
            const conversationId = privateConsolidation ? scope.conversationId : domains[0]!, sourceSequence = Math.max(...references.map(source => source.sequence));
            if (privateConsolidation) for (const domain of new Set(domains)) {
                if (this.sources.blockedTag({ ...scope, conversationId: domain }, draft.tags, sourceSequence)) throw new Error('私人整理的真实来源域仍有禁记限制。');
            }
            this.sources.assertProhibitionRevision({ ...scope, conversationId }, expectedProhibitionRevision);
            if (this.sources.blockedTag({ ...scope, conversationId }, draft.tags, sourceSequence))
                throw new Error('该日记涉及已禁止记录的内容。');
            const previous = revision ? this.load(revision.id) : undefined;
            if (previous && (!this.visible(scope, previous) || previous.version !== revision!.expectedVersion || previous.sourceConversationId !== conversationId))
                throw new Error('日记版本或可见域已变化，请重新读取。');
            if (previous && !hostClassification && typeof previous.metadata?.captureEpisodeId === 'string')
                draft.metadata = { ...draft.metadata, captureEpisodeId: previous.metadata.captureEpisodeId };
            const dependencies = draft.relatedMemoryIds.map(id => this.load(id));
            if (dependencies.some(source => !this.visible(scope, source) || source.id === previous?.id)) throw new Error('整理来源不属于此伙伴当前可读的本人记忆。');
            if (readMemories) for (const dependency of dependencies) {
                const witnessed = readMemories.some(reference => reference.id === dependency.id
                    && (reference.version === undefined || this.ledger.versionRevision(reference.id, reference.version) === dependency.contentRevision)
                    && (reference.contentRevision === undefined || reference.contentRevision === dependency.contentRevision));
                if (!witnessed) throw new Error('整理依赖未在本次实际推理中读取，或其正文已变化；请重新读取该条记忆。');
            }
            this.development.validate(scope, draft, available, dependencies, previous?.id);
            const method = draft.procedure ?? (previous?.procedure ? { applicability: previous.procedure.applicability, steps: previous.procedure.steps,
              limitations: previous.procedure.limitations, verification: previous.procedure.verification } : undefined);
            const scopeId = this.scope(scope.companionId, conversationId), identity = hash([scopeId, draft.content, references.map(source => [source.messageId, source.revision, source.checksum]), draft.occurredAt ?? '', draft.relatedMemoryIds, ...(draft.selfDevelopment ? [draft.selfDevelopment] : []), method]);
            const existing = !previous && this.db.prepare('SELECT data FROM vcp_memory_notes WHERE companion_id=? AND identity_key=?').get(scope.companionId, identity);
            let restored: CompanionMemory | undefined;
            if (existing) {
                const note = json<CompanionMemory>(row(existing).data);
                if (this.visible(scope, note)) {
                    // A verified host operation can reuse an identical body
                    // previously written as an ordinary diary. Its actual
                    // classification still needs to be recorded; free input
                    // metadata never reaches this branch as an authority.
                    if (hostClassification) {
                        const metadata = { ...note.metadata };
                        for (const key of hostClassificationKeys) delete metadata[key];
                        note.metadata = { ...metadata, ...hostClassification }; this.persist(note);
                    }
                    return note;
                }
                // This authority is created only inside complete() from its
                // fresh lease's durable intent; candidate metadata cannot grant it.
                const invalidRestoration = note.status === 'invalid' && reconsideredInvalidNotes?.get(note.id) === note.version;
                let survivingOriginal = false;
                if (note.status === 'forgotten' && reconsideredRetiredNotes?.get(note.id) === note.version) {
                    // A source-only withdrawal can retire A+B while leaving the
                    // original immutable B body lawful. Only this fresh capture
                    // lease's durable intent may reuse that original identity.
                    // Whole-note forget retracts every historical authority;
                    // a general record or model metadata cannot grant this path.
                    const original = this.ledger.readBody(scope.companionId, note.id, 1);
                    const canonicalDependencies = (values: Array<{ id: string; contentRevision: number }>) => [...values].sort((a, b) => a.id.localeCompare(b.id));
                    survivingOriginal = !!original && original.memory.content === draft.content
                      && hash(original.memory.sources) === hash(references)
                      && hash(canonicalDependencies(original.dependencies)) === hash(canonicalDependencies(dependencies.map(source => ({ id: source.id, contentRevision: source.contentRevision! }))))
                      && this.sources.frozenMemoryValid(scope, { id: note.id, contentRevision: 1,
                        sources: original.memory.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) });
                }
                if (!invalidRestoration && !survivingOriginal)
                    throw new Error('该日记来源已失效或已遗忘。');
                restored = note;
            }
            const note: CompanionMemory = { id: previous?.id ?? restored?.id ?? 'note_' + identity.slice(0, 48), companionId: scope.companionId, scopeId, content: draft.content, tags: draft.tags, occurredAt: draft.occurredAt ?? references.at(-1)?.worldCreatedAt ?? references.at(-1)?.createdAt, diaryName: draft.diaryName ?? '经历', metadata: { ...draft.metadata, ...(draft.selfDevelopment ? { characterDevelopment: draft.selfDevelopment } : {}), learnedEntranceSourceId: draft.learnedEntranceSourceId, sourceMessageIds: references.map(source => source.messageId) }, sourceMessageId: references[0]!.messageId, sourceConversationId: conversationId, sources: references, sourceSequence, createdAt: previous?.createdAt ?? restored?.createdAt ?? stamp(), updatedAt: stamp(), origin: references.some(source => source.authorId === 'user') ? 'user' : 'companion', status: 'queued', version: (previous?.version ?? restored?.version ?? 0) + 1, captureMethod };
            if (method) {
                note.procedure = unverifiedCompanionMemoryProcedure(method);
                if (previous?.procedure && previous.content === note.content && previous.occurredAt === note.occurredAt
                  && hash(previous.sources) === hash(note.sources)
                  && hash([previous.procedure.applicability, previous.procedure.steps, previous.procedure.limitations, previous.procedure.verification])
                    === hash([method.applicability, method.steps, method.limitations, method.verification]))
                    note.procedure.validation = previous.procedure.validation;
            }
            if (dependencies.some(source => !this.visible(scope, source) || source.id === note.id))
                throw new Error('整理来源不属于此伙伴当前可读的本人记忆。');
            const cause: CompanionMemoryWriteCause = writeCause ?? {
                ...('operationId' in scope && typeof scope.operationId === 'string' ? { eventId: 'operation/' + scope.operationId }
                    : hostClassification?.worldJobId ? { eventId: 'world-job/' + hostClassification.worldJobId } : {}),
                operation: hostClassification?.dreamMode ? 'simulation' : hostClassification?.sleepReflection ? 'reflection'
                    : hostClassification?.consolidation ? 'consolidate' : previous ? 'revise' : 'record',
            };
            this.persist(note, previous || restored ? undefined : identity, dependencies.map(source => ({ id: source.id, contentRevision: source.contentRevision! })), cause);
            this.development.saved(note);
            this.db.prepare('DELETE FROM vcp_note_dependencies WHERE note_id=?').run(note.id);
            for (const source of dependencies)
                this.db.prepare('INSERT INTO vcp_note_dependencies VALUES(?,?,?)').run(note.id, source.id, source.contentRevision);
            this.ledger.recordBody(note, dependencies.map(source => ({ id: source.id, contentRevision: source.contentRevision! })));
            // Exact full-source writes can safely settle duplicate extraction.
            // Partial quotations never claim that all facts in a message were encoded.
            this.ledger.cover(note, available.filter(source => draft.content.trim() === source.content.trim()
              && draft.evidence.some(evidence => evidence.sourceMessageId === source.id && evidence.quote.trim() === source.content.trim())).map(source => source.id));
            this.enqueue(note, 'remember');
            if (previous) {
                this.withdrawStateMemories?.(previous.companionId, [{ id: previous.id, version: previous.version }]);
                if (note.contentRevision !== previous.contentRevision) this.invalidateDependents(note.id);
            }
            this.observeNote?.(note);
            return note;
        }).immediate();
    }
    private invalidateDependents(id: string, visited = new Set<string>(), cause = id + ':' + this.load(id).version): void { if (visited.has(id))
        return; visited.add(id); for (const dependency of rows(this.db.prepare('SELECT note_id FROM vcp_note_dependencies WHERE source_note_id=?').all(id)))
        this.withdrawNote(String(dependency.note_id), 'invalid', visited, cause); }
    withdrawNote(id: string, status: 'forgotten' | 'invalid', visited = new Set<string>(), dependencyCause?: string, preserveHistorical = false): void {
        this.db.transaction(() => {
            const note = this.load(id);
            if (['forgotten', 'invalid'].includes(note.status)) {
                if (note.status === 'invalid' && status === 'invalid' && dependencyCause) {
                    this.reconsiderRetiredNote(note, dependencyCause);
                    this.invalidateDependents(id, visited, dependencyCause);
                }
                return;
            }
            const sourceIds = note.sources.map(source => source.messageId);
            if (status === 'forgotten' && !preserveHistorical) forgetCompanionMemoryHistoryNote(this.db, note.companionId, note.id);
            this.withdrawStateMemories?.(note.companionId, [{ id: note.id, version: note.version }]);
            if (status === 'forgotten' || !dependencyCause) this.invalidateOwner(note.companionId);
            note.status = status;
            this.consolidation.restore(note.id);
            note.version++;
            note.updatedAt = stamp();
            note.content = status === 'forgotten' ? '已遗忘的日记' : '来源已失效的日记';
            note.tags = [];
            note.sources = [];
            delete note.metadata;
            delete note.sourceMessageId;
            this.persist(note);
            this.enqueue(note, 'forget');
            if (status === 'invalid' && dependencyCause) this.reconsiderRetiredNote(note, dependencyCause, sourceIds);
            if (this.withdrawStateSources && sourceIds.length) {
                // Retiring a derivative does not revoke its still-valid raw
                // evidence. Its own state effects were withdrawn by version.
                const scope = this.sources.ownerScope(note.companionId);
                // Reset can remove the last entrance before journal cleanup.
                // No entrance means no readable source; never recreate one.
                const accessible = this.db.prepare(`SELECT 1 FROM companions p
                  JOIN conversation_members m ON m.companion_id=p.id JOIN conversations c ON c.id=m.conversation_id
                  WHERE p.id=? AND p.deleted_at IS NULL AND c.id=?
                  AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs j WHERE j.companion_id=p.id AND j.status!='completed')`).get(note.companionId, scope.conversationId);
                const retained = new Set(accessible ? this.sources.filter(scope, sourceIds).map(source => source.id) : []);
                const revoked = sourceIds.filter(id => !retained.has(id));
                if (revoked.length) this.withdrawStateSources(note.companionId, revoked);
            }
            this.invalidateDependents(id, visited, dependencyCause);
        }).immediate();
    }
    resetOwner(owner: string, limit: number): number {
        const started = performance.now(); this.pruneReconsiderations(owner);
        const notes = rows(this.db.prepare("SELECT id FROM vcp_memory_notes INDEXED BY vcp_note_reset_pending WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') LIMIT ?").all(owner, Math.min(limit, 32)));
        let processed = 0;
        for (const note of notes) {
            this.withdrawNote(String(note.id), 'forgotten'); processed++;
            // A single lineage withdrawal remains atomic. Yield between notes
            // instead of spending a whole dense batch in this worker turn.
            if (performance.now() - started >= 25) break;
        }
        return processed;
    }
    rebuildIndex(companionId?: string): number { return this.db.transaction(() => { const found = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed') AND json_extract(data,'$.archivedAt') IS NULL" + (companionId ? ' AND companion_id=?' : '')).all(...(companionId ? [companionId] : []))); for (const entry of found) {
        const note = json<CompanionMemory>(entry.data);
        this.changedOwners.add(note.companionId);
        note.status = 'queued';
        this.persist(note);
        this.enqueue(note, 'remember');
        this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version=? AND operation='remember' AND status!='running'").run(note.id, note.version);
    } return found.length; }).immediate(); }
    read(scope: Scope, id: string, limit = 30, cursor = 0): NonNullable<CompanionStorageResponse['memoryRead']> { const note = this.load(id); if (!this.visible(scope, note))
        throw new Error('日记来源失效或不属于当前可见范围。'); const next = cursor + limit; return { memory: this.project(note, scope), sources: this.sources.filter(scope, note.sources.slice(cursor, next).map(source => source.messageId)), related: [], hasMore: next < note.sources.length, nextSourceCursor: next < note.sources.length ? next : undefined }; }
    inspect(scope: Scope, id: string, limit = 30, cursor = 0) { return this.read(scope, id, limit, cursor); }
    list(companionId: string, includeArchived = false): CompanionMemory[] { return rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') ORDER BY rowid DESC").all(companionId)).map(found => json<CompanionMemory>(found.data)).filter(note => includeArchived || !note.archivedAt); }
    browse(input: CompanionMemorySearch): CompanionMemoryPage {
        const query = companionMemorySearchSchema.parse(input);
        // A deferred read transaction keeps the metadata selection and final
        // body loads in one SQLite snapshot, including concurrent WAL writers.
        return this.db.transaction(() => {
            this.sources.requireScope(query);
            if (query.query.trim()) throw new Error('正文搜索必须由 VCP 执行。');
            const { start, end } = companionMemoryDateRange(query.from, query.to, this.memoryTimeZone());
            const cursor = query.cursor ?? 0, selected: MemoryMetadata[] = [];
            const statement = this.db.prepare("SELECT json_remove(data,'$.content') AS metadata FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') ORDER BY rowid DESC") as
              ReturnType<CompanionConnection['prepare']> & { iterate(...args: unknown[]): Iterable<unknown> };
            let matched = 0;
            for (const found of statement.iterate(query.companionId)) {
                const note = json<MemoryMetadata>(row(found).metadata);
                if (note.archivedAt) continue;
                const at = Date.parse(note.occurredAt ?? note.sources.at(-1)?.worldCreatedAt ?? note.sources.at(-1)?.createdAt ?? note.createdAt);
                if (!this.visible(query, note) || query.diaryName && note.diaryName !== query.diaryName || !query.tags.every(tag => note.tags.includes(tag))
                  || start !== undefined && !(at >= start) || end !== undefined && !(at <= end)) continue;
                if (matched++ < cursor) continue;
                selected.push(note);
                if (selected.length > query.limit) break;
            }
            // Visibility can still read original sources and dependency bodies.
            // Only top-level page bodies, not that authority work, are bounded.
            const hasMore = selected.length > query.limit;
            return { items: selected.slice(0, query.limit).map(metadata => {
                const memory = this.load(metadata.id);
                return { memory: this.project(memory, query), reasons: ['journal-list'], path: [memory.id] };
            }), hasMore, nextCursor: hasMore ? cursor + query.limit : undefined };
        })();
    }
    snapshot(scope: Scope): NonNullable<CompanionStorageResponse['memorySnapshot']> {
        this.sources.requireScope(scope);
        const notes = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status')='indexed' ORDER BY id").all(scope.companionId))
          .map(found => json<CompanionMemory>(found.data)).filter(note => !note.archivedAt && this.visible(scope, note));
        const revision = hash(['owner-memory-v2', scope.companionId, scope.beforeSequence ?? null, notes.map(note => [note.id, note.version, note.sources.map(source => [source.messageId, source.revision, source.checksum])])]);
        const semanticRevision = hash(['owner-memory-content-v1', scope.companionId, scope.beforeSequence ?? null,
          notes.map(note => [note.id, note.contentRevision, note.occurredAt, note.content, note.sources.map(source => [source.messageId, source.revision, source.checksum])])]);
        return { scopeId: 'view_' + revision.slice(0, 48), revision, semanticRevision, revocationEpoch: this.ledger.state(scope.companionId).revocationEpoch, notes: notes.map(note => this.project(note, scope)) };
    }
    domains(scope: Scope): NonNullable<CompanionStorageResponse['memoryDomains']> { this.sources.requireScope(scope); return rows(this.db.prepare('SELECT * FROM vcp_memory_scopes WHERE companion_id=? ORDER BY scope_id').all(scope.companionId)).map(domain => ({ scopeId: String(domain.scope_id), companionId: String(domain.companion_id), conversationId: String(domain.conversation_id), revision: Number(domain.revision), state: domain.state as 'dirty' | 'ready', updatedAt: String(domain.updated_at) })); }
    private transitiveSourceIds(note: CompanionMemory): string[] {
        const ids = new Set<string>(), visited = new Set<string>(), pending = [note.id];
        while (pending.length) {
            const id = pending.pop()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const source = this.load(id);
            if (source.companionId !== note.companionId) throw new Error('派生来源不能属于其他伙伴。');
            for (const entry of source.sources) ids.add(entry.messageId);
            for (const entry of rows(this.db.prepare('SELECT message_id FROM vcp_note_source_history WHERE note_id=?').all(id))) ids.add(String(entry.message_id));
            for (const entry of rows(this.db.prepare('SELECT source_note_id FROM vcp_note_dependencies WHERE note_id=?').all(id))) pending.push(String(entry.source_note_id));
        }
        return [...ids];
    }
    forget(input: Extract<CompanionStorageCommand, {
        type: 'memory.forget';
    }>): number {
        const command = companionMemoryForgetSchema.parse(input);
        return this.db.transaction(() => {
            const room = this.sources.requireScope(command);
            this.invalidateOwner(command.companionId, { operation: 'forget', eventId: command.requestMessageId ? 'forget-request/' + command.requestMessageId : 'forget/' + randomUUID(),
              conversationId: command.conversationId, sourceMessageIds: command.sourceMessageIds, ...(command.id ? { noteIds: [command.id] } : {}) });
            if (!command.id && !command.sourceMessageIds.length && !command.tag)
                throw new Error('请指定需要遗忘的日记、来源或标签。');
            if (command.requestMessageId && !this.sources.filter(command, [command.requestMessageId]).some(source => source.authorId === 'user'))
                throw new Error('遗忘请求不是当前可见的用户来源。');
            const notes = this.list(command.companionId, true).filter(note => this.visible(command, note) && (command.id ? note.id === command.id : command.sourceMessageIds.length ? note.sources.some(source => command.sourceMessageIds.includes(source.messageId)) : note.tags.includes(command.tag!)));
            if (command.id && !notes.length) {
                const retired = this.load(command.id);
                if (retired.companionId !== command.companionId) throw new Error('不能遗忘其他伙伴的历史记忆。');
                // A prior source-only withdrawal may have retired the latest
                // note while leaving unrelated old revisions lawful. Explicit
                // whole-note forget must still revoke those exact old assets.
                forgetCompanionMemoryHistoryNote(this.db, command.companionId, retired.id);
                this.sources.block(command.companionId, rows(this.db.prepare('SELECT message_id FROM vcp_note_source_history WHERE note_id=?').all(retired.id)).map(source => String(source.message_id)));
            }
            // A source selector revokes only the named sources. A matched merge
            // may also contain unrelated evidence that must remain restorable.
            // Note/tag selectors still revoke their full provenance graph.
            const sourceOnly = !command.id && command.sourceMessageIds.length > 0;
            const sourceIds = [...new Set([...command.sourceMessageIds, ...(sourceOnly ? [] : notes.flatMap(note => [
                ...this.transitiveSourceIds(note),
                ...rows(this.db.prepare('SELECT message_id FROM vcp_note_source_history WHERE note_id=?').all(note.id)).map(source => String(source.message_id)),
            ]))])];
            if (command.sourceMessageIds.length && this.sources.filter(command, command.sourceMessageIds).length !== command.sourceMessageIds.length)
                throw new Error('遗忘来源不可访问。');
            this.sources.block(command.companionId, sourceIds);
            this.pruneReconsiderations(command.companionId);
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
                    if (note.companionId === command.companionId) {
                        this.withdrawNote(note.id, 'forgotten', new Set(), undefined, sourceOnly);
                        // A source selector revokes A, not an unrelated raw B
                        // that shared the retired draft. Re-extract B normally;
                        // never grant authority to restore this forgotten ID.
                        if (sourceOnly) {
                            const retired = this.load(note.id);
                            this.reconsiderRetiredNote(retired, retired.id + ':' + retired.version, note.sources.map(source => source.messageId));
                        }
                    }
                }
            this.withdrawStateSources?.(command.companionId, sourceIds);
            return notes.length;
        }).immediate();
    }
    delete(id: string): void { const note = this.load(id); this.forget({ type: 'memory.forget', ...this.sources.ownerScope(note.companionId), id }); }
    organize(scope: Scope, ids: string[], tags: string[], expectedProhibitionRevision?: string): CompanionMemory[] { return this.db.transaction(() => ids.map(id => { const note = this.load(id); this.sources.assertProhibitionRevision({ ...scope, conversationId: note.sourceConversationId }, expectedProhibitionRevision); if (!this.visible(scope, note))
        throw new Error('日记不可见。'); if (this.sources.blockedTag({ ...scope, conversationId: note.sourceConversationId }, tags, note.sourceSequence))
        throw new Error('禁止记录该标签。'); if (JSON.stringify(note.tags) === JSON.stringify(tags)) return note;
        note.tags = [...tags]; note.version++; note.status = 'queued'; note.updatedAt = stamp(); this.persist(note); this.enqueue(note, 'remember'); return note; })).immediate(); }
    rehomeConversation(oldId: string, newId: string): void { this.db.prepare('UPDATE vcp_capture_jobs SET conversation_id=? WHERE conversation_id=?').run(newId, oldId); for (const entry of rows(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE conversation_id=?').all(oldId)))
        this.withdrawNote(json<CompanionMemory>(entry.data).id, 'invalid'); }
    claimOutbox(companionId?: string, leaseMs = 120000, excludedOwners: readonly string[] = []): NonNullable<CompanionStorageResponse['memoryOutbox']> | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            this.consolidation.reconcilePending();
            for (let checked = 0; checked < 64; checked++) {
            const owner = this.db.prepare(`SELECT d.companion_id FROM companion_memory_delivery_owners d
              WHERE d.companion_id NOT IN(SELECT value FROM json_each(?)) ${companionId ? 'AND d.companion_id=?' : ''}
              AND EXISTS(SELECT 1 FROM vcp_memory_outbox o WHERE o.companion_id=d.companion_id AND o.status IN('pending','failed')
                AND o.next_attempt<=? AND o.attempts<8 AND NOT EXISTS(SELECT 1 FROM vcp_memory_outbox active
                  WHERE active.scope_id=o.scope_id AND active.status='running' AND active.lease_until>?))
              ORDER BY d.last_service,d.companion_id LIMIT 1`)
              .get(...(companionId ? [JSON.stringify(excludedOwners), companionId, now, now] : [JSON.stringify(excludedOwners), now, now]));
            if (!owner) return;
            const found = this.db.prepare(`SELECT o.* FROM vcp_memory_outbox o WHERE o.companion_id=? AND o.status IN('pending','failed') AND o.next_attempt<=? AND o.attempts<8
              AND NOT EXISTS(SELECT 1 FROM vcp_memory_outbox active WHERE active.scope_id=o.scope_id AND active.status='running' AND active.lease_until>?)
              ORDER BY o.ordinal LIMIT 1`).get(row(owner).companion_id, now, now);
            if (!found)
                return;
            const entry = row(found), note = this.load(String(entry.note_id));
            this.db.prepare('UPDATE companion_memory_delivery_owners SET last_service=(SELECT COALESCE(MAX(last_service),0)+1 FROM companion_memory_delivery_owners) WHERE companion_id=?').run(note.companionId);
            if (entry.operation === 'remember' && note.archivedAt) {
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE id=?").run(entry.id);
                continue;
            }
            if (entry.operation === 'forget' && !note.archivedAt && ['queued', 'indexed'].includes(note.status)) {
                // A derivative was invalidated after archiving this original.
                // Its obsolete archive removal must not erase a restored note.
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE id=?").run(entry.id);
                continue;
            }
            if (note.version !== Number(entry.note_version)) {
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                continue;
            }
            if (entry.operation === 'remember' && !this.visible(this.sources.ownerScope(note.companionId), note)) {
                this.withdrawNote(note.id, 'invalid');
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                continue;
            }
            const token = randomUUID();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, entry.id);
            return { id: String(entry.id), companionId: note.companionId, scopeId: note.scopeId, noteId: note.id, noteVersion: note.version, operation: entry.operation as 'remember' | 'forget', note, leaseToken: token, attempts: Number(entry.attempts) + 1 };
            }
        }).immediate();
    }
    completeOutbox(id: string, token: string, indexed: boolean, sourceFile?: string): { state: 'completed' | 'stale'; reason?: string } { return this.db.transaction(() => { const entry = this.leased('vcp_memory_outbox', id, token), note = this.load(String(entry.note_id));
      let disposition: { state: 'completed' | 'stale'; reason?: string } = { state: 'completed' };
      if (entry.operation === 'remember' && note.version === Number(entry.note_version) && note.sources.some(source => this.fictionalSource(source.messageId) || this.deletedTopicSource(source.messageId))) this.withdrawNote(note.id, 'invalid');
      if (entry.operation === 'remember' && note.version === Number(entry.note_version) && this.visible(this.sources.ownerScope(note.companionId), note)) {
        if (!indexed)
            throw new Error('VCP 尚未确认索引完成。');
        note.status = 'indexed';
        note.sourceFile = sourceFile;
        note.updatedAt = stamp();
        this.persist(note);
    }
      if (entry.operation === 'remember') disposition = this.consolidation.publish(note);
      this.db.prepare("UPDATE vcp_memory_outbox SET status=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(disposition.state === 'stale' ? 'stale' : 'done', disposition.reason ?? null, id);
      if (!this.db.prepare("SELECT 1 FROM vcp_memory_outbox WHERE scope_id=? AND status NOT IN('done','stale','cancelled') LIMIT 1").get(note.scopeId))
        this.db.prepare("UPDATE vcp_memory_scopes SET state='ready',updated_at=? WHERE scope_id=?").run(stamp(), note.scopeId);
      return disposition; }).immediate(); }
    failOutbox(id: string, token: string, error: string, retryAfterMs = 30000): void { this.leased('vcp_memory_outbox', id, token); this.db.prepare("UPDATE vcp_memory_outbox SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(error, Date.now() + retryAfterMs, id); }
    deferOutbox(id: string, token: string, retryAfterMs = 1000): void { this.leased('vcp_memory_outbox', id, token); this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',attempts=MAX(0,attempts-1),error=NULL,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(Date.now() + retryAfterMs, id); }
    policies(companionId: string): NonNullable<CompanionStorageResponse['memoryPolicies']> {
        if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(companionId)) throw new Error('伙伴不存在。');
        const topics: NonNullable<CompanionStorageResponse['memoryPolicies']> = rows(this.db.prepare(`SELECT p.*,r.released_at,
          (SELECT q.message_id FROM vcp_source_prohibition_requests q WHERE q.prohibition_id=p.id ORDER BY q.message_id LIMIT 1) AS request_message_id,
          COALESCE((SELECT m.created_at FROM messages m JOIN vcp_source_prohibition_requests q ON q.message_id=m.id WHERE q.prohibition_id=p.id ORDER BY m.sequence LIMIT 1),
            (SELECT m.created_at FROM messages m WHERE m.sequence=p.through_sequence)) AS created_at
          FROM vcp_source_prohibitions p LEFT JOIN vcp_source_prohibition_releases r ON r.prohibition_id=p.id
          WHERE p.companion_id=? AND (p.persistent=1 OR r.prohibition_id IS NOT NULL) ORDER BY p.id`).all(companionId)).map(rule => ({
            id: String(rule.id), companionId, conversationId: String(rule.conversation_id), reason: 'persistent-topic', tags: [String(rule.tag)],
            requestMessageId: rule.request_message_id ? String(rule.request_message_id) : undefined, requestSnippet: '',
            blocked: !!rule.persistent, createdAt: rule.created_at ? String(rule.created_at) : new Date(0).toISOString(),
            releasedAt: rule.released_at ? String(rule.released_at) : undefined,
        }));
        return topics;
    }
    releasePolicy(companionId: string, id: string): NonNullable<CompanionStorageResponse['memoryPolicies']> {
        return this.db.transaction(() => {
            const policy = this.policies(companionId).find(rule => rule.id === id);
            if (!policy) throw new Error('遗忘限制不属于该伙伴。');
            // Release authorizes future inputs; it never replays old messages.
            if (policy.blocked) {
                this.db.prepare('UPDATE vcp_source_prohibitions SET persistent=0,through_sequence=(SELECT COALESCE(MAX(sequence),0) FROM messages) WHERE companion_id=? AND id=?').run(companionId, id);
                this.db.prepare('INSERT INTO vcp_source_prohibition_releases VALUES(?,?)').run(id, stamp());
            }
            this.invalidateOwner(companionId);
            return this.policies(companionId);
        }).immediate();
    }
    private statusCounts(companionId: string, conversationId?: string) {
        return this.db.transaction(() => {
            const state = this.db.prepare(`SELECT
              COALESCE((SELECT sequence FROM companion_memory_projection_state WHERE companion_id=?),0) AS sequence,
              COALESCE((SELECT revocation_epoch FROM companion_memory_lifecycle_state WHERE companion_id=?),0) AS epoch,
              COALESCE((SELECT revision FROM vcp_memory_management_epochs WHERE companion_id=?),0) AS reset`).get(companionId, companionId, companionId) as { sequence: number; epoch: number; reset: number };
            const version = this.db.prepare('PRAGMA data_version').get() as { data_version: number };
            const counters = [state.sequence, state.epoch, state.reset, version.data_version, this.projection.cacheGeneration(companionId)];
            const stable = counters.every(value => Number.isSafeInteger(value) && value >= 0), stamp = JSON.stringify(counters), key = JSON.stringify([companionId, conversationId ?? null]);
            const previous = this.statusNoteCounts.get(key);
            if (stable && previous?.stamp === stamp) { this.statusNoteCounts.delete(key); this.statusNoteCounts.set(key, previous); return previous.value; }
            // Counts are display metadata, with the exact previous status and
            // archived semantics. SQLite never transports or JS-parses bodies.
            const counts = this.db.prepare(`SELECT
              SUM(CASE WHEN COALESCE(json_extract(data,'$.status'),'') NOT IN('invalid','forgotten') THEN 1 ELSE 0 END) AS memories,
              SUM(CASE WHEN json_extract(data,'$.status')='forgotten' THEN 1 ELSE 0 END) AS forgotten,
              SUM(CASE WHEN json_extract(data,'$.status')='indexed' THEN 1 ELSE 0 END) AS indexed,
              SUM(CASE WHEN json_extract(data,'$.status')='queued' AND COALESCE(json_extract(data,'$.archivedAt'),'')='' THEN 1 ELSE 0 END) AS pendingIndex
              FROM vcp_memory_notes WHERE companion_id=?${conversationId ? ' AND conversation_id=?' : ''}`)
                .get(...(conversationId ? [companionId, conversationId] : [companionId])) as { memories: number | null; forgotten: number | null; indexed: number | null; pendingIndex: number | null };
            const value = { memories: counts.memories ?? 0, forgotten: counts.forgotten ?? 0, indexed: counts.indexed ?? 0, pendingIndex: counts.pendingIndex ?? 0 };
            if (stable) { this.statusNoteCounts.delete(key); this.statusNoteCounts.set(key, { owner: companionId, stamp, value });
                while (this.statusNoteCounts.size > 16) this.statusNoteCounts.delete(this.statusNoteCounts.keys().next().value!); }
            return value;
        })();
    }
    status(companionId: string, conversationId?: string): NonNullable<CompanionStorageResponse['memoryStatus']> {
        const filter = conversationId ? ' AND conversation_id=?' : '', values = conversationId ? [companionId, conversationId] : [companionId];
        const jobs = rows(this.db.prepare('SELECT status,COUNT(*) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter + ' GROUP BY status').all(...values));
        const count = (status: string) => Number(jobs.find(job => job.status === status)?.n ?? 0);
        const notes = this.statusCounts(companionId, conversationId);
        const lastCapture = this.db.prepare('SELECT error FROM vcp_capture_jobs WHERE companion_id=?' + filter + " AND status='failed' ORDER BY ordinal DESC LIMIT 1").get(...values);
        const outboxFilter = conversationId ? ' AND note_id IN(SELECT id FROM vcp_memory_notes WHERE conversation_id=?)' : '';
        const lastDelivery = this.db.prepare('SELECT error FROM vcp_memory_outbox WHERE companion_id=?' + outboxFilter + " AND status='failed' ORDER BY ordinal DESC LIMIT 1").get(...values);
        const deliveryFailures = Number(row(this.db.prepare('SELECT count(*) AS n FROM vcp_memory_outbox WHERE companion_id=?' + outboxFilter + " AND status='failed'").get(...values)).n);
        const messageWatermark = Number(row(this.db.prepare('SELECT COALESCE(MAX(source_sequence),0) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter).get(...values)).n);
        const pending = row(this.db.prepare('SELECT MIN(source_sequence) AS n FROM vcp_capture_jobs WHERE companion_id=?' + filter + " AND status!='done'").get(...values)).n;
        const last = lastDelivery ?? lastCapture;
        return {
            pending: count('pending'), running: count('running'), failed: count('failed') + deliveryFailures, completed: count('done'),
            ...notes,
            messageWatermark, captureWatermark: pending === null ? messageWatermark : Math.max(0, Number(pending) - 1),
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
                const response = json<{ ok: boolean; notes: Array<{ id: string; version: number }>; deferred?: CompanionStorageResponse['memoryConsolidationDeferred'] }>(receipt.response);
                const memories = response.notes.map(previous => {
                    const current = this.load(previous.id);
                    this.sources.assertProhibitionRevision({ ...command, conversationId: current.sourceConversationId }, expectedProhibitionRevision);
                    if (current.version !== previous.version || !this.visible(command, current)) throw new Error('记忆操作的已提交结果或来源已变化。');
                    return current;
                });
                return { ok: response.ok, memories, ...(response.deferred ? { memoryConsolidationDeferred: response.deferred } : {}) };
            }
            const response = run();
            this.db.prepare('INSERT INTO vcp_operation_receipts VALUES(?,?,?,?,?)').run(operationId, command.companionId, command.conversationId, signature,
              JSON.stringify({ ok: response.ok, notes: (response.memories ?? []).map(note => ({ id: note.id, version: note.version })),
                ...(response.memoryConsolidationDeferred ? { deferred: response.memoryConsolidationDeferred } : {}) }));
            return response;
        }).immediate();
    }
    private libraryVisible(owner: string, note: CompanionMemory): boolean {
        try { return note.companionId === owner && this.visible(this.sources.ownerScope(owner), note); }
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
        const projection = this.projection.execute(command); if (projection) return projection;
        const sourceDelivery = this.sourceOutbox.execute(command); if (sourceDelivery) return sourceDelivery;
        const historyDelivery = this.historyOutbox.execute(command); if (historyDelivery) return historyDelivery;
        switch (command.type) {
            case 'memory.procedure.observe-action': return this.db.transaction(() => ({ ok: true,
                memories: this.procedures.observeAction(command.actionId).flatMap(observation => {
                    const note = this.annotateProcedure(observation.noteId, observation.contentRevision, observation.validation);
                    return note ? [this.project(note, this.sources.ownerScope(note.companionId))] : [];
                }) })).immediate();
            case 'memory.lifecycle.state': return { ok: true, memoryLifecycleState: this.lifecycleState(command.companionId) };
            case 'memory.lifecycle.changes': return { ok: true, memoryLifecycleChanges: this.lifecycleChanges(command.companionId, command.afterSequence ?? 0, command.limit ?? 64) };
            case 'memory.revision.read': throw new Error('历史正文必须从伙伴的canonical历史文件读取，SQL账本不提供模型正文回退。');
            case 'memory.search': throw new Error('记忆检索只能由 VCP 执行。');
            case 'memory.operation.inspect': {
                const receipt = this.db.prepare('SELECT response FROM vcp_operation_receipts WHERE id=? AND companion_id=?').get(command.operationId, command.companionId);
                const references = receipt ? json<{ notes: Array<{ id: string }> }>(row(receipt).response).notes : [];
                const notes = references.map(reference => this.load(reference.id));
                return { ok: true, memories: notes.map(note => {
                    if (this.visible(this.sources.ownerScope(command.companionId), note)) return note;
                    if (!['forgotten', 'invalid'].includes(note.status)) this.withdrawNote(note.id, 'invalid');
                    // A durable receipt must still identify an old export for removal without disclosing revoked text.
                    return { ...this.load(note.id), content: '[来源已撤回]', tags: [], sources: [], sourceMessageId: undefined,
                        sourceSequence: 0, metadata: undefined, diaryName: undefined, occurredAt: undefined, procedure: undefined,
                        status: note.status === 'forgotten' ? 'forgotten' as const : 'invalid' as const };
                }) };
            }
            case 'memory.library.page': {
                const limit = command.limit ?? 64, cursor = command.cursor ?? 0;
                const found = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') IN('queued','indexed') ORDER BY id LIMIT ? OFFSET ?").all(command.companionId, limit + 1, cursor));
                const notes = found.slice(0, limit).map(entry => json<CompanionMemory>(entry.data)).filter(note => this.libraryVisible(command.companionId, note));
                return { ok: true, memoryPage: { items: notes.map(memory => ({ memory: this.project(memory, this.sources.ownerScope(command.companionId)), reasons: ['library-projection'], path: [memory.id] })), hasMore: found.length > limit, ...(found.length > limit ? { nextCursor: cursor + limit } : {}) } };
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
                const scope = this.sources.ownerScope(command.companionId);
                if (!this.libraryVisible(command.companionId, note)) return { ok: true };
                return { ok: true, memoryRead: this.read(scope, note.id, command.sourceLimit, command.sourceCursor) };
            }
            case 'memory.library.delete': return this.db.transaction(() => {
                const note = this.load(command.id);
                if (note.companionId !== command.companionId || note.version !== command.expectedVersion) throw new Error('日记所属伙伴或版本已变化，请重新读取。');
                return { ok: true, forgottenCount: this.forget({ type: 'memory.forget', ...this.sources.ownerScope(note.companionId), id: note.id }) };
            }).immediate();
            case 'memory.library.organize': return this.db.transaction(() => {
                const note = this.load(command.id), scope = this.sources.ownerScope(command.companionId), policyScope = { ...scope, conversationId: note.sourceConversationId };
                if (note.companionId !== command.companionId || note.version !== command.expectedVersion || !this.visible(scope, note)) throw new Error('日记所属伙伴、版本或来源已变化，请重新读取。');
                const expected = 'expectedProhibitionRevision' in command && typeof command.expectedProhibitionRevision === 'string' ? command.expectedProhibitionRevision : undefined;
                this.sources.assertProhibitionRevision(policyScope, expected);
                if (this.sources.blockedTag(policyScope, command.tags, note.sourceSequence)) throw new Error('禁止记录该标签。');
                if (JSON.stringify(note.tags) === JSON.stringify(command.tags) && note.diaryName === command.diaryName
                  && (command.autoTags === undefined || command.autoTags === (note.metadata?.autoTags !== false))) return { ok: true, memories: [note] };
                note.tags = [...command.tags]; note.diaryName = command.diaryName; note.version++; note.updatedAt = stamp(); note.status = 'queued';
                if (command.autoTags !== undefined) note.metadata = { ...note.metadata, autoTags: command.autoTags };
                this.persist(note); this.enqueue(note, 'remember');
                return { ok: true, memories: [note] };
            }).immediate();
            case 'memory.browse': return { ok: true, memoryPage: this.browse(command) };
            case 'memory.sources.filter': return { ok: true, memorySources: this.sourcesFilter(command, command.ids) };
            case 'memory.records.filter': return { ok: true, memories: command.ids.map(id => { try {
                    return this.load(id);
                }
                catch {
                    return undefined;
                } }).filter((note): note is CompanionMemory => !!note && this.visible(command, note)).map(note => this.project(note, command)) };
            case 'memory.read':
            case 'memory.inspect': return { ok: true, memoryRead: this.read(command, command.id, command.sourceLimit, command.sourceCursor) };
            case 'memory.domains': return { ok: true, memoryDomains: this.domains(command) };
            case 'memory.snapshot': return { ok: true, memorySnapshot: this.snapshot(command) };
            case 'memory.frozen.valid': return { ok: true, memoryFrozenValid: command.memories.every(memory => this.sources.frozenMemoryValid(command, memory)) };
            case 'character.development': this.sources.requireScope(command); return { ok: true, characterDevelopment: this.development.read(command, command.limit ?? 12) };
            case 'memory.prohibitions': return this.writePolicy(command);
            case 'memory.record': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, undefined, 'automatic', command.expectedProhibitionRevision, command.readMemories); return { ok: true, memories: note ? [note] : [] }; });
            }
            case 'memory.revise': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, { id: command.id, expectedVersion: command.expectedVersion }, 'automatic', command.expectedProhibitionRevision, command.readMemories); return { ok: true, memories: note ? [note] : [] }; });
            }
            case 'memory.organize': return this.operation(command, () => ({ ok: true, memories: this.organize(command, command.ids, command.tags ?? [], command.expectedProhibitionRevision) }));
            case 'memory.consolidate': return this.operation(command, () => {
                const note = this.consolidation.prepare(command); return { ok: true, memories: note ? [note] : [], ...(!note ? { memoryConsolidationDeferred: {
                  requiresFreshReadSet: true as const, reason: '本次具体来源正在等待另一项整合发布，原文保留；待其结束后重新读取当前版本再决定。' } } : {}) };
            });
            case 'memory.forget': return { ok: true, forgottenCount: this.forget(command) };
            case 'memory.status': return { ok: true, memoryStatus: this.status(command.companionId, command.conversationId) };
            case 'memory.processing.status': return { ok: true, memoryProcessing: memoryProcessingStatus(this.db, command.companionId, command.limit, command.filter, item => {
                try {
                    if (item.noteId) { const note = this.load(item.noteId); return item.sourceRevision === String(note.version) && this.visible(this.sources.ownerScope(command.companionId), note) ? note.content : undefined; }
                    if (item.sourceMessageId && item.conversationId) {
                        if (this.fictionalSource(item.sourceMessageId)) return undefined;
                        const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(item.sourceMessageId);
                        return source && item.sourceRevision === `${row(source).revision ?? 1}:${companionSourceChecksum(String(row(source).content))}` && this.sources.visible({ companionId: command.companionId, conversationId: item.conversationId }, row(source)) ? String(row(source).content) : undefined;
                    }
                } catch { /* Withdrawn or no-longer-visible evidence has no preview. */ }
                return undefined;
            }) };
            case 'memory.policy.list': return { ok: true, memoryPolicies: this.policies(command.companionId) };
            case 'memory.policy.release': return { ok: true, memoryPolicies: this.releasePolicy(command.companionId, command.id) };
            case 'memory.index.rebuild': return { ok: true, rebuiltCount: this.rebuildIndex(command.companionId) };
            case 'memory.jobs.claim': return { ok: true, memoryJob: this.claim(command.companionId, command.leaseMs, command.force) };
            case 'memory.jobs.contributions': return { ok: true, memoryCaptureContributions: this.captureContributions(command) };
            case 'memory.jobs.proposal.read': return { ok: true, memoryCaptureProposal: this.captureProposal(command.id, command.leaseToken) };
            case 'memory.jobs.proposal.save': this.captureProposal(command.id, command.leaseToken, companionCaptureProposalSchema.parse(command.proposal)); return { ok: true };
            case 'memory.jobs.complete': return { ok: true, memories: this.complete(command.id, command.leaseToken, command.notes, command.stateProposal, command.expectedProhibitionRevision, command.expectedStateRevision, command.readMemories) };
            case 'memory.jobs.fail':
                this.fail(command.id, command.leaseToken, command.error, command.retryAfterMs, command.preserveProposal);
                return { ok: true };
            case 'memory.jobs.defer':
                this.defer(command.id, command.leaseToken, command.error, command.retryAfterMs);
                return { ok: true };
            case 'memory.jobs.retry-admission':
                this.retryAdmission(command.companionId);
                return { ok: true };
            case 'memory.jobs.retry':
            case 'memory.outbox.retry':
                this.retry(command.companionId);
                return { ok: true };
            case 'memory.outbox.claim': return { ok: true, memoryOutbox: this.claimOutbox(command.companionId, command.leaseMs, command.excludedOwners) };
            case 'memory.outbox.pending': return { ok: true, memoryOutboxPending: !!this.db.prepare("SELECT 1 FROM vcp_memory_outbox WHERE companion_id=? AND status IN('pending','running','failed') AND operation='remember' LIMIT 1").get(command.companionId) };
            case 'memory.outbox.complete':
                return { ok: true, memoryOutboxDisposition: this.completeOutbox(command.id, command.leaseToken, command.indexed, command.sourceFile) };
            case 'memory.outbox.fail':
                this.failOutbox(command.id, command.leaseToken, command.error, command.retryAfterMs);
                return { ok: true };
            case 'memory.outbox.defer':
                this.deferOutbox(command.id, command.leaseToken, command.retryAfterMs);
                return { ok: true };
            default: return undefined;
        }
    }
}
