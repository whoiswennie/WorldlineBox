import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { z } from 'zod';
import type { companionMemorySourceSchema, companionMemoryProhibitionSchema } from '../shared/companion-memory';
export type CompanionSourceScope = {
    companionId: string;
    conversationId: string;
    beforeSequence?: number;
    /** Internal recursion flag; never a model/tool argument. */
    excludePlayerSources?: boolean;
};
type Row = Record<string, string | number | null>;
const row = (value: unknown) => value as Row;
const json = <T>(value: unknown) => JSON.parse(String(value)) as T;
export const companionSourceChecksum = (content: string) => createHash('sha256').update(content).digest('hex');
/** Message evidence and authorization only. No memory retrieval, facts or vector state. */
export class CompanionSourceAccess {
    constructor(private readonly db: CompanionConnection, private readonly getMessage: (id: string) => CompanionMessage) { }
    initialize(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS vcp_source_observers(message_id TEXT NOT NULL REFERENCES messages(id),companion_id TEXT NOT NULL REFERENCES companions(id),PRIMARY KEY(message_id,companion_id));
      CREATE TABLE IF NOT EXISTS vcp_source_blocks(message_id TEXT NOT NULL REFERENCES messages(id),companion_id TEXT NOT NULL REFERENCES companions(id),created_at TEXT NOT NULL,PRIMARY KEY(message_id,companion_id));
      CREATE TABLE IF NOT EXISTS vcp_source_prohibitions(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,tag TEXT NOT NULL,through_sequence INTEGER NOT NULL,persistent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vcp_source_policy_holds(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,request_message_id TEXT,request_snippet TEXT NOT NULL,created_at TEXT NOT NULL,released_at TEXT);
      CREATE INDEX IF NOT EXISTS vcp_source_policy_owner ON vcp_source_policy_holds(companion_id,conversation_id,released_at);
      CREATE TABLE IF NOT EXISTS vcp_source_policy_tags(policy_id TEXT NOT NULL REFERENCES vcp_source_policy_holds(id) ON DELETE CASCADE,prohibition_id TEXT NOT NULL REFERENCES vcp_source_prohibitions(id) ON DELETE CASCADE,PRIMARY KEY(policy_id,prohibition_id));
      CREATE TABLE IF NOT EXISTS vcp_source_prohibition_requests(prohibition_id TEXT NOT NULL REFERENCES vcp_source_prohibitions(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(prohibition_id,message_id));
      CREATE TABLE IF NOT EXISTS vcp_source_prohibition_releases(prohibition_id TEXT PRIMARY KEY REFERENCES vcp_source_prohibitions(id) ON DELETE CASCADE,released_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS vcp_source_management_message ON vcp_source_prohibition_requests(message_id);
      CREATE INDEX IF NOT EXISTS vcp_source_observer_owner ON vcp_source_observers(companion_id,message_id);
      CREATE INDEX IF NOT EXISTS vcp_source_prohibition_owner ON vcp_source_prohibitions(companion_id,conversation_id);
    `);
    }
    requireScope(scope: CompanionSourceScope): Row {
        if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(scope.companionId))
            throw new Error('伙伴不存在。');
        const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=?').get(scope.conversationId);
        if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId))
            throw new Error('伙伴不是聊天成员。');
        return row(conversation);
    }
    observe(messageId: string, companionId: string): void {
        this.db.prepare('INSERT OR IGNORE INTO vcp_source_observers(message_id,companion_id) VALUES(?,?)').run(messageId, companionId);
    }
    captureHeld(companionId: string, conversationId: string): boolean {
        return !!this.db.prepare("SELECT 1 FROM vcp_source_policy_holds WHERE companion_id=? AND conversation_id IN(?,'*') AND released_at IS NULL LIMIT 1").get(companionId, conversationId);
    }
    worldScope(conversationId: string): boolean { return !!this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + conversationId); }
    managementSource(messageId: string): boolean { return !!this.db.prepare('SELECT 1 FROM vcp_source_prohibition_requests WHERE message_id=? LIMIT 1').get(messageId); }
    logicalDomain(messageId: string): string {
        const observation = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + messageId);
        if (observation) return json<{ forConversationId: string }>(row(observation).value).forConversationId;
        const source = this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(messageId);
        if (!source) throw new Error('记忆来源不存在。');
        return String(row(source).conversation_id);
    }
    formal(source: Row): boolean {
        const manual = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('vcp-manual-input/' + source.id);
        if (manual)
            return source.author_id === 'user' && source.kind === 'notice' && source.status === 'sent'
                && json<{
                    checksum: string;
                }>(row(manual).value).checksum === companionSourceChecksum(String(source.content));
        const observation = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + source.id);
        if (observation)
            return source.author_id === 'system' && source.kind === 'notice'
                && json<{
                    checksum: string;
                }>(row(observation).value).checksum === companionSourceChecksum(String(source.content));
        if (source.status !== 'sent' || source.author_id === 'system' || source.kind === 'notice')
            return false;
        if (source.kind === 'action') {
            const action = source.action_id ? this.db.prepare('SELECT data,status FROM actions WHERE id=?').get(source.action_id) : undefined;
            if (!action || !['succeeded', 'failed', 'cancelled'].includes(String(row(action).status)))
                return false;
            const result = json<{
                result?: string;
                error?: string;
            }>(row(action).data);
            return !!(result.result || result.error);
        }
        const loop = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + source.id);
        if (loop)
            return json<{
                status: string;
            }>(row(loop).value).status === 'done';
        const fingerprint = source.request_fingerprint ? json<{
            loopStep?: number;
        }>(source.request_fingerprint) : undefined;
        return fingerprint?.loopStep === undefined;
    }
    reference(source: Row): z.infer<typeof companionMemorySourceSchema> {
        const manual = this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('vcp-manual-input/' + source.id);
        const observation = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + source.id);
        const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + source.id);
        const worldTime = this.db.prepare('SELECT world_at FROM companion_message_times WHERE message_id=?').get(source.id);
        const assetReadId = observation ? json<{ assetRead?: string }>(row(observation).value).assetRead : undefined;
        const assetRead = assetReadId ? this.db.prepare('SELECT 1 FROM companion_learning_reads WHERE source_message_id=? AND id=?').get(source.id, assetReadId) : undefined;
        return { sourceType: manual ? 'manual_input' : assetRead ? 'asset_read' : observation ? 'world_observation' : 'message', messageId: String(source.id), conversationId: String(source.conversation_id),
            sequence: Number(source.sequence), authorId: String(source.author_id), revision: Number(source.revision ?? 1),
            checksum: companionSourceChecksum(String(source.content)), createdAt: String(source.created_at),
            ...(worldTime ? { worldCreatedAt: String(row(worldTime).world_at) } : {}), ...(publication ? { publishedAfterSequence: Number(row(publication).value) } : {}) };
    }
    blockedTag(scope: CompanionSourceScope, tags: readonly string[], sequence: number): boolean {
        return this.db.prepare('SELECT tag,through_sequence,persistent FROM vcp_source_prohibitions WHERE companion_id=? AND (conversation_id=? OR conversation_id=\'*\')').all(scope.companionId, scope.conversationId)
            .some(value => {
            const rule = row(value);
            return (rule.persistent || sequence <= Number(rule.through_sequence))
                && tags.some(tag => tag.normalize('NFKC').toLocaleLowerCase() === String(rule.tag).normalize('NFKC').toLocaleLowerCase());
        });
    }
    prohibitions(scope: CompanionSourceScope): Array<z.infer<typeof companionMemoryProhibitionSchema>> {
        this.requireScope(scope);
        return this.db.prepare("SELECT id,tag,conversation_id,through_sequence,persistent FROM vcp_source_prohibitions WHERE companion_id=? AND conversation_id IN(?,'*') ORDER BY id").all(scope.companionId, scope.conversationId)
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
        const id = String(source.id);
        if (visited.has(id))
            return true;
        visited.add(id);
        if (this.db.prepare('SELECT 1 FROM vcp_source_blocks WHERE message_id=? AND companion_id=?').get(id, scope.companionId))
            return true;
        const blocked = this.db.prepare('SELECT tag,through_sequence,persistent FROM vcp_source_prohibitions p WHERE companion_id=? AND (conversation_id=? OR conversation_id=\'*\') AND NOT EXISTS(SELECT 1 FROM vcp_source_prohibition_requests r WHERE r.prohibition_id=p.id AND r.message_id=?)').all(scope.companionId, source.conversation_id, id)
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
            const loop = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-loop/' + id);
            if (loop)
                ancestors.add(json<{
                    sourceMessageId: string;
                }>(row(loop).value).sourceMessageId);
        }
        if (source.action_id) {
            const action = this.db.prepare('SELECT data FROM actions WHERE id=?').get(source.action_id);
            if (action)
                ancestors.add(json<{
                    sourceMessageId: string;
                }>(row(action).data).sourceMessageId);
        }
        for (const ancestorId of ancestors) {
            const ancestor = this.db.prepare('SELECT * FROM messages WHERE id=?').get(ancestorId);
            if (ancestor && this.forgotten(scope, row(ancestor), new Set(visited)))
                return true;
        }
        return false;
    }
    visible(scope: CompanionSourceScope, source: Row, visited = new Set<string>()): boolean {
        const conversation = this.requireScope(scope), id = String(source.id);
        const peerContext = scope.excludePlayerSources || this.worldScope(scope.conversationId);
        if (peerContext && !this.worldScope(String(source.conversation_id))) return false;
        if (visited.has(id))
            return false;
        visited.add(id);
        const observationRow = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-world-observation/' + id);
        const observation = observationRow ? json<{
            companionId: string;
            forConversationId: string;
            throughSequence?: number;
            assetRead?: string;
            sources: Array<{
                id: string;
                conversationId: string;
                checksum: string;
            }>;
        }>(row(observationRow).value) : undefined;
        if (observation?.assetRead && !this.db.prepare("SELECT 1 FROM companion_learning_reads r JOIN companion_learning_grants g ON g.id=r.grant_id WHERE r.id=? AND r.source_message_id=? AND r.companion_id=? AND r.status='read' AND g.enabled=1").get(observation.assetRead, id, scope.companionId)) return false;
        if (peerContext && observation && !this.worldScope(observation.forConversationId)) return false;
        if (observation && (observation.companionId !== scope.companionId || conversation.kind === 'group' && observation.forConversationId !== scope.conversationId && source.conversation_id !== scope.conversationId
            || observation.sources.some(reference => {
                const original = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reference.id);
                return !original || companionSourceChecksum(String(row(original).content)) !== reference.checksum
                    || !this.visible({ ...scope, conversationId: reference.conversationId, excludePlayerSources: peerContext }, row(original), new Set(visited));
            })))
            return false;
        const currentObservation = !!observation && observation.forConversationId === scope.conversationId
            && (scope.beforeSequence === undefined || observation.throughSequence !== undefined && observation.throughSequence <= scope.beforeSequence);
        if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(source.author_id)
            || this.db.prepare("SELECT 1 FROM companion_reset_rooms s JOIN companion_reset_jobs j ON j.id=s.job_id WHERE s.conversation_id=? AND j.status!='completed' LIMIT 1").get(source.conversation_id)
            || this.db.prepare('SELECT 1 FROM companion_reset_messages WHERE message_id=? LIMIT 1').get(id))
            return false;
        const boundary = this.db.prepare('SELECT through_sequence FROM companion_reset_boundaries WHERE companion_id=?').get(scope.companionId);
        if (boundary && Number(source.sequence) <= Number(row(boundary).through_sequence))
            return false;
        if (this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(scope.companionId))
            return false;
        if (!currentObservation && scope.beforeSequence !== undefined && Number(source.sequence) > scope.beforeSequence)
            return false;
        const publication = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('message-published-after/' + id);
        if (scope.beforeSequence !== undefined && publication && scope.beforeSequence <= Number(row(publication).value))
            return false;
        if (!currentObservation && conversation.kind === 'group' && source.conversation_id !== scope.conversationId)
            return false;
        if (!this.db.prepare('SELECT 1 FROM vcp_source_observers WHERE message_id=? AND companion_id=?').get(id, scope.companionId))
            return false;
        return this.formal(source) && !this.forgotten(scope, source);
    }
    filter(scope: CompanionSourceScope, ids: readonly string[]): CompanionMessage[] {
        this.requireScope(scope);
        return [...new Set(ids)].flatMap(id => {
            const source = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
            return source && this.visible(scope, row(source)) ? [this.getMessage(id)] : [];
        });
    }
    block(companionId: string, ids: readonly string[]): void {
        for (const id of ids)
            this.db.prepare('INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) VALUES(?,?,?)').run(id, companionId, new Date().toISOString());
    }
}
