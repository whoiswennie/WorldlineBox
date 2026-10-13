import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { path7za } from '7zip-bin';
import { afterEach, describe, expect, it } from 'vitest';
import { hashFile, removeManaged } from '../../src/main/dsh/files';
import { RuntimeService, runTool, validate7zListing } from '../../src/main/dsh/runtime-service';
import type { OperationContext } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function createService() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-official-installer-')); roots.push(root);
  const service = new RuntimeService({ rootPath: root, sevenZipPath: path7za, onChanged: () => undefined }); await service.init();
  const operation: OperationContext = { id: 'official-installer-validation', signal: new AbortController().signal, update: async () => undefined, log: async () => undefined };
  return { root, service, operation };
}

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_INSTALLER)('official Windows SFX installer', () => {
  it('uses the shipped 7zip-bin binary to list, extract, seal and reopen the official installer', async () => {
    const installer = process.env.WORLDLINEBOX_DSH_REAL_INSTALLER!;
    const listing = await runTool(path7za, ['l', '-slt', installer]);
    validate7zListing(listing);
    expect(listing).toContain('Path = resources\\app.asar');
    const { root, service, operation } = await createService();
    const runtime = await service.import(installer, 'installer', installer, operation);
    expect(runtime.version).toBe('0.2.0-rc.2');
    expect(runtime.nodeVersion).toBe('24.18.1');
    expect(runtime.sourceSha256).toBe(await hashFile(installer));
    expect(runtime.fileCount).toBeGreaterThan(9_000);
    await service.verify(runtime.id);
    expect((await readFile(path.join(service.directory(runtime.id), 'version'), 'utf8')).trim()).toBe('44.0.0');
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
    const restored = new RuntimeService({ rootPath: root, sevenZipPath: path7za, onChanged: () => undefined });
    await restored.init(); expect(restored.list()).toEqual([runtime]); await restored.verify(runtime.id);
  }, 180_000);
});

describe.skipIf(process.platform !== 'win32' || process.env.WORLDLINEBOX_DSH_REAL_DOWNLOAD !== '1')('official Windows network download', () => {
  it('downloads from the real HTTPS endpoint and imports the official payload without running the installer', async () => {
    const { root, service, operation } = await createService();
    const runtime = await service.download(operation);
    expect(runtime.version).toBe('0.2.0-rc.2');
    expect(runtime.source).toBe('https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe');
    await service.verify(runtime.id);
    expect(await hashFile(path.join(root, 'cache', `${runtime.sourceSha256}.exe`))).toBe(runtime.sourceSha256);
    expect(await readdir(path.join(root, 'staging'))).toEqual([]);
  }, 300_000);
});
