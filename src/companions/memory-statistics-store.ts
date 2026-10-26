import type { CompanionConnection } from './store';

const active = (alias: string) => `json_extract(${alias}.data,'$.status') IN('queued','indexed')`;
const derived = (alias: string) => `COALESCE(json_extract(${alias}.data,'$.metadata.dream'),0)=1 OR COALESCE(json_extract(${alias}.data,'$.metadata.simulation'),0)=1
  OR COALESCE(json_extract(${alias}.data,'$.metadata.sleepReflection'),0)=1 OR json_extract(${alias}.data,'$.metadata.consolidation') IS NOT NULL`;
const original = (alias: string) => `CASE WHEN (${active(alias)}) AND NOT (${derived(alias)}) THEN 1 ELSE 0 END`;
const representation = (alias: string) => `CASE WHEN (${active(alias)}) AND (${derived(alias)}) THEN 1 ELSE 0 END`;

/** Content-free counters are updated in the source transaction. Polling a
 * processing panel never materializes or counts an owner's entire corpus. */
export function initializeCompanionMemoryStatistics(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_statistics(companion_id TEXT PRIMARY KEY,source_versions INTEGER NOT NULL DEFAULT 0,
    original_entries INTEGER NOT NULL DEFAULT 0,derived_entries INTEGER NOT NULL DEFAULT 0);`);
  if (!db.prepare("SELECT 1 FROM metadata WHERE key='memory-statistics-ready/v1'").get()) db.transaction(() => {
    db.exec(`DELETE FROM companion_memory_statistics;
      INSERT INTO companion_memory_statistics(companion_id,source_versions)
        SELECT companion_id,COUNT(*) FROM vcp_capture_jobs GROUP BY companion_id;
      INSERT INTO companion_memory_statistics(companion_id,original_entries,derived_entries)
        SELECT companion_id,SUM(${original('n')}),SUM(${representation('n')}) FROM vcp_memory_notes n GROUP BY companion_id
        ON CONFLICT(companion_id) DO UPDATE SET original_entries=excluded.original_entries,derived_entries=excluded.derived_entries;`);
    db.prepare("INSERT INTO metadata(key,value) VALUES('memory-statistics-ready/v1','1')").run();
  }).immediate();
  for (const [table, source] of [['vcp_capture_jobs', true], ['vcp_memory_notes', false]] as const) {
    const increment = (alias: string, sign: number) => `INSERT INTO companion_memory_statistics(companion_id,source_versions,original_entries,derived_entries)
      VALUES(${alias}.companion_id,${source ? sign : 0},${source ? 0 : sign + '*(' + original(alias) + ')'},${source ? 0 : sign + '*(' + representation(alias) + ')'})
      ON CONFLICT(companion_id) DO UPDATE SET source_versions=source_versions+excluded.source_versions,
        original_entries=original_entries+excluded.original_entries,derived_entries=derived_entries+excluded.derived_entries;`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_statistics_insert AFTER INSERT ON ${table} BEGIN ${increment('NEW', 1)} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_statistics_delete AFTER DELETE ON ${table} BEGIN ${increment('OLD', -1)} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_statistics_update AFTER UPDATE OF ${source ? 'companion_id' : 'data,companion_id'} ON ${table}
      ${source ? 'WHEN NEW.companion_id IS NOT OLD.companion_id' : `WHEN NEW.companion_id IS NOT OLD.companion_id OR (${original('OLD')})!=(${original('NEW')}) OR (${representation('OLD')})!=(${representation('NEW')})`}
      BEGIN ${increment('OLD', -1)} ${increment('NEW', 1)} END;`);
  }
}

export function companionMemoryStatistics(db: CompanionConnection, companionId: string) {
  const row = db.prepare('SELECT source_versions AS sourceVersions,original_entries AS originalEntries,derived_entries AS derivedEntries FROM companion_memory_statistics WHERE companion_id=?').get(companionId) as
    { sourceVersions: number; originalEntries: number; derivedEntries: number } | undefined;
  return row ?? { sourceVersions: 0, originalEntries: 0, derivedEntries: 0 };
}
