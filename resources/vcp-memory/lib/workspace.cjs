'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = {
  API_URL: '', API_Key: '', WhitelistEmbeddingModel: 'google/gemini-embedding-001',
  VECTORDB_DIMENSION: 3072, DEFAULT_TIMEZONE: 'Asia/Shanghai',
  TDB_KNOWLEDGE_ENABLED: false, KNOWLEDGEBASE_BATCH_WINDOW_MS: 100,
  KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS: 100,
};
function resolveHome(value) {
  return path.resolve(value || process.env.VCP_MEMORY_HOME || path.join(process.cwd(), '.vcp-memory'));
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function initHome(home, overrides = {}) {
  home = resolveHome(home);
  fs.mkdirSync(home, { recursive: true });
  for (const directory of ['dailynote', 'knowledge', 'backups', 'sessions']) {
    fs.mkdirSync(path.join(home, directory), { recursive: true });
  }
  const configFile = path.join(home, 'config.json');
  const created = !fs.existsSync(configFile);
  if (created) {
    const defaults = overrides.API_URL ? DEFAULT_CONFIG : { ...DEFAULT_CONFIG,
      CHAT_API_URL: 'https://api.deepseek.com', CHAT_MODEL: 'deepseek-flash',
      LOCAL_EMBEDDING_ENABLED: true, VECTORDB_DIMENSION: 768,
      WhitelistEmbeddingModel: 'embeddinggemma-2' };
    atomicJson(configFile, { ...defaults, ...overrides });
  } else if (Object.keys(overrides).length) {
    throw new Error('Workspace already exists. Use config set to update explicit configuration keys.');
  }
  return { home, configFile, created };
}
function readConfig(home) {
  const file = path.join(resolveHome(home), 'config.json');
  if (!fs.existsSync(file)) throw new Error(`Workspace not initialized: run vcp-memory --home "${home}" init`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function configSet(home, key, value) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid configuration key');
  const config = readConfig(home);
  config[key] = value;
  atomicJson(path.join(home, 'config.json'), config);
  return { key, value: redactValue(key, value) };
}
function redactValue(key, value) {
  if (/key|api$|token|password|secret|authorization|headers/i.test(key) && value) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactValue('', item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactValue(name, item)]));
  return value;
}
function sanitizedConfig(config) { return redactValue('', config); }
function stageRuntime(home) {
  const source = path.join(ROOT, 'upstream', 'toolbox');
  if (!fs.existsSync(source)) throw new Error('Upstream source snapshot is missing');
  const runtime = path.join(home, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const ownedRuntime = fs.realpathSync(runtime);
  if (fs.lstatSync(runtime).isSymbolicLink() || comparable(ownedRuntime) !== comparable(path.join(fs.realpathSync(home), 'runtime'))) {
    throw Object.assign(new Error('Memory runtime must be an owned physical directory'), { code: 'MEMORY_RUNTIME_PATH_UNSAFE' });
  }
  const manifestFile = path.join(ROOT, 'upstream', 'manifest.json');
  const signature = crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
  const marker = path.join(runtime, '.snapshot-version');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') !== signature) {
    throw new Error('Upstream snapshot changed. Back up this workspace and run runtime-upgrade before continuing.');
  }
  // Source is immutable in the package; original plugins may write adjacent caches and settings.
  // Each memory workspace therefore owns its own runtime copy.
  if (!fs.existsSync(marker)) {
    fs.mkdirSync(runtime, { recursive: true });
    fs.cpSync(source, runtime, { recursive: true, force: false, errorOnExist: false,
      filter: file => !['tests', 'docs', 'target', 'node_modules'].includes(path.basename(file)) });
    fs.writeFileSync(marker, signature);
  }
  const dependencies = path.join(runtime, 'node_modules');
  const expected = path.join(ROOT, 'node_modules');
  if (!fs.existsSync(expected)) throw Object.assign(new Error('The packaged memory dependency directory is missing'), { code: 'MEMORY_DEPENDENCIES_MISSING' });
  const inspect = () => { try { return fs.lstatSync(dependencies); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
  const expectedPhysical = fs.realpathSync.native(expected);
  const matches = () => {
    try { return comparable(fs.realpathSync.native(dependencies)) === comparable(expectedPhysical); }
    catch (error) {
      if (error.code === 'ENOENT' || process.platform === 'win32' && ['UNKNOWN', 'EINVAL'].includes(error.code)) return false;
      throw error;
    }
  };
  const existing = inspect();
  let backup;
  if (existing && !matches()) {
    if (existing.isSymbolicLink()) fs.unlinkSync(dependencies);
    else {
      // Keep an old copied dependency tree intact. Both absolute move targets
      // are verified children of this workspace's physical runtime directory.
      backup = path.join(ownedRuntime, `.node_modules.previous-${crypto.randomUUID()}`);
      const from = path.join(ownedRuntime, 'node_modules');
      if (path.dirname(from) !== ownedRuntime || path.dirname(backup) !== ownedRuntime) throw new Error('Dependency recovery escaped its runtime');
      fs.renameSync(from, backup);
    }
  }
  if (!inspect()) {
    try { fs.symlinkSync(expectedPhysical, dependencies, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (error.code !== 'EEXIST' || !matches()) {
        if (backup && !inspect()) fs.renameSync(backup, dependencies);
        throw error;
      }
    }
  }
  return runtime;
}
function applyEnvironment(home, config, runtimeDir) {
  // Explicit config wins over the caller's environment; absent values may come from env.
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && value !== undefined && value !== '') process.env[key] = String(value);
  }
  const locations = {
    PROJECT_BASE_PATH: runtimeDir,
    KNOWLEDGEBASE_ROOT_PATH: path.join(home, 'dailynote'),
    KNOWLEDGEBASE_STORE_PATH: path.join(home, 'VectorStore'),
    TDB_KNOWLEDGE_ROOT_PATH: path.join(home, 'knowledge'),
    TDB_KNOWLEDGE_STORE_PATH: path.join(home, 'VectorStoreTDB'),
    AGENT_DIR_PATH: path.join(home, 'Agent'),
    TVSTXT_DIR_PATH: path.join(home, 'TVStxt'),
  };
  for (const [key, value] of Object.entries(locations)) process.env[key] = value;
  for (const key of ['AGENT_DIR_PATH', 'TVSTXT_DIR_PATH']) fs.mkdirSync(locations[key], { recursive: true });
  return locations;
}
function acquireLock(home) {
  home = resolveHome(home);
  const lock = path.join(home, '.runtime-lock');
  const ownerFile = path.join(home, '.runtime-owner.json');
  fs.mkdirSync(home, { recursive: true });
  let release;
  try { release = require('proper-lockfile').lockSync(home, {
    realpath: false, lockfilePath: lock, stale: 10000, update: 2000, retries: 0,
  }); }
  catch (error) {
    if (error.code !== 'ELOCKED') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch {}
    throw new Error(`Workspace in use${owner?.pid ? ' by PID ' + owner.pid : ''}. Use the same serve session, or retry after it closes (crash recovery lease: 10 seconds).`);
  }
  try { atomicJson(ownerFile, { pid: process.pid, startedAt: new Date().toISOString() }); }
  catch (error) { release(); throw error; }
  return () => { try { fs.unlinkSync(ownerFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { release(); } };
}
function backup(home, label = 'manual') {
  const directory = path.join(home, 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^a-z0-9-]/gi, '_')}-${crypto.randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const item of fs.readdirSync(home)) {
    if (['backups', '.runtime-lock', '.runtime-owner.json'].includes(item)) continue;
    fs.cpSync(path.join(home, item), path.join(directory, item), { recursive: true,
      filter: file => path.basename(file) !== 'node_modules' });
  }
  return { backup: directory };
}
function verifyUpstream({ all = false } = {}) {
  const result = spawnSync(process.execPath, all ? [path.join(ROOT, 'scripts', 'verify-integrity.cjs')]
    : [path.join(ROOT, 'scripts', 'snapshot-upstream.cjs'), '--verify'], { encoding: 'utf8', cwd: ROOT });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'Snapshot verification failed');
  try { return JSON.parse(result.stdout); } catch { return { verified: true, detail: result.stdout.trim() }; }
}
module.exports = { ROOT, resolveHome, atomicJson, initHome, readConfig, configSet, sanitizedConfig,
  stageRuntime, applyEnvironment, acquireLock, backup, verifyUpstream };
