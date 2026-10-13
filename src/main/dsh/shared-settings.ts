import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isMap, isSeq, parseDocument, visit, type YAMLSeq } from 'yaml';
import { lstat, mkdir, readFile, rename, writeFile } from './disk';
import { connectNativeSettings, SharedSettingsRpcError, type NativeSettingsTransport, type NativeSettingsView, type SettingsMutation } from './shared-settings-rpc';

const deepseekFields = ['baseURL', 'thinking', 'reasoningEffort', 'maxTokens', 'defaultContextWindow', 'models', 'streamIdleTimeoutMs', 'maxRequestFilesBytes', 'maxInlineRequestImageBytes', 'maxImagesPerRequest', 'imageOffloadByteQuantum', 'inlineImageOffloadByteQuantum', 'imageOffloadCountQuantum', 'filesApiTimeoutMs', 'fileExpiresAfterSeconds', 'fileRefreshMarginSeconds', 'fileQuotaCleanupBatch', 'retryPolicy'];
export const SHARED_MODEL_FIELDS = {
  'llm-deepseek': [...deepseekFields, 'apiKeyEnv'],
  'llm-deepseek-account': deepseekFields,
  'llm-pi-ai': ['providers'],
  'agent-default-model': ['provider', 'model', 'reasoningEffort'],
} as const;
export type SharedModelNamespace = keyof typeof SHARED_MODEL_FIELDS;
export type SharedModelSnapshot = Partial<Record<SharedModelNamespace, Record<string, unknown>>>;
const packageNames: Record<SharedModelNamespace, string> = {
  'llm-deepseek': '@deepseek-ai/dsh-llm-deepseek-api-key', 'llm-deepseek-account': '@deepseek-ai/dsh-llm-deepseek-account',
  'llm-pi-ai': '@deepseek-ai/dsh-llm-pi-ai', 'agent-default-model': '@deepseek-ai/dsh-agent-default-model',
};
const namespaces = Object.keys(SHARED_MODEL_FIELDS) as SharedModelNamespace[];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function parseStore(text: string): SharedSettingsFile {
  try { return JSON.parse(text) as SharedSettingsFile; }
  catch { throw new Error('Shared model settings storage is not valid JSON.'); }
}
async function privateProfilePath(homePath: string): Promise<void> {
  for (const directory of [homePath, path.join(homePath, 'profiles'), path.join(homePath, 'profiles', 'web')]) {
    try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private model settings directories cannot be linked.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
function cloneData(value: unknown, depth = 0): unknown {
  if (depth > 50) throw new Error('Model settings exceed nesting limits.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(entry => cloneData(entry, depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (['__proto__', 'prototype', 'constructor', '__jsExpr'].includes(key)) throw new Error('Unsafe model settings field.');
    return [key, cloneData(entry, depth + 1)];
  }));
  throw new Error('Shared model settings must be plain JSON values.');
}
function selected(ns: SharedModelNamespace, config: unknown): Record<string, unknown> {
  if (config === undefined) return {};
  if (!record(config)) throw new Error(`Invalid shared model namespace ${ns}.`);
  const result = Object.fromEntries(SHARED_MODEL_FIELDS[ns].filter(key => Object.hasOwn(config, key)).map(key => [key, cloneData(config[key])]));
  if (JSON.stringify(result).length > 2 * 1024 * 1024) throw new Error(`Shared model namespace ${ns} exceeds size limits.`);
  return result;
}
export function sanitizeSharedModels(snapshot: unknown): SharedModelSnapshot {
  if (!record(snapshot)) throw new Error('Invalid shared model snapshot.');
  return Object.fromEntries(namespaces.map(ns => [ns, selected(ns, snapshot[ns])]));
}
function documentOf(text: string) {
  if (text.length > 8 * 1024 * 1024) throw new Error('Private profile patch exceeds size limits.');
  const document = parseDocument(text || '[]\n', { uniqueKeys: true, prettyErrors: false, customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] });
  if (document.errors.length || !isSeq(document.contents)) throw new Error('Private profile patch must be a valid YAML sequence.');
  return { document, rows: document.contents as YAMLSeq };
}
export function readSharedModels(text: string): SharedModelSnapshot {
  const { rows } = documentOf(text);
  const result: SharedModelSnapshot = {};
  for (const row of rows.items) {
    if (!isMap(row)) continue;
    const id = row.get('id');
    if (typeof id !== 'string' || !namespaces.includes(id as SharedModelNamespace)) continue;
    const ns = id as SharedModelNamespace;
    if (row.has('insert') || row.has('name') && row.get('name') !== packageNames[ns]) throw new Error(`Ambiguous shared model namespace ${ns}.`);
    if (!row.has('config')) continue;
    const config = row.get('config', true);
    if (config !== undefined) visit(config, { Node(_key, node) { if (node.tag === 'tag:yaml.org,2002:js') throw new Error(`Dynamic shared model configuration is unsupported: ${ns}.`); } });
    result[ns] = selected(ns, row.toJSON().config);
  }
  return sanitizeSharedModels(result);
}
/** Update only model fields; plugin rows, disabled flags, skills and unrelated options remain private. */
export function writeSharedModels(text: string, snapshot: SharedModelSnapshot): string {
  const { document, rows: sequence } = documentOf(text);
  const values = sanitizeSharedModels(snapshot);
  // Reading first rejects ambiguous or executable shared configuration.
  readSharedModels(text);
  for (const ns of namespaces) {
    const rows = sequence.items.filter(row => isMap(row) && row.get('id') === ns);
    for (const row of rows) if (isMap(row)) {
      const config = row.get('config', true);
      if (isMap(config)) for (const key of SHARED_MODEL_FIELDS[ns]) config.delete(key);
    }
    let target = rows.at(-1);
    if (!isMap(target) && Object.keys(values[ns] ?? {}).length > 0) {
      target = document.createNode({ id: ns, name: packageNames[ns], config: {} });
      sequence.items.push(target);
    }
    if (!isMap(target)) continue;
    if (!target.has('config')) target.set('config', document.createNode({}));
    for (const [key, value] of Object.entries(values[ns] ?? {})) document.setIn([sequence.items.indexOf(target), 'config', key], value);
  }
  return String(document);
}

/** Home overrides are later than the profile in native composition. Preserve their full private config before routing the common fields. */
export function foldHomeModelOverrides(profileText: string, homeText: string): { profile: string; home: string; changed: boolean } {
  readSharedModels(profileText); readSharedModels(homeText);
  const profile = documentOf(profileText); const home = documentOf(homeText); let changed = false;
  for (const row of home.rows.items) {
    if (!isMap(row) || typeof row.get('id') !== 'string' || !namespaces.includes(row.get('id') as SharedModelNamespace) || !row.has('config')) continue;
    const ns = row.get('id') as SharedModelNamespace;
    let target = profile.rows.items.findLast(entry => isMap(entry) && entry.get('id') === ns);
    if (!isMap(target)) { target = profile.document.createNode({ id: ns, name: packageNames[ns] }); profile.rows.items.push(target); }
    if (!isMap(target)) throw new Error('Invalid private model composition.');
    target.set('config', profile.document.createNode(row.toJSON().config)); row.delete('config'); changed = true;
  }
  return { profile: changed ? String(profile.document) : profileText, home: changed ? String(home.document) : homeText, changed };
}

export interface ModelSyncConflict { namespace: SharedModelNamespace; path: string[] }
/** Three-way, field-level reconciliation; conflict reports carry no configured values. */
export function mergeSharedModels(baseline: SharedModelSnapshot, canonical: SharedModelSnapshot, observed: SharedModelSnapshot): { values: SharedModelSnapshot; conflicts: ModelSyncConflict[] } {
  const conflicts: ModelSyncConflict[] = [];
  const merge = (base: unknown, shared: unknown, local: unknown, ns: SharedModelNamespace, at: string[]): unknown => {
    if (isDeepStrictEqual(local, base) || isDeepStrictEqual(local, shared)) return shared;
    if (isDeepStrictEqual(shared, base)) return local;
    if ((base === undefined || record(base)) && record(shared) && record(local)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(shared), ...Object.keys(local)])) {
        const value = merge(record(base) ? base[key] : undefined, shared[key], local[key], ns, [...at, key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    conflicts.push({ namespace: ns, path: at });
    return shared;
  };
  const a = sanitizeSharedModels(baseline), b = sanitizeSharedModels(canonical), c = sanitizeSharedModels(observed);
  return { values: Object.fromEntries(namespaces.map(ns => [ns, merge(a[ns], b[ns], c[ns], ns, [])])), conflicts };
}

interface SharedSettingsFile { version: 1; values: SharedModelSnapshot; clients: Record<string, SharedModelSnapshot> }
export interface SharedSettingsIssue { instanceId: string; code: string; namespaces: string[]; paths: string[][] }
type Peer = { homePath: string; transport: NativeSettingsTransport; unsubscribe: () => void };

export class SharedSettingsCoordinator {
  private store: SharedSettingsFile = { version: 1, values: {}, clients: {} };
  private loaded = false;
  private disposed = false;
  private savedText?: string;
  private readonly peers = new Map<string, Peer>();
  private readonly reportedIssues = new Map<string, string>();
  private readonly connecting = new Map<string, symbol>();
  private tail = Promise.resolve();
  private pendingSync?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: { storePath: string; onIssue?: (issue: SharedSettingsIssue) => void; connect?: typeof connectNativeSettings }) {
    if (!path.isAbsolute(options.storePath)) throw new Error('Shared settings storage must be absolute.');
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.then(() => undefined, () => undefined); return result;
  }
  private issue(instanceId: string, code: string, conflicts: ModelSyncConflict[] = []) {
    const issue = { instanceId, code, namespaces: [...new Set(conflicts.map(conflict => conflict.namespace))], paths: conflicts.map(conflict => conflict.path) };
    const signature = JSON.stringify(issue);
    if (this.reportedIssues.get(instanceId) === signature) return;
    this.reportedIssues.set(instanceId, signature);
    this.options.onIssue?.(issue);
  }
  private async load() {
    if (this.loaded) return;
    try {
      const info = await lstat(this.options.storePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Invalid shared model settings storage.');
      const value = parseStore(await readFile(this.options.storePath, 'utf8'));
      if (value.version !== 1 || !record(value.clients)) throw new Error('Invalid shared settings store.');
      this.store = { version: 1, values: sanitizeSharedModels(value.values), clients: Object.fromEntries(Object.entries(value.clients).map(([id, values]) => [id, sanitizeSharedModels(values)])) };
      this.savedText = JSON.stringify(this.store);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  private async save() {
    const text = JSON.stringify(this.store);
    if (text === this.savedText) return;
    await mkdir(path.dirname(this.options.storePath), { recursive: true });
    const temporary = `${this.options.storePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, this.options.storePath);
    this.savedText = text;
  }
  async prepareStopped(instanceId: string, homePath: string): Promise<void> {
    if (this.disposed) throw new Error('Shared model settings coordination is closed.');
    await this.serial(async () => {
      await this.load();
      if (!path.isAbsolute(homePath) || this.peers.has(instanceId)) throw new Error('Model settings offline preparation requires a stopped private instance.');
      await privateProfilePath(homePath);
      const file = path.join(homePath, 'profiles', 'web', 'cordis.patch.yml');
      const homeFile = path.join(homePath, 'cordis.patch.yml');
      let before = '[]\n';
      try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Private profile patch cannot be linked.'); before = await readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let homeBefore = '[]\n';
      try { const info = await lstat(homeFile); if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('Private home patch cannot be linked or oversized.'); homeBefore = await readFile(homeFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const folded = foldHomeModelOverrides(before, homeBefore);
      const observed = readSharedModels(folded.profile);
      const merged = mergeSharedModels(this.store.clients[instanceId] ?? {}, this.store.values, observed);
      if (merged.conflicts.length) { this.issue(instanceId, 'settings/conflict', merged.conflicts); throw new Error('Shared model settings conflict; private settings were preserved.'); }
      const after = writeSharedModels(folded.profile, merged.values);
      const current = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '[]\n'; throw error; });
      if (current !== before) throw new Error('Private profile settings changed during preparation.');
      if (folded.changed && await readFile(homeFile, 'utf8') !== homeBefore) throw new Error('Private home settings changed during preparation.');
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, after, { flag: 'wx', mode: 0o600 }); await rename(temporary, file);
      if (folded.changed) {
        // Commit the complete preserving profile first; an interruption still leaves the original Home override intact.
        if (await readFile(homeFile, 'utf8') !== homeBefore) throw new Error('Private home settings changed during preparation.');
        const homeTemporary = `${homeFile}.${randomUUID()}.tmp`;
        await writeFile(homeTemporary, folded.home, { flag: 'wx', mode: 0o600 }); await rename(homeTemporary, homeFile);
      }
      this.store.values = merged.values; this.store.clients[instanceId] = merged.values; await this.save();
      this.reportedIssues.delete(instanceId);
    });
  }
  async attach(instanceId: string, readyUrl: string, homePath: string): Promise<void> {
    if (this.disposed) throw new Error('Shared model settings coordination is closed.');
    this.detach(instanceId);
    const ticket = Symbol(instanceId); this.connecting.set(instanceId, ticket);
    let transport: NativeSettingsTransport;
    try { transport = await (this.options.connect ?? connectNativeSettings)(readyUrl); }
    catch (error) { if (this.connecting.get(instanceId) === ticket) this.connecting.delete(instanceId); throw error; }
    if (this.disposed || this.connecting.get(instanceId) !== ticket) {
      transport.close(); throw new Error('Shared model settings connection was cancelled.');
    }
    this.connecting.delete(instanceId);
    this.peers.set(instanceId, { homePath, transport, unsubscribe: transport.onChanged((ns) => { if (namespaces.includes(ns as SharedModelNamespace)) void this.syncNow().catch(() => undefined); }) });
    if (!this.timer) { this.timer = setInterval(() => { void this.syncNow().catch(() => undefined); }, 1_500); this.timer.unref(); }
    await this.syncNow();
  }
  detach(instanceId: string): void {
    this.connecting.delete(instanceId);
    const peer = this.peers.get(instanceId); if (!peer) return;
    this.peers.delete(instanceId); peer.unsubscribe(); peer.transport.close();
    this.reportedIssues.delete(instanceId);
    if (!this.peers.size) { clearInterval(this.timer); this.timer = undefined; }
  }
  async dispose(): Promise<void> { this.disposed = true; this.connecting.clear(); for (const id of this.peers.keys()) this.detach(id); await this.tail; }
  async syncNow(): Promise<void> {
    if (this.disposed) return;
    if (this.pendingSync) return this.pendingSync;
    const synchronization = this.serial(async () => {
      await this.load();
      const observations = new Map<string, NativeSettingsView[]>();
      let canonical = this.store.values;
      for (const [id, peer] of this.peers) {
        try {
          const views = await peer.transport.describe(); observations.set(id, views);
          const observed = { ...this.store.clients[id], ...Object.fromEntries(views.filter(view => namespaces.includes(view.ns as SharedModelNamespace)).map(view => [view.ns, selected(view.ns as SharedModelNamespace, view.user)])) };
          const merged = mergeSharedModels(this.store.clients[id] ?? {}, canonical, observed);
          if (merged.conflicts.length) { this.issue(id, 'settings/conflict', merged.conflicts); return; }
          canonical = merged.values;
        } catch (error) {
          if (this.peers.get(id) !== peer) continue;
          this.issue(id, error instanceof SharedSettingsRpcError ? error.code : 'settings/read-failed'); return;
        }
      }
      this.store.values = canonical;
      for (const [id, views] of observations) {
        const peer = this.peers.get(id); if (!peer) continue;
        let applying: SharedModelNamespace | undefined;
        try {
          for (const ns of namespaces) {
            applying = ns;
            const view = views.find(entry => entry.ns === ns);
            if (!view) { if (Object.keys(canonical[ns] ?? {}).length) throw new SharedSettingsRpcError('settings/namespace-unavailable'); continue; }
            const current = selected(ns, view.user);
            const ops: SettingsMutation[] = SHARED_MODEL_FIELDS[ns].filter(key => !isDeepStrictEqual(current[key], canonical[ns]?.[key])).map(key => Object.hasOwn(canonical[ns] ?? {}, key)
              ? { op: 'set', path: [key], value: canonical[ns]![key] }
              : { op: 'unset', path: [key] });
            if (!ops.length) continue;
            if (view.secrets?.some(secret => secret.set && ops.some(op => op.path[0] === secret.path[0]))) throw new SharedSettingsRpcError('settings/secret-path-conflict');
            await peer.transport.mutate(ns, ops, view.revision);
          }
          this.store.clients[id] = canonical;
          this.reportedIssues.delete(id);
        } catch (error) { this.issue(id, error instanceof SharedSettingsRpcError ? error.code : 'settings/write-failed', applying ? [{ namespace: applying, path: [] }] : []); }
      }
      await this.save();
    });
    this.pendingSync = synchronization.finally(() => { this.pendingSync = undefined; });
    await this.pendingSync;
  }
  /** An imported model snapshot participates in CAS-style merging instead of silently replacing local values. */
  async importSnapshot(snapshot: SharedModelSnapshot): Promise<void> {
    if (this.disposed) throw new Error('Shared model settings coordination is closed.');
    await this.serial(async () => {
      await this.load(); const merged = mergeSharedModels({}, this.store.values, sanitizeSharedModels(snapshot));
      if (merged.conflicts.length) { this.issue('backup-import', 'settings/conflict', merged.conflicts); throw new Error('Imported shared model settings conflict with current choices.'); }
      this.store.values = merged.values; await this.save();
      this.reportedIssues.delete('backup-import');
    });
    await this.syncNow();
  }
  async exportSnapshot(): Promise<SharedModelSnapshot> { return this.serial(async () => { await this.load(); return sanitizeSharedModels(this.store.values); }); }
  private async importedValues(storePath: string): Promise<SharedModelSnapshot | undefined> {
    if (!path.isAbsolute(storePath)) throw new Error('Imported shared settings path must be absolute.');
    try {
      const info = await lstat(storePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Invalid imported shared settings file.');
      const imported = parseStore(await readFile(storePath, 'utf8'));
      if (imported.version !== 1) throw new Error('Unsupported imported shared settings version.');
      return sanitizeSharedModels(imported.values);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async assertImportableFrom(storePath: string): Promise<void> {
    const imported = await this.importedValues(storePath); if (imported === undefined) return;
    await this.serial(async () => {
      await this.load();
      const merged = mergeSharedModels({}, this.store.values, imported);
      if (merged.conflicts.length) throw new Error('Imported shared model settings conflict with current choices.');
    });
  }
  async importFrom(storePath: string): Promise<void> {
    const imported = await this.importedValues(storePath); if (imported !== undefined) await this.importSnapshot(imported);
  }
}
