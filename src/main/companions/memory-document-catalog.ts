import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher, type Dir } from 'node:fs';
import { lstat, opendir } from 'node:fs/promises';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryDocument } from '../../shared/companion-memory-documents';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { memoryLibraryPathParts, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession } from './memory-library';

type State = { generation: string; frames: Array<{ relative: string; dir: Dir }>; started: boolean; complete: boolean; indexed: number; dirty: Set<string>; watcher?: FSWatcher; job?: Promise<void>; error?: string; lastScan: number };
interface Options {
  library: CompanionMemoryLibrary;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  describe(relative: string, content: string, updatedAt: string, note?: CompanionMemory, entry?: MemoryLibraryDocumentSession['manifest']['files'][string]): CompanionMemoryDocument;
}
/** Incremental, persistent file catalogue. Only bounded pages are hydrated through the authoritative document reader. */
export class CompanionMemoryDocumentCatalog {
  private closed = false;
  private readonly states = new Map<string, State>();
  constructor(private readonly options: Options) {}
  async ensure(session: MemoryLibraryDocumentSession): Promise<State> {
    let state = this.states.get(session.owner.id);
    if (!state) {
      state = { generation: randomUUID(), frames: [], started: false, complete: false, indexed: 0, dirty: new Set(), lastScan: Date.now() };
      this.states.set(session.owner.id, state);
      try {
        state.watcher = watch(session.root, { recursive: true }, (_event, filename) => {
          if (this.closed || !filename) return;
          let relative = filename.replaceAll('\\', '/');
          if (relative.endsWith('.meta.json')) relative = relative.slice(0, -10);
          if (relative.split('/').some(part => part.startsWith('.'))) return;
          try { memoryLibraryPathParts(relative); } catch { return; }
          if (state!.error) state!.lastScan = 0;
          // A rename can affect a folder; a bounded rescan discovers descendants.
          if (!/\.(md|txt)$/iu.test(relative)) { state!.lastScan = 0; return; }
          state!.dirty.add(relative);
          this.schedule(session.owner.id, state!);
        });
        state.watcher.on('error', error => { state!.error = error.message; state!.lastScan = 0; });
      } catch (error) { state.error = error instanceof Error ? error.message : String(error); }
      await this.batch(session, state, 128);
    } else if (state.dirty.size) await this.refresh(session, state, 64);
    if (state.complete && Date.now() - state.lastScan > 60_000) {
      for (const frame of state.frames) await frame.dir.close().catch(() => undefined);
      state.frames = []; state.error = undefined;
      state.generation = randomUUID(); state.started = false; state.complete = false; state.indexed = 0; state.lastScan = Date.now();
    }
    this.schedule(session.owner.id, state);
    return state;
  }
  private async one(session: MemoryLibraryDocumentSession, relative: string, state: State, force = false): Promise<void> {
    if (!/\.(md|txt)$/iu.test(relative)) return;
    memoryLibraryPathParts(relative);
    const entry = session.manifest.files[relative];
    let info;
    try { info = await lstat(session.file(relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!info || entry?.state === 'forgotten') {
      await this.options.request({ type: 'document.catalog.drop', companionId: session.owner.id, paths: [relative] }); return;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`记忆目录不能包含链接或目录联接：${relative}`);
    const stamp = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${entry?.version ?? ''}:${entry?.hash ?? ''}:${entry?.state ?? ''}`;
    if (!force && (await this.options.request({ type: 'document.catalog.touch', companionId: session.owner.id, path: relative, stamp, generation: state.generation })).documentCatalogUnchanged) return;
    if (info.size > 8_000_000) return;
    const content = await session.text(relative, true); if (content === undefined || content.length > 2_000_000) return;
    const note = entry?.noteId ? await session.current(entry) : undefined;
    if (entry?.noteId && !note) { await this.options.request({ type: 'document.catalog.drop', companionId: session.owner.id, paths: [relative] }); return; }
    const document = this.options.describe(relative, content, info.mtime.toISOString(), note, entry);
    await this.options.request({ type: 'document.catalog.put', companionId: session.owner.id, generation: state.generation,
      entries: [{ document, text: content, stamp }] });
  }
  private async refresh(session: MemoryLibraryDocumentSession, state: State, limit: number): Promise<void> {
    for (const relative of [...state.dirty].slice(0, limit)) { state.dirty.delete(relative); await this.one(session, relative, state, true); }
  }
  private async batch(session: MemoryLibraryDocumentSession, state: State, limit: number): Promise<void> {
    if (!state.started) { state.frames.push({ relative: '', dir: await opendir(session.root) }); state.started = true; }
    let visited = 0;
    while (state.frames.length && visited < limit && !this.closed) {
      const frame = state.frames.at(-1)!, entry = await frame.dir.read();
      if (!entry) { await frame.dir.close(); state.frames.pop(); continue; }
      visited++;
      if (entry.name.startsWith('.')) continue;
      const relative = frame.relative ? frame.relative + '/' + entry.name : entry.name;
      memoryLibraryPathParts(relative);
      if (entry.isSymbolicLink()) throw new Error(`记忆目录包含链接，已停止索引：${relative}`);
      if (entry.isDirectory()) {
        // Resolve every ancestor through the library's path checks before opening it.
        await session.text(relative + '/worldlinebox-validation-placeholder', true);
        await this.options.request({ type: 'document.catalog.put', companionId: session.owner.id, generation: state.generation, entries: [], folders: [relative] });
        state.frames.push({ relative, dir: await opendir(session.file(relative)) });
      } else if (entry.isFile() && /\.(md|txt)$/iu.test(entry.name)) { await this.one(session, relative, state); state.indexed++; }
    }
    if (!state.frames.length) {
      state.complete = true; state.lastScan = Date.now();
      await this.options.request({ type: 'document.catalog.finish', companionId: session.owner.id, generation: state.generation });
    }
  }
  private schedule(owner: string, state: State): void {
    if (this.closed || state.job || state.complete && !state.dirty.size) return;
    const job = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (this.closed) return;
      await this.options.library.withDocuments(owner, async session => {
        await this.refresh(session, state, 64);
        if (!state.complete) await this.batch(session, state, 128);
      }, { synchronize: false });
    }).catch((error: unknown) => { state.error = error instanceof Error ? error.message : String(error); state.complete = true; }).finally(() => {
      state.job = undefined;
      if (!this.closed && !state.error) this.schedule(owner, state);
    });
    state.job = job;
  }
  mark(owner: string, ...files: string[]): void {
    const state = this.states.get(owner); if (!state) return;
    for (const file of files) {
      if (/\.(md|txt)$/iu.test(file)) state.dirty.add(file); else state.lastScan = 0;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const state of this.states.values()) state.watcher?.close();
    await Promise.allSettled([...this.states.values()].map(state => state.job));
    for (const state of this.states.values()) for (const frame of state.frames) await frame.dir.close().catch(() => undefined);
    this.states.clear();
  }
}
