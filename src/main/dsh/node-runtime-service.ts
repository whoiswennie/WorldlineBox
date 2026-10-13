import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { copyFile, createWriteStream, lstat, mkdir, readFile, realpath, writeFile, rm } from './disk';
import { contained, copyTree, hashFile, redact, safeRelative, type TreeInventory } from './files';
import { fetchHttpsDownload, type HttpsDownloadFetch } from './https-download';
import type { OperationContext } from './operations';
import { attachProcessJob } from './windows-job';
import { terminateOwnedProcess } from './instance-process';
import { npmDownloadMonitorSource } from './npm-download-monitor';

export const OFFICIAL_DSH_NPM_PACKAGE = '@deepseek-ai/dsh';
export const OFFICIAL_DSH_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness';

/** Immutable registry coordinates, resolved by the version catalog before installation. */
export interface OfficialNodeRelease {
  version: string;
  tarball: string;
  integrity: string;
}

export interface NodeInstallTools {
  nodeExecutable: string;
  npmCli: string;
  nodeVersion: string;
  npmVersion: string;
}

export interface NodeInstallNetwork {
  /** The current proxy is captured when npm starts, rather than when the manager starts. */
  env: NodeJS.ProcessEnv;
  registry: string;
}
export interface NodeRuntimeInstallPreparationOptions {
  installationDirectory:string;release:OfficialNodeRelease;tarball:string;sourceSha256:string;
  tools:NodeInstallTools;signal:AbortSignal;registry:string;
}
export type NodeRuntimeInstallPreparation=(options:NodeRuntimeInstallPreparationOptions)=>Promise<string[]>;

export interface NodeRuntimeReceipt {
  format: 'worldlinebox-dsh-node-runtime-v1';
  version: string;
  nodeVersion: string;
  npmVersion: string;
  package: typeof OFFICIAL_DSH_NPM_PACKAGE;
  repository: typeof OFFICIAL_DSH_REPOSITORY;
  tarball: string;
  integrity: string;
  npmIntegrity: string;
  dependencyLockSha256: string;
  nodeExecutableSha256: string;
  sourceSha256: string;
  executable: 'bin/node.exe';
  cli: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
}

/** Source identity keeps dependency locations and integrity, without a registry mirror's URL. */
export async function dependencyLockSha256(directory:string,signal?:AbortSignal):Promise<string> {
  const file=path.join(directory,'package-lock.json');const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw new Error('Invalid Node dependency lock.');
  const lock=JSON.parse(await readFile(file,{encoding:'utf8',signal})) as {lockfileVersion?:number;packages?:Record<string,unknown>};
  if(lock.lockfileVersion!==3||!lock.packages||typeof lock.packages!=='object'||Array.isArray(lock.packages))throw new Error('Unsupported Node dependency lock.');
  const entries=Object.entries(lock.packages).sort(([a],[b])=>a<b?-1:a>b?1:0);
  if(entries.length>100_000)throw new Error('Node dependency lock exceeds its supported size.');
  let count=0;
  const canonical=(value:unknown,depth=0):unknown=>{
    if(++count>1_000_000||depth>64)throw new Error('Node dependency lock is too complex.');
    if(Array.isArray(value))return value.map(item=>canonical(item,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item,depth+1)]));
    return value;
  };
  const packages=entries.map(([location,value])=>{
    if(location)safeRelative(location);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid package entry in Node dependency lock.');
    const properties=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='resolved'&&(location!==''||key!=='name')));
    return {location,metadata:canonical(properties)};
  });
  return createHash('sha256').update(JSON.stringify({lockfileVersion:3,packages})).digest('hex');
}

/** Directory import inspects bytes only; no imported Node executable or CLI is run. */
export async function validateOfficialNodeProgram(program:string,signal?:AbortSignal):Promise<NodeRuntimeReceipt> {
  const file=path.join(program,'node-runtime.json');const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw new Error('Invalid Node runtime receipt.');
  const receipt=JSON.parse(await readFile(file,{encoding:'utf8',signal})) as NodeRuntimeReceipt;
  if(receipt.format!=='worldlinebox-dsh-node-runtime-v1'||receipt.package!==OFFICIAL_DSH_NPM_PACKAGE||receipt.repository!==OFFICIAL_DSH_REPOSITORY
    ||receipt.executable!=='bin/node.exe'||receipt.cli!=='dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
    ||!supportsDshNode(receipt.nodeVersion)||typeof receipt.npmVersion!=='string'||receipt.npmVersion.length>128
    ||![receipt.sourceSha256,receipt.nodeExecutableSha256,receipt.dependencyLockSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))
    ||receipt.npmIntegrity!==receipt.integrity)throw new Error('Unsupported official Node runtime receipt.');
  validateOfficialNodeRelease({version:receipt.version,tarball:receipt.tarball,integrity:receipt.npmIntegrity});
  const node=await ordinaryFile(path.join(program,'bin','node.exe'));
  if(await hashFile(node,signal)!==receipt.nodeExecutableSha256)throw new Error('Imported Node executable does not match its receipt.');
  await verifyInstalledPackage(path.join(program,'dsh'),receipt.version);
  const lock=JSON.parse(await readFile(path.join(program,'dsh','package-lock.json'),'utf8')) as {packages?:Record<string,{version?:string;integrity?:string}>};
  const dsh=lock.packages?.['node_modules/@deepseek-ai/dsh'];
  if(dsh?.version!==receipt.version||dsh.integrity!==receipt.npmIntegrity
    ||await dependencyLockSha256(path.join(program,'dsh'),signal)!==receipt.dependencyLockSha256)throw new Error('Imported DSH dependency lock does not match its receipt.');
  return receipt;
}

/** Reject a dependency solver's mixed DSH family before registering a sealed runtime. */
export async function validateNodeRuntimeInventory(program: string, version: string,
  inventory: TreeInventory, signal?: AbortSignal): Promise<void> {
  if (inventory.byteLength > 6 * 1024 ** 3) throw new Error('The DSH dependency closure exceeds its supported size.');
  const manifests = inventory.files.filter(file => /(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?\/package\.json$/.test(file.path));
  if (!manifests.length || manifests.length > 3000) throw new Error('Invalid official DSH package closure.');
  for (let start = 0; start < manifests.length; start += 32) {
    signal?.throwIfAborted();
    await Promise.all(manifests.slice(start, start + 32).map(async file => {
      if (file.size > 1024 * 1024) throw new Error('Invalid official DSH package manifest.');
      const manifest = JSON.parse(await readFile(contained(program, file.path), {encoding:'utf8', signal})) as {name?: string;version?: string};
      const expected = `@deepseek-ai/${path.basename(path.dirname(file.path))}`;
      if (manifest.name !== expected || manifest.version !== version) throw new Error('Installed official DSH packages contain mixed release versions.');
    }));
  }
}

export function validateOfficialNodeRelease(release: OfficialNodeRelease): OfficialNodeRelease {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/i.test(release.version)
    || release.version.length > 128) throw new Error('Invalid official DSH version.');
  const url = new URL(release.tarball);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port
    || url.username || url.password || url.search || url.hash
    || url.pathname !== `/@deepseek-ai/dsh/-/dsh-${release.version}.tgz`) {
    throw new Error('The DSH package must come from its official npm release.');
  }
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.integrity)
    || Buffer.from(release.integrity.slice(7), 'base64').length !== 64) {
    throw new Error('Official npm SHA-512 integrity is required.');
  }
  return { ...release };
}

export function supportsDshNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const major = Number(match[1]); const minor = Number(match[2]);
  return major >= 24 || major === 22 && minor >= 19;
}

/** Child-only installation environment: no user npmrc, package cache or API credentials. */
export async function nodeInstallEnvironment(staging: string, tools: NodeInstallTools,
  network: NodeInstallNetwork): Promise<NodeJS.ProcessEnv> {
  const registry = new URL(network.registry);
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.hash || registry.search) {
    throw new Error('The npm registry must be an HTTPS registry URL.');
  }
  const env = { ...network.env };
  let inheritedPath = '';
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') { inheritedPath = env[key] ?? ''; delete env[key]; }
    else if (/^(DSH_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_|DEEPSEEK_|OPENAI_|ANTHROPIC_|GEMINI_|GOOGLE_API_KEY$|AZURE_OPENAI_|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$|NPM_TOKEN$|NPM_CONFIG_|PNPM_|PYTHONHOME$|PYTHONPATH$|PYTHONUSERBASE$|PYTHONNOUSERSITE$|PIP_USER$|PSModulePath$)/i.test(key)) delete env[key];
  }
  const user = path.join(staging, 'user'); const cache = path.join(staging, 'cache');
  await Promise.all([user, cache, path.join(cache, 'tmp'), path.join(user, 'AppData', 'Roaming'),
    path.join(user, 'AppData', 'Local')].map(dir => mkdir(dir, { recursive: true })));
  const emptyConfig = path.join(staging, 'empty-user.npmrc');
  const emptyGlobalConfig = path.join(staging, 'empty-global.npmrc');
  await Promise.all([emptyConfig, emptyGlobalConfig].map(file => writeFile(file, '', { flag: 'wx' })));
  return { ...env, PATH: `${path.dirname(tools.nodeExecutable)}${path.delimiter}${inheritedPath}`,
    HOME: user, USERPROFILE: user, APPDATA: path.join(user, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(user, 'AppData', 'Local'),
    TEMP: path.join(cache, 'tmp'), TMP: path.join(cache, 'tmp'), TMPDIR: path.join(cache, 'tmp'),
    npm_config_cache: cache, npm_config_userconfig: emptyConfig, npm_config_globalconfig: emptyGlobalConfig,
    npm_config_registry: registry.href, PYTHONUSERBASE:path.join(user,'python-userbase'),PIP_USER:'1',
    PSModulePath:path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules'),
    NO_COLOR: '1', FORCE_COLOR: '0' };
}

async function ordinaryFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('A managed runtime tool is not an ordinary file.');
  return realpath(file);
}

/**
 * Spawn the pinned package manager in an owned Job. Cancellation finishes its tree before
 * the caller removes staging, so install-script descendants cannot continue writing there.
 */
export async function runNodeInstall(tools: NodeInstallTools, args: string[], cwd: string,
  env: NodeJS.ProcessEnv, operation: OperationContext): Promise<void> {
  operation.signal.throwIfAborted();
  const nonce = randomUUID();
  const monitor = path.join(cwd, `.worldline-download-${nonce}.cjs`);
  if (operation.download) await writeFile(monitor, npmDownloadMonitorSource(nonce), { flag: 'wx' });
  const installEnv = operation.download ? { ...env, NODE_OPTIONS: `--require=${JSON.stringify(monitor)}` } : env;
  const child = spawn(tools.nodeExecutable, [tools.npmCli, ...args], {
    cwd, env: installEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessWithoutNullStreams;
  child.once('error', () => undefined);
  let job: ReturnType<typeof attachProcessJob>;
  try { job = attachProcessJob(child); }
  catch (error) { await terminateOwnedProcess(child); if (operation.download) await rm(monitor, { force: true }); throw error; }
  child.stdin.end();
  child.on('message', message => {
    if (message && typeof message === 'object' && 'nonce' in message && message.nonce === nonce && 'bytes' in message && typeof message.bytes === 'number') operation.download?.report(message.bytes);
  });
  let output = ''; let diagnostics = ''; let queued = Promise.resolve();
  const flush = (final = false) => {
    const split = final ? output.length : output.lastIndexOf('\n') + 1;
    if (!split) return;
    const lines = redact(output.slice(0, split).replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')); output = output.slice(split);
    diagnostics = (diagnostics + lines).slice(-4096);
    queued = queued.then(() => operation.log(lines)).catch(() => undefined);
  };
  const append = (buffer: Buffer) => { output += buffer.toString('utf8'); if (output.length > 64 * 1024) output = output.slice(-64 * 1024); flush(); };
  child.stdout.on('data', append); child.stderr.on('data', append);
  const stop = () => { try { job?.terminate(); if (!job) child.kill(); } catch { child.kill(); } };
  operation.signal.addEventListener('abort', stop, { once: true });
  if (operation.signal.aborted) stop();
  try {
    await operation.download?.begin(undefined, { pause: () => { if (child.connected) child.send({ type: 'pause', nonce }, () => undefined); }, resume: () => { if (child.connected) child.send({ type: 'resume', nonce }, () => undefined); } });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    flush(true); await queued; operation.signal.throwIfAborted(); await operation.download?.wait();
    if (code !== 0) throw new Error(`Official DSH npm installation failed (exit ${code}). ${diagnostics}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) await terminateOwnedProcess(child);
    operation.signal.removeEventListener('abort', stop); job?.close();
    await operation.download?.end();
    if (operation.download) await rm(monitor, { force: true });
  }
}

async function downloadOfficialPackage(release: OfficialNodeRelease, file: string,
  fetcher: HttpsDownloadFetch, operation: OperationContext): Promise<string> {
  const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(10 * 60_000)]);
  const response = await fetchHttpsDownload(release.tarball, fetcher, signal);
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Official DSH package download failed (HTTP ${response.status}).`); }
  const sha512 = createHash('sha512'); let size = 0;
  const total = Number(response.headers.get('content-length'));
  await operation.download?.begin(total > 0 ? total : undefined);
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) return callback(new Error('Official DSH CLI archive exceeded its allowed size.'));
    void (async () => { await operation.download?.wait(); sha512.update(chunk); operation.download?.report(size); callback(null, chunk); })().catch(callback);
  } });
  try { await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(file, { flags: 'wx' }), { signal }); }
  finally { await operation.download?.end(); }
  const expected = Buffer.from(release.integrity.slice(7), 'base64');
  if (!timingSafeEqual(sha512.digest(), expected)) throw new Error('Official DSH package SHA-512 did not match registry metadata.');
  return hashFile(file, signal);
}

async function verifyInstalledPackage(directory: string, version: string): Promise<void> {
  const pkg = path.join(directory, 'node_modules', '@deepseek-ai', 'dsh');
  const file = await ordinaryFile(path.join(pkg, 'package.json'));
  const manifest = JSON.parse(await readFile(file, 'utf8')) as {
    name?: string; version?: string; bin?: { dsh?: string }; repository?: { url?: string };
    dependencies?: Record<string, string>;
  };
  if (manifest.name !== OFFICIAL_DSH_NPM_PACKAGE || manifest.version !== version || manifest.bin?.dsh !== 'lib/bin.js'
    || manifest.repository?.url !== `git+${OFFICIAL_DSH_REPOSITORY}.git`) throw new Error('Installed DSH metadata does not match the selected official release.');
  await ordinaryFile(path.join(pkg, 'lib', 'bin.js'));
  for (const name of ['dsh-base', 'dsh-web-app', 'dsh-headless']) {
    if (manifest.dependencies?.[`@deepseek-ai/${name}`] !== version) throw new Error('Official DSH bundle versions do not match.');
    const dependency = JSON.parse(await readFile(await ordinaryFile(path.join(directory, 'node_modules', '@deepseek-ai', name, 'package.json')), 'utf8')) as { name?: string; version?: string };
    if (dependency.name !== `@deepseek-ai/${name}` || dependency.version !== version) throw new Error('Installed DSH core bundle versions do not match.');
  }
  await ordinaryFile(path.join(directory, 'package-lock.json'));
}

/** The verification tarball is temporary; retain registry coordinates in the sealed lock. */
async function retainRegistryCoordinates(directory: string, release: OfficialNodeRelease): Promise<void> {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  if (!manifest.dependencies?.[OFFICIAL_DSH_NPM_PACKAGE]) throw new Error('npm did not save the DSH dependency.');
  manifest.dependencies[OFFICIAL_DSH_NPM_PACKAGE] = release.version;
  const lockPath = path.join(directory, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    lockfileVersion?: number; packages?: Record<string, { dependencies?: Record<string, string>; version?: string; resolved?: string; integrity?: string }>;
  };
  const root = lock.packages?.['']; const dsh = lock.packages?.['node_modules/@deepseek-ai/dsh'];
  if (lock.lockfileVersion !== 3 || !root?.dependencies?.[OFFICIAL_DSH_NPM_PACKAGE]
    || dsh?.version !== release.version || dsh.integrity !== release.integrity) {
    throw new Error('npm did not retain the verified DSH package identity in its lock.');
  }
  root.dependencies[OFFICIAL_DSH_NPM_PACKAGE] = release.version;
  dsh.resolved = release.tarball;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(lockPath, JSON.stringify(lock, null, 2));
}

export async function prepareOfficialNodeRuntime(options: {
  release: OfficialNodeRelease; staging: string; program: string; tools: NodeInstallTools;
  network: () => Promise<NodeInstallNetwork>; fetch: HttpsDownloadFetch; operation: OperationContext;
  prepareInstall?:NodeRuntimeInstallPreparation;
}): Promise<NodeRuntimeReceipt> {
  const release = validateOfficialNodeRelease(options.release);
  if (!supportsDshNode(options.tools.nodeVersion)) throw new Error('Official DSH requires Node 22.19 or Node 24 and newer.');
  const nodeExecutable = await ordinaryFile(options.tools.nodeExecutable);
  const npmCli = await ordinaryFile(options.tools.npmCli);
  const tools = { ...options.tools, nodeExecutable, npmCli };
  const operation = options.operation;
  await mkdir(options.staging, { recursive: true });
  const tarball = path.join(options.staging, 'official-dsh.tgz');
  await operation.update('downloading official npm release', 5);
  const sourceSha256 = await downloadOfficialPackage(release, tarball, options.fetch, operation);
  const install = path.join(options.staging, 'npm-install');
  await mkdir(install);
  if(!options.prepareInstall)await writeFile(path.join(install, 'package.json'), JSON.stringify({
    name: 'worldlinebox-dsh-runtime', version: '1.0.0', private: true, type: 'module',
  }), { flag: 'wx' });
  await operation.update('installing official dependencies', 20);
  const network = await options.network();
  const env = await nodeInstallEnvironment(options.staging, tools, network);
  const args=options.prepareInstall?await options.prepareInstall({installationDirectory:install,release,tarball,sourceSha256,tools,signal:operation.signal,registry:network.registry}):['install', '--save-exact', '--omit=dev', '--no-audit', '--no-fund',
    '--engine-strict', '--install-strategy=hoisted', '--fetch-timeout=600000', '--fetch-retries=2',
    '--registry', network.registry, tarball];
  await runNodeInstall(tools,args,install,env,operation);
  await operation.update('validating exact DSH package', 70);
  await retainRegistryCoordinates(install, release);
  await verifyInstalledPackage(install, release.version);
  operation.signal.throwIfAborted();
  await mkdir(path.join(options.program, 'bin'), { recursive: true });
  await copyFile(nodeExecutable, path.join(options.program, 'bin', 'node.exe'));
  // npm owns all links in this scratch tree; flatten only links confined to that tree.
  // The published program has no live relation to npm caches, tools or other releases.
  await copyTree(install, path.join(options.program, 'dsh'), { signal: operation.signal });
  await verifyInstalledPackage(path.join(options.program, 'dsh'), release.version);
  const receipt: NodeRuntimeReceipt = {
    format: 'worldlinebox-dsh-node-runtime-v1', version: release.version,
    nodeVersion: tools.nodeVersion, npmVersion: tools.npmVersion,
    package: OFFICIAL_DSH_NPM_PACKAGE, repository: OFFICIAL_DSH_REPOSITORY,
    tarball: release.tarball, integrity: release.integrity,npmIntegrity:release.integrity,sourceSha256,
    dependencyLockSha256:await dependencyLockSha256(path.join(options.program,'dsh'),operation.signal),
    nodeExecutableSha256:await hashFile(path.join(options.program,'bin','node.exe'),operation.signal),
    executable: 'bin/node.exe', cli: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  };
  await writeFile(path.join(options.program, 'node-runtime.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
