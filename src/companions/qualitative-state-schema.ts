import type { CompanionConnection } from './store';

/** New-protocol state initializer; no old numeric state is read or converted. */
export function ensureQualitativeStateTables(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_current_experiences(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL,source_sequence INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companion_current_experience_owner ON companion_current_experiences(companion_id,active,source_sequence DESC);
    CREATE TABLE IF NOT EXISTS companion_relationship_records(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),target_id TEXT NOT NULL,topic TEXT NOT NULL,context TEXT NOT NULL,conversation_id TEXT NOT NULL,source_sequence INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS companion_relationship_owner ON companion_relationship_records(companion_id,active,source_sequence DESC);
    CREATE TABLE IF NOT EXISTS companion_qualitative_state_sources(kind TEXT NOT NULL,record_id TEXT NOT NULL,companion_id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(kind,record_id,source_id));
    CREATE INDEX IF NOT EXISTS companion_qualitative_source ON companion_qualitative_state_sources(companion_id,source_id);
    CREATE TABLE IF NOT EXISTS companion_qualitative_state_memories(kind TEXT NOT NULL,record_id TEXT NOT NULL,companion_id TEXT NOT NULL,note_id TEXT NOT NULL,note_version INTEGER NOT NULL,PRIMARY KEY(kind,record_id,note_id,note_version));`);
}
