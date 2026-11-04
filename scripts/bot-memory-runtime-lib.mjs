import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function resolveBotMemoryNode(projectRoot, explicit) {
  if (explicit || process.env.WORLDLINEBOX_BOT_NODE) return path.resolve(explicit || process.env.WORLDLINEBOX_BOT_NODE);
  if (Number(process.versions.node.split('.')[0]) === 24) return process.execPath;
  const tools = path.join(projectRoot, '.tools');
  const candidates = (await readdir(tools)).filter(name => /^node-v24\.\d+\.\d+-/.test(name)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const found = candidates.map(name => path.join(tools, name, process.platform === 'win32' ? 'node.exe' : 'bin/node')).find(existsSync);
  if (!found) throw new Error('Node 24 required. Set WORLDLINEBOX_BOT_NODE to the DSH Node executable.');
  return found;
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function inside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === '..' || !part)) throw new Error('Unsafe bot memory manifest path');
  return path.join(root, relative);
}
const canonicalEntries = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
function accepts(values, current) {
  return !values || !values.includes('!' + current) && (values.includes(current) || values.includes('any') || values.every(value => value.startsWith('!')));
}
/** Check the installed production closure against exact lockfile identities.
 * Other-platform optional binaries and dev-only packages are not required.
 * Installer-generated fallback extras do not replace any locked dependency. */
export async function verifyBotMemoryDependencyClosure({ packageRoot, platform = process.platform, arch = process.arch }) {
  const root = await realpath(packageRoot), lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!lock.packages?.[''] || canonicalEntries(pkg.dependencies) !== canonicalEntries(lock.packages[''].dependencies)
    || canonicalEntries(pkg.optionalDependencies) !== canonicalEntries(lock.packages[''].optionalDependencies)) throw new Error('Bot memory dependency lock does not match its package');
  const libc = platform === 'linux' ? process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl' : undefined;
  let packages = 0, skipped = 0;
  for (const [relative, expected] of Object.entries(lock.packages)) {
    if (!relative) continue;
    if (expected.dev || !accepts(expected.os, platform) || !accepts(expected.cpu, arch) || libc && !accepts(expected.libc, libc)) { skipped++; continue; }
    const file = inside(root, relative + '/package.json');
    let bytes;
    try {
      if ((await lstat(file)).isSymbolicLink() || !(await realpath(file)).startsWith(root + path.sep)) throw new Error('Dependency manifest escapes its isolated resource root');
      bytes = await readFile(file, 'utf8');
    } catch (error) { throw new Error(`Bot memory production dependency missing or unsafe: ${relative}`, { cause: error }); }
    const installed = JSON.parse(bytes), name = expected.name || relative.split('node_modules/').at(-1);
    if (installed.name !== name || installed.version !== expected.version) throw new Error(`Bot memory production dependency differs from lock: ${relative}`);
    if (canonicalEntries(installed.dependencies) !== canonicalEntries(expected.dependencies)
      || canonicalEntries(installed.optionalDependencies) !== canonicalEntries(expected.optionalDependencies)) throw new Error(`Bot memory dependency edges differ from lock: ${relative}`);
    packages++;
  }
  const require = createRequire(path.join(root, 'package.json'));
  for (const name of Object.keys(pkg.dependencies || {})) {
    try { require.resolve(name); }
    catch (error) { throw new Error(`Bot memory runtime dependency entry point is missing: ${name}`, { cause: error }); }
  }
  return { packages, skipped, lockfileVersion: lock.lockfileVersion };
}
/** Verify actual source bytes and an independent Node native runtime, without
 * installing, rewriting data, or trusting Electron's ABI. */
export async function verifyBotMemory({ packageRoot, projectRoot, nodePath, compareSource = true }) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'worldlinebox-integration-manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.module !== 'vcp-memory' || !Array.isArray(manifest.files) || !manifest.runtime?.abi) throw new Error('Invalid bot memory integration manifest');
  if (Number(manifest.runtime.version?.replace(/^v/, '').split('.')[0]) !== 24) throw new Error('Bot memory native dependencies require the managed Node 24 runtime');
  const root = await realpath(packageRoot);
  if (compareSource) {
    const expected = new Set();
    const sourceRoot = path.join(projectRoot, 'resources', 'vcp-memory');
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) expected.add(path.relative(sourceRoot, file).replaceAll('\\', '/'));
      }
    };
    await walk(sourceRoot);
    if (manifest.files.length !== expected.size || new Set(manifest.files.map(entry => entry.path)).size !== expected.size
      || manifest.files.some(entry => !expected.has(entry.path))) throw new Error('Bot memory manifest omits or duplicates source files');
  }
  for (const entry of manifest.files) {
    const file = inside(root, entry.path);
    if ((await lstat(file)).isSymbolicLink() || !(await realpath(file)).startsWith(root + path.sep)) throw new Error('Bot memory source escapes its resource root');
    const bytes = await readFile(file);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`Bot memory source integrity mismatch: ${entry.path}`);
    if (compareSource) {
      const source = await readFile(inside(path.join(projectRoot, 'resources', 'vcp-memory'), entry.path));
      if (!source.equals(bytes)) throw new Error(`Bot memory resource is stale: ${entry.path}`);
    }
  }
  const listed = new Set(manifest.files.map(entry => entry.path));
  if (listed.size !== manifest.files.length) throw new Error('Bot memory manifest duplicates source files');
  const inspectStaged = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name), relative = path.relative(root, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) throw new Error('Bot memory source tree contains a link');
      if (entry.isDirectory()) await inspectStaged(file);
      else if (entry.isFile() && !listed.has(relative) && !['.dependencies-version', 'worldlinebox-integration-manifest.json'].includes(relative)) {
        throw new Error(`Bot memory resource contains an unlisted stale file: ${relative}`);
      }
    }
  };
  await inspectStaged(root);
  if (existsSync(path.join(root, 'vendor', 'local-embedding'))) throw new Error('Duplicate standalone embedding model/runtime must not ship');
  const dependencyClosure = await verifyBotMemoryDependencyClosure({ packageRoot: root });
  const native = spawnSync(nodePath, ['-e', `
    const actual={version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch};
    const D=require('better-sqlite3');const db=new D(':memory:');db.exec('CREATE TABLE probe(id INTEGER)');db.close();
    const v=require('./upstream/toolbox/rust-vexus-lite');const i=new v.VexusIndex(64,16);const r=new v.NativeKnowledgeRuntime(i);
    const capabilities=r.capabilities();r.shutdown();process.stdout.write(JSON.stringify({actual,capabilities}));
  `], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (native.status !== 0) throw new Error(`Bot memory native Node ABI probe failed: ${native.stderr || native.stdout}`);
  const probe = JSON.parse(native.stdout);
  if (Number(probe.actual.version.replace(/^v/, '').split('.')[0]) !== 24 || probe.actual.abi !== manifest.runtime.abi || probe.actual.platform !== manifest.runtime.platform || probe.actual.arch !== manifest.runtime.arch) throw new Error('Bot memory staged dependencies do not match the selected DSH Node 24 ABI');
  const lock = await readFile(path.join(root, 'package-lock.json'));
  const signature = createHash('sha256').update(lock).update(JSON.stringify(manifest.runtime)).digest('hex');
  if (signature !== manifest.dependenciesSignature) throw new Error('Bot memory dependency lock/runtime signature mismatch');
  return { ok: true, packageRoot: root, sourceFiles: manifest.files.length, runtime: probe.actual, native: probe.capabilities, dependencyClosure };
}
