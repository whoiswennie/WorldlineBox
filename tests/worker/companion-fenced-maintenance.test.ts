import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { COMPANION_COGNITION_PROTOCOL } from '../../src/companions/cognition-protocol';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from '../../src/companions/fenced-maintenance';
import { companionRecoveryFencePath, CompanionRecoveryFence, createCompanionRecoveryMutationRunner, fencedCompanionConnection } from '../../src/companions/recovery-fence';
import { installCompanionRecoveryFileExact } from '../../src/companions/recovery-package';
import type { CompanionConnection } from '../../src/companions/store';

const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CompanionConnection };
const roots: string[] = [], handles = new Set<{ close(): void }>();
const track = <T extends { close(): void }>(handle: T): T => { handles.add(handle); return handle; };
const close = (handle: { close(): void }) => { handle.close(); handles.delete(handle); };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(() => {
  vi.restoreAllMocks(); for (const handle of handles) handle.close(); handles.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-fenced-maintenance-')) throw new Error('Unexpected maintenance fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const libraryPath = mkdtempSync(path.join(tmpdir(), 'companion-fenced-maintenance-')); roots.push(libraryPath);
  const data = path.join(libraryPath, '.worldlinebox', 'companions'); mkdirSync(data, { recursive: true });
  const libraryId = randomUUID(), selection = { libraryPath, libraryId }, ledger = path.join(data, 'messages.sqlite');
  const library = new Database(path.join(libraryPath, '.worldlinebox', 'library.db'));
  library.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); library.prepare('INSERT INTO library VALUES(?)').run(libraryId); library.close();
  const db = new Database(ledger);
  db.exec(`CREATE TABLE companion_cognition_protocol(singleton INTEGER PRIMARY KEY,protocol TEXT NOT NULL);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE companions(id TEXT PRIMARY KEY);
    CREATE TABLE messages(id TEXT PRIMARY KEY);
    CREATE TABLE domain_sentinel(id TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES('target','before'); INSERT INTO domain_sentinel VALUES('pending-domain-work','must-remain-pending');`);
  db.prepare('INSERT INTO companion_cognition_protocol VALUES(1,?)').run(COMPANION_COGNITION_PROTOCOL);
  const fence = new CompanionRecoveryFence(selection, ledger, db), head = fence.current(); fence.close(); db.close();
  const read = (sql: string, authority = false) => {
    const source = new Database(authority ? companionRecoveryFencePath(selection) : ledger, { readonly: true, fileMustExist: true });
    try { return source.prepare(sql).all(); } finally { source.close(); }
  };
  return { libraryPath, ledger, selection, head, read, open: () => track(openCompanionFencedMaintenance(selection, head)) };
}

it('opens and plans an enrolled existing ledger without Store initialization, schema backfills or domain state changes', () => {
  const f = fixture(), beforeTables = f.read("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"), beforeRows = f.read('SELECT * FROM domain_sentinel');
  const ledgerSHA = sha(readFileSync(f.ledger)), authoritySHA = sha(readFileSync(companionRecoveryFencePath(f.selection)));
  const inspection = track(inspectCompanionFencedMaintenance(f.selection)); expect(inspection.head).toEqual(f.head);
  expect(() => inspection.db.prepare("UPDATE domain_sentinel SET value='bad'").run()).toThrow(); close(inspection);
  expect(sha(readFileSync(f.ledger))).toBe(ledgerSHA); expect(sha(readFileSync(companionRecoveryFencePath(f.selection)))).toBe(authoritySHA);
  const maintenance = f.open(); expect(maintenance.head).toEqual(f.head); close(maintenance);
  expect(f.read("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")).toEqual(beforeTables);
  expect(f.read('SELECT * FROM domain_sentinel')).toEqual(beforeRows); expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 0, pending: 0 }]);
});

it('shares the exact prepare-before-primary-commit and finish-after-commit protocol, with one generation for nested statement guards', () => {
  const f = fixture(), primary = track(new Database(f.ledger)), observer = track(new Database(f.ledger, { readonly: true }));
  const fence = track(new CompanionRecoveryFence(f.selection, f.ledger, primary)), runner = createCompanionRecoveryMutationRunner(primary, fence);
  const db = fencedCompanionConnection(primary, runner), events: string[] = [], prepare = fence.prepare.bind(fence), finish = fence.finish.bind(fence);
  vi.spyOn(fence, 'prepare').mockImplementation(connection => {
    events.push('prepare'); expect(observer.prepare("SELECT value FROM metadata WHERE key='target'").get()).toEqual({ value: 'before' });
    const generation = prepare(connection); expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 1, pending: 1 }]); return generation;
  });
  vi.spyOn(fence, 'finish').mockImplementation(generation => {
    events.push('finish'); expect(observer.prepare("SELECT value FROM metadata WHERE key='target'").get()).toEqual({ value: 'after' }); finish(generation);
  });
  runner(() => {
    db.prepare("UPDATE metadata SET value='after' WHERE key='target'").run();
    db.transaction(() => db.prepare("INSERT INTO metadata VALUES('receipt','exact')").run()).immediate();
  });
  expect(events).toEqual(['prepare', 'finish']); expect(fence.current().generation).toBe(1);
});

it('requires explicit synchronous mutation and rolls back the entire callback on failure', () => {
  const f = fixture(), maintenance = f.open();
  expect(() => maintenance.db.prepare("UPDATE metadata SET value='outside' WHERE key='target'").run()).toThrow('维护事务');
  expect(() => maintenance.db.pragma('user_version=88')).toThrow('PRAGMA');
  expect(() => maintenance.mutate(db => { db.prepare("UPDATE metadata SET value='partial' WHERE key='target'").run(); db.prepare("INSERT INTO metadata VALUES('receipt','partial')").run(); throw new Error('CAS drift'); })).toThrow('CAS drift');
  expect(f.read('SELECT * FROM metadata ORDER BY key')).toEqual([{ key: 'target', value: 'before' }]);
  expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 0, pending: 0 }]);
  expect(() => maintenance.mutate(() => undefined)).toThrow('待核对');
});

it('rejects asynchronous work rather than committing SQL before its callback completes', () => {
  const f = fixture(), maintenance = f.open();
  expect(() => maintenance.mutate(async db => { db.prepare("UPDATE metadata SET value='async-partial' WHERE key='target'").run(); return true; })).toThrow('同步完成');
  expect(f.read('SELECT * FROM metadata')).toEqual([{ key: 'target', value: 'before' }]);
  expect(() => maintenance.db.prepare("INSERT INTO metadata VALUES('late','no')").run()).toThrow('维护事务');
});

it('rolls back all repair SQL and its receipt if independent durable prepare is unavailable', () => {
  const f = fixture(), maintenance = f.open(), authority = track(new Database(companionRecoveryFencePath(f.selection)));
  authority.exec("CREATE TRIGGER fail_prepare BEFORE UPDATE OF generation ON recovery_authority BEGIN SELECT RAISE(ABORT,'prepare unavailable'); END");
  expect(() => maintenance.mutate(db => { db.prepare("UPDATE metadata SET value='repaired' WHERE key='target'").run(); db.prepare("INSERT INTO metadata VALUES('receipt','completed')").run(); })).toThrow('prepare unavailable');
  expect(f.read('SELECT * FROM metadata')).toEqual([{ key: 'target', value: 'before' }]); expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 0, pending: 0 }]);
});

it('settles an unknown finish only on explicit apply reentry and leaves an exact completed operation as a no-op', () => {
  const f = fixture(), maintenance = f.open(), authority = track(new Database(companionRecoveryFencePath(f.selection)));
  authority.exec("CREATE TRIGGER fail_finish BEFORE UPDATE OF pending ON recovery_authority WHEN OLD.pending=1 AND NEW.pending=0 BEGIN SELECT RAISE(ABORT,'finish unavailable'); END");
  expect(() => maintenance.mutate(db => { db.prepare("UPDATE metadata SET value='repaired' WHERE key='target'").run(); db.prepare("INSERT INTO metadata VALUES('exact-operation','completed-manifest')").run(); })).toThrow('finish unavailable');
  close(maintenance); authority.exec('DROP TRIGGER fail_finish'); close(authority);
  const pending = f.read('SELECT generation,pending FROM recovery_authority', true); expect(pending).toEqual([{ generation: 1, pending: 1 }]);
  expect(() => inspectCompanionFencedMaintenance(f.selection)).toThrow('未结写入'); expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual(pending);
  const nextHead = { ...f.head, generation: 1 }, resumed = track(openCompanionFencedMaintenance(f.selection, nextHead));
  expect(resumed.head).toEqual(nextHead);
  resumed.mutate(db => { expect(db.prepare("SELECT value FROM metadata WHERE key='exact-operation'").get()).toEqual({ value: 'completed-manifest' }); expect(db.prepare("SELECT value FROM metadata WHERE key='target'").get()).toEqual({ value: 'repaired' }); });
  expect(resumed.head).toEqual(nextHead); expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 1, pending: 0 }]);
});

it('keeps crash reconciliation committed even when the subsequent old expected head is rejected', () => {
  const f = fixture(), authority = track(new Database(companionRecoveryFencePath(f.selection)));
  // The independent prepare committed, but the primary transaction did not.
  authority.exec('UPDATE recovery_authority SET previous_generation=generation,generation=generation+1,pending=1'); close(authority);
  expect(() => inspectCompanionFencedMaintenance(f.selection)).toThrow('未结写入');
  expect(() => openCompanionFencedMaintenance(f.selection, f.head)).toThrow('水位已变化');
  expect(f.read('SELECT generation,pending FROM recovery_authority', true)).toEqual([{ generation: 1, pending: 0 }]);
  expect(f.read('SELECT generation FROM companion_recovery_state')).toEqual([{ generation: 1 }]);
  expect(f.read('SELECT * FROM metadata')).toEqual([{ key: 'target', value: 'before' }]);
  const admitted = track(openCompanionFencedMaintenance(f.selection, { ...f.head, generation: 1 })); expect(admitted.head.generation).toBe(1);
});

it('rejects an external raw SQLite commit made after admission without adopting it into the maintenance baseline', () => {
  const f = fixture(), maintenance = f.open(), foreign = track(new Database(f.ledger));
  foreign.prepare("UPDATE domain_sentinel SET value='external-change'").run(); let called = false;
  expect(() => maintenance.mutate(() => { called = true; })).toThrow('外部写入'); expect(called).toBe(false);
  expect(f.read('SELECT * FROM metadata')).toEqual([{ key: 'target', value: 'before' }]); expect(f.read('SELECT generation FROM recovery_authority', true)).toEqual([{ generation: 0 }]);
});

it('advances monotonically for two explicit phases and refuses another operation with the old head', () => {
  const f = fixture(), maintenance = f.open();
  maintenance.mutate(db => db.prepare("INSERT INTO metadata VALUES('operation','prepared')").run()); expect(maintenance.head.generation).toBe(1);
  maintenance.mutate(db => { expect(db.prepare("UPDATE metadata SET value='completed' WHERE key='operation' AND value='prepared'").run().changes).toBe(1); db.prepare("UPDATE metadata SET value='repaired' WHERE key='target' AND value='before'").run(); });
  expect(maintenance.head.generation).toBe(2); close(maintenance);
  expect(() => openCompanionFencedMaintenance(f.selection, f.head)).toThrow('水位已变化');
  const resume = track(openCompanionFencedMaintenance(f.selection, { ...f.head, generation: 2 })); expect(resume.head.generation).toBe(2);
});

it('rejects unknown library, lineage, missing authority and replaced primary identities without enrolling or initializing a substitute', () => {
  const f = fixture();
  expect(() => openCompanionFencedMaintenance({ ...f.selection, libraryId: randomUUID() }, f.head)).toThrow('资产库身份');
  expect(() => openCompanionFencedMaintenance(f.selection, { ...f.head, lineageId: randomUUID() })).toThrow('水位已变化');
  const copy = f.ledger + '.copy'; copyFileSync(f.ledger, copy); unlinkSync(f.ledger); copyFileSync(copy, f.ledger);
  const before = sha(readFileSync(f.ledger)); expect(() => openCompanionFencedMaintenance(f.selection, f.head)).toThrow('正式恢复'); expect(sha(readFileSync(f.ledger))).toBe(before);
  unlinkSync(companionRecoveryFencePath(f.selection)); expect(() => openCompanionFencedMaintenance(f.selection, f.head)).toThrow('权威已丢失'); expect(existsSync(companionRecoveryFencePath(f.selection))).toBe(false);
});

it('publishes fsynced exact staged bytes without overwriting a preexisting different body and safely resumes its exact link pair', () => {
  const f = fixture(), source = path.join(f.libraryPath, 'immutable-body'), target = path.join(f.libraryPath, 'current-body'), stage = path.join(f.libraryPath, 'stage');
  writeFileSync(source, 'original published bytes'); const expected = { hash: sha(readFileSync(source)), size: readFileSync(source).length };
  expect(installCompanionRecoveryFileExact(source, target, expected, stage)).toBe(true);
  expect(installCompanionRecoveryFileExact(source, target, expected, stage)).toBe(false);
  writeFileSync(target, 'unknown user bytes'); expect(() => installCompanionRecoveryFileExact(source, target, expected, stage)).toThrow('不会覆盖'); expect(readFileSync(target, 'utf8')).toBe('unknown user bytes');
  unlinkSync(target); const staged = path.join(stage, sha(target) + '.body'); writeFileSync(staged, readFileSync(source)); linkSync(staged, target);
  expect(installCompanionRecoveryFileExact(source, target, expected, stage)).toBe(false); expect(existsSync(staged)).toBe(false); expect(readFileSync(target)).toEqual(readFileSync(source));
});
