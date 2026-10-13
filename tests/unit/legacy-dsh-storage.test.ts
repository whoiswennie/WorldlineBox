import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPackage } from '@electron/asar';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrateLegacyDshStorage } from '../../src/main/legacy-dsh-storage';
import * as managedFiles from '../../src/main/dsh/files';
import { readFile as physicalReadFile, realpath as physicalRealpath, rm as physicalRm } from '../../src/main/dsh/disk';

const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const temporaryDirectory = await physicalRealpath(tmpdir());
  for (const root of temporaryRoots.splice(0)) {
    if (path.dirname(path.resolve(root)) === temporaryDirectory && path.basename(root).startsWith('worldlinebox-legacy-dsh-')) await physicalRm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(await physicalRealpath(tmpdir()), 'worldlinebox-legacy-dsh-'));
  temporaryRoots.push(root);
  const projectRoot = path.join(root, 'project');
  const userDataPath = path.join(root, 'user-profile', 'WorldlineBox');
  const legacyProfile = path.join(projectRoot, '.tools', 'dev-user-data');
  const source = path.join(legacyProfile, 'dsh-launcher');
  const target = path.join(userDataPath, 'dsh-launcher');
  await mkdir(path.join(source, 'cache'), { recursive: true });
  await mkdir(path.join(source, 'operations'));
  await mkdir(path.join(userDataPath, 'Worlds'), { recursive: true });
  await writeFile(path.join(userDataPath, 'Worlds', 'existing.json'), 'existing world data');
  await writeFile(path.join(legacyProfile, 'Preferences'), 'old Chromium preferences');
  await writeFile(path.join(userDataPath, 'Preferences'), 'current Chromium preferences');
  for (const name of ['instances', 'runtimes', 'snapshots', 'packs']) {
    await mkdir(path.join(source, name));
    await writeFile(path.join(source, `${name}.json`), '[]');
  }
  await writeFile(path.join(source, 'operations', 'operations.json'), '[{"status":"failed","error":"old download failed"}]');
  await writeFile(path.join(source, 'cache', 'installer.exe'), Buffer.alloc(64 * 1024, 7));
  return { root, projectRoot, userDataPath, legacyProfile, source, target };
}

describe('safe relocation of legacy empty DSH stores', () => {
  it('copies the installer and raw ASAR bytes, verifies the store and preserves both profiles', async () => {
    const data = await fixture();
    const asarSource = path.join(data.root, 'asar-input');
    await mkdir(asarSource);
    await writeFile(path.join(asarSource, 'package.json'), '{"name":"physical-archive-fixture"}');
    const archive = path.join(data.source, 'cache', 'fixture.asar');
    await createPackage(asarSource, archive);
    const before = await managedFiles.inventoryTree(data.source);
    const migrated = await migrateLegacyDshStorage(data);
    expect(migrated.status).toBe('migrated');
    expect(migrated.fileCount).toBe(before.fileCount);
    expect(migrated.byteLength).toBe(before.byteLength);
    expect((await managedFiles.inventoryTree(data.target)).contentSha256).toBe(before.contentSha256);
    expect((await managedFiles.inventoryTree(data.source)).contentSha256).toBe(before.contentSha256);
    expect(await physicalReadFile(path.join(data.target, 'cache', 'fixture.asar'))).toEqual(await physicalReadFile(archive));
    expect(await readFile(path.join(data.userDataPath, 'Preferences'), 'utf8')).toBe('current Chromium preferences');
    expect(await readFile(path.join(data.legacyProfile, 'Preferences'), 'utf8')).toBe('old Chromium preferences');
    expect(await readFile(path.join(data.userDataPath, 'Worlds', 'existing.json'), 'utf8')).toBe('existing world data');
    expect((await migrateLegacyDshStorage(data)).status).toBe('target-exists');
  });

  it('never merges into or overwrites an existing shared DSH directory', async () => {
    const data = await fixture();
    await mkdir(data.target);
    await writeFile(path.join(data.target, 'instances.json'), '[{"name":"existing instance"}]');
    const before = await managedFiles.inventoryTree(data.target);
    expect((await migrateLegacyDshStorage(data)).status).toBe('target-exists');
    expect((await managedFiles.inventoryTree(data.target)).contentSha256).toBe(before.contentSha256);
  });

  it('preserves old operational paths and requests backup import when instances exist', async () => {
    const data = await fixture();
    const instance = { name: 'Do not rebase by text replacement', homePath: path.join(data.source, 'instances', 'one', 'home') };
    await writeFile(path.join(data.source, 'instances.json'), JSON.stringify([instance]));
    const result = await migrateLegacyDshStorage(data);
    expect(result.status).toBe('needs-backup-import');
    expect(result.message).toContain('backups');
    expect(JSON.parse(await readFile(path.join(data.source, 'instances.json'), 'utf8'))).toEqual([instance]);
    await expect(readFile(path.join(data.target, 'instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses active old processes or operations and unregistered environment data', async () => {
    const data = await fixture();
    expect((await migrateLegacyDshStorage({ ...data, sourceInUse: true })).status).toBe('source-in-use');
    await writeFile(path.join(data.source, 'operations', 'operations.json'), '[{"status":"running"}]');
    expect((await migrateLegacyDshStorage(data)).status).toBe('source-in-use');
    await writeFile(path.join(data.source, 'operations', 'operations.json'), '[{"status":"queued"}]');
    expect((await migrateLegacyDshStorage(data)).status).toBe('source-in-use');
    await writeFile(path.join(data.source, 'operations', 'operations.json'), '[]');
    await writeFile(path.join(data.source, 'instances', 'orphaned-session'), 'retained');
    expect((await migrateLegacyDshStorage(data)).status).toBe('needs-backup-import');
  });

  it('does not publish incomplete downloads or unpublished staging programs', async () => {
    const data = await fixture();
    const pending = path.join(data.source, 'cache', 'operation.download');
    await writeFile(pending, 'incomplete transfer');
    expect((await migrateLegacyDshStorage(data)).status).toBe('source-in-use');
    await rm(pending);
    await mkdir(path.join(data.source, 'staging'));
    await writeFile(path.join(data.source, 'staging', 'uncommitted-program'), 'still extracting');
    expect((await migrateLegacyDshStorage(data)).status).toBe('source-in-use');
    await expect(readFile(path.join(data.target, 'instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a downloaded installer whose digest no longer matches its cache identity', async () => {
    const data = await fixture();
    await writeFile(path.join(data.source, 'cache', `${'0'.repeat(64)}.exe`), 'changed after download');
    const result = await migrateLegacyDshStorage(data);
    expect(result.status).toBe('unsafe');
    expect(result.message).toContain('SHA-256');
    await expect(readFile(path.join(data.target, 'instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects relative, overlapping and linked source paths without publishing data', async () => {
    const data = await fixture();
    expect((await migrateLegacyDshStorage({ ...data, userDataPath: 'relative' })).status).toBe('unsafe');
    expect((await migrateLegacyDshStorage({ ...data, userDataPath: data.source })).status).toBe('unsafe');
    const linked = path.join(data.root, 'linked-profile');
    await symlink(data.legacyProfile, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await migrateLegacyDshStorage({ ...data, legacyUserDataPath: linked })).status).toBe('unsafe');
    await symlink(path.join(data.source, 'cache'), path.join(data.source, 'linked-cache'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await migrateLegacyDshStorage(data)).status).toBe('unsafe');
    await expect(readFile(path.join(data.target, 'instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the destination uncommitted when the old store changes during copying', async () => {
    const data = await fixture();
    const copy = managedFiles.copyTree;
    vi.spyOn(managedFiles, 'copyTree').mockImplementation(async (...args) => {
      await copy(...args);
      await writeFile(path.join(data.source, 'cache', 'installer.exe'), 'changed by old process');
    });
    const result = await migrateLegacyDshStorage(data);
    expect(result.status).toBe('unsafe');
    expect(result.message).toContain('changed during copying');
    await expect(readFile(path.join(data.target, 'instances.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(data.source, 'cache', 'installer.exe'), 'utf8')).toBe('changed by old process');
  });
});
