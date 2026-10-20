import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryParent = await realpath(tmpdir());
const root = await mkdtemp(path.join(temporaryParent, 'worldlinebox-tools-reproduction-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, windowsHide: true, shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Tool reproduction failed: ${script} (${signal ?? code}).`)));
  });
}
async function cleanup() {
  const resolved = await realpath(root);
  if (path.dirname(resolved) !== temporaryParent || !path.basename(resolved).startsWith('worldlinebox-tools-reproduction-')) throw new Error('Unexpected tool reproduction cleanup path.');
  await rm(resolved, { recursive: true, force: true });
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Tool reproduction targets Windows x64.');
  // Only tracked build instructions and the locked npm extraction libraries are
  // copied. No existing portable executable tree enters this clean workspace.
  for (const file of [
    'scripts/acquire-portable-tools.mjs', 'scripts/portable-tools.mjs', 'scripts/publish-portable-tools.mjs',
    'resources/portable-tools/tool-lock.json', 'resources/portable-tools/download-lock.json',
    'resources/portable-tools/manifests/win32-x64.json',
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(project, file), path.join(root, file));
  }
  for (const dependency of ['adm-zip', '7zip-bin']) {
    await cp(path.join(project, 'node_modules', dependency), path.join(root, 'node_modules', dependency), { recursive: true });
  }
  const downloads = JSON.parse(await readFile(path.join(root, 'resources/portable-tools/download-lock.json'), 'utf8'));
  await mkdir(path.join(root, '.tools/portable-downloads'), { recursive: true });
  for (const name of Object.keys(downloads.archives)) {
    await copyFile(path.join(project, '.tools/portable-downloads', `${name}.archive`), path.join(root, '.tools/portable-downloads', `${name}.archive`))
      .catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await run('scripts/acquire-portable-tools.mjs');
  // The default command checks every file and actually runs all tool versions.
  await run('scripts/portable-tools.mjs');
  const expectedLock = await readFile(path.join(project, 'resources/portable-tools/tool-lock.json'));
  const actualLock = await readFile(path.join(root, 'resources/portable-tools/tool-lock.json'));
  if (!actualLock.equals(expectedLock)) throw new Error('Clean reproduction changed the committed tool lock.');
  const manifest = await readFile(path.join(root, 'resources/portable-tools/win32-x64/manifest.json'));
  const approved = JSON.parse(expectedLock.toString('utf8'));
  if (hash(manifest) !== approved.manifestSha256) throw new Error('Clean reproduction differs from the reviewed manifest.');
  console.log(JSON.stringify({ cleanToolDirectory: true, existingPortableTreeCopied: false, extractionDependencies: 'locked npm libraries',
    archiveChecksumsVerified: true, toolLockUnchanged: true, manifestSha256: hash(manifest), files: JSON.parse(manifest.toString('utf8')).files.length }));
} finally {
  await cleanup();
}
