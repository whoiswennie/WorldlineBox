import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import { actionSchema } from '../shared/companions';
import type { CompanionStorageResponse } from '../shared/companion-storage';
import { executionSourceInvalidKey } from './execution-source-access';

type Candidate = NonNullable<CompanionStorageResponse['capabilityRevalidation']>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Candidate only: never an instruction to reveal content or retry a tool.
 * The old untyped guard rejected every capability without a DSH checkpoint.
 * New verified withdrawals carry a validator and are never repair candidates. */
export function readCapabilityRevalidationCandidate(db: CompanionConnection, id: string): Candidate | undefined {
  const marker = db.prepare('SELECT value FROM metadata WHERE key=?').get(executionSourceInvalidKey('action', id)) as { value: string } | undefined;
  if (!marker) return;
  try {
    const invalidation = JSON.parse(marker.value) as Record<string, unknown>;
    if (Object.keys(invalidation).length !== 1 || typeof invalidation.invalidatedAt !== 'string'
      || !Number.isFinite(Date.parse(invalidation.invalidatedAt))) return;
    if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get('task-checkpoint/' + id)) return;
    const stored = db.prepare('SELECT data FROM actions WHERE id=?').get(id) as { data: string } | undefined;
    if (!stored) return;
    const action = actionSchema.parse(JSON.parse(stored.data));
    if (!action.capability || action.id !== id || action.contentAvailable === false) return;
    const generation = db.prepare('SELECT total_changes() AS value').get() as { value: number };
    return { action: { ...action, canResume: false }, invalidation: marker.value,
      actionDigest: hash(stored.data), writeGeneration: Number(generation.value) };
  } catch { return; }
}

/** Main verifies the real parent/source/run before this CAS. Since this worker
 * is the sole SQLite writer, total_changes fences ALL intervening dependency
 * writes, not just action updates. A busy database can retry on a later read. */
export function commitCapabilityRevalidation(db: CompanionConnection, input: Omit<Candidate, 'action'> & { id: string }): boolean {
  return db.transaction(() => {
    const current = readCapabilityRevalidationCandidate(db, input.id);
    if (!current || current.writeGeneration !== input.writeGeneration || current.actionDigest !== input.actionDigest
      || current.invalidation !== input.invalidation) return false;
    db.prepare('DELETE FROM metadata WHERE key=? AND value=?').run(executionSourceInvalidKey('action', input.id), input.invalidation);
    db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('capability-source-revalidated/' + input.id,
      JSON.stringify({ revalidatedAt: new Date().toISOString(), previousInvalidation: JSON.parse(input.invalidation),
        actionDigest: input.actionDigest, validator: 'capability-v1', replayed: false }));
    return true;
  }).immediate();
}
