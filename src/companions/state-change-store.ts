import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionRuntimeState } from '../shared/companion-state';
import { companionStateChangeSchema, type CompanionStateChange } from '../shared/companion-state-change';
import type { CompanionMessage } from '../shared/companions';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Snapshot = Pick<CompanionRuntimeState, 'energy' | 'expression' | 'focus' | 'experience' | 'relationshipRecords'>;
export class CompanionStateChangeStore {
  constructor(private readonly db: CompanionConnection, private readonly visible: (scope: Scope, ids: string[]) => CompanionMessage[]) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_state_changes(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),kind TEXT NOT NULL,applied_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_state_change_recent ON companion_state_changes(companion_id,applied_at DESC);
      CREATE TABLE IF NOT EXISTS companion_state_change_sources(change_id TEXT NOT NULL REFERENCES companion_state_changes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(change_id,message_id));
      CREATE INDEX IF NOT EXISTS companion_state_change_source ON companion_state_change_sources(message_id,change_id);
      CREATE TABLE IF NOT EXISTS companion_state_change_memories(change_id TEXT NOT NULL REFERENCES companion_state_changes(id) ON DELETE CASCADE,note_id TEXT NOT NULL,note_version INTEGER NOT NULL,PRIMARY KEY(change_id,note_id,note_version));
      CREATE INDEX IF NOT EXISTS companion_state_change_memory ON companion_state_change_memories(note_id,note_version,change_id);`);
  }
  add(owner: string, receipt: Omit<CompanionStateChange, 'energyDelta' | 'expression' | 'focus' | 'experienceId' | 'relationshipRecordIds'>, before: Snapshot, after: Snapshot): void {
    const oldRecords = new Set(before.relationshipRecords.map(record => record.id));
    const added = after.relationshipRecords.filter(record => !oldRecords.has(record.id)).map(record => record.id);
    if (before.energy === after.energy && before.expression === after.expression && before.focus === after.focus
      && before.experience?.id === after.experience?.id && !added.length) return;
    const sourceVersions = receipt.sourceMessageIds.map(messageId => {
      const source = this.db.prepare('SELECT revision,content FROM messages WHERE id=?').get(messageId) as { revision: number; content: string } | undefined;
      if (!source) throw new Error('状态生效来源不存在。');
      return { messageId, revision: source.revision, checksum: createHash('sha256').update(source.content).digest('hex') };
    });
    const value = companionStateChangeSchema.parse({ ...receipt, sourceVersions, energyDelta: after.energy - before.energy,
      ...(before.experience?.id !== after.experience?.id && after.experience ? { experienceId: after.experience.id } : {}),
      ...(added.length ? { relationshipRecordIds: added } : {}),
      ...(before.expression !== after.expression ? { expression: { before: before.expression, after: after.expression } } : {}),
      ...(before.focus !== after.focus ? { focus: { before: before.focus, after: after.focus } } : {}) });
    if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_changes(id,companion_id,kind,applied_at,data) VALUES(?,?,?,?,?)').run(value.id, owner, value.kind, value.appliedAt, JSON.stringify(value)).changes) return;
    for (const id of new Set(value.sourceMessageIds)) this.db.prepare('INSERT INTO companion_state_change_sources(change_id,message_id) VALUES(?,?)').run(value.id, id);
    for (const note of value.memoryVersions ?? []) this.db.prepare('INSERT OR IGNORE INTO companion_state_change_memories(change_id,note_id,note_version) VALUES(?,?,?)').run(value.id, note.id, note.version);
  }
  recent(scope: Scope): CompanionStateChange[] {
    const group = (this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(scope.conversationId) as { kind: string } | undefined)?.kind === 'group';
    const rows = this.db.prepare('SELECT data FROM companion_state_changes WHERE companion_id=? AND active=1 ORDER BY applied_at DESC,rowid DESC LIMIT 30').all(scope.companionId) as { data: string }[];
    return rows.map(row => companionStateChangeSchema.parse(JSON.parse(row.data))).filter(change =>
      (!group || change.sourceConversationId === scope.conversationId)
      && (!change.sourceMessageIds.length || this.visible(scope, change.sourceMessageIds).length === change.sourceMessageIds.length)
      && (change.sourceVersions ?? []).every(version => {
        const source = this.visible(scope, [version.messageId])[0];
        const stored = source && this.db.prepare('SELECT revision FROM messages WHERE id=?').get(source.id) as { revision: number } | undefined;
        return source && stored?.revision === version.revision && createHash('sha256').update(source.content).digest('hex') === version.checksum;
      })).slice(0, 5);
  }
  withdraw(owner: string, sourceIds: string[]): void {
    for (const source of sourceIds) this.db.prepare('UPDATE companion_state_changes SET active=0 WHERE companion_id=? AND id IN(SELECT change_id FROM companion_state_change_sources WHERE message_id=?)').run(owner, source);
  }
  delivery(scope: Scope, field: 'expression' | 'focus'): CompanionStateChange | undefined {
    return this.recent(scope).find(change => change[field] !== undefined);
  }
}
