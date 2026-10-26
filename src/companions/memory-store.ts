import { createHash, randomUUID } from 'node:crypto';
import { companionMemoryCandidateSchema, companionMemoryConsolidateSchema, companionMemorySearchSchema, companionMemoryForgetSchema, type CompanionMemoryCandidate, type CompanionMemoryJob, type CompanionMemorySearch, type CompanionMemoryPage } from '../shared/companion-memory';
import type { CompanionMemory, CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse, SaveCompanionMemory } from '../shared/companion-storage';
import type { CompanionStateProposal } from '../shared/companion-state';
import type { CompanionConnection } from './store';
import { CompanionSourceAccess, companionSourceChecksum, type CompanionSourceScope as Scope } from './source-access';
import { retireFactMemory } from './memory-migration';
import { initializeMemoryProcessingJournal, memoryProcessingStatus } from './memory-processing-store';
import { CompanionCharacterDevelopmentStore } from './character-development-store';
import { CompanionMemoryConsolidationStore } from './memory-consolidation-store';
import type { CompanionMemoryStateIntegration } from './state-store';
import { normalizeCompanionCharacterDiary } from '../shared/companion-character-development';
import { initializeTopicParticipationReceipts, topicParticipationMemoryContent, topicParticipationMemoryTags, type TopicParticipationReceipt } from './topic-participation';
import { companionAutomaticConsolidationHasNovelty } from '../shared/companion-memory-novelty';
import { companionMemoryDateRange } from '../shared/companion-memory-time';
import { companionMessageFictionalLineage } from './fictional-source';
type Row = Record<string, string | number | null>;
type HostClassification = { consolidation?: true | 'source_version_graph'; automaticConsolidation?: true; sleepReflection?: true;
  sleepWorldJobId?: string; worldJobId?: string; sleepEpisodeId?: string };
/** Host-only, body-free authority for one fresh extraction of a retired derivative. */
type CaptureReconsideration = { sourceRevision: number; sourceChecksum: string; invalidNotes: Array<{ id: string; version: number }>;
  retiredNotes?: Array<{ id: string; version: number }>;
  causes: string[]; blockedLeaseToken?: string };
const hostClassificationKeys = ['consolidation', 'automaticConsolidation', 'sleepReflection', 'sleepWorldJobId', 'worldJobId', 'sleepEpisodeId'] as const;
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
    invalidateOwner(id: string): void {
        if (this.invalidatedOwners.has(id)) return;
        this.invalidatedOwners.add(id);
        this.db.prepare('INSERT INTO vcp_memory_management_epochs VALUES(?,1) ON CONFLICT(companion_id) DO UPDATE SET revision=revision+1').run(id);
        for (const scope of rows(this.db.prepare('SELECT scope_id FROM vcp_memory_scopes WHERE companion_id=?').all(id))) this.invalidatedScopes.add(String(scope.scope_id));
    }
    takeInvalidatedOwners(): string[] { const ids = [...this.invalidatedOwners]; this.invalidatedOwners.clear(); return ids; }
    takeInvalidatedScopes(): string[] { const ids = [...this.invalidatedScopes]; this.invalidatedScopes.clear(); return ids; }
    readonly sources: CompanionSourceAccess;
    private readonly development: CompanionCharacterDevelopmentStore;
    private readonly consolidation: CompanionMemoryConsolidationStore;
    constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage, private readonly applyState?: (scope: Scope, proposal: CompanionStateProposal) => void, private readonly observeNote?: (note: CompanionMemory) => void, private readonly withdrawStateSources?: (companionId: string, sourceIds: string[]) => void,
      private readonly applyIntegration?: (scope: Scope, input: CompanionMemoryStateIntegration) => void,
      private readonly withdrawStateMemories?: (companionId: string, versions: Array<{ id: string; version: number }>) => void,
      private readonly memoryTimeZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
        this.sources = new CompanionSourceAccess(db, getMessage, (owner, id, version, scope) => {
          try { const note = this.load(id); return note.version === version && this.visible(scope ?? this.sources.ownerScope(owner), note); } catch { return false; }
        }); this.development = new CompanionCharacterDevelopmentStore(db, (scope, note) => this.visible(scope, note));
        this.consolidation = new CompanionMemoryConsolidationStore(db, {
          load: id => this.load(id), valid: note => this.visible(this.sources.ownerScope(note.companionId), note),
          persist: note => this.persist(note), enqueue: (note, operation) => this.enqueue(note, operation), invalidate: owner => this.invalidateOwner(owner),
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
      INSERT OR IGNORE INTO metadata(key,value) VALUES('vcp-peer-episode-backfill-v2-through','0');
      INSERT OR IGNORE INTO metadata(key,value) SELECT 'vcp-peer-episode-backfill-v2-target',CAST(COALESCE(MAX(ordinal),0) AS TEXT) FROM vcp_capture_jobs;
      INSERT OR IGNORE INTO metadata(key,value) SELECT 'vcp-capture-backfill-target',CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages;
    `);
        const captureColumns = this.db.prepare('PRAGMA table_info(vcp_capture_jobs)').all() as Array<{ name: string }>;
        for (const name of ['completed_batch_id', 'output_note_versions']) if (!captureColumns.some(column => column.name === name)) this.db.exec(`ALTER TABLE vcp_capture_jobs ADD COLUMN ${name} TEXT`);
        if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='vcp-management-totals-ready'").get()) this.db.transaction(() => {
            this.db.prepare("INSERT OR REPLACE INTO vcp_memory_management_totals SELECT companion_id,COUNT(*) FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed') GROUP BY companion_id").run();
            this.db.prepare("INSERT OR REPLACE INTO metadata VALUES('vcp-management-totals-ready','1')").run();
        }).immediate();
        retireFactMemory(this.db);
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
    private visible(scope: Scope, note: CompanionMemory, visited = new Set<string>()): boolean {
        if (visited.has(note.id))
            return false;
        return this.sources.validateMemory(scope, note, () => this.visibleValue(scope, note, visited));
    }
    private visibleValue(scope: Scope, note: CompanionMemory, visited: Set<string>): boolean {
        this.sources.requireScope(scope);
        visited.add(note.id);
        if (note.companionId !== scope.companionId || ['forgotten', 'invalid'].includes(note.status) || !note.sources.length
            || note.sources.some(source => this.fictionalSource(source.messageId)) || this.sources.captureHeld(note.companionId, note.sourceConversationId))
            return false;
        if (this.sources.blockedTag({ ...scope, conversationId: note.sourceConversationId }, note.tags, note.sourceSequence))
            return false;
        if (!note.sources.every(reference => { const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reference.messageId); return source && Number(row(source).revision ?? 1) === reference.revision && companionSourceChecksum(String(row(source).content)) === reference.checksum && this.sources.visible(scope, row(source)); }))
            return false;
        return rows(this.db.prepare('SELECT source_note_id,version FROM vcp_note_dependencies WHERE note_id=?').all(note.id)).every(dependency => { const source = this.load(String(dependency.source_note_id)); return source.version === Number(dependency.version) && this.visible(scope, source, new Set(visited)); });
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
        if(this.sources.captureHeld(companionId,worldRoom)||this.sources.blockedTag(scope,tags,Number(source.sequence))||!this.sources.visible(scope,source)) return;
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
        if (this.sources.captureHeld(companionId, worldRoom) || !this.sources.visible(scope, source)) return;
        this.db.prepare('INSERT OR IGNORE INTO vcp_capture_jobs(id,companion_id,conversation_id,message_id,source_sequence,through_sequence,source_checksum,source_revision) VALUES(?,?,?,?,?,?,?,?)')
            .run(randomUUID(), companionId, worldRoom, messageId, source.sequence, source.sequence, receipt.checksum, source.revision ?? 1);
    }
    enqueueMessage(messageId: string, finalizedLoop = false, historical = false): void {
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
            return this.backfillPeerEpisodes(limit) && next >= target;
        }).immediate();
    }
    /** Reconsider previously skipped peer episodes once after the capture-policy
     * upgrade. Existing observer receipts, source versions and forget barriers
     * remain authoritative; this never invents historical room participation. */
    private backfillPeerEpisodes(limit: number): boolean {
        const through = Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-peer-episode-backfill-v2-through'").get()).value);
        const target = Number(row(this.db.prepare("SELECT value FROM metadata WHERE key='vcp-peer-episode-backfill-v2-target'").get()).value);
        const batch = rows(this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j JOIN companion_social_conversations s ON s.id=j.conversation_id
          WHERE j.ordinal>? AND j.ordinal<=? ORDER BY j.ordinal LIMIT ?`).all(through, target, limit));
        for (const job of batch) {
            const oldScopeFailure = job.status === 'failed' && /新日记不能关联其他来源域|整理来源不属于同一可见域/u.test(String(job.error ?? ''));
            if (!oldScopeFailure && (job.status !== 'done' || job.output_note_versions !== '[]')) continue;
            // Historical note dependencies include forgotten/invalid notes and
            // prevent re-creating a deliberately withdrawn episode.
            if (this.db.prepare('SELECT 1 FROM vcp_note_source_history h JOIN vcp_memory_notes n ON n.id=h.note_id WHERE h.message_id=? AND n.companion_id=? LIMIT 1').get(job.message_id, job.companion_id)) continue;
            const found = this.db.prepare('SELECT * FROM messages WHERE id=?').get(job.message_id);
            if (!found) continue;
            const source = row(found), scope = { companionId: String(job.companion_id), conversationId: String(job.conversation_id) };
            if (Number(source.revision ?? 1) !== Number(job.source_revision) || companionSourceChecksum(String(source.content)) !== job.source_checksum) continue;
            try { if (!this.sources.visible(scope, source)) continue; } catch { continue; }
            this.db.prepare("UPDATE vcp_capture_jobs SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL,completed_batch_id=NULL,output_note_versions=NULL WHERE id=? AND status IN('done','failed')").run(job.id);
        }
        const next = batch.length ? Number(batch.at(-1)!.ordinal) : target;
        this.db.prepare("UPDATE metadata SET value=? WHERE key='vcp-peer-episode-backfill-v2-through'").run(String(next));
        return next >= target;
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
        return !this.sources.captureHeld(String(job.companion_id), String(job.conversation_id))
          && !this.sources.captureHeld(String(job.companion_id), this.sources.logicalDomain(String(job.message_id)));
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
    claim(companionId?: string, leaseMs = 120000): CompanionMemoryJob | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.retireFictionalCaptureJobs();
            for (const job of rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_until<=?").all(now))) {
                const intent = this.reconsideration(job);
                if (intent && (intent.blockedLeaseToken === job.lease_token || !this.liveReconsideration(job, intent))) this.releaseSupersededCapture(String(job.lease_token));
            }
            this.db.prepare("UPDATE vcp_capture_jobs SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            const candidates = this.db.prepare(`SELECT j.* FROM vcp_capture_jobs j JOIN companions c ON c.id=j.companion_id WHERE j.status IN('pending','failed') AND j.next_attempt<=? AND j.attempts<8 AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1 AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=j.companion_id AND r.status!='completed') AND NOT EXISTS(SELECT 1 FROM vcp_source_policy_holds h WHERE h.companion_id=j.companion_id AND h.conversation_id IN(j.conversation_id,'*') AND h.released_at IS NULL) ${companionId ? 'AND j.companion_id=?' : ''} AND j.ordinal>? ORDER BY j.ordinal LIMIT 8`);
            let found: Row | undefined, after = 0;
            for (;;) {
                const page = rows(candidates.all(now, ...(companionId ? [companionId] : []), after));
                found = page.find(job => this.captureReady(job));
                if (found || page.length < 8) break;
                after = Number(page.at(-1)!.ordinal);
            }
            if (!found)
                return;
            const job = found, token = randomUUID(), reconsidering = !!this.reconsideration(job);
            // A historical extraction cannot replay state, while a fresh source
            // must retain its normal state processing. Never mix those batches.
            const cohort = this.db.prepare(`SELECT * FROM vcp_capture_jobs j WHERE companion_id=? AND conversation_id=? AND status IN('pending','failed')
              AND next_attempt<=? AND attempts<8 AND EXISTS(SELECT 1 FROM metadata m WHERE m.key='vcp-capture-reconsideration/'||j.companion_id||'/'||j.id)=?
              AND id!=? AND (source_sequence>? OR source_sequence=? AND ordinal>?) ORDER BY source_sequence,ordinal LIMIT 8`);
            const batch = [job]; let sequence = -1, ordinal = 0;
            while (batch.length < 8) {
                const page = rows(cohort.all(job.companion_id, job.conversation_id, now, Number(reconsidering), job.id, sequence, sequence, ordinal));
                for (const source of page) if (batch.length < 8 && this.captureReady(source)) batch.push(source);
                if (page.length < 8) break;
                sequence = Number(page.at(-1)!.source_sequence); ordinal = Number(page.at(-1)!.ordinal);
            }
            batch.sort((a, b) => Number(a.source_sequence) - Number(b.source_sequence) || Number(a.ordinal) - Number(b.ordinal));
            for (const source of batch)
                this.db.prepare("UPDATE vcp_capture_jobs SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, source.id);
            return { id: String(job.id), companionId: String(job.companion_id), conversationId: String(job.conversation_id), sourceMessageIds: batch.map(source => String(source.message_id)), throughSequence: Math.max(...batch.map(source => Number(source.through_sequence))), leaseToken: token, attempts: Number(job.attempts) + 1, sourceChecksums: Object.fromEntries(batch.map(source => [String(source.message_id), String(source.source_checksum)])), sourceRevisions: Object.fromEntries(batch.map(source => [String(source.message_id), Number(source.source_revision)])) };
        }).immediate();
    }
    private leased(table: 'vcp_capture_jobs' | 'vcp_memory_outbox', id: string, token: string): Row { const found = this.db.prepare(`SELECT * FROM ${table} WHERE id=? AND status='running' AND lease_token=? AND lease_until>?`).get(id, token, Date.now()); if (!found)
        throw new Error('VCP 投递租约已失效。'); return row(found); }
    complete(id: string, token: string, notes: CompanionMemoryCandidate[], stateProposal?: CompanionStateProposal, expectedProhibitionRevision?: string, expectedStateRevision?: number): CompanionMemory[] {
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
                const saved = this.recordJournal(scope, note, undefined, 'automatic', undefined, false, undefined,
                  new Map(reconsiderations.flatMap(({ intent }) => intent.invalidNotes.map(reference => [reference.id, reference.version] as const))));
                if (saved)
                    result.push(saved);
            }
            if (!reconsiderations.length && stateProposal && !stateProposal.sourceMessageIds.every(source => sourceIds.has(source))) throw new Error('状态提议只能使用本批正式来源。');
            if (!reconsiderations.length && stateProposal && this.sources.filter(scope, stateProposal.sourceMessageIds).length === stateProposal.sourceMessageIds.length) {
                if (result.length && !(stateProposal.appraisals ?? []).some(appraisal => appraisal.target === 'user'))
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
    fail(id: string, token: string, error: string, retryAfterMs = 30000): void { this.db.transaction(() => {
        this.leased('vcp_capture_jobs', id, token);
        const batch = rows(this.db.prepare("SELECT * FROM vcp_capture_jobs WHERE status='running' AND lease_token=?").all(token));
        if (batch.some(job => this.reconsideration(job)?.blockedLeaseToken === token)) { this.releaseSupersededCapture(token); return; }
        this.db.prepare("UPDATE vcp_capture_jobs SET status='failed',error=?,next_attempt=?,lease_token=NULL,lease_until=NULL WHERE lease_token=?").run(error, Date.now() + retryAfterMs, token);
    }).immediate(); }
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
    retry(companionId?: string): void { for (const table of ['vcp_capture_jobs', 'vcp_memory_outbox'])
        this.db.prepare(`UPDATE ${table} SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL
          WHERE (status='failed' OR status='pending' AND attempts>=8 OR status='running' AND attempts>=8 AND lease_until<=?)
          ${companionId ? 'AND companion_id=?' : ''}`).run(Date.now(), ...(companionId ? [companionId] : [])); }
    recordPrivateConsolidation(scope: Scope, candidate: CompanionMemoryCandidate, worldJobId: string, leaseToken: string): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const found = this.db.prepare("SELECT data,lease_until FROM companion_world_jobs WHERE id=? AND companion_id=? AND kind='dream' AND status='running'").get(worldJobId, scope.companionId);
            if (!found) throw new Error('私人睡眠整理必须属于当前真实梦任务。');
            const job = json<{ companionId: string; conversationId: string; leaseToken?: string; sleepEpisodeId?: string; memoryVersions?: Array<{ id: string; version: number }> }>(row(found).data);
            if (job.leaseToken !== leaseToken || String(row(found).lease_until) < stamp() || job.conversationId !== scope.conversationId) throw new Error('私人睡眠整理租约或消息入口已变化。');
            const room = this.sources.requireScope(scope);
            if (room.kind !== 'private' && scope.conversationId !== 'world_' + scope.companionId) throw new Error('跨经历反思只能发布到本人私人入口。');
            const versions = new Map(job.memoryVersions?.map(memory => [memory.id, memory.version]));
            const related = candidate.relatedMemoryIds ?? [];
            if (!related.length || related.some(id => !versions.has(id))) throw new Error('私人整理缺少本轮实际读取的记忆版本。');
            const seeds = related.map(id => this.load(id));
            const ownerScope = this.sources.ownerScope(scope.companionId);
            if (seeds.some(seed => seed.companionId !== scope.companionId || seed.version !== versions.get(seed.id) || !this.visible(ownerScope, seed))) throw new Error('私人整理的种子已经变化。');
            const sourceIds = new Set(seeds.flatMap(seed => seed.sources.map(source => source.messageId)));
            if (candidate.sourceMessageIds.some(id => !sourceIds.has(id))) throw new Error('私人整理不能引入本轮未读取的来源。');
            return this.recordJournal(scope, candidate, undefined, 'automatic', undefined, true,
              { consolidation: true, sleepReflection: true, sleepWorldJobId: worldJobId, worldJobId, ...(job.sleepEpisodeId ? { sleepEpisodeId: job.sleepEpisodeId } : {}) });
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
            const job = json<{ conversationId: string; leaseToken?: string; seedMemoryVersions?: Array<{ id: string; version: number }>; maintenanceMemoryVersions?: Array<{ id: string; version: number }> }>(row(found).data);
            if (job.leaseToken !== leaseToken || String(row(found).lease_until) < stamp() || job.conversationId !== scope.conversationId) throw new Error('自动记忆整合的睡眠租约或入口已变化。');
            const versions = new Map((job.maintenanceMemoryVersions ?? job.seedMemoryVersions)?.map(note => [note.id, note.version]));
            if (plan.inputs.some(note => versions.get(note.id) !== note.version)) throw new Error('自动整合只能使用本轮准确读取的真实种子版本。');
            const originals = plan.inputs.map(note => this.load(note.id)), ownerScope = this.sources.ownerScope(scope.companionId);
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
                  { automaticConsolidation: true, sleepWorldJobId: worldJobId });
                return { ok: true, memories: note ? [note] : [] };
            }).memories?.[0];
        }).immediate();
    }
    record(scope: Scope, input: CompanionMemoryCandidate, revision?: { id: string; expectedVersion: number },
      captureMethod: 'automatic' | 'manual' = 'automatic', expectedProhibitionRevision?: string): CompanionMemory | undefined {
        return this.recordJournal(scope, input, revision, captureMethod, expectedProhibitionRevision);
    }
    private recordJournal(scope: Scope, input: CompanionMemoryCandidate, revision?: {
        id: string;
        expectedVersion: number;
    }, captureMethod: 'automatic' | 'manual' = 'automatic', expectedProhibitionRevision?: string, privateConsolidation = false, hostClassification?: HostClassification,
      reconsideredInvalidNotes?: ReadonlyMap<string, number>): CompanionMemory | undefined {
        return this.db.transaction(() => {
            const draft = companionMemoryCandidateSchema.parse(normalizeCompanionCharacterDiary(input));
            // Free metadata is not an alternate host authority. Only the
            // verified sleep lease and actual consolidation path below may
            // classify a note as processed/derived or associate a sleep job.
            // Keep dream/simulation markers conservative: declaring fiction
            // never turns it into an original factual source.
            const metadata = { ...draft.metadata };
            for (const key of hostClassificationKeys) delete metadata[key];
            draft.metadata = { ...metadata, ...hostClassification };
            this.sources.requireScope(scope);
            const available = this.sources.filter(privateConsolidation ? this.sources.ownerScope(scope.companionId) : scope, draft.sourceMessageIds);
            if (available.length !== new Set(draft.sourceMessageIds).size)
                throw new Error('日记来源不可见、已撤回或尚未正式发送。');
            this.rejectFictionalSources(available.map(source => source.id));
            this.validateParticipationCandidate(scope.companionId,available,draft);
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
                if (this.sources.captureHeld(scope.companionId, domain) || this.sources.blockedTag({ ...scope, conversationId: domain }, draft.tags, sourceSequence)) throw new Error('私人整理的真实来源域仍有禁记限制。');
            }
            this.sources.assertProhibitionRevision({ ...scope, conversationId }, expectedProhibitionRevision);
            if (this.sources.captureHeld(scope.companionId, conversationId)) throw new Error('此可见域仍有旧版持续遗忘限制，请先在记忆管理中确认处理。');
            if (this.sources.blockedTag({ ...scope, conversationId }, draft.tags, sourceSequence))
                throw new Error('该日记涉及已禁止记录的内容。');
            const previous = revision ? this.load(revision.id) : undefined;
            if (previous && (!this.visible(scope, previous) || previous.version !== revision!.expectedVersion || previous.sourceConversationId !== conversationId))
                throw new Error('日记版本或可见域已变化，请重新读取。');
            const dependencies = draft.relatedMemoryIds.map(id => this.load(id));
            if (dependencies.some(source => !this.visible(scope, source) || source.id === previous?.id)) throw new Error('整理来源不属于此伙伴当前可读的本人记忆。');
            this.development.validate(scope, draft, available, dependencies, previous?.id);
            const scopeId = this.scope(scope.companionId, conversationId), identity = hash([scopeId, draft.content, draft.tags, references.map(source => [source.messageId, source.revision, source.checksum]), draft.occurredAt ?? '', draft.relatedMemoryIds, ...(draft.selfDevelopment ? [draft.selfDevelopment] : [])]);
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
                if (note.status !== 'invalid' || reconsideredInvalidNotes?.get(note.id) !== note.version)
                    throw new Error('该日记来源已失效或已遗忘。');
                restored = note;
            }
            const note: CompanionMemory = { id: previous?.id ?? restored?.id ?? 'note_' + identity.slice(0, 48), companionId: scope.companionId, scopeId, content: draft.content, tags: draft.tags, occurredAt: draft.occurredAt ?? references.at(-1)?.worldCreatedAt ?? references.at(-1)?.createdAt, diaryName: draft.diaryName ?? '经历', metadata: { ...draft.metadata, ...(draft.selfDevelopment ? { characterDevelopment: draft.selfDevelopment } : {}), learnedEntranceSourceId: draft.learnedEntranceSourceId, sourceMessageIds: references.map(source => source.messageId) }, sourceMessageId: references[0]!.messageId, sourceConversationId: conversationId, sources: references, sourceSequence, createdAt: previous?.createdAt ?? restored?.createdAt ?? stamp(), updatedAt: stamp(), origin: references.some(source => source.authorId === 'user') ? 'user' : 'companion', status: 'queued', version: (previous?.version ?? restored?.version ?? 0) + 1, captureMethod };
            if (dependencies.some(source => !this.visible(scope, source) || source.id === note.id))
                throw new Error('整理来源不属于此伙伴当前可读的本人记忆。');
            this.persist(note, previous || restored ? undefined : identity);
            this.development.saved(note);
            this.db.prepare('DELETE FROM vcp_note_dependencies WHERE note_id=?').run(note.id);
            for (const source of dependencies)
                this.db.prepare('INSERT INTO vcp_note_dependencies VALUES(?,?,?)').run(note.id, source.id, source.version);
            this.enqueue(note, 'remember');
            if (previous) {
                this.withdrawStateMemories?.(previous.companionId, [{ id: previous.id, version: previous.version }]);
                this.invalidateOwner(note.companionId);
                this.invalidateDependents(note.id);
            }
            this.observeNote?.(note);
            return note;
        }).immediate();
    }
    private invalidateDependents(id: string, visited = new Set<string>(), cause = id + ':' + this.load(id).version): void { if (visited.has(id))
        return; visited.add(id); for (const dependency of rows(this.db.prepare('SELECT note_id FROM vcp_note_dependencies WHERE source_note_id=?').all(id)))
        this.withdrawNote(String(dependency.note_id), 'invalid', visited, cause); }
    withdrawNote(id: string, status: 'forgotten' | 'invalid', visited = new Set<string>(), dependencyCause?: string): void {
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
            this.withdrawStateMemories?.(note.companionId, [{ id: note.id, version: note.version }]);
            this.invalidateOwner(note.companionId);
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
    resetOwner(owner: string, limit: number): number { this.pruneReconsiderations(owner); const notes = rows(this.db.prepare("SELECT id FROM vcp_memory_notes INDEXED BY vcp_note_reset_pending WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') LIMIT ?").all(owner, limit)); for (const note of notes)
        this.withdrawNote(String(note.id), 'forgotten'); return notes.length; }
    rebuildIndex(companionId?: string): number { return this.db.transaction(() => { const found = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE json_extract(data,'$.status') IN('queued','indexed') AND json_extract(data,'$.archivedAt') IS NULL" + (companionId ? ' AND companion_id=?' : '')).all(...(companionId ? [companionId] : []))); for (const entry of found) {
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
    list(companionId: string, includeArchived = false): CompanionMemory[] { return rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status') NOT IN('forgotten','invalid') ORDER BY rowid DESC").all(companionId)).map(found => json<CompanionMemory>(found.data)).filter(note => includeArchived || !note.archivedAt); }
    browse(input: CompanionMemorySearch): CompanionMemoryPage {
        const query = companionMemorySearchSchema.parse(input); this.sources.requireScope(query);
        if (query.query.trim()) throw new Error('正文搜索必须由 VCP 执行。');
        const { start, end } = companionMemoryDateRange(query.from, query.to, this.memoryTimeZone());
        const available = this.list(query.companionId).filter(note => {
            const at = Date.parse(note.occurredAt ?? note.sources.at(-1)?.worldCreatedAt ?? note.sources.at(-1)?.createdAt ?? note.createdAt);
            return this.visible(query, note) && (!query.diaryName || note.diaryName === query.diaryName) && query.tags.every(tag => note.tags.includes(tag))
              && (start === undefined || at >= start) && (end === undefined || at <= end);
        });
        const cursor = query.cursor ?? 0;
        return { items: available.slice(cursor, cursor + query.limit).map(memory => ({ memory, reasons: ['journal-list'], path: [memory.id] })),
            hasMore: available.length > cursor + query.limit, nextCursor: available.length > cursor + query.limit ? cursor + query.limit : undefined };
    }
    snapshot(scope: Scope): NonNullable<CompanionStorageResponse['memorySnapshot']> { this.sources.requireScope(scope); const notes = rows(this.db.prepare("SELECT data FROM vcp_memory_notes WHERE companion_id=? AND json_extract(data,'$.status')='indexed' ORDER BY id").all(scope.companionId)).map(found => json<CompanionMemory>(found.data)).filter(note => !note.archivedAt && this.visible(scope, note)); const revision = hash(['owner-memory-v2', scope.companionId, scope.beforeSequence ?? null, notes.map(note => [note.id, note.version, note.sources.map(source => [source.messageId, source.revision, source.checksum])])]); return { scopeId: 'view_' + revision.slice(0, 48), revision, notes }; }
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
            this.invalidateOwner(command.companionId);
            if (!command.id && !command.sourceMessageIds.length && !command.tag)
                throw new Error('请指定需要遗忘的日记、来源或标签。');
            if (command.requestMessageId && !this.sources.filter(command, [command.requestMessageId]).some(source => source.authorId === 'user'))
                throw new Error('遗忘请求不是当前可见的用户来源。');
            const notes = this.list(command.companionId, true).filter(note => this.visible(command, note) && (command.id ? note.id === command.id : command.sourceMessageIds.length ? note.sources.some(source => command.sourceMessageIds.includes(source.messageId)) : note.tags.includes(command.tag!)));
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
                        this.withdrawNote(note.id, 'forgotten');
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
        throw new Error('禁止记录该标签。'); this.invalidateOwner(note.companionId); note.tags = [...tags]; note.version++; note.status = 'queued'; note.updatedAt = stamp(); this.persist(note); this.enqueue(note, 'remember'); this.invalidateDependents(note.id); return note; })).immediate(); }
    rehomeConversation(oldId: string, newId: string): void { this.db.prepare('UPDATE vcp_capture_jobs SET conversation_id=? WHERE conversation_id=?').run(newId, oldId); for (const entry of rows(this.db.prepare('SELECT data FROM vcp_memory_notes WHERE conversation_id=?').all(oldId)))
        this.withdrawNote(json<CompanionMemory>(entry.data).id, 'invalid'); }
    claimOutbox(companionId?: string, leaseMs = 120000): NonNullable<CompanionStorageResponse['memoryOutbox']> | undefined {
        return this.db.transaction(() => {
            const now = Date.now();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(now);
            this.consolidation.reconcilePending();
            const found = this.db.prepare(`SELECT o.* FROM vcp_memory_outbox o WHERE o.status IN('pending','failed') AND o.next_attempt<=? AND o.attempts<8 AND NOT EXISTS(SELECT 1 FROM vcp_memory_outbox active WHERE active.scope_id=o.scope_id AND active.status='running' AND active.lease_until>?) ${companionId ? 'AND o.companion_id=?' : ''} ORDER BY o.ordinal LIMIT 1`).get(...(companionId ? [now, now, companionId] : [now, now]));
            if (!found)
                return;
            const entry = row(found), note = this.load(String(entry.note_id));
            if (entry.operation === 'remember' && note.archivedAt) {
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE id=?").run(entry.id);
                return;
            }
            if (entry.operation === 'forget' && !note.archivedAt && ['queued', 'indexed'].includes(note.status)) {
                // A derivative was invalidated after archiving this original.
                // Its obsolete archive removal must not erase a restored note.
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE id=?").run(entry.id);
                return;
            }
            if (note.version !== Number(entry.note_version)) {
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                return;
            }
            if (entry.operation === 'remember' && !this.visible(this.sources.ownerScope(note.companionId), note)) {
                this.withdrawNote(note.id, 'invalid');
                this.db.prepare("UPDATE vcp_memory_outbox SET status='done' WHERE id=?").run(entry.id);
                return;
            }
            const token = randomUUID();
            this.db.prepare("UPDATE vcp_memory_outbox SET status='running',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(token, now + leaseMs, entry.id);
            return { id: String(entry.id), companionId: note.companionId, scopeId: note.scopeId, noteId: note.id, noteVersion: note.version, operation: entry.operation as 'remember' | 'forget', note, leaseToken: token, attempts: Number(entry.attempts) + 1 };
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
            indexed: notes.filter(note => note.status === 'indexed').length, pendingIndex: notes.filter(note => note.status === 'queued' && !note.archivedAt).length,
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
        switch (command.type) {
            case 'memory.search': throw new Error('记忆检索只能由 VCP 执行。');
            case 'memory.operation.inspect': {
                const receipt = this.db.prepare('SELECT response FROM vcp_operation_receipts WHERE id=? AND companion_id=?').get(command.operationId, command.companionId);
                const references = receipt ? json<{ notes: Array<{ id: string }> }>(row(receipt).response).notes : [];
                const notes = references.map(reference => this.load(reference.id));
                return { ok: true, memories: notes.map(note => {
                    if (this.visible(this.sources.ownerScope(command.companionId), note)) return note;
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
            case 'memory.frozen.valid': return { ok: true, memoryFrozenValid: command.memories.every(memory => this.sources.frozenMemoryValid(command, memory)) };
            case 'character.development': this.sources.requireScope(command); return { ok: true, characterDevelopment: this.development.read(command, command.limit ?? 12) };
            case 'memory.prohibitions': return this.writePolicy(command);
            case 'memory.record': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, undefined, 'automatic', command.expectedProhibitionRevision); return { ok: true, memories: note ? [note] : [] }; });
            }
            case 'memory.revise': {
                return this.operation(command, () => { const note = this.record(command, command.candidate, { id: command.id, expectedVersion: command.expectedVersion }, 'automatic', command.expectedProhibitionRevision); return { ok: true, memories: note ? [note] : [] }; });
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
            case 'memory.jobs.backfill': return { ok: true, backfillComplete: this.backfill(command.limit) };
            case 'memory.index.rebuild': return { ok: true, rebuiltCount: this.rebuildIndex(command.companionId) };
            case 'memory.jobs.claim': return { ok: true, memoryJob: this.claim(command.companionId, command.leaseMs) };
            case 'memory.jobs.complete': return { ok: true, memories: this.complete(command.id, command.leaseToken, command.notes, command.stateProposal, command.expectedProhibitionRevision, command.expectedStateRevision) };
            case 'memory.jobs.fail':
                this.fail(command.id, command.leaseToken, command.error, command.retryAfterMs);
                return { ok: true };
            case 'memory.jobs.retry':
            case 'memory.outbox.retry':
                this.retry(command.companionId);
                return { ok: true };
            case 'memory.outbox.claim': return { ok: true, memoryOutbox: this.claimOutbox(command.companionId, command.leaseMs) };
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
