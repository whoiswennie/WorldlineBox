import { app } from 'electron';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as koffi from 'koffi';
import { mkdir, readdir, rename, readFile } from '../../src/main/dsh/disk';
import { hashFile } from '../../src/main/dsh/files';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import type { OperationContext } from '../../src/main/dsh/operations';

const [root, installer, sevenZip] = process.argv.slice(2);
if (!root || !installer || !sevenZip) throw new Error('Expected private probe root, cached installer and 7za.');
app.setPath('userData', path.join(root, 'electron-user-data'));
app.disableHardwareAcceleration();
const kernel = koffi.load('kernel32.dll');
const openFile = kernel.func('uintptr_t __stdcall CreateFileW(str16 name, uint32_t access, uint32_t share, uintptr_t security, uint32_t creation, uint32_t flags, uintptr_t template)');
const closeFile = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
function holdFile(file: string, shareRead: boolean): () => void {
  const handle = openFile(file, 0x80000000, shareRead ? 1 : 0, 0, 3, 0x80, 0);
  assert(handle !== 0 && handle !== 0n && handle !== 0xffffffffffffffffn, 'The native test lock must be acquired.');
  let closed = false;
  return () => { if (!closed) { assert(closeFile(handle)); closed = true; } };
}

async function testCase(name: string, mode: 'short' | 'readable' | 'exclusive') {
  const manager = path.join(root!, 'workspace-depth', 'dev-user-data', 'dsh-launcher', name);
  const service = new RuntimeService({ rootPath: manager, sevenZipPath: sevenZip!, onChanged: () => undefined });
  await service.init(); const logs: string[] = []; let release: (() => void) | undefined;
  let enabled = true; let nativeRenameCode = ''; let timer: ReturnType<typeof setTimeout> | undefined;
  const operation: OperationContext = { id: `electron-${name}`, signal: new AbortController().signal,
    log: async text => { logs.push(text); }, update: async phase => {
      if (phase !== 'committing' || !enabled) return;
      const stage = (await readdir(path.join(manager, 'staging')))[0]!;
      const artifact = path.join(manager, 'staging', stage, 'artifact');
      release = holdFile(path.join(artifact, 'program', 'DeepSeek Harness.exe'), mode !== 'exclusive');
      // Reproduce the exact original failure using a real Windows handle,
      // rather than injecting a rejected JavaScript promise.
      try { await rename(artifact, `${artifact}-native-lock-probe`); throw new Error('The controlled no-share-delete handle did not block rename.'); }
      catch (error) { nativeRenameCode = (error as NodeJS.ErrnoException).code ?? ''; assert.equal(nativeRenameCode, 'EPERM'); }
      if (mode === 'short') timer = setTimeout(() => release?.(), 250);
    } };
  const started = Date.now(); let runtime;
  try {
    if (mode === 'exclusive') {
      await assert.rejects(service.import(installer!, 'installer', 'official-cached-probe', operation));
      assert.deepEqual(service.list(), []);
      assert.deepEqual(JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8')), []);
      const stage = (await readdir(path.join(manager, 'staging')))[0]!;
      const prepared = JSON.parse(await readFile(path.join(manager, 'staging', stage, 'artifact', 'artifact.json'), 'utf8'));
      assert.equal(prepared.version, '0.2.0-rc.2');
      release?.(); enabled = false;
      runtime = await service.import(installer!, 'installer', 'official-cached-probe', operation);
      assert(logs.some(line => line.includes('without downloading or extracting again')));
      assert.equal((await readdir(path.join(manager, 'quarantine'))).length, 1);
    } else runtime = await service.import(installer!, 'installer', 'official-cached-probe', operation);
  } finally { if (timer) clearTimeout(timer); release?.(); }
  assert.equal(runtime.version, '0.2.0-rc.2'); assert(runtime.fileCount > 9000);
  await service.verify(runtime.id);
  const reopened = new RuntimeService({ rootPath: manager, sevenZipPath: sevenZip!, onChanged: () => undefined });
  await reopened.init(); assert.deepEqual(reopened.list(), service.list()); await reopened.verify(runtime.id);
  const usedCopy = logs.some(line => line.includes('copying and verifying all bytes'));
  if (mode === 'readable') assert(usedCopy);
  if (mode === 'short') assert(!usedCopy);
  const result = { name, mode, nativeRenameCode, version: runtime.version, files: runtime.fileCount, usedCopy, elapsedMs: Date.now() - started };
  console.log(`DSH_COMMIT_CASE ${JSON.stringify(result)}`);
  return result;
}

app.whenReady().then(async () => {
  await mkdir(root!, { recursive: true });
  const before = await hashFile(installer!);
  const cases = [await testCase('short-lock', 'short'), await testCase('readable-lock', 'readable'), await testCase('exclusive-lock', 'exclusive')];
  assert.equal(await hashFile(installer!), before, 'The cached official installer must stay byte-identical.');
  console.log(`DSH_COMMIT_RESULT ${JSON.stringify({ electron: process.versions.electron, cachedSha256: before, cases })}`);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
