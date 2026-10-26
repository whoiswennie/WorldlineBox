import { watch, type FSWatcher } from 'node:fs';
import { setImmediate as yieldTurn } from 'node:timers/promises';

export interface MemoryLibraryDirtyBatch {
  full: boolean; paths: string[]; directories: string[]; current(): boolean;
  escalate(reason: string, relative?: string): void;
  progress(stage: string, processed: number, total?: number): void;
  rescan(): void;
}
interface Dirty { full: boolean; paths: Set<string>; directories: Set<string> }
export interface MemoryLibraryDirtyOptions {
  directory: string;
  reconcile(owner: string, batch: MemoryLibraryDirtyBatch): Promise<void>;
  report?(error: unknown): void;
  watch?: typeof watch;
  waitMs?: number;
}
const ownerId = /^[a-zA-Z0-9_-]{1,100}$/u;
const excluded = new Set(['提示词', '形象', '来源', '记忆历史']);
const blocked = (message: string) => Object.assign(new Error(message), { code: 'MEMORY_FILES_PENDING' });

/** Notifications only request reconciliation: filenames never grant authority.
 * There is one coalescing runner per owner, and it continues after a foreground
 * wait expires. Work batches themselves yield through the library writer queue. */
export class CompanionMemoryDirtyFiles {
  private watcher?: FSWatcher;
  private watchError?: unknown;
  private closed = false;
  private readonly known = new Set<string>();
  private readonly dirty = new Map<string, Dirty>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, unknown>();
  private readonly revisions = new Map<string, number>();
  private readonly recent = new Map<string, Array<{ at: number; event: string; path: string; full: boolean }>>();
  private readonly batches = new Map<string, { full: boolean; paths: string[]; directories: string[]; startedAt: number; reason?: string; stage?: string; processed?: number; total?: number }>();
  private active = 0;
  private readonly waiting: Array<(admitted: boolean) => void> = [];
  constructor(private readonly options: MemoryLibraryDirtyOptions) {}

  start(): void {
    if (this.closed) throw blocked('伙伴记忆文件监控已经关闭。');
    if (this.watcher) return;
    try {
      const watcher = (this.options.watch ?? watch)(this.options.directory, { recursive: true }, (event, filename) => {
        if (this.closed) return;
        if (filename === null) { this.overflow(); return; }
        this.changed(event, filename.toString());
      });
      this.watcher = watcher; this.watchError = undefined;
      watcher.unref();
      watcher.on('error', error => {
        if (this.closed || this.watcher !== watcher) return;
        this.watchError = error; this.watcher = undefined; watcher.close();
        this.overflow(); this.options.report?.(error);
      });
    } catch (error) { this.watchError = error; throw blocked('伙伴记忆文件监控不可用，已暂停使用可能过时的索引。'); }
  }

  private changed(event: string, filename: string): void {
    const parts = filename.split(/[\\/]/u);
    const owner = parts.shift();
    if (!owner || !ownerId.test(owner) || !this.known.has(owner)) return;
    if (parts.some(part => !part || part === '.' || part === '..')) { this.mark(owner, undefined); return; }
    if (!parts.length) {
      this.record(owner, event, filename, event !== 'change');
      if (event === 'change') this.markDirectory(owner, ''); else this.mark(owner, undefined);
      return;
    }
    if (parts.some(part => part.startsWith('.')) || excluded.has(parts[0]!)) return;
    // These are owner role/config/status files, not notebooks. Their actual
    // consumers independently read them live and validate their own receipts.
    if (parts.length === 1 && ['profile.md', '记忆策略.json', '同步状态.md'].includes(parts[0]!)) return;
    const name = parts.at(-1)!;
    if (name.startsWith('.') || /\.meta\.json$|\.tmp$/iu.test(name)) return;
    if (/\.(?:md|txt)$/iu.test(name) && parts.length > 1) {
      if (parts[0] === '时间线' && name.startsWith('VCP-')) return;
      // The library escalates missing/unregistered paths to a full inventory.
      // A host's atomic replacement of a known body remains a cheap exact
      // check, rather than rescanning an entire large owner after every write.
      this.record(owner, event, filename, false); this.mark(owner, parts.join('/'));
    } else if (event === 'rename') { this.record(owner, event, filename, true); this.mark(owner, undefined); }
    else { this.record(owner, event, filename, false); this.markDirectory(owner, parts.join('/')); }
  }
  private record(owner: string, event: string, filename: string, full: boolean): void {
    const events = this.recent.get(owner) ?? []; events.push({ at: Date.now(), event, path: filename, full });
    if (events.length > 32) events.shift(); this.recent.set(owner, events);
  }
  snapshot(owner: string) {
    const dirty = this.dirty.get(owner);
    return { running: this.running.has(owner), batch: this.batches.get(owner), global: { active: this.active, queued: this.waiting.length, limit: 4 },
      queued: dirty ? { full: dirty.full, paths: [...dirty.paths].slice(0, 32), pathCount: dirty.paths.size, directories: [...dirty.directories] } : undefined,
      recent: this.recent.get(owner) ?? [] };
  }
  private overflow(): void { for (const owner of this.known) { this.record(owner, 'overflow', '', true); this.mark(owner, undefined); } }
  private mark(owner: string, relative: string | undefined): void {
    this.revisions.set(owner, (this.revisions.get(owner) ?? 0) + 1);
    const dirty = this.dirty.get(owner) ?? { full: false, paths: new Set<string>(), directories: new Set<string>() };
    if (relative === undefined || dirty.paths.size >= 1024) { dirty.full = true; dirty.paths.clear(); dirty.directories.clear(); }
    else if (!dirty.full) dirty.paths.add(relative);
    this.dirty.set(owner, dirty); this.errors.delete(owner);
    if (this.known.has(owner)) this.run(owner);
  }
  private markDirectory(owner: string, relative: string): void {
    this.revisions.set(owner, (this.revisions.get(owner) ?? 0) + 1);
    const dirty = this.dirty.get(owner) ?? { full: false, paths: new Set<string>(), directories: new Set<string>() };
    if (dirty.directories.size >= 128) { dirty.full = true; dirty.paths.clear(); dirty.directories.clear(); }
    else if (!dirty.full) dirty.directories.add(relative);
    this.dirty.set(owner, dirty); this.errors.delete(owner); if (this.known.has(owner)) this.run(owner);
  }
  private admit(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.active < 4 && !this.waiting.length) { this.active++; return Promise.resolve(true); }
    return new Promise(resolve => this.waiting.push(resolve));
  }
  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) { if (!this.closed) this.active++; next(!this.closed); }
  }
  private run(owner: string): Promise<void> {
    const previous = this.running.get(owner); if (previous) return previous;
    const pending = (async () => {
      // A new async turn separates watcher callbacks from a caller's
      // reconciliation AsyncLocalStorage frame.
      await yieldTurn();
      while (!this.closed && this.known.has(owner)) {
        if (!this.dirty.has(owner)) return;
        if (!await this.admit()) return;
        try {
        if (this.closed || !this.known.has(owner)) return;
        if (this.watchError || !this.watcher) throw blocked('伙伴记忆文件监控中断，需要完成重新核对后再查询。');
        const dirty = this.dirty.get(owner); if (!dirty) return;
        this.dirty.delete(owner);
        const revision = this.revisions.get(owner);
        const current = () => this.revisions.get(owner) === revision;
        const diagnostic = { full: dirty.full, paths: [...dirty.paths].slice(0, 32), directories: [...dirty.directories], startedAt: Date.now() } as NonNullable<ReturnType<typeof this.batches.get>>;
        this.batches.set(owner, diagnostic);
        try {
          await this.options.reconcile(owner, { full: dirty.full, paths: [...dirty.paths], directories: [...dirty.directories], current,
            escalate: (reason, relative) => { diagnostic.full = true; diagnostic.reason = reason + (relative ? ': ' + relative : ''); },
            progress: (stage, processed, total) => { Object.assign(diagnostic, { stage, processed, total }); },
            rescan: () => this.mark(owner, undefined) });
        }
        catch (error) {
          // Preserve an unfinished/full pass after a transient failure. A
          // later prepare or notification retries it, never silently clears it.
          const later = this.dirty.get(owner);
          this.dirty.set(owner, { full: true, paths: new Set(later?.paths), directories: new Set(later?.directories) });
          // A rename/change delivered during this failed pass may already
          // repair a transient missing path. Reconcile that newer generation
          // autonomously; a stable conflict still stops and remains blocked.
          if (!current()) { await yieldTurn(); continue; }
          throw error;
        }
        } finally { this.release(); }
        await yieldTurn();
      }
    })();
    this.running.set(owner, pending);
    void pending.then(() => this.errors.delete(owner), error => { this.errors.set(owner, error); this.options.report?.(error); }).finally(() => {
      if (this.running.get(owner) === pending) this.running.delete(owner);
      this.batches.delete(owner);
    });
    return pending;
  }
  async prepare(owner: string): Promise<void> {
    if (!ownerId.test(owner)) throw new Error('伙伴标识无效。');
    this.start();
    if (!this.known.has(owner)) { this.known.add(owner); this.mark(owner, undefined); }
    // Let already queued native notifications enter the coalescing queue.
    await yieldTurn();
    const pending = this.running.get(owner) ?? (this.dirty.has(owner) ? this.run(owner) : undefined);
    if (!pending) { const error = this.errors.get(owner); if (error) throw error; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(blocked('伙伴记忆文件仍在分批核对，后台会继续处理，请稍后重试。'),
          { memoryFilePreparation: this.snapshot(owner) })), this.options.waitMs ?? 5000);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async forget(owner: string): Promise<void> {
    this.known.delete(owner); this.dirty.delete(owner); this.errors.delete(owner);
    await this.running.get(owner)?.catch(() => undefined);
    this.dirty.delete(owner); this.errors.delete(owner); this.revisions.delete(owner); this.recent.delete(owner); this.batches.delete(owner);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const waiting of this.waiting.splice(0)) waiting(false);
    const watcher = this.watcher; this.watcher = undefined;
    if (watcher) await new Promise<void>(resolve => { watcher.once('close', resolve); watcher.close(); });
    await Promise.allSettled(this.running.values()); this.dirty.clear(); this.known.clear(); this.revisions.clear(); this.recent.clear(); this.batches.clear();
  }
}
