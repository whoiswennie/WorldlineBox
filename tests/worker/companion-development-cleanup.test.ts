import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite3 from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { importCompanionRetainedHostData } from '../../src/companions/retained-host-data';
import type { CompanionConnection } from '../../src/companions/store';
import { afterEach, expect, it } from 'vitest';
import { executeCompanionManagedCleanup, planCompanionManagedCleanup, type CompanionCleanupOptions } from '../../src/companions/development-cleanup';

const roots: string[] = [];
const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number }): CompanionConnection };
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-dev-cleanup-')) throw new Error('Unexpected test directory.');
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-dev-cleanup-')); roots.push(root);
  const metadata = path.join(root, '.worldlinebox'), dataRoot = path.join(metadata, 'companions'), memoryRoot = path.join(root, '伙伴记忆');
  const owner = path.join(memoryRoot, 'alice'), attachmentRoot = path.join(dataRoot, 'attachments'), shared = path.join(dataRoot, 'dsh-tasks');
  for (const directory of [owner, attachmentRoot, shared]) mkdirSync(directory, { recursive: true });
  const library = new Database(path.join(metadata, 'library.db')); library.exec("CREATE TABLE library(library_id TEXT PRIMARY KEY); INSERT INTO library VALUES('selected-library')"); library.close();
  const ledger = path.join(dataRoot, 'messages.sqlite'), db = new Database(ledger);
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);
    INSERT INTO companions VALUES('alice','{"persona":"PRIVATE_PERSONA_CANARY"}',NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,companion_id TEXT REFERENCES companions(id),content TEXT); INSERT INTO messages VALUES('message','alice','PRIVATE_MESSAGE_CANARY');
    CREATE VIRTUAL TABLE message_search USING fts5(tokens,content='',contentless_delete=1); INSERT INTO message_search(rowid,tokens) VALUES(1,'PRIVATE_INDEX_CANARY');
    CREATE TABLE companion_current_experiences(id TEXT PRIMARY KEY,companion_id TEXT,data TEXT); INSERT INTO companion_current_experiences VALUES('experience','alice','PRIVATE_EXPERIENCE');
    CREATE TABLE companion_growth_goal_definitions(goal_id TEXT PRIMARY KEY,revision INTEGER,sources TEXT); INSERT INTO companion_growth_goal_definitions VALUES('goal-alice',1,'[{"messageId":"message","revision":1}]');
    CREATE TABLE companion_social_budget(companion_id TEXT PRIMARY KEY,data TEXT); INSERT INTO companion_social_budget VALUES('alice','{"used":3}');
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata VALUES('memory-private/alice','PRIVATE_METADATA'),('companion-model-resources-initialized','KEEP_BUDGET_POLICY'),('unrelated-setting','KEEP_SETTING');
    CREATE TABLE player_profile(id TEXT PRIMARY KEY,revision INTEGER,data TEXT);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,data TEXT,relative_path TEXT); INSERT INTO attachments VALUES('owned','{}','attachments/owned.txt'),('player','{}','attachments/player.png');`);
  db.exec("CREATE TABLE companion_model_requests(id TEXT PRIMARY KEY,state TEXT); INSERT INTO companion_model_requests VALUES('old_allowance','admitted'); CREATE TABLE companion_model_request_purposes(request_id TEXT PRIMARY KEY,purpose TEXT); INSERT INTO companion_model_request_purposes VALUES('old_allowance','reply')");
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=', 'base64');
  const draft = { name: '我', description: '人类资料保留', avatarAttachmentId: 'player' };
  const profile = { ...draft, id: 'user', revision: 3, updatedAt: '2026-10-28T00:00:00Z', contentHash: createHash('sha256').update(JSON.stringify({
    id: 'user', name: draft.name, description: draft.description, avatar: { id: 'player', mime: 'image/png', size: image.length, relativePath: 'attachments/player.png' },
  })).digest('hex') };
  db.prepare('INSERT INTO player_profile VALUES(?,?,?)').run('user', 3, JSON.stringify(profile));
  db.prepare('UPDATE attachments SET data=? WHERE id=?').run(JSON.stringify({ id: 'player', name: 'player.png', mime: 'image/png', size: image.length }), 'player');
  db.close();
  writeFileSync(path.join(owner, 'instance.json'), JSON.stringify({ companionId: 'alice' })); writeFileSync(path.join(owner, 'profile.md'), 'PRIVATE_FILE_CANARY');
  writeFileSync(path.join(memoryRoot, 'unknown-global.md'), 'KEEP_UNKNOWN'); writeFileSync(path.join(attachmentRoot, 'owned.txt'), 'PRIVATE_ATTACHMENT'); writeFileSync(path.join(attachmentRoot, 'player.png'), image);
  writeFileSync(path.join(dataRoot, '模型资源预算.json'), 'KEEP_RESOURCE_POLICY'); writeFileSync(path.join(dataRoot, 'credentials.json'), 'KEEP_GLOBAL_CREDENTIALS'); writeFileSync(path.join(shared, 'shared-session'), 'KEEP_DSH');
  writeFileSync(path.join(dataRoot, '模型资源预算.json.backup'), 'KEEP_UNRELATED_BACKUP');
  const options: CompanionCleanupOptions = { libraryPath: root, libraryId: 'selected-library', openDatabase: (file, readonly) => new Database(file, { readonly, fileMustExist: true, timeout: 0 }) };
  const scalar = (sql: string) => { const read = new Database(ledger); try { return read.prepare(sql).get(); } finally { read.close(); } };
  return { root, ledger, dataRoot, memoryRoot, owner, shared, options, scalar };
}
it('plans without changing owner records and removes the exact managed manifest including retired allowances while preserving credentials, player data and shared DSH', async () => {
  const f = fixture(), plan = await planCompanionManagedCleanup(f.options);
  expect(plan.owners).toEqual(['alice']); expect(plan.tablesPreservedUntilFileRemoval).not.toContain('companion_model_requests'); expect(plan.tables.some(table => table.name === 'companion_model_requests')).toBe(true); expect(plan.preservedPaths).toContain(path.join(f.memoryRoot, 'unknown-global.md'));
  expect(plan.tables.some(table => table.name === 'companion_growth_goal_definitions')).toBe(true);
  expect(plan.tables.some(table => table.name === 'companion_social_budget')).toBe(true);
  expect(plan.tablesPreservedUntilFileRemoval).not.toContain('companion_social_budget');
  expect(plan.files.some(file => file.path === path.join(f.dataRoot, '模型资源预算.json'))).toBe(true);
  expect(f.scalar('SELECT COUNT(*) n FROM companions')).toEqual({ n: 1 }); expect(existsSync(path.join(f.owner, 'profile.md'))).toBe(true);
  await expect(executeCompanionManagedCleanup(plan, '0'.repeat(64), f.options)).rejects.toThrow('hash');
  const result = await executeCompanionManagedCleanup(plan, plan.planHash, f.options); expect(result.completed).toBe(true);
  expect(result.new_database_required).toBe(true); expect(existsSync(f.ledger)).toBe(false); expect(existsSync(f.owner)).toBe(false);
  const fresh = new Database(f.ledger);
  try {
    fresh.exec("CREATE TABLE companion_cognition_protocol(singleton INTEGER PRIMARY KEY,protocol TEXT); INSERT INTO companion_cognition_protocol VALUES(1,'worldlinebox.companion-cognition-v2'); CREATE TABLE companions(id TEXT PRIMARY KEY); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE player_profile(id TEXT PRIMARY KEY,revision INTEGER,data TEXT); CREATE TABLE attachments(id TEXT PRIMARY KEY,data TEXT,relative_path TEXT)");
    expect(importCompanionRetainedHostData(fresh, { dataRoot: f.dataRoot, libraryPath: f.root, libraryId: 'selected-library' })).toEqual({ imported: true });
    expect(JSON.parse(String((fresh.prepare('SELECT data FROM player_profile').get() as { data: string }).data)).name).toBe('我');
    expect(fresh.prepare('SELECT id FROM attachments').get()).toEqual({ id: 'player' }); expect(fresh.prepare('SELECT COUNT(*) n FROM companions').get()).toEqual({ n: 0 });
    expect(fresh.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'companion_model_%'").get()).toEqual({ n: 0 });
    expect(JSON.parse(readFileSync(result.retainedHostDataPath, 'utf8'))).not.toHaveProperty('modelAccounting');
    expect(importCompanionRetainedHostData(fresh, { dataRoot: f.dataRoot, libraryPath: f.root, libraryId: 'selected-library' })).toEqual({ imported: false });
  } finally { fresh.close(); }
  expect(existsSync(path.join(f.dataRoot, '模型资源预算.json'))).toBe(false);
  for (const [file, value] of [[path.join(f.shared, 'shared-session'), 'KEEP_DSH'], [path.join(f.dataRoot, 'credentials.json'), 'KEEP_GLOBAL_CREDENTIALS'], [path.join(f.dataRoot, '模型资源预算.json.backup'), 'KEEP_UNRELATED_BACKUP'], [path.join(f.memoryRoot, 'unknown-global.md'), 'KEEP_UNKNOWN']]) expect(readFileSync(file!, 'utf8')).toBe(value);
  expect(readFileSync(f.ledger).includes(Buffer.from('PRIVATE_MESSAGE_CANARY'))).toBe(false);
  expect(await executeCompanionManagedCleanup(plan, plan.planHash, f.options)).toEqual(result);
});
it('refuses an unknown SQL domain and never treats a retained preference manifest as arbitrary SQL or file authority', async () => {
  const unknown = fixture(), unsafe = new Database(unknown.ledger); unsafe.exec('CREATE TABLE unrelated_assets(id TEXT PRIMARY KEY)'); unsafe.close();
  await expect(planCompanionManagedCleanup(unknown.options)).rejects.toThrow('unknown non-companion SQL table');
  expect(existsSync(path.join(unknown.owner, 'profile.md'))).toBe(true);
  const f = fixture(), plan = await planCompanionManagedCleanup(f.options), result = await executeCompanionManagedCleanup(plan, plan.planHash, f.options);
  const fresh = new Database(f.ledger);
  try {
    fresh.exec("CREATE TABLE companion_cognition_protocol(singleton INTEGER PRIMARY KEY,protocol TEXT); INSERT INTO companion_cognition_protocol VALUES(1,'worldlinebox.companion-cognition-v2'); CREATE TABLE companions(id TEXT PRIMARY KEY); CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE player_profile(id TEXT PRIMARY KEY,revision INTEGER,data TEXT); CREATE TABLE attachments(id TEXT PRIMARY KEY,data TEXT,relative_path TEXT)");
    const options = { dataRoot: f.dataRoot, libraryPath: f.root, libraryId: 'selected-library' };
    expect(() => importCompanionRetainedHostData(fresh, { ...options, libraryId: 'wrong-library' })).toThrow('another selected library');
    fresh.prepare('INSERT INTO companions(id) VALUES(?)').run('new-person');
    expect(() => importCompanionRetainedHostData(fresh, options)).toThrow('without companion identities'); fresh.exec('DELETE FROM companions');
    const image = path.join(f.dataRoot, 'attachments/player.png'), original = readFileSync(image); writeFileSync(image, 'CHANGED_IMAGE');
    expect(() => importCompanionRetainedHostData(fresh, options)).toThrow('bytes changed'); writeFileSync(image, original);
    const manifest = JSON.parse(readFileSync(result.retainedHostDataPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(result.retainedHostDataPath, JSON.stringify({ ...manifest, sql: 'DROP TABLE companions' }));
    expect(() => importCompanionRetainedHostData(fresh, options)).toThrow();
    expect(fresh.prepare('SELECT COUNT(*) n FROM player_profile').get()).toEqual({ n: 0 }); expect(fresh.prepare('SELECT COUNT(*) n FROM metadata').get()).toEqual({ n: 0 });
  } finally { fresh.close(); }
});
it.each(['companions-recovery-authority.sqlite','companions-recovery-enrollment.json'])('refuses planning or executing the old cleanup once %s exists, without touching the ledger or host authority',async name=>{
  const f=fixture(),plan=await planCompanionManagedCleanup(f.options),before=readFileSync(f.ledger),file=path.join(f.root,'.worldlinebox',name);writeFileSync(file,'KEEP_NEW_RECOVERY_AUTHORITY');
  await expect(planCompanionManagedCleanup(f.options)).rejects.toThrow('新伙伴系统已登记恢复权威');
  await expect(executeCompanionManagedCleanup(plan,plan.planHash,f.options)).rejects.toThrow('正式退役');
  expect(readFileSync(f.ledger)).toEqual(before);expect(readFileSync(file,'utf8')).toBe('KEEP_NEW_RECOVERY_AUTHORITY');expect(existsSync(path.join(f.owner,'profile.md'))).toBe(true);expect(existsSync(path.join(f.dataRoot,'development-cleanup'))).toBe(false);
});
it('rejects an unknown shared-budget SQL table rather than classifying it by a model or budget keyword', async () => {
  const f = fixture(), db = new Database(f.ledger); db.exec('CREATE TABLE shared_model_budget(id TEXT PRIMARY KEY)'); db.close();
  await expect(planCompanionManagedCleanup(f.options)).rejects.toThrow(/unknown non-companion SQL table.*: shared_model_budget/u);
  expect(f.scalar('SELECT COUNT(*) n FROM companions')).toEqual({ n: 1 });
  expect(readFileSync(path.join(f.dataRoot, '模型资源预算.json'), 'utf8')).toBe('KEEP_RESOURCE_POLICY');
  expect(readFileSync(path.join(f.dataRoot, 'credentials.json'), 'utf8')).toBe('KEEP_GLOBAL_CREDENTIALS');
});
it.each(['invalid_profile_hash', 'missing_player_image'] as const)('rejects %s before removing any old managed data', async invalid => {
  const f = fixture(), db = new Database(f.ledger);
  if (invalid === 'invalid_profile_hash') { const profile = JSON.parse(String((db.prepare('SELECT data FROM player_profile').get() as { data: string }).data));
    profile.contentHash = '0'.repeat(64); db.prepare('UPDATE player_profile SET data=?').run(JSON.stringify(profile)); }
  else db.exec("DELETE FROM attachments WHERE id='player'");
  db.close(); await expect(planCompanionManagedCleanup(f.options)).rejects.toThrow();
  expect(existsSync(f.ledger)).toBe(true); expect(existsSync(f.owner)).toBe(true);
  expect(f.scalar('SELECT COUNT(*) n FROM companion_model_requests')).toEqual({ n: 1 });
});
it('rejects changed plans, wrong library ownership and active SQLite journals before deleting anything', async () => {
  const f = fixture(), plan = await planCompanionManagedCleanup(f.options);
  await expect(executeCompanionManagedCleanup({ ...plan, memoryRoot: tmpdir() }, plan.planHash, f.options)).rejects.toThrow('hash');
  await expect(planCompanionManagedCleanup({ ...f.options, libraryId: 'another-library' })).rejects.toThrow('identity');
  writeFileSync(path.join(f.owner, 'profile.md'), 'NEW_CONTENT'); await expect(executeCompanionManagedCleanup(plan, plan.planHash, f.options)).rejects.toThrow('changed');
  expect(f.scalar('SELECT COUNT(*) n FROM companions')).toEqual({ n: 1 });
  const active = new Database(f.ledger); try { active.exec("INSERT INTO messages VALUES('later','alice','NEW_PRIVATE')"); await expect(planCompanionManagedCleanup(f.options)).rejects.toThrow('stop its writers'); } finally { active.close(); }
});
it('resumes an interrupted new cleanup checkpoint without restoring old identities or deleting unrelated files', async () => {
  const f = fixture(), plan = await planCompanionManagedCleanup(f.options); let crash = true;
  const interrupted: CompanionCleanupOptions = { ...f.options, openDatabase: (file, readonly) => {
    const db = new Database(file, { readonly, fileMustExist: true, timeout: 0 });
    if (readonly) return db;
    return { prepare: db.prepare.bind(db), exec: db.exec.bind(db), close: () => { db.close(); if (crash) { crash = false; throw new Error('SIMULATED_PROCESS_LOSS'); } } };
  } };
  await expect(executeCompanionManagedCleanup(plan, plan.planHash, interrupted)).rejects.toThrow('SIMULATED_PROCESS_LOSS');
  expect(f.scalar('SELECT COUNT(*) n FROM companions')).toEqual({ n: 0 }); expect(existsSync(f.owner)).toBe(true);
  expect((await executeCompanionManagedCleanup(plan, plan.planHash, f.options)).completed).toBe(true);
  expect(existsSync(f.owner)).toBe(false); expect(readFileSync(path.join(f.shared, 'shared-session'), 'utf8')).toBe('KEEP_DSH');
});
