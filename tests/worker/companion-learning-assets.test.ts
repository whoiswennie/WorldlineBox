import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import { LibraryService } from '../../src/worker/library-service';
import { companionLearningAssets } from '../../src/main/companions/learning-assets';
import type { CompanionLearningGrant } from '../../src/shared/companion-learning';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';

const require = createRequire(import.meta.url);
interface Db { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void }
const Sqlite = require('better-sqlite3') as new (file: string) => Db;
const roots: string[] = [], services: LibraryService[] = [], databases: Db[] = [], links: string[] = [];
afterEach(() => {
  databases.splice(0).forEach(db => db.close()); services.splice(0).forEach(service => service.closeAll());
  // Unlink only our known junctions before recursive cleanup. Never follow a
  // reparse point to another root or shared runtime during fixture cleanup.
  for (const link of links.splice(0)) { try { unlinkSync(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  for (const root of roots.splice(0)) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-learning-assets-')) throw new Error('Unexpected learning fixture root.'); removeOwnedDirectorySync(root); }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-assets-')); roots.push(root);
  const service = new LibraryService(); services.push(service);
  const library = service.createLibrary({ displayName: '授权资料库', selectedParentPath: root });
  const folder = service.createManagedFolder({ libraryId: library.libraryId, name: 'Books' });
  const outside = service.createManagedFolder({ libraryId: library.libraryId, name: 'Books-extra' });
  const db = new Sqlite(path.join(library.libraryPath, '.worldlinebox/library.db')); databases.push(db);
  const add = (name: string, content: string | Buffer, target = folder) => {
    const assetId = randomUUID(), revisionId = randomUUID(), bytes = typeof content === 'string' ? Buffer.from(content) : content;
    const relative = target.relativePath + '/' + name, at = new Date().toISOString();
    db.prepare("INSERT INTO assets(asset_id,location_kind,managed_folder_id,linked_folder_id,relative_file_path,current_revision_id,availability,path_identity,created_at,updated_at) VALUES(?,'managed',?,NULL,?,NULL,'available',?,?,?)")
      .run(assetId, target.folderId, relative, relative, at, at);
    db.prepare("INSERT INTO revisions(revision_id,asset_id,parent_revision_id,byte_size,modified_at,original_filename,origin,accepted_at) VALUES(?,?,NULL,?,?,?,'import',?)")
      .run(revisionId, assetId, bytes.length, at, name, at);
    db.prepare('UPDATE assets SET current_revision_id=? WHERE asset_id=?').run(revisionId, assetId);
    const file = service.resolveAssetPath(library.libraryId, assetId); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes);
    return service.listAssets({ libraryId: library.libraryId, recursive: true, assetIds: [assetId] })[0]!;
  };
  const request = async (command: WorkerCommand): Promise<WorkerResult> => {
    switch (command.type) {
      case 'library.list': return { ok: true, type: 'library.list', libraries: service.listLibraries() };
      case 'folder.list': return { ok: true, type: 'folder.list', folders: service.listManagedFolders(command.libraryId) };
      case 'linked-folder.list': return { ok: true, type: 'linked-folder.list', folders: service.listLinkedFolders(command.libraryId) };
      case 'asset.learning.page': return { ok: true, type: 'asset.learning.page', ...service.listLearningAssets(command) };
      case 'media.get-asset-path': return { ok: true, type: 'media.asset-path', assetId: command.assetId, absolutePath: service.resolveAssetPath(command.libraryId, command.assetId) };
      default: throw new Error('Unexpected learning request: ' + command.type);
    }
  };
  const grant: CompanionLearningGrant = { id: 'grant_one', companionId: 'alice', libraryId: library.libraryId, libraryName: library.displayName,
    libraryPath: library.libraryPath, folderId: folder.folderId, enabled: true, autonomous: false, intervalMinutes: 30, revision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', reads: 0 };
  const make = (invoke = request, memoryRoot = path.join(root, 'memory-runtime')) => companionLearningAssets({ request: invoke, memoryRoot });
  return { root, service, library, folder, outside, db, add, request, grant, make };
}

it('enumerates a granted subtree in bounded stable pages without leaking a similarly named sibling', async () => {
  const f = fixture(), child = f.service.createManagedFolder({ libraryId: f.library.libraryId, name: 'Child', parentFolderId: f.folder.folderId });
  const ids = Array.from({ length: 70 }, (_, index) => f.add(index + '.md', '真实资料 ' + index, index % 2 ? child : f.folder).assetId).sort();
  const outsider = f.add('不能读取.md', '未授权的另一目录。', f.outside);
  const reader = f.make(); const first = await reader.page(f.grant), second = await reader.page(f.grant, first.nextCursor), third = await reader.page(f.grant, second.nextCursor);
  expect([first.assets.length, second.assets.length, third.assets.length]).toEqual([32, 32, 6]);
  expect([...first.assets, ...second.assets, ...third.assets].map(asset => asset.assetId)).toEqual(ids);
  expect(third.hasMore).toBe(false); await expect(reader.read(f.grant, outsider)).rejects.toMatchObject({ code: 'source-moved' });
  for (let index = 0; index < 60; index++) f.add('extra-' + index + '.md', '更多真实资料。');
  const clamped = f.service.listLearningAssets({ libraryId: f.library.libraryId, folderId: f.folder.folderId, limit: 999 });
  expect(clamped.assets).toHaveLength(128); expect(clamped.hasMore).toBe(true);
});

it('reads complete UTF-8 and BOM UTF-16 text with immutable byte hashes while treating oversized sources as unread', async () => {
  const f = fixture(), reader = f.make(), text = '真实中文资料与多语 🌱';
  const utf8 = f.add('utf8.md', text), utf16 = f.add('utf16.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]));
  const first = await reader.read(f.grant, utf8), second = await reader.read(f.grant, utf16);
  expect(first.content).toBe(text); expect(second.content).toBe(text);
  expect(first.revisionId).toMatch(new RegExp('^' + utf8.currentRevisionId + '_[a-f0-9]{20}$'));
  expect(first.revisionId).not.toBe(second.revisionId);
  const large = f.add('large.md', Buffer.alloc(2097153, 65)); expect(await reader.read(f.grant, large)).toMatchObject({ content: '', truncated: true });
});

it('rejects invalid encodings and binary files without inventing readable text', async () => {
  const f = fixture(), reader = f.make();
  await expect(reader.read(f.grant, f.add('invalid.md', Buffer.from([255, 255])))).rejects.toMatchObject({ code: 'unsupported-text' });
  await expect(reader.read(f.grant, f.add('binary.md', Buffer.from([65, 0, 66])))).rejects.toMatchObject({ code: 'unsupported-text' });
});

it('rechecks directory membership after reading before permitting any receipt', async () => {
  const f = fixture(), item = f.add('moving.md', '读取期间被移出授权目录。'); let checks = 0;
  const reader = f.make(async command => {
    if (command.type === 'asset.learning.page' && command.assetId === item.assetId && ++checks === 2)
      f.db.prepare('UPDATE assets SET managed_folder_id=?,relative_file_path=? WHERE asset_id=?').run(f.outside.folderId, f.outside.relativePath + '/moving.md', item.assetId);
    return f.request(command);
  });
  await expect(reader.read(f.grant, item)).rejects.toMatchObject({ code: 'source-moved' }); expect(checks).toBe(2);
});

it('refuses private memory and application paths even with a whole-library grant or a canonical alias', async () => {
  const f = fixture(), item = f.add('ordinary.md', '普通资料。');
  const privateRoot = path.join(f.root, 'private-runtime'), alias = path.join(f.root, 'runtime-alias');
  mkdirSync(privateRoot); writeFileSync(path.join(privateRoot, 'secrets.md'), 'PRIVATE_OWNER_DIARY');
  symlinkSync(privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); links.push(alias);
  const reader = f.make(async command => command.type === 'media.get-asset-path'
    ? { ok: true, type: 'media.asset-path', assetId: command.assetId, absolutePath: path.join(privateRoot, 'secrets.md') } : f.request(command), alias);
  await expect(reader.read({ ...f.grant, folderId: undefined }, item)).rejects.toMatchObject({ code: 'private-source' });
  const application = path.join(f.root, '.WORLDLINEBOX'); mkdirSync(application); writeFileSync(path.join(application, 'secrets.md'), 'PRIVATE_APPLICATION');
  const appReader = f.make(async command => command.type === 'media.get-asset-path'
    ? { ok: true, type: 'media.asset-path', assetId: command.assetId, absolutePath: path.join(application, 'secrets.md') } : f.request(command));
  await expect(appReader.read(f.grant, item)).rejects.toMatchObject({ code: 'private-source' });
});

it('does not offer private managed notebook directories as grant targets', async () => {
  const f = fixture(), root = f.service.createManagedFolder({ libraryId: f.library.libraryId, name: '笔记' });
  f.service.createManagedFolder({ libraryId: f.library.libraryId, name: '伙伴记忆', parentFolderId: root.folderId });
  const catalog = await f.make().catalog();
  expect(catalog[0]!.folders.some(folder => folder.name.includes('伙伴记忆'))).toBe(false);
});

it('refuses owner historical revisions under a whole-library grant instead of recursively learning its own history', async () => {
  const f = fixture(), item = f.add('ordinary-history-candidate.md', '普通授权资料。');
  const folder = path.join(f.library.libraryPath, '伙伴记忆', 'alice', '记忆历史', 'note-one'); mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'r1-history.md'); writeFileSync(file, 'PRIVATE_HISTORICAL_BODY_MUST_NOT_BECOME_A_NEW_LEARNING_SOURCE');
  const reader = f.make(async command => command.type === 'media.get-asset-path'
    ? { ok: true, type: 'media.asset-path', assetId: command.assetId, absolutePath: file } : f.request(command));
  await expect(reader.read({ ...f.grant, folderId: undefined }, item)).rejects.toMatchObject({ code: 'private-source' });
});
