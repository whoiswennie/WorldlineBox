import path from 'node:path';
import { lstat, readdir, unlink } from 'node:fs/promises';

export interface PreparedRecallDiskLimits { maxPackages?: number; maxBytes?: number }
const DEFAULT_PACKAGES = 256, DEFAULT_BYTES = 512 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
const preparedBudgetPathKey = (file: string) => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
async function preparedBudgetOwnedDirectory(directory: string): Promise<boolean> {
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, part); let info;
    try { info = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Prepared recall budget ancestor must remain owned and unlinked.');
  } return true;
}
interface Entry { file: string; bytes: number; modified: number; quarantined?: boolean }
interface Workspace { root: string; maxPackages: number; maxBytes: number; references: number; initialized: boolean;
  tail: Promise<unknown>; files: Map<string, Entry>; bytes: number }
const workspaces = new Map<string, Workspace>();
export interface PreparedRecallDiskTurn { admit(bytes: number): void; committed(file: string, bytes: number): void; removed(file: string): void }

/** One explicit disk budget per actual workspace, shared by all its owner and
 * generation clients. Only owned prepared folders are inspected, never native
 * runtime dependency links, diary bodies or other asset-library documents. */
export class VcpPreparedRecallDiskBudget {
  private readonly state: Workspace;
  private closed = false;
  constructor(readonly root: string, dataRoot: string, limits: PreparedRecallDiskLimits = {}) {
    if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw new Error('Invalid prepared recall workspace root.');
    const relative = path.relative(root, dataRoot), parts = relative ? relative.split(path.sep) : [];
    const nativeLayout = parts.every(part => /^[a-f0-9]{64}$/u.test(part))
      || parts[0] === 'generation' && parts.slice(1).every(part => /^[a-f0-9]{64}$/u.test(part));
    const ownerLayout = parts.length === 4 && /^[a-zA-Z0-9_-]{1,100}$/u.test(parts[0]!) && parts[1] === '.认知索引'
      && ['hot', 'generation'].includes(parts[2]!) && /^[a-f0-9]{64}$/u.test(parts[3]!);
    if (path.isAbsolute(relative) || parts.includes('..') || !(nativeLayout && parts.length <= 3 || ownerLayout))
      throw new Error('Prepared recall data root must be inside its native workspace layout.');
    const maxPackages = limits.maxPackages ?? DEFAULT_PACKAGES, maxBytes = limits.maxBytes ?? DEFAULT_BYTES;
    if (![maxPackages, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid prepared recall disk limits.');
    const key = preparedBudgetPathKey(root), existing = workspaces.get(key);
    if (existing && (existing.maxPackages !== maxPackages || existing.maxBytes !== maxBytes)) throw new Error('Prepared recall workspace limits must agree.');
    this.state = existing ?? { root, maxPackages, maxBytes, references: 0, initialized: false, tail: Promise.resolve(), files: new Map(), bytes: 0 };
    this.state.references++; workspaces.set(key, this.state);
  }
  private removeEntry(file: string): void {
    const key = preparedBudgetPathKey(file), previous = this.state.files.get(key);
    if (previous) { this.state.bytes -= previous.bytes; this.state.files.delete(key); }
  }
  private addEntry(file: string, bytes: number, modified: number): void {
    this.removeEntry(file); this.state.files.set(preparedBudgetPathKey(file), { file, bytes, modified }); this.state.bytes += bytes;
  }
  private async discover(): Promise<void> {
    if (this.state.initialized) return;
    if (!await preparedBudgetOwnedDirectory(this.state.root)) { this.state.initialized = true; return; }
    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (depth === 0 && /^[a-zA-Z0-9_-]{1,100}$/u.test(entry.name)) {
          if (entry.isDirectory()) for (const lane of ['hot', 'generation']) {
            const index = path.join(file, '.认知索引'), target = path.join(index, lane);
            let indexInfo, laneInfo;
            try { indexInfo = await lstat(index); laneInfo = await lstat(target); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
            if (!indexInfo.isDirectory() || indexInfo.isSymbolicLink() || !laneInfo.isDirectory() || laneInfo.isSymbolicLink())
              throw new Error('Prepared recall owner index must be owned and unlinked.');
            await walk(target, 2);
          }
        }
        if (entry.name === 'prepared-recalls' && depth > 0 && depth <= 4) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Prepared recall budget directory must be owned and unlinked.');
          for (const name of await readdir(file)) {
            if (!/^prepared_[a-f0-9]{32}\.json(?:\.tmp)?$/u.test(name)) continue;
            const packet = path.join(file, name), info = await lstat(packet);
            this.addEntry(packet, info.size, info.mtimeMs);
            if (!info.isFile() || info.isSymbolicLink()) this.state.files.get(preparedBudgetPathKey(packet))!.quarantined = true;
          }
        } else if (depth < 4 && (/^[a-f0-9]{64}$/u.test(entry.name) || depth === 0 && entry.name === 'generation')) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Prepared recall workspace ancestor must be owned and unlinked.');
          await walk(file, depth + 1);
        }
      }
    };
    await walk(this.state.root, 0); this.state.initialized = true;
  }
  private async reclaim(protectedFile: (file: string) => boolean, reclaimed: (file: string) => void): Promise<void> {
    for (const entry of [...this.state.files.values()]) {
      if (protectedFile(entry.file)) continue;
      const relative = path.relative(this.state.root, entry.file);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Prepared recall budget file escaped its workspace.');
      // Entries survive across owner clients. Recheck their ancestors before
      // TTL unlink so a later asset-directory junction cannot redirect cleanup.
      let owned: boolean;
      try { owned = await preparedBudgetOwnedDirectory(path.dirname(entry.file)); }
      catch {
        // Keep its last known disk charge while quarantining the inaccessible
        // owner path. Never follow/unlink it, or block an unrelated owner merely
        // because another owner's asset folder was replaced or lost access.
        entry.quarantined = true; reclaimed(entry.file); continue;
      }
      if (!owned) { this.removeEntry(entry.file); reclaimed(entry.file); continue; }
      let info;
      try { info = await lstat(entry.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.removeEntry(entry.file); else entry.quarantined = true;
        reclaimed(entry.file); continue; }
      if (!info.isFile() || info.isSymbolicLink()) { entry.quarantined = true; reclaimed(entry.file); continue; }
      entry.quarantined = false;
      if (Date.now() - info.mtimeMs >= TTL_MS) { await unlink(entry.file); this.removeEntry(entry.file); reclaimed(entry.file); }
      else if (info.size !== entry.bytes || info.mtimeMs !== entry.modified) this.addEntry(entry.file, info.size, info.mtimeMs);
    }
  }
  run<T>(operation: (turn: PreparedRecallDiskTurn) => Promise<T>, protectedFile: (file: string) => boolean,
    reclaimed: (file: string) => void): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Prepared recall workspace budget is closed.'));
    const pending = this.state.tail.catch(() => undefined).then(async () => {
      await this.discover(); await this.reclaim(protectedFile, reclaimed);
      return operation({ admit: bytes => {
        if (this.state.files.size + 1 > this.state.maxPackages || this.state.bytes + bytes > this.state.maxBytes)
          throw Object.assign(new Error('Prepared recall workspace disk capacity is busy.'), { code: 'VCP_MEMORY_PREPARED_CAPACITY' });
      }, committed: (file, bytes) => this.addEntry(file, bytes, Date.now()), removed: file => this.removeEntry(file) });
    });
    this.state.tail = pending.catch(() => undefined); return pending;
  }
  snapshot() { return { workspacePackages: this.state.files.size, workspaceBytes: this.state.bytes,
    workspaceQuarantinedPackages: [...this.state.files.values()].filter(entry => entry.quarantined).length,
    maxWorkspacePackages: this.state.maxPackages, maxWorkspaceBytes: this.state.maxBytes }; }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true; this.state.references--;
    await this.state.tail;
    const key = preparedBudgetPathKey(this.state.root);
    if (!this.state.references && workspaces.get(key) === this.state) workspaces.delete(key);
  }
}
