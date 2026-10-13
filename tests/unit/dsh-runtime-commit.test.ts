import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { path7za } from '7zip-bin';
import * as koffi from 'koffi';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import { publishSealedArtifact, retryFileOperation } from '../../src/main/dsh/runtime-commit';
import { RuntimeService, runTool } from '../../src/main/dsh/runtime-service';
import type { OperationContext } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function temporary() { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-commit-')); roots.push(root); return root; }
const busy = () => Object.assign(new Error('sharing violation'), { code: 'EPERM' });

function holdFile(file: string, shareRead: boolean): () => void {
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, uintptr_t security, uint32_t creation, uint32_t flags, uintptr_t template)');
  const close = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
  const handle = create(file, 0x80000000, shareRead ? 1 : 0, 0, 3, 0x80, 0);
  if (handle === 0n || handle === 0 || handle === 0xffffffffffffffffn) throw new Error('Could not open the controlled Windows file lock.');
  let released = false;
  return () => { if (!released) { released = true; if (!close(handle)) throw new Error('Could not close the controlled Windows file lock.'); } };
}

async function artifact(root: string) {
  const source = path.join(root, 'artifact'); await mkdir(path.join(source, 'program'), { recursive: true });
  await writeFile(path.join(source, 'program', 'fixture.exe'), 'unchanged payload');
  const seal = await inventoryTree(path.join(source, 'program'));
  await writeFile(path.join(source, 'seal.json'), JSON.stringify(seal));
  await writeFile(path.join(source, 'artifact.json'), '{"ready":true}');
  return { source, destination: path.join(root, 'published'), seal };
}

describe('bounded runtime file commits', () => {
  it('retries Windows sharing errors but stops at its bound and preserves permanent errors', async () => {
    let attempts = 0;
    await expect(retryFileOperation(async () => { if (++attempts < 3) throw busy(); return 'done'; }, { platform: 'win32', delays: [1, 1] })).resolves.toBe('done');
    expect(attempts).toBe(3);
    const failure = busy(); attempts = 0;
    await expect(retryFileOperation(async () => { attempts++; throw failure; }, { platform: 'win32', delays: [1, 1] })).rejects.toBe(failure);
    expect(attempts).toBe(3);
    for (const code of ['EINVAL', 'EIO', 'ENOENT', 'EEXIST']) {
      attempts = 0; const fatal = Object.assign(new Error(code), { code });
      await expect(retryFileOperation(async () => { attempts++; throw fatal; }, { platform: 'win32', delays: [1, 1] })).rejects.toBe(fatal);
      expect(attempts).toBe(1);
    }
  });

  it('cancels a pending sharing retry before another filesystem attempt', async () => {
    const controller = new AbortController(); let attempts = 0;
    const work = retryFileOperation(async () => { attempts++; throw busy(); }, { platform: 'win32', delays: [10_000], signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 10)); controller.abort();
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempts).toBe(1);
    await expect(retryFileOperation(async () => { throw busy(); }, { platform: 'linux', delays: [1, 1] })).rejects.toMatchObject({ code: 'EPERM' });
  });
});

describe.skipIf(process.platform !== 'win32')('Windows native file sharing during runtime publication', () => {
  it('waits for a short executable lock and commits by rename without changing bytes', async () => {
    const { source, destination, seal } = await artifact(await temporary());
    const release = holdFile(path.join(source, 'program', 'fixture.exe'), true);
    const timer = setTimeout(release, 175);
    let copies = 0;
    try {
      expect(await publishSealedArtifact(source, destination, { verifyCopy: async () => { copies++; } })).toBe('renamed');
      expect(copies).toBe(0);
      expect(await inventoryTree(path.join(destination, 'program'))).toEqual(seal);
    } finally { clearTimeout(timer); release(); }
  });

  it('verifies a complete physical copy before adding ready metadata when a readable lock persists', async () => {
    const { source, destination, seal } = await artifact(await temporary());
    const release = holdFile(path.join(source, 'program', 'fixture.exe'), true);
    let verified = false;
    try {
      const result = await publishSealedArtifact(source, destination, { verifyCopy: async directory => {
        expect(await readdir(directory)).toEqual(['program']);
        expect(await inventoryTree(path.join(directory, 'program'))).toEqual(seal); verified = true;
      } });
      expect(result).toBe('copied'); expect(verified).toBe(true);
      expect(await readFile(path.join(destination, 'artifact.json'), 'utf8')).toBe('{"ready":true}');
      expect(await inventoryTree(path.join(source, 'program'))).toEqual(seal);
    } finally { release(); }
  });

  it('retains a sealed failed installer, keeps the index empty and safely resumes after the lock is released', async () => {
    const root = await temporary(); const input = path.join(root, 'input'); const packageRoot = path.join(root, 'package');
    const host = path.join(packageRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host');
    await mkdir(path.join(host, 'lib'), { recursive: true });
    await mkdir(path.join(packageRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true });
    await mkdir(path.join(input, 'resources'), { recursive: true });
    await writeFile(path.join(input, 'DeepSeek Harness.exe'), 'fixture executable');
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.0-rc.2' }));
    await writeFile(path.join(packageRoot, 'dsh', 'desktop-runtime.json'), JSON.stringify({ platform: 'win32', arch: 'x64' }));
    await writeFile(path.join(host, 'package.json'), JSON.stringify({ version: '0.2.0-rc.2' }));
    await writeFile(path.join(host, 'lib', 'cli.js'), '// fixture');
    await writeFile(path.join(packageRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '{}');
    await createPackage(packageRoot, path.join(input, 'resources', 'app.asar'));
    const installer = path.join(root, 'fixture.exe');
    await runTool(path7za, ['a', '-t7z', installer, path.join(input, '*')]);
    const manager = path.join(root, 'manager'); const logs: string[] = [];
    const service = new RuntimeService({ rootPath: manager, sevenZipPath: path7za, onChanged: () => undefined }); await service.init();
    let release: (() => void) | undefined; let lockEnabled = true;
    const operation: OperationContext = { id: 'controlled-commit', signal: new AbortController().signal,
      log: async line => { logs.push(line); }, update: async phase => {
        if (phase !== 'committing' || !lockEnabled) return;
        const stage = (await readdir(path.join(manager, 'staging')))[0]!;
        release = holdFile(path.join(manager, 'staging', stage, 'artifact', 'program', 'DeepSeek Harness.exe'), false);
      } };
    try {
      await expect(service.import(installer, 'installer', 'fixture', operation)).rejects.toBeTruthy();
      expect(service.list()).toEqual([]);
      expect(JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8'))).toEqual([]);
      const stage = (await readdir(path.join(manager, 'staging')))[0]!;
      expect(JSON.parse(await readFile(path.join(manager, 'staging', stage, 'artifact', 'artifact.json'), 'utf8'))).toMatchObject({ version: '0.2.0-rc.2' });
    } finally { release?.(); lockEnabled = false; }
    const restored = await service.import(installer, 'installer', 'fixture', operation);
    await service.verify(restored.id);
    expect(logs.some(line => line.includes('without downloading or extracting again'))).toBe(true);
    expect(await readdir(path.join(manager, 'staging'))).toEqual([]);
    expect((await readdir(path.join(manager, 'quarantine'))).length).toBe(1);
    expect((await inventoryTree(input)).fileCount).toBe(2);
  });
});
