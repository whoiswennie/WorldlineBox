import path from 'node:path';
import { dshNodePackRuntimeLockSchema, type DshNodePackRuntimeLock } from '../../shared/dsh-pack-runtime';
import { lstat, mkdir, readFile, writeFile } from './disk';
import { hashFile, safeRelative } from './files';
import { dependencyLockSha256, OFFICIAL_DSH_NPM_PACKAGE, validateOfficialNodeRelease, type NodeInstallTools, type OfficialNodeRelease } from './node-runtime-service';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const exactVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const integrity = /^sha(?:512|384|256|1)-[A-Za-z0-9+/]+={0,2}$/;
interface PackageRecord { name?: string; version?: string; resolved?: string; integrity?: string; link?: unknown; inBundle?: unknown; dependencies?: Record<string, string>; [key: string]: unknown }
interface NpmLock { name?: string; version?: string; lockfileVersion: number; packages: Record<string, PackageRecord>; [key: string]: unknown }
export async function validatePortableNodeRuntimeLock(lockValue: DshNodePackRuntimeLock, lockFile: string, signal?: AbortSignal): Promise<NpmLock> {
  const expected = dshNodePackRuntimeLockSchema.parse(lockValue); signal?.throwIfAborted(); const info = await lstat(lockFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 ** 2) throw new Error('Invalid portable npm dependency lock.');
  const value: unknown = JSON.parse(await readFile(lockFile, { encoding: 'utf8', signal }));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid portable npm dependency lock.');
  const lock = value as NpmLock;
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages) || Object.keys(lock.packages).length > 100_000) throw new Error('The portable runtime requires a bounded npm-v3 package lock.');
  const root = lock.packages['']; const primary = lock.packages[`node_modules/${OFFICIAL_DSH_NPM_PACKAGE}`];
  if (!root || root.dependencies?.[OFFICIAL_DSH_NPM_PACKAGE] !== expected.version || Object.keys(root.dependencies).length !== 1
    || primary?.version !== expected.version || primary.integrity !== expected.npmIntegrity) throw new Error('The portable dependency lock does not match the selected official DSH source.');
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.link) throw new Error('Portable runtime dependencies cannot contain link entries.');
    if (!location) continue; safeRelative(location);
    const name = item.name ?? location.split('/node_modules/').at(-1)!.replace(/^node_modules\//, '');
    if (!location.startsWith('node_modules/') || !packageName.test(name) || !item.version || !exactVersion.test(item.version)) throw new Error('The portable dependency lock contains an unsupported package identity.');
    if (item.inBundle === true && item.resolved === undefined && item.integrity === undefined) continue;
    if (typeof item.integrity !== 'string' || !integrity.test(item.integrity) || typeof item.resolved !== 'string') throw new Error('Every portable registry dependency requires a pinned content integrity.');
    let url: URL; try { url = new URL(item.resolved); } catch { throw new Error('Portable dependency downloads must use HTTPS registry URLs.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.tgz')) throw new Error('Portable dependency downloads must use credential-free HTTPS registry archives.');
    const expectedSuffix = `/-/${name.split('/').at(-1)}-${item.version}.tgz`;
    if (!decodeURIComponent(url.pathname).endsWith(expectedSuffix)) throw new Error('A portable dependency download URL does not match its locked name and version.');
  }
  if (await dependencyLockSha256(path.dirname(lockFile), signal) !== expected.dependencyLockSha256) throw new Error('The portable npm dependency graph differs from its runtime identity.');
  return lock;
}

/** Prepare npm ci, retaining every locked package and SRI while using the already verified primary tarball. */
export async function prepareNodeRuntimeLockInstall(options: { lock: DshNodePackRuntimeLock; lockFile: string; installationDirectory: string;
  release: OfficialNodeRelease; tarball: string; sourceSha256: string; tools: NodeInstallTools; signal?: AbortSignal; registry: string }): Promise<string[]> {
  const expected = dshNodePackRuntimeLockSchema.parse(options.lock); const release = validateOfficialNodeRelease(options.release);
  if (release.version !== expected.version || release.integrity !== expected.npmIntegrity || options.sourceSha256 !== expected.sourceSha256) throw new Error('The downloaded official DSH source differs from the pack runtime identity.');
  if (options.tools.nodeVersion !== expected.nodeVersion || options.tools.npmVersion !== expected.npmVersion) throw new Error('The pack requires its recorded Node and npm versions; an incompatible interpreter cannot replay this runtime.');
  const node = await lstat(options.tools.nodeExecutable); const tarball = await lstat(options.tarball);
  if (!node.isFile() || node.isSymbolicLink() || !tarball.isFile() || tarball.isSymbolicLink()
    || await hashFile(options.tools.nodeExecutable, options.signal) !== expected.nodeExecutableSha256
    || await hashFile(options.tarball, options.signal) !== expected.sourceSha256) throw new Error('The pinned runtime interpreter or source bytes failed their recorded SHA-256.');
  const lock = await validatePortableNodeRuntimeLock(expected, options.lockFile, options.signal);
  const registry = new URL(options.registry); if (registry.protocol !== 'https:' || registry.username || registry.password || registry.hash || registry.search) throw new Error('Runtime replay requires a credential-free HTTPS npm registry.');
  const destination = options.installationDirectory; await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new Error('The runtime replay destination cannot be linked.');
  const localTarball = `file:${path.relative(destination, options.tarball).replaceAll('\\', '/')}`;
  lock.packages['']!.dependencies![OFFICIAL_DSH_NPM_PACKAGE] = localTarball;
  for (const [location, item] of Object.entries(lock.packages)) {
    if (!location || item.inBundle === true && item.resolved === undefined) continue;
    if (location === `node_modules/${OFFICIAL_DSH_NPM_PACKAGE}`) { item.resolved = localTarball; continue; }
    const name = item.name ?? location.split('/node_modules/').at(-1)!.replace(/^node_modules\//, '');
    const encodedName = name.split('/').map(part => encodeURIComponent(part).replace(/^%40/, '@')).join('/');
    item.resolved = `${registry.href.replace(/\/$/, '')}/${encodedName}/-/${encodeURIComponent(name.split('/').at(-1)!)}-${encodeURIComponent(item.version!)}.tgz`;
  }
  const manifest = { name: lock.name ?? 'worldlinebox-dsh-runtime', version: lock.packages['']!.version ?? '1.0.0', private: true, type: 'module', dependencies: lock.packages['']!.dependencies };
  options.signal?.throwIfAborted(); await writeFile(path.join(destination, 'package.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', signal: options.signal });
  await writeFile(path.join(destination, 'package-lock.json'), JSON.stringify(lock, null, 2), { flag: 'wx', signal: options.signal });
  return ['ci', '--omit=dev', '--no-audit', '--no-fund', '--engine-strict', '--install-strategy=hoisted', '--fetch-timeout=600000', '--fetch-retries=2', '--registry', registry.href];
}
