import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { validateRetainedPlayerProfile } from './retained-host-data';

export interface CleanupDatabase {
  prepare(sql: string): { get(...values: unknown[]): unknown; all(...values: unknown[]): unknown[]; run(...values: unknown[]): unknown };
  exec(sql: string): unknown; close(): unknown;
}
export interface CompanionCleanupOptions {
  libraryPath: string; libraryId: string;
  openDatabase(file: string, readonly: boolean): CleanupDatabase;
}
interface FileProof { path: string; root: string; size: number; sha256: string; device: number; inode: number; modified: number; changed: number }
interface TablePlan { name: string; mode: 'all' | 'fts' | 'metadata' | 'attachments'; rows: number; sql: string }
export interface CompanionManagedCleanupPlan {
  schema: 'worldlinebox.development-companion-cleanup-v1'; libraryPath: string; libraryId: string;
  ledgerPath: string; memoryRoot: string; dataRoot: string; owners: string[];
  ledgerProof: FileProof; tables: TablePlan[]; tablesPreservedUntilFileRemoval: string[];
  metadataKeys: string[]; preservedMetadataKeys: string[]; keptAttachmentIds: string[];
  files: FileProof[]; directories: string[]; preservedPaths: string[]; createdAt: string; planHash: string;
  retainedHostData: { schema: 'worldlinebox.retained-host-data-v3'; libraryPath: string; libraryId: string; dataRoot: string;
    playerProfile: unknown | null;
    attachments: Array<{ id: string; relativePath: string; attachment: Record<string, unknown>; file: FileProof }> };
}
const quote = (name: string) => { if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(name)) throw new Error('Unexpected SQLite identifier.'); return '"' + name + '"'; };
const object = (value: unknown) => value as Record<string, unknown>;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(object(value)[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function planHash(plan: Omit<CompanionManagedCleanupPlan, 'planHash'> | CompanionManagedCleanupPlan): string {
  const { createdAt: _createdAt, planHash: _planHash, ...authority } = plan as CompanionManagedCleanupPlan; void _createdAt; void _planHash;
  return hash(canonical(authority));
}
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function directory(file: string): Promise<string> {
  const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A selected root is not an independent directory: ' + file);
  const actual = await realpath(file); if (path.relative(path.resolve(file), actual)) throw new Error('A selected root traverses a link: ' + file); return actual;
}
async function safeFile(root: string, file: string): Promise<void> {
  if (!inside(root, file)) throw new Error('Cleanup target escaped its explicit managed root.');
  let parent = root;
  for (const part of path.relative(root, file).split(path.sep).slice(0, -1)) { parent = path.join(parent, part); await directory(parent); }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || path.relative(file, await realpath(file))) throw new Error('Cleanup target is linked or changed: ' + file);
}
async function proof(root: string, file: string): Promise<FileProof> {
  await safeFile(root, file); const before = await lstat(file);
  if (before.size > 512 * 1024 * 1024) throw new Error('A cleanup file exceeds its 512 MiB inspection budget.');
  const handle = await open(file, 'r'), digest = createHash('sha256');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk); } finally { await handle.close(); }
  const after = await lstat(file);
  if ([before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':') !== [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':')) throw new Error('A cleanup target changed while being inspected.');
  return { path: file, root, size: after.size, sha256: digest.digest('hex'), device: after.dev, inode: after.ino, modified: after.mtimeMs, changed: after.ctimeMs };
}
async function unoccupied(ledger: string, library: string): Promise<void> {
  for (const database of [ledger, library]) for (const suffix of ['-wal', '-shm', '-journal']) {
    try { await lstat(database + suffix); throw new Error('The selected library still has a journal/shared-memory file; stop its writers before cleanup: ' + database + suffix); }
    catch (error) { if (!missing(error)) throw error; }
  }
}
/** SQLite readonly WAL connections may create sidecars. Inspect a verified
 * offline copy so planning never opens the original ledger or asset database. */
async function inspectDatabase<T>(options: CompanionCleanupOptions, source: string, inspect: (db: CleanupDatabase) => T): Promise<T> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'worldlinebox-cleanup-read-')), copy = path.join(temporary, 'snapshot.sqlite');
  const cleanSnapshot = async () => {
    for (const suffix of ['', '-wal', '-shm', '-journal']) { const file = copy + suffix;
      if (path.dirname(file) !== temporary) throw new Error('Snapshot cleanup escaped its temporary directory.');
      try { await unlink(file); } catch (error) { if (!missing(error)) throw error; }
    }
    await rmdir(temporary);
  };
  try {
    if ((await lstat(source)).size > 512 * 1024 * 1024) throw new Error('A cleanup database exceeds its 512 MiB inspection budget.');
    await copyFile(source, copy); const db = options.openDatabase(copy, true);
    try { return inspect(db); } finally { db.close(); }
  } finally { await cleanSnapshot(); }
}
async function selection(options: CompanionCleanupOptions, requireLedger = true) {
  if (!path.isAbsolute(options.libraryPath) || !options.libraryId.trim()) throw new Error('An explicit selected library and identity are required.');
  const libraryPath = await directory(path.resolve(options.libraryPath)), metadata = await directory(path.join(libraryPath, '.worldlinebox'));
  await requireLegacyUnenrolledNamespace(metadata);
  const dataRoot = await directory(path.join(metadata, 'companions')), ledgerPath = path.join(dataRoot, 'messages.sqlite');
  const libraryDatabase = path.join(metadata, 'library.db'); await safeFile(metadata, libraryDatabase);
  try { await safeFile(dataRoot, ledgerPath); } catch (error) { if (requireLedger || !missing(error)) throw error; }
  await unoccupied(ledgerPath, libraryDatabase);
  await inspectDatabase(options, libraryDatabase, db => {
    const identities = db.prepare('SELECT library_id FROM library LIMIT 2').all();
    if (identities.length !== 1 || object(identities[0]).library_id !== options.libraryId) throw new Error('The selected path does not belong to the expected library identity.');
  });
  const memoryRoot = path.join(libraryPath, '伙伴记忆');
  try { await directory(memoryRoot); } catch (error) { if (!missing(error)) throw error; }
  return { libraryPath, dataRoot, ledgerPath, libraryDatabase, memoryRoot };
}
/** This one-time development switch is never a reset protocol for an enrolled
 * current identity. In particular it cannot delete only the primary ledger
 * while leaving the independent revocation authority behind. */
async function requireLegacyUnenrolledNamespace(metadata:string):Promise<void>{
  for(const name of ['companions-recovery-authority.sqlite','companions-recovery-enrollment.json']){
    try{await lstat(path.join(metadata,name));}catch(error){if(missing(error))continue;throw error;}
    throw new Error('新伙伴系统已登记恢复权威；一次性旧数据清理工具不能删除此账本。请使用正式退役或选择新的资产库，不会删除或重建恢复权威。');
  }
}
// Only human preferences survive an old-protocol database replacement.
// Retired model allowance records are managed data, with no runtime authority.
const protectedTable = (name: string) => name === 'player_profile';
const ownedTable = (name: string) => /^(?:companion_|vcp_)/u.test(name) || ['companions', 'conversations', 'conversation_members', 'messages', 'message_attachments', 'actions', 'attachments', 'memories', 'proactive_state', 'message_search'].includes(name);
const runtimeMetadata = (key: string) => !/^(?:credentials\/|connections\/|provider-config\/|llm\/|global\/)/iu.test(key)
  && /^(?:vcp-|memory-|companion-|world-|social-|life-|learning-|qualitative-|state-|task-|message-|topic-|artifact-|cognition-|growth-|file-result\/|execution-|proactive\/)/u.test(key);

/** Produces an exact, bounded, read-only manifest. Unknown paths/tables are
 * preserved; nothing is discovered as a memory or recursively removed. */
export async function planCompanionManagedCleanup(options: CompanionCleanupOptions): Promise<CompanionManagedCleanupPlan> {
  const scope = await selection(options), beforeLedger = await proof(scope.dataRoot, scope.ledgerPath);
  let owners: string[] = [], tables: TablePlan[] = [], tablesPreservedUntilFileRemoval: string[] = [], metadataKeys: string[] = [], preservedMetadataKeys: string[] = [], keptAttachmentIds: string[] = [], attachments: Array<{ path: string; id: string }> = [];
  let playerProfile: unknown | null = null;
  const playerAttachments: Array<{ id: string; relativePath: string; attachment: Record<string, unknown> }> = [];
  await inspectDatabase(options, scope.ledgerPath, db => {
    const mode = object(db.prepare('PRAGMA journal_mode').get()).journal_mode;
    if (mode !== 'wal') throw new Error('Offline cleanup requires the selected companion WAL ledger.');
    owners = db.prepare('SELECT id FROM companions ORDER BY id').all().map(row => String(object(row).id));
    if (owners.some(id => !/^[a-zA-Z0-9_-]{1,100}$/u.test(id))) throw new Error('A companion owner identity is malformed.');
    const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ name: String(object(row).name), sql: String(object(row).sql ?? '') }));
    const virtual = schema.filter(row => /CREATE VIRTUAL TABLE/iu.test(row.sql));
    const shadows = (name: string) => virtual.some(row => name.startsWith(row.name + '_'));
    tables = []; tablesPreservedUntilFileRemoval = [];
    for (const item of schema) {
      if (!shadows(item.name) && !protectedTable(item.name) && (ownedTable(item.name) || item.name === 'metadata')) tables.push({ ...item,
        mode: item.name === 'metadata' ? 'metadata' : item.name === 'attachments' ? 'attachments' : /USING fts5/iu.test(item.sql) ? 'fts' : 'all', rows: Number(object(db.prepare('SELECT COUNT(*) AS n FROM ' + quote(item.name)).get()).n) });
      else if (shadows(item.name) || item.name === 'player_profile') tablesPreservedUntilFileRemoval.push(item.name);
      else throw new Error('The companion ledger contains an unknown non-companion SQL table; explicit host review is required before removing the database: ' + item.name);
    }
    const keys = schema.some(row => row.name === 'metadata') ? db.prepare('SELECT key FROM metadata ORDER BY key').all().map(row => String(object(row).key)) : [];
    metadataKeys = keys.filter(runtimeMetadata); preservedMetadataKeys = keys.filter(key => !runtimeMetadata(key));
    keptAttachmentIds = [];
    if (schema.some(row => row.name === 'player_profile')) for (const row of db.prepare('SELECT data FROM player_profile').all()) {
      const player = JSON.parse(String(object(row).data)) as { id?: string; avatarAttachmentId?: string; appearanceAttachmentId?: string };
      if (playerProfile || player.id !== 'user') throw new Error('Only the actual human player profile can be retained.'); playerProfile = player;
      for (const id of [player.avatarAttachmentId, player.appearanceAttachmentId]) if (id) keptAttachmentIds.push(id);
    }
    attachments = [];
    if (schema.some(row => row.name === 'attachments')) for (const value of db.prepare('SELECT id,data,relative_path FROM attachments ORDER BY id').all()) {
      const row = object(value), id = String(row.id), relativePath = String(row.relative_path);
      if (keptAttachmentIds.includes(id)) { const original = JSON.parse(String(row.data)) as Record<string, unknown>;
        // Retain only public attachment metadata. Original filesystem paths and
        // URLs cannot become a later file-read permission.
        playerAttachments.push({ id, relativePath, attachment: { id, name: original.name, mime: original.mime, size: original.size } });
      } else attachments.push({ id, path: relativePath });
    }
  });
  await unoccupied(scope.ledgerPath, scope.libraryDatabase);
  if (canonical(await proof(scope.dataRoot, scope.ledgerPath)) !== canonical(beforeLedger)) throw new Error('The ledger changed while its read-only snapshot was inspected.');
  const files: FileProof[] = [], directories: string[] = [], preservedPaths: string[] = []; let total = 0;
  const addFile = async (root: string, file: string) => {
    const item = await proof(root, file); total += item.size;
    if (files.length >= 50000 || total > 8 * 1024 ** 3) throw new Error('Cleanup manifest exceeds its file/byte review budget.'); files.push(item);
  };
  const walk = async (root: string, target: string, depth = 0): Promise<void> => {
    if (depth > 20 || !inside(root, target)) throw new Error('Cleanup directory escaped its owner or depth budget.');
    await directory(target); directories.push(target);
    for (const entry of await readdir(target, { withFileTypes: true })) {
      const child = path.join(target, entry.name); if (entry.isDirectory()) await walk(root, child, depth + 1); else await addFile(root, child);
    }
  };
  try {
    for (const entry of await readdir(scope.memoryRoot, { withFileTypes: true })) {
      const file = path.join(scope.memoryRoot, entry.name);
      if (!owners.includes(entry.name)) { preservedPaths.push(file); continue; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('A registered owner root was replaced by a link or file.');
      const marker = path.join(file, 'instance.json');
      try { await safeFile(scope.memoryRoot, marker); if ((await lstat(marker)).size > 256 * 1024) throw new Error('An owner marker exceeds its inspection budget.');
        const value = JSON.parse(await readFile(marker, 'utf8')) as { companionId?: string; id?: string; ownerId?: string };
        const marked = value.companionId ?? value.ownerId ?? value.id; if (marked && marked !== entry.name) throw new Error('An owner marker belongs to a different identity.');
      } catch (error) { if (!missing(error)) throw error; }
      await walk(scope.memoryRoot, file);
    }
  } catch (error) { if (!missing(error)) throw error; }
  for (const attachment of attachments) {
    if (!/^attachments\/[a-zA-Z0-9_-]{1,100}(?:\.[a-zA-Z0-9]{1,16})?$/u.test(attachment.path)) throw new Error('An attachment path is outside the managed attachment namespace.');
    try { await addFile(scope.dataRoot, path.join(scope.dataRoot, attachment.path)); } catch (error) { if (!missing(error)) throw error; }
  }
  // The removed allowance feature used exactly this one host file. Do not
  // broaden this into a data-root scan or a filename-pattern deletion.
  try { await addFile(scope.dataRoot, path.join(scope.dataRoot, '模型资源预算.json')); } catch (error) { if (!missing(error)) throw error; }
  const retainedAttachments = [];
  for (const attachment of playerAttachments) {
    if (!/^attachments\/[a-zA-Z0-9_-]{1,100}\.(?:png|jpg|jpeg|webp)$/iu.test(attachment.relativePath)) throw new Error('A human avatar is not in the managed image attachment namespace.');
    retainedAttachments.push({ ...attachment, file: await proof(scope.dataRoot, path.join(scope.dataRoot, attachment.relativePath)) });
  }
  playerProfile = validateRetainedPlayerProfile(playerProfile, retainedAttachments);
  const base = { schema: 'worldlinebox.development-companion-cleanup-v1' as const, ...scope, libraryId: options.libraryId, owners, tables, tablesPreservedUntilFileRemoval, metadataKeys, preservedMetadataKeys, keptAttachmentIds,
    retainedHostData: { schema: 'worldlinebox.retained-host-data-v3' as const, libraryPath: scope.libraryPath, libraryId: options.libraryId, dataRoot: scope.dataRoot,
      playerProfile, attachments: retainedAttachments },
    ledgerProof: await proof(scope.dataRoot, scope.ledgerPath), files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort((a, b) => b.length - a.length || a.localeCompare(b)), preservedPaths: preservedPaths.sort(), createdAt: new Date().toISOString() };
  return { ...base, planHash: planHash(base) };
}

/** Executes only a caller-reviewed hash. A durable phase receipt supports
 * finishing file deletion after a crash; it never restores old identities. */
export async function executeCompanionManagedCleanup(plan: CompanionManagedCleanupPlan, expectedHash: string, options: CompanionCleanupOptions): Promise<{ planHash: string; completed: true; deletedFiles: number; new_database_required: true; retainedHostDataPath: string }> {
  if (plan.schema !== 'worldlinebox.development-companion-cleanup-v1' || expectedHash !== plan.planHash || planHash(plan) !== expectedHash) throw new Error('Cleanup plan hash does not match the reviewed manifest.');
  const scope = await selection(options, false);
  if (scope.libraryPath !== plan.libraryPath || scope.ledgerPath !== plan.ledgerPath || scope.memoryRoot !== plan.memoryRoot || options.libraryId !== plan.libraryId) throw new Error('Cleanup plan belongs to another selected library.');
  const receiptRoot = path.join(scope.dataRoot, 'development-cleanup'); await mkdir(receiptRoot, { recursive: true }); await directory(receiptRoot);
  const receiptFile = path.join(receiptRoot, expectedHash + '.json');
  const retainedHostDataPath = path.join(receiptRoot, 'retained-host-data.json');
  let receipt: { schema: string; planHash: string; phase: 'prepared' | 'ledger_cleaned' | 'completed'; deletedFiles: string[] };
  try { await safeFile(receiptRoot, receiptFile); receipt = JSON.parse(await readFile(receiptFile, 'utf8')) as typeof receipt; }
  catch (error) { if (!missing(error)) throw error; receipt = { schema: plan.schema, planHash: expectedHash, phase: 'prepared', deletedFiles: [] };
    const current = await planCompanionManagedCleanup(options); if (current.planHash !== expectedHash) throw new Error('Library data changed after the cleanup plan was reviewed.', { cause: error });
    await writeFile(receiptFile, JSON.stringify(receipt), { flag: 'wx' }); }
  if (receipt.planHash !== expectedHash || receipt.schema !== plan.schema) throw new Error('Cleanup recovery receipt is invalid.');
  const result = () => ({ planHash: expectedHash, completed: true as const, deletedFiles: receipt.deletedFiles.length, new_database_required: true as const, retainedHostDataPath });
  if (receipt.phase === 'completed') return result();
  const retained = JSON.stringify({ ...plan.retainedHostData, cleanupPlanHash: expectedHash });
  try { await writeFile(retainedHostDataPath, retained, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await safeFile(receiptRoot, retainedHostDataPath);
    if (await readFile(retainedHostDataPath, 'utf8') !== retained) throw new Error('An earlier retained human-preference manifest differs; it must be reviewed before another development cleanup.', { cause: error }); }
  const save = async () => {
    await safeFile(receiptRoot, receiptFile); const temporary = receiptFile + '.next';
    try { await safeFile(receiptRoot, temporary); await unlink(temporary); } catch (error) { if (!missing(error)) throw error; }
    const handle = await open(temporary, 'wx'); try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
    await safeFile(receiptRoot, receiptFile); await safeFile(receiptRoot, temporary); await rename(temporary, receiptFile);
  };
  let ledgerExists = true; try { await lstat(scope.ledgerPath); } catch (error) { if (!missing(error)) throw error; ledgerExists = false; }
  if (!ledgerExists && receipt.phase !== 'ledger_cleaned') throw new Error('The original ledger vanished before its cleanup commit.');
  const db = ledgerExists ? options.openDatabase(scope.ledgerPath, false) : undefined;
  try { if (db) {
    db.exec('PRAGMA busy_timeout=0; PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN EXCLUSIVE');
    try {
      const currentOwners = db.prepare('SELECT id FROM companions ORDER BY id').all().map(row => String(object(row).id));
      if (receipt.phase === 'ledger_cleaned' && currentOwners.length || currentOwners.some(owner => !plan.owners.includes(owner))) throw new Error('New identities appeared after cleanup began; refusing to remove new data.');
      const committed = !!db.prepare('SELECT 1 FROM metadata WHERE key=? AND value=?').get('development-cleanup-commit/' + expectedHash, 'ledger_cleaned');
      const profiles = db.prepare('SELECT data FROM player_profile').all().map(row => JSON.parse(String(object(row).data)) as unknown);
      if (canonical(profiles[0] ?? null) !== canonical(plan.retainedHostData.playerProfile) || profiles.length > 1) throw new Error('The human profile changed after cleanup was planned.');
      if (receipt.phase === 'ledger_cleaned' && !committed) throw new Error('The cleanup commit marker is missing; refusing to remove a new or replacement database.');
      if (receipt.phase === 'prepared') {
        const currentLedger = await proof(scope.dataRoot, scope.ledgerPath);
        let walBytes = 0; try { walBytes = (await lstat(scope.ledgerPath + '-wal')).size; } catch (error) { if (!missing(error)) throw error; }
        const empty = plan.tables.every(table => table.mode === 'metadata' ? plan.metadataKeys.every(key => !db.prepare('SELECT 1 FROM metadata WHERE key=?').get(key))
          : table.mode === 'attachments' ? db.prepare('SELECT id FROM attachments').all().every(row => plan.keptAttachmentIds.includes(String(object(row).id)))
            : Number(object(db.prepare('SELECT COUNT(*) n FROM ' + quote(table.name)).get()).n) === 0);
        if ((canonical(currentLedger) !== canonical(plan.ledgerProof) || walBytes) && !(committed && empty)) throw new Error('The original ledger changed before the exclusive cleanup transaction.');
        const triggers = db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").all().filter(row => plan.tables.some(table => table.name === object(row).tbl_name));
        for (const trigger of triggers) db.exec('DROP TRIGGER ' + quote(String(object(trigger).name)));
        for (const table of [...plan.tables.filter(table => table.mode === 'fts'), ...plan.tables.filter(table => table.mode !== 'fts')]) {
          if (table.mode === 'metadata') { for (const key of plan.metadataKeys) db.prepare('DELETE FROM metadata WHERE key=?').run(key); }
          else if (table.mode === 'attachments') { for (const row of db.prepare('SELECT id FROM attachments').all()) if (!plan.keptAttachmentIds.includes(String(object(row).id))) db.prepare('DELETE FROM attachments WHERE id=?').run(object(row).id); }
          else if (table.mode === 'fts' && /content\s*=/iu.test(table.sql)) db.exec('INSERT INTO ' + quote(table.name) + '(' + quote(table.name) + ") VALUES('delete-all')");
          else db.exec('DELETE FROM ' + quote(table.name));
        }
        for (const trigger of triggers) db.exec(String(object(trigger).sql));
        db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('development-cleanup-commit/' + expectedHash, 'ledger_cleaned');
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Cleanup would leave references in preserved data.');
      db.exec('COMMIT'); receipt.phase = 'ledger_cleaned'; await save();
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* Already committed: the phase receipt handles retry. */ } throw error; }
    db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
  } } finally { db?.close(); }
  await unoccupied(scope.ledgerPath, scope.libraryDatabase);
  for (const file of plan.files) {
    const retiredPolicy = file.root === scope.dataRoot && file.path === path.join(scope.dataRoot, '模型资源预算.json');
    if (!inside(scope.memoryRoot, file.path) && !inside(path.join(scope.dataRoot, 'attachments'), file.path) && !retiredPolicy) throw new Error('Recovery manifest escaped the approved file roots.');
    if (receipt.deletedFiles.includes(file.path)) continue;
    try { const current = await proof(file.root, file.path); if (canonical(current) !== canonical(file)) throw new Error('A planned file changed; it will not be deleted: ' + file.path); await unlink(file.path); }
    catch (error) { if (!missing(error)) throw error; }
    receipt.deletedFiles.push(file.path); await save();
  }
  for (const folder of plan.directories) { if (!inside(scope.memoryRoot, folder)) throw new Error('Recovery folder escaped the memory root.');
    try { await directory(folder); await rmdir(folder); } catch (error) { if (!missing(error)) throw error; } }
  if (ledgerExists) {
    await requireLegacyUnenrolledNamespace(path.join(scope.libraryPath,'.worldlinebox'));
    await safeFile(scope.dataRoot, scope.ledgerPath); const current = await lstat(scope.ledgerPath);
    if (current.dev !== plan.ledgerProof.device || current.ino !== plan.ledgerProof.inode) throw new Error('The ledger file identity changed; refusing to remove a replacement database.');
    await unlink(scope.ledgerPath);
  }
  receipt.phase = 'completed'; await save(); return result();
}
