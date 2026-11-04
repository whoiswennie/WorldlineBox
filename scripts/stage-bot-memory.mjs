import { cp, mkdir, readFile, readdir, writeFile, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBotMemoryNode, verifyBotMemory } from './bot-memory-runtime-lib.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(projectRoot, 'resources', 'vcp-memory');
const target = path.join(projectRoot, '.tools', 'bot-memory-release', 'vcp-memory');
const nodeArg = process.argv.find(value => value.startsWith('--node='));
const nodePath = await resolveBotMemoryNode(projectRoot, nodeArg?.slice(7));
const engine = spawnSync(nodePath, ['-p', 'process.versions.node'], { encoding: 'utf8', windowsHide: true });
if (engine.status !== 0 || Number(engine.stdout.trim().split('.')[0]) !== 24) throw new Error('Bot memory staging requires the DSH Node 24 runtime.');
const verify = spawnSync(nodePath, [path.join(source, 'scripts', 'verify-integrity.cjs'), '--managed-embedding'], { encoding: 'utf8', windowsHide: true });
if (verify.status !== 0) throw new Error(`VCP source integrity failed: ${verify.stderr || verify.stdout}`);
const integrity = JSON.parse(verify.stdout);
const integritySummary = { ok: integrity.ok, manifests: integrity.results.map(result => ({ manifest: result.manifest,
  files: result.files, ok: result.ok, omittedManagedEmbedding: result.omittedManagedEmbedding?.length || 0 })) };
// Windows cannot replace a native addon loaded by another Bot Worker. If the
// exact source, manifest, production closure and actual Node ABI already match,
// reuse the immutable release without copying or touching any file in it.
if (!process.argv.includes('--install') && existsSync(path.join(target, 'worldlinebox-integration-manifest.json'))) {
  let release;
  try { release = await verifyBotMemory({ packageRoot: target, projectRoot, nodePath }); }
  catch (error) { console.error('Existing bot memory release requires staging: ' + (error instanceof Error ? error.message : String(error))); }
  if (release) {
    console.log(JSON.stringify({ staged: target, reused: true, integrity: integritySummary, runtime: release.runtime,
      sourceFiles: release.sourceFiles, dependencyClosure: release.dependencyClosure }));
    process.exit(0);
  }
}
await mkdir(target, { recursive: true });
// Copy immutable source only. This runtime owns its Node dependencies; never
// reuse Electron-rebuilt better-sqlite3 or package a second embedding model.
for (const entry of await readdir(source)) {
  if (entry === 'node_modules') throw new Error('VCP source tree must not contain node_modules');
  await cp(path.join(source, entry), path.join(target, entry), { recursive: true, force: true, filter: async (from, to) => {
    const sourceInfo = await lstat(from); if (sourceInfo.isSymbolicLink()) throw new Error('VCP source must not contain links');
    if (!sourceInfo.isFile()) return true;
    try {
      const targetInfo = await lstat(to); if (targetInfo.isSymbolicLink()) throw new Error('VCP staged source must not contain links');
      if (targetInfo.isFile() && targetInfo.size === sourceInfo.size && (await readFile(from)).equals(await readFile(to))) return false;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return true;
  } });
}
const lockBytes = await readFile(path.join(target, 'package-lock.json'));
const nodeVersion = spawnSync(nodePath, ['-p', "JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})"], { encoding: 'utf8', windowsHide: true });
if (nodeVersion.status !== 0) throw new Error('Bot memory Node runtime is unavailable');
const signature = createHash('sha256').update(lockBytes).update(nodeVersion.stdout.trim()).digest('hex');
const marker = path.join(target, '.dependencies-version');
const installed = existsSync(marker) && (await readFile(marker, 'utf8')).trim() === signature;
if (!installed || process.argv.includes('--install')) {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
  const npmCli = candidates.find(file => existsSync(file) && file.endsWith('.js'));
  if (!npmCli) throw new Error('npm CLI required for isolated bot memory dependency staging');
  const env = { ...process.env, PATH: path.dirname(nodePath) + path.delimiter + process.env.PATH,
    VcpkgEnabled: 'false', npm_config_runtime: 'node', npm_config_target: '', npm_config_disturl: '', ELECTRON_RUN_AS_NODE: '' };
  const install = spawnSync(nodePath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: target, env, stdio: 'inherit', windowsHide: true });
  if (install.status !== 0) throw new Error('Isolated VCP production dependency install failed');
  await writeFile(marker, signature + '\n');
}
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(file);
    else if (entry.isFile()) files.push({ path: path.relative(source, file).replaceAll('\\', '/'),
      bytes: (await stat(file)).size, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  }
}
await walk(source);
await writeFile(path.join(target, 'worldlinebox-integration-manifest.json'), JSON.stringify({ schema: 1, module: 'vcp-memory',
  sourceVersion: JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version,
  runtime: JSON.parse(nodeVersion.stdout), dependenciesSignature: signature, files }, null, 2) + '\n');
const release = await verifyBotMemory({ packageRoot: target, projectRoot, nodePath });
console.log(JSON.stringify({ staged: target, reused: false, integrity: integritySummary,
  runtime: release.runtime, sourceFiles: release.sourceFiles, dependencyClosure: release.dependencyClosure }));
