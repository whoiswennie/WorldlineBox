import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';
import { readCapabilityRevalidationCandidate, commitCapabilityRevalidation } from '../../src/companions/capability-revalidation-store';
import { revalidateCompanionCapabilityPresentation } from '../../src/main/companions/capability-revalidation';
import { companionCapabilityRecordId } from '../../src/main/companions/capability-journal';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionAction } from '../../src/shared/companions';
import { boundaryNow, boundaryRun } from './companion-agenda-boundary-fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const { db, connection } = nodeCompanionConnection(); cleanups.push(() => db.close());
  db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE actions(id TEXT PRIMARY KEY,data TEXT NOT NULL)');
  const id = companionCapabilityRecordId({ companionId: 'alice', conversationId: 'own_room', invocationId: 'run' }, 'actual_call');
  const action: CompanionAction = { id, companionId: 'alice', conversationId: 'own_room', title: '核对自己的安排', status: 'succeeded',
    createdAt: boundaryNow, updatedAt: boundaryNow, result: '真实返回仍然保留。',
    capability: { name: 'agenda', callId: 'actual_call', invocationId: 'run', agendaRunId: 'run', inputHash: createHash('sha256').update('{}').digest('hex') } };
  db.prepare('INSERT INTO actions VALUES(?,?)').run(id, JSON.stringify(action));
  const key = 'execution-source-invalid/action/' + id;
  db.prepare('INSERT INTO metadata VALUES(?,?)').run(key, JSON.stringify({ invalidatedAt: boundaryNow }));
  const run = { ...boundaryRun(), status: 'completed' as const, activeGrantId: undefined, activeGrantRevision: undefined };
  const current = { owner: 'alice', unavailable: false, mutateAtCommit: false };
  const commands: string[] = [];
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(command.type);
    if (current.unavailable && command.type === 'state') throw new Error('storage temporarily unavailable');
    if (command.type === 'capability.revalidation.read') return { ok: true, capabilityRevalidation: readCapabilityRevalidationCandidate(connection, command.id) };
    if (command.type === 'capability.revalidation.commit') {
      if (current.mutateAtCommit) db.prepare('INSERT INTO metadata VALUES(?,?)').run('concurrent-source-write', 'true');
      return { ok: true, capabilityRevalidated: commitCapabilityRevalidation(connection, command) };
    }
    if (command.type === 'state') return { ok: true, state: { companions: [{ id: 'alice' }], conversations: [{ id: 'own_room', kind: 'private', memberIds: [current.owner] }] } as CompanionStorageResponse['state'] };
    if (command.type === 'agenda.run.read') return { ok: true, agendaRun: run };
    throw new Error('Unexpected revalidation command ' + command.type);
  };
  return { db, connection, action, id, key, current, commands, request,
    recover: () => revalidateCompanionCapabilityPresentation(id, request),
    marker: () => db.prepare('SELECT value FROM metadata WHERE key=?').get(key) };
}

it('restores only a canonically valid legacy capability tombstone and leaves an audit without replaying any action', async () => {
  const f = fixture(), original = f.db.prepare('SELECT data FROM actions WHERE id=?').get(f.id)!.data;
  expect(await f.recover()).toBe(true); expect(f.marker()).toBeUndefined();
  expect(f.db.prepare('SELECT data FROM actions WHERE id=?').get(f.id)!.data).toBe(original);
  const audit = f.db.prepare('SELECT value FROM metadata WHERE key=?').get('capability-source-revalidated/' + f.id)!;
  expect(JSON.parse(String(audit.value))).toMatchObject({ validator: 'capability-v1', replayed: false });
  expect(f.commands).not.toContain('action.update'); expect(f.commands).not.toContain('capability.begin');
  expect(await f.recover()).toBe(false);
});
it('retains the tombstone when current ownership no longer permits that private record', async () => {
  const f = fixture(); f.current.owner = 'bob'; expect(await f.recover()).toBe(false); expect(f.marker()).toBeDefined();
});
it('rejects a verified withdrawal and any legacy checkpoint rather than clearing all capability invalidations', async () => {
  const f = fixture(); f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ invalidatedAt: boundaryNow, validator: 'capability-v1' }), f.key);
  expect(await f.recover()).toBe(false); expect(f.marker()).toBeDefined();
  f.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify({ invalidatedAt: boundaryNow }), f.key);
  f.db.prepare('INSERT INTO metadata VALUES(?,?)').run('task-checkpoint/' + f.id, '{}');
  expect(await f.recover()).toBe(false); expect(f.marker()).toBeDefined();
});
it('rejects the commit after any intervening SQLite dependency write', async () => {
  const f = fixture(); f.current.mutateAtCommit = true; expect(await f.recover()).toBe(false); expect(f.marker()).toBeDefined();
  expect(f.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('capability-source-revalidated/' + f.id)).toBeUndefined();
});
it('leaves the original record untouched on temporary validation unavailability', async () => {
  const f = fixture(); f.current.unavailable = true; await expect(f.recover()).rejects.toThrow(); expect(f.marker()).toBeDefined();
  expect(f.commands).not.toContain('capability.revalidation.commit');
});
