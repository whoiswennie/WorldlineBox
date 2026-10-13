import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from './disk';
import { retryFileOperation } from './runtime-commit';
import { supportsSharedDataRuntime } from './validated-runtime';

const MARKER = '// WorldlineBox shared workspace adapter v1';
export interface SharedWorkspaceAdapterEntry {
  id: 'worldline-shared-workspace'; insert: true; name: string; config: { workspacePath: string; runtimeVersion: string };
}

/** A technical plugin kept outside user profiles and immutable runtime artifacts. */
export async function writeSharedWorkspaceAdapter(options: {
  instanceRoot: string; workspacePath: string; runtimeVersion: string; signal?: AbortSignal;
}): Promise<SharedWorkspaceAdapterEntry> {
  if (!supportsSharedDataRuntime(options.runtimeVersion)) throw new Error('No verified shared Workspace adapter exists for this runtime.');
  if (!path.isAbsolute(options.instanceRoot) || !path.isAbsolute(options.workspacePath)) throw new Error('Shared Workspace adapter paths must be absolute.');
  options.signal?.throwIfAborted();
  const rootStat = await lstat(options.instanceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Shared Workspace adapter requires an ordinary private instance root.');
  const root = await realpath(options.instanceRoot);
  const directory = path.join(root, 'launcher');
  const directoryStat = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) throw new Error('Shared Workspace adapter directory is not owned storage.');
  if (!directoryStat) await mkdir(directory, { mode: 0o700 });
  if (path.relative(root, await realpath(directory)) !== 'launcher') throw new Error('Shared Workspace adapter directory escapes its private instance.');
  const workspaceStat = await lstat(options.workspacePath);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error('Shared Workspace must be an ordinary managed directory.');
  const workspacePath = await realpath(options.workspacePath);
  const name = path.join(directory, 'shared-workspace-adapter.mjs');
  const existing = await lstat(name).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > 256 * 1024)) throw new Error('Shared Workspace adapter file is not owned storage.');
  const previous = existing ? await readFile(name, 'utf8') : undefined;
  if (previous !== undefined && !previous.startsWith(MARKER)) throw new Error('Shared Workspace adapter refuses to replace an unmanaged file.');
  if (previous !== SHARED_WORKSPACE_ADAPTER_SOURCE) {
    const temporary = `${name}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, SHARED_WORKSPACE_ADAPTER_SOURCE, { flag: 'wx', mode: 0o600, signal: options.signal });
      await retryFileOperation(() => rename(temporary, name), { signal: options.signal });
    } finally { await rm(temporary, { force: true }); }
  }
  return { id: 'worldline-shared-workspace', insert: true, name, config: { workspacePath,runtimeVersion:options.runtimeVersion } };
}

export const SHARED_WORKSPACE_ADAPTER_SOURCE = `${MARKER}\n` + String.raw`
import { realpath } from 'node:fs/promises';

const MAX_LIST = 100000;
const MAX_MEMO = 10000;
const BATCH_SIZE = 128;
const identity = header => JSON.stringify([header.id, header.version, header.createdAt, header.cwd ?? null, header.isSeeded]);

export default function sharedWorkspaceAdapter(ctx, config) {
  const lifetime = new AbortController();
  const memo = new Map();
  const failures = new Map();
  const revisions = new Map();
  const diagnostics = new Set();
  let disposed = false;
  let pending;
  let cursor = 0;
  let workspacePath;
  const controller = ctx.sessionController;
  const listState = controller.listState;
  const original = listState.summarizeCold;
  const warn = category => {
    if (disposed || diagnostics.has(category)) return;
    diagnostics.add(category);
    ctx.logger.warn('WorldlineBox shared Workspace refresh skipped an unavailable native read (' + category + '). Existing records were retained.');
  };
  const wrapped = function(input) {
    const header=input?.header??input;
    if (ctx.sessions.get(header.id) !== undefined) return original.call(this, input);
    const record = memo.get(header.id);
    if(record?.identity!==identity(header))return original.call(this,input);
    const summary=structuredClone(record.summary);
    if(input?.header){if(input.formatStatus!==undefined)summary.formatStatus=structuredClone(input.formatStatus);else delete summary.formatStatus;}
    return summary;
  };
  const remember = (id, record) => {
    memo.delete(id); memo.set(id, record);
    while (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value);
  };

  const poll = async () => {
    if (disposed) return;
    workspacePath ??= await realpath(config.workspacePath);
    lifetime.signal.throwIfAborted();
    // Never create a registration: deleting it is a durable user choice.
    const workspace = ctx.workspaceRegistry.list().find(value => value.path === workspacePath);
    if (workspace === undefined) return;
    const snapshots = await ctx.sessionPersistence.list({ signal: lifetime.signal });
    if (!Array.isArray(snapshots) || snapshots.length > MAX_LIST) { warn('list-bound'); return; }
    const candidates = snapshots.filter(snapshot => snapshot?.header?.cwd === workspacePath && typeof snapshot.header.id === 'string' && typeof snapshot.revision === 'string');
    const visible = new Set(candidates.map(snapshot => snapshot.header.id));
    for (const id of memo.keys()) if (!visible.has(id)) memo.delete(id);
    for (const id of revisions.keys()) if (!visible.has(id)) revisions.delete(id);
    // Discover new IDs/foreign renames on the next poll even when a large
    // archive is still warming. The rotating half still visits every baseline.
    const priority = candidates.filter(snapshot => revisions.get(snapshot.header.id) !== snapshot.revision && failures.get(snapshot.header.id) !== snapshot.revision)
      .sort((left, right) => Number(revisions.has(right.header.id)) - Number(revisions.has(left.header.id)) || right.header.createdAt - left.header.createdAt)
      .slice(0, BATCH_SIZE / 2);
    const selected = [...priority]; const selectedIds = new Set(priority.map(snapshot => snapshot.header.id));
    let visited = 0;
    while (visited < candidates.length && selected.length < BATCH_SIZE) {
      const snapshot = candidates[(cursor + visited) % candidates.length]; visited++;
      if (!selectedIds.has(snapshot.header.id)) { selected.push(snapshot); selectedIds.add(snapshot.header.id); }
    }
    for (const snapshot of selected) {
      lifetime.signal.throwIfAborted();
      const header = snapshot?.header;
      if (!header || typeof header.id !== 'string' || typeof snapshot.revision !== 'string' || header.cwd !== workspacePath) continue;
      // Native local events own all availability/running state for attached sessions.
      if (ctx.sessions.get(header.id) !== undefined) { memo.delete(header.id); continue; }
      const lifecycle = identity(header);
      const previous = memo.get(header.id);
      if (previous?.identity === lifecycle && previous.revision === snapshot.revision && workspace.sessionIds.includes(header.id)) continue;
      if (failures.get(header.id) === snapshot.revision) continue;
      let observation;
      try {
        observation = await ctx.sessionQuery.observeSession(header.id, { signal: lifetime.signal, projectionMode: 'all' });
        lifetime.signal.throwIfAborted();
        if (ctx.sessions.get(header.id) !== undefined || observation.header.cwd !== workspacePath || identity(observation.header) !== lifecycle) continue;
        // The native header index is memory only. Refreshing it avoids pruning a
        // previously registered id whose artifact appeared after this Host boot.
        await ctx.workspaceRegistry.indexHeaders([observation.header]);
        if (ctx.workspaceRegistry.get(workspace.id) !== workspace) continue;
        if (!workspace.sessionIds.includes(header.id)) await workspace.attachSession(header.id);
        if (disposed || ctx.workspaceRegistry.get(workspace.id) !== workspace || ctx.sessions.get(header.id) !== undefined) continue;
        const summary = original.call(listState, config.runtimeVersion==='0.2.1-alpha.2'?{header:observation.header,formatStatus:snapshot.formatStatus}:observation.header);
        const fresh = observation.projections;
        if (fresh && typeof fresh.asOfSeq === 'number' && fresh.values && typeof fresh.values === 'object') {
          summary.projections = { kind: 'cached', asOfSeq: fresh.asOfSeq, values: fresh.values };
          const metadata = fresh.values.sessionListMetadata;
          summary.blank = metadata?.blank ?? false;
          summary.updatedAt = Math.max(observation.header.createdAt, metadata?.lastPromptAt ?? 0);
        }
        // summarizeCold is only the native cold face; no Agent is prepared or
        // promoted, and the observation never takes the session writer lease.
        summary.agentAvailable = false; summary.running = false;
        const digest = JSON.stringify(summary);
        remember(header.id, { identity: lifecycle, revision: observation.revision, summary: structuredClone(summary), digest });
        revisions.set(header.id, observation.revision);
        failures.delete(header.id);
        if (previous?.digest !== digest) {
          ctx.emit('api-session/added', summary);
          ctx.emit('api-session/activity', header.id, summary.updatedAt);
        }
      } catch {
        if (!disposed && !lifetime.signal.aborted) { failures.set(header.id, snapshot.revision); warn('session-observation'); }
      } finally { observation?.[Symbol.dispose]?.(); }
    }
    cursor = candidates.length ? (cursor + visited) % candidates.length : 0;
    while (failures.size > MAX_MEMO) failures.delete(failures.keys().next().value);
  };
  const refresh = () => {
    if (disposed || pending) return;
    pending = poll().catch(() => { if (!disposed && !lifetime.signal.aborted) warn('native-list'); }).finally(() => { pending = undefined; });
  };
  ctx.effect(() => {
    listState.summarizeCold = wrapped;
    const timer = setInterval(refresh, 2000); timer.unref?.(); refresh();
    return async () => {
      disposed = true; lifetime.abort(); clearInterval(timer);
      if (listState.summarizeCold === wrapped) listState.summarizeCold = original;
      await pending;
      memo.clear(); failures.clear(); revisions.clear(); diagnostics.clear();
    };
  }, 'WorldlineBox shared Workspace read-only summaries');
}
sharedWorkspaceAdapter.inject = ['workspaceRegistry', 'sessionPersistence', 'sessionController', 'sessionQuery', 'sessions'];
`;
