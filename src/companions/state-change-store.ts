import type { CompanionConnection } from './store';
import type { CompanionRuntimeState } from '../shared/companion-state';
import { companionStateChangeSchema, type CompanionStateChange } from '../shared/companion-state-change';
import type { CompanionMessage } from '../shared/companions';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Snapshot = Pick<CompanionRuntimeState, 'affect' | 'relationship' | 'energy' | 'expression' | 'focus'>;
export class CompanionStateChangeStore {
  constructor(private readonly db: CompanionConnection, private readonly visible: (scope: Scope, ids: string[]) => CompanionMessage[]) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_state_changes(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),kind TEXT NOT NULL,applied_at TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_state_change_recent ON companion_state_changes(companion_id,applied_at DESC);
      CREATE TABLE IF NOT EXISTS companion_state_change_sources(change_id TEXT NOT NULL REFERENCES companion_state_changes(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(change_id,message_id));
      CREATE INDEX IF NOT EXISTS companion_state_change_source ON companion_state_change_sources(message_id,change_id);
      CREATE TABLE IF NOT EXISTS companion_state_change_memories(change_id TEXT NOT NULL REFERENCES companion_state_changes(id) ON DELETE CASCADE,note_id TEXT NOT NULL,note_version INTEGER NOT NULL,PRIMARY KEY(change_id,note_id,note_version));
      CREATE INDEX IF NOT EXISTS companion_state_change_memory ON companion_state_change_memories(note_id,note_version,change_id);`);
    if (!this.db.prepare("SELECT 1 FROM metadata WHERE key='state-change-memory-links/v1'").get()) {
      this.db.prepare(`INSERT OR IGNORE INTO companion_state_change_memories SELECT c.id,json_extract(v.value,'$.id'),json_extract(v.value,'$.version')
        FROM companion_state_changes c,json_each(c.data,'$.memoryVersions') v`).run();
      this.db.prepare("INSERT INTO metadata(key,value) VALUES('state-change-memory-links/v1','done')").run();
    }
  }
  add(owner: string, receipt: Omit<CompanionStateChange, 'affectDelta' | 'relationshipDelta' | 'energyDelta' | 'expression' | 'focus'>, before: Snapshot, after: Snapshot): void {
    const affectDelta = { pleasure: after.affect.pleasure - before.affect.pleasure, arousal: after.affect.arousal - before.affect.arousal, dominance: after.affect.dominance - before.affect.dominance };
    const relationshipDelta = { affinity: after.relationship.affinity - before.relationship.affinity, trust: after.relationship.trust - before.relationship.trust, respect: after.relationship.respect - before.relationship.respect };
    if (![...Object.values(affectDelta), ...Object.values(relationshipDelta), after.energy - before.energy].some(value => Math.abs(value) > 1e-12)
      && before.expression === after.expression && before.focus === after.focus) return;
    const value = companionStateChangeSchema.parse({ ...receipt, affectDelta, relationshipDelta, energyDelta: after.energy - before.energy,
      ...(before.expression !== after.expression ? { expression: { before: before.expression, after: after.expression } } : {}),
      ...(before.focus !== after.focus ? { focus: { before: before.focus, after: after.focus } } : {}) });
    if (!this.db.prepare('INSERT OR IGNORE INTO companion_state_changes(id,companion_id,kind,applied_at,data) VALUES(?,?,?,?,?)').run(value.id, owner, value.kind, value.appliedAt, JSON.stringify(value)).changes) return;
    for (const id of new Set(value.sourceMessageIds)) this.db.prepare('INSERT INTO companion_state_change_sources(change_id,message_id) VALUES(?,?)').run(value.id, id);
    for (const note of value.memoryVersions ?? []) this.db.prepare('INSERT OR IGNORE INTO companion_state_change_memories(change_id,note_id,note_version) VALUES(?,?,?)').run(value.id, note.id, note.version);
  }
  recent(scope: Scope): CompanionStateChange[] {
    const group = (this.db.prepare('SELECT kind FROM conversations WHERE id=?').get(scope.conversationId) as { kind: string } | undefined)?.kind === 'group';
    // Bounded SQL scan and transport. Private reasons are never relabelled as group events.
    const rows = this.db.prepare('SELECT data FROM companion_state_changes WHERE companion_id=? AND active=1 ORDER BY applied_at DESC,rowid DESC LIMIT 30').all(scope.companionId) as { data: string }[];
    return rows.map(row => companionStateChangeSchema.parse(JSON.parse(row.data))).filter(change => {
      if (group && change.sourceConversationId !== scope.conversationId) return false;
      return !change.sourceMessageIds.length || this.visible(scope, change.sourceMessageIds).length === change.sourceMessageIds.length;
    }).slice(0, 5);
  }
  withdraw(owner: string, sourceIds: string[]): void {
    for (const source of sourceIds) this.db.prepare('UPDATE companion_state_changes SET active=0 WHERE companion_id=? AND id IN(SELECT change_id FROM companion_state_change_sources WHERE message_id=?)').run(owner, source);
  }
  delivery(scope: Scope, field: 'expression' | 'focus'): CompanionStateChange | undefined {
    const found = this.db.prepare(`SELECT data FROM companion_state_changes WHERE companion_id=? AND active=1 AND json_type(data,'$.${field}')='object' ORDER BY applied_at DESC,rowid DESC LIMIT 30`).all(scope.companionId) as { data: string }[];
    for (const row of found) {
      const change = companionStateChangeSchema.parse(JSON.parse(row.data));
      if (!change.sourceMessageIds.length || this.visible(scope, change.sourceMessageIds).length === change.sourceMessageIds.length) return change;
    }
    return undefined;
  }
}
