import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile), sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const sourceExtension = /\.(?:[cm]?[jt]sx?|json|css|html|svg)$/iu;
type Entry = { path: string; bytes: number; sha256: string };
type CopyEntry = Entry & { frozenPath: string };
export interface FrozenMemorySoakManifest {
  schema: 'worldlinebox.memory-soak-implementation-v1'; capturedAt: string; repositoryRoot: string;
  git: { head: string | null; dirty: boolean; status: string };
  sources: Entry[]; hostCjs: CopyEntry[]; vendor: CopyEntry[];
  vendorManifests: Array<{ path: string; sha256: string; repository?: string; commit?: string; listedFiles: number }>;
  dependencies: { kind: 'pinned_shared_npm'; nodeModules: string; packageLockSha256: string;
    node: string; electron?: string; packages: Array<{ name: string; version: string; packageJsonSha256: string; packageJsonPath: string }> };
  loadedImplementation: Record<string, string>;
}
async function files(root: string, accept: (relative: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, relative: string) => {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(directory, item.name), key = relative ? relative + '/' + item.name : item.name, info = await lstat(child);
      if (info.isSymbolicLink()) throw new Error('Implementation snapshot refuses directory/file links: ' + child);
      if (info.isDirectory()) await visit(child, key);
      else if (info.isFile() && accept(key)) found.push(key);
    }
  };
  await visit(root, ''); return found.sort();
}
async function stableBytes(file: string): Promise<Buffer> {
  const before = await lstat(file), bytes = await readFile(file), after = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) throw new Error('Implementation changed while capturing: ' + file);
  return bytes;
}
async function mapBounded<T, V>(values: T[], work: (value: T) => Promise<V>): Promise<V[]> {
  const output = new Array<V>(values.length); let cursor = 0;
  let stopped = false;
  const settled = await Promise.allSettled(Array.from({ length: Math.min(8, values.length) }, async () => {
    for (;;) { const index = cursor++; if (stopped || index >= values.length) return;
      try { output[index] = await work(values[index]!); } catch (error) { stopped = true; throw error; } }
  }));
  const failed = settled.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  return output;
}
async function sourcePaths(repository: string): Promise<string[]> {
  const tree = (await Promise.all(['src', 'tests', 'scripts'].map(async folder => (await files(path.join(repository, folder), relative => sourceExtension.test(relative))).map(file => folder + '/' + file)))).flat();
  const root = (await readdir(repository, { withFileTypes: true })).filter(item => item.isFile() && (sourceExtension.test(item.name) || item.name === 'package-lock.json'))
    .map(item => item.name);
  return [...tree, ...root].sort();
}
async function gitState(repository: string): Promise<FrozenMemorySoakManifest['git']> {
  try { const [head, status] = await Promise.all([execute('git', ['rev-parse', 'HEAD'], { cwd: repository }), execute('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repository })]);
    return { head: head.stdout.trim(), dirty: !!status.stdout.trim(), status: status.stdout.trim() }; }
  catch { return { head: null, dirty: true, status: 'Git identity unavailable.' }; }
}
/** All native code and the complete vendored source/binary tree are copied.
 * npm dependencies remain at their explicitly recorded installed boundary;
 * the package lock/version hashes are checked, never silently replaced. */
export async function freezeMemorySoakImplementation(input: { fixtureRoot: string; repositoryRoot?: string; requireClean?: boolean;
  loadedImplementation?: Record<string, unknown> }) {
  if (!path.isAbsolute(input.fixtureRoot)) throw new Error('Frozen soak fixture root must be absolute.');
  const repository = await realpath(input.repositoryRoot ?? process.cwd()), git = await gitState(repository);
  if (input.requireClean && (!git.head || git.dirty)) throw new Error('Final memory soak requires a clean committed implementation.');
  const root = path.join(input.fixtureRoot, 'frozen-implementation'), hostRoot = path.join(root, 'host'), vendorRoot = path.join(root, 'vendor');
  await mkdir(root); await mkdir(hostRoot); await mkdir(vendorRoot);
  const sources = await mapBounded(await sourcePaths(repository), async relative => { const bytes = await stableBytes(path.join(repository, relative)); return { path: relative, bytes: bytes.length, sha256: sha(bytes) }; });
  const copy = async (origin: string, target: string, selected: string[], readonlyFiles = true): Promise<CopyEntry[]> => mapBounded(selected, async relative => {
    const bytes = await stableBytes(path.join(origin, relative)), destination = path.join(target, ...relative.split('/'));
    await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' }); if (readonlyFiles) await chmod(destination, 0o444);
    return { path: relative, bytes: bytes.length, sha256: sha(bytes), frozenPath: destination };
  });
  const originalHost = path.join(repository, 'src/main/vcp-memory'), originalVendor = path.join(repository, 'vendor/vcp-memory');
  const hostCjs = await copy(originalHost, hostRoot, await files(originalHost, relative => relative.endsWith('.cjs')));
  if (!hostCjs.some(entry => entry.path === 'worker.cjs') || !hostCjs.some(entry => entry.path === 'cold-worker.cjs')) throw new Error('Incomplete native host snapshot.');
  // Windows fs.cp propagates the readonly attribute into the private runtime;
  // upstream must atomically replace its copied rag_params.json there. Guard
  // this private vendor snapshot by content hashes rather than that attribute.
  const vendor = await copy(originalVendor, vendorRoot, await files(originalVendor, () => true), false);
  const vendorManifests: FrozenMemorySoakManifest['vendorManifests'] = [];
  for (const name of ['upstream-manifest.json', 'peripheral-manifest.json']) {
    const bytes = await stableBytes(path.join(originalVendor, name)), parsed = JSON.parse(bytes.toString('utf8')) as
      { repository?: string; commit?: string; files: Array<{ path: string; bytes: number; sha256: string }> };
    for (const expected of parsed.files) { const captured = vendor.find(file => file.path === expected.path);
      if (!captured || captured.sha256 !== expected.sha256 || captured.bytes !== expected.bytes) throw new Error('Vendored manifest mismatch: ' + expected.path); }
    vendorManifests.push({ path: name, sha256: sha(bytes), repository: parsed.repository, commit: parsed.commit, listedFiles: parsed.files.length });
  }
  const nodeModules = await realpath(path.join(repository, 'node_modules'));
  // Only a dependency boundary, never a source/owner root. Cleanup unlinks this
  // exact junction without following its target (removeOwnedDirectory).
  await symlink(nodeModules, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const dependencyRequire = createRequire(path.join(repository, 'package.json'));
  const packages = await mapBounded(['better-sqlite3', '@dqbd/tiktoken', 'dayjs', 'axios', 'dotenv', 'node-fetch', 'ignore'], async name => {
    let directory = path.dirname(dependencyRequire.resolve(name));
    for (;;) { try { const raw = await stableBytes(path.join(directory, 'package.json')), parsed = JSON.parse(raw.toString('utf8')) as { name: string; version: string };
      if (parsed.name === name) return { name, version: parsed.version, packageJsonSha256: sha(raw), packageJsonPath: path.join(directory, 'package.json') }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(directory); if (parent === directory) throw new Error('Missing package identity: ' + name); directory = parent; }
  });
  const manifest: FrozenMemorySoakManifest = { schema: 'worldlinebox.memory-soak-implementation-v1', capturedAt: new Date().toISOString(), repositoryRoot: repository, git,
    sources, hostCjs, vendor, vendorManifests, dependencies: { kind: 'pinned_shared_npm', nodeModules, packageLockSha256: sha(await stableBytes(path.join(repository, 'package-lock.json'))),
      node: process.versions.node, ...(process.versions.electron ? { electron: process.versions.electron } : {}), packages },
    loadedImplementation: Object.fromEntries(Object.entries(input.loadedImplementation ?? {}).map(([name, value]) => [name, sha(String(value))])) };
  const manifestFile = path.join(root, 'implementation-manifest.json'); await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { flag: 'wx' }); await chmod(manifestFile, 0o444);
  const manifestSha256 = sha(await readFile(manifestFile));
  const verifyFrozen = async () => {
    if (sha(await stableBytes(manifestFile)) !== manifestSha256) throw new Error('Frozen implementation manifest changed.');
    await mapBounded([...hostCjs, ...vendor], async entry => { const bytes = await stableBytes(entry.frozenPath); if (sha(bytes) !== entry.sha256) throw new Error('Frozen implementation changed: ' + entry.path); });
    if (await realpath(path.join(root, 'node_modules')) !== nodeModules) throw new Error('Frozen dependency boundary changed.');
  };
  const verifySources = async () => {
    if (JSON.stringify(await sourcePaths(repository)) !== JSON.stringify(sources.map(file => file.path))) throw new Error('Source files were added/removed during the soak.');
    await mapBounded(sources, async entry => { if (sha(await stableBytes(path.join(repository, entry.path))) !== entry.sha256) throw new Error('Source changed during the soak: ' + entry.path); });
    if (sha(await stableBytes(path.join(repository, 'package-lock.json'))) !== manifest.dependencies.packageLockSha256) throw new Error('Dependency lock changed during the soak.');
    for (const entry of manifest.dependencies.packages) if (sha(await stableBytes(entry.packageJsonPath)) !== entry.packageJsonSha256) throw new Error('Installed dependency identity changed: ' + entry.name);
    for (const entry of vendor) if (sha(await stableBytes(path.join(originalVendor, entry.path))) !== entry.sha256) throw new Error('Vendor source changed during the soak: ' + entry.path);
    const currentGit = await gitState(repository); if (git.head !== currentGit.head) throw new Error('Git HEAD changed during the soak.');
  };
  const beforeLaunch = (workerPath: string) => {
    const expected = hostCjs.find(entry => path.resolve(entry.frozenPath) === path.resolve(workerPath));
    if (!expected || sha(readFileSync(expected.frozenPath)) !== expected.sha256) throw new Error('Native launch is outside the frozen host tree or changed.');
    for (const entry of [...hostCjs, ...vendor]) if (sha(readFileSync(entry.frozenPath)) !== entry.sha256) throw new Error('Frozen native input changed before launch: ' + entry.path);
  };
  await verifyFrozen(); await verifySources();
  return { root, workerPath: path.join(hostRoot, 'worker.cjs'), coldWorkerPath: path.join(hostRoot, 'cold-worker.cjs'), vendorRoot,
    manifest, manifestFile, manifestSha256, verifyFrozen, verifySources, beforeLaunch };
}
