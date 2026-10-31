import { createHash, randomUUID } from 'node:crypto';
import type { CompanionMemory } from '../../shared/companions';
import type { CompanionMemoryDocument } from '../../shared/companion-memory-documents';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession } from './memory-library';
import { companionHistoryView, companionNarrativeText } from '../../shared/companion-memory-content';
import { detachedCompanionExecutionValidation, withCompanionExecutionValidation } from './source-execution-evidence';

type State = { generation: string; signature: string; paths: string[]; cursor: number; complete: boolean; indexed: number; dirty: Set<string>; job?: Promise<void>; batch?: Promise<void>; error?: string };
interface Options {
  library: CompanionMemoryLibrary; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  describe(relative: string, content: string, updatedAt: string, note?: CompanionMemory, entry?: MemoryLibraryDocumentSession['manifest']['files'][string]): CompanionMemoryDocument;
}
/** A rebuildable search index over registered artifacts only. No filesystem
 * watcher, directory walk, filename discovery or ingestion permission exists. */
export class CompanionMemoryDocumentCatalog {
  private closed = false;
  private readonly states = new Map<string, State>();
  private readonly jobs = new Set<Promise<void>>();
  constructor(private readonly options: Options) {}
  async ensure(session: MemoryLibraryDocumentSession): Promise<State> {
    const paths = Object.entries(session.manifest.files).filter(([file, entry]) => /\.(?:md|txt)$/iu.test(file) && entry.artifact.kind !== 'context_snapshot' && !file.startsWith('.运行/')).map(([file]) => file).sort();
    const signature = createHash('sha256').update(JSON.stringify(paths.map(file => [file, session.manifest.files[file]!.artifact.contentRevision, session.manifest.files[file]!.hash]))).digest('hex');
    let state = this.states.get(session.owner.id);
    if (!state || state.signature !== signature) {
      state = { generation: randomUUID(), signature, paths, cursor: 0, complete: false, indexed: 0, dirty: new Set() }; this.states.set(session.owner.id, state);
    }
    // First paint needs a small useful page, not a serial read of 64 bodies.
    // The remaining registered entries continue on the background lane.
    if (!state.batch && !state.complete && !state.indexed) await this.batch(session, state, 12);
    this.schedule(session.owner.id, state); return state;
  }
  private async one(session: MemoryLibraryDocumentSession, relative: string, state: State) {
    const entry = await session.currentEntry(relative);
    if (!entry) { await this.dropped(session.owner.id, relative); return; }
    const note = entry.noteId ? await session.current(entry) : undefined;
    if (entry.noteId && !note) { await this.dropped(session.owner.id, relative); return; }
    if (entry.artifact.kind === 'navigation' && !await session.timelineValid(relative, entry.hash)) { await this.dropped(session.owner.id, relative); return; }
    if (this.states.get(session.owner.id) !== state || this.closed) return;
    const stamp = JSON.stringify([entry.artifact.contentRevision, entry.hash, note?.version, note?.tags]);
    const unchanged = await this.options.request({ type: 'document.catalog.touch', companionId: session.owner.id, generation: state.generation, path: relative, stamp });
    if (unchanged.documentCatalogUnchanged) return;
    const content = await session.text(relative);
    if (content === undefined || content.length > 2_000_000) return;
    if (this.states.get(session.owner.id) !== state || this.closed) return;
    const document = this.options.describe(relative, content, entry.artifact.committedAt, note, entry);
    await this.options.request({ type: 'document.catalog.put', companionId: session.owner.id, generation: state.generation,
      entries: [{ document, text: entry.artifact.kind === 'revision_history' ? companionHistoryView(content)?.content ?? '' : companionNarrativeText(content), stamp }] });
  }
  private batch(session: MemoryLibraryDocumentSession, state: State, limit: number): Promise<void> {
    // Foreground and background fills share one cursor; the generation is
    // complete only after every earlier entry has finished its durable put.
    const batch = (state.batch ?? Promise.resolve()).then(() => this.fill(session, state, limit)); state.batch = batch;
    void batch.finally(() => { if (state.batch === batch) state.batch = undefined; }).catch(() => undefined); return batch;
  }
  private async fill(session: MemoryLibraryDocumentSession, state: State, limit: number) {
    for (const file of [...state.dirty].slice(0, limit)) { if (this.states.get(session.owner.id) !== state || this.closed) return; state.dirty.delete(file); await this.one(session, file, state); }
    for (let count = 0; count < limit && state.cursor < state.paths.length; count++) { if (this.states.get(session.owner.id) !== state || this.closed) return; await this.one(session, state.paths[state.cursor++]!, state); state.indexed++; }
    if (this.states.get(session.owner.id) === state && !this.closed && state.cursor === state.paths.length && !state.complete) { await this.options.request({ type: 'document.catalog.finish', companionId: session.owner.id, generation: state.generation }); state.complete = true; }
  }
  private schedule(owner: string, state: State) {
    if (this.closed || state.job || state.complete && !state.dirty.size) return;
    // Catalog work belongs to this owner, not the UI read's proof lifetime.
    // Existing closed/state checks still cancel an invalidated owner job.
    const job = detachedCompanionExecutionValidation(() => new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (!this.closed && this.states.get(owner) === state) await withCompanionExecutionValidation(() =>
        this.options.library.withDocuments(owner, session => this.batch(session, state, 64), { readOnly: true }));
    })).catch(cause => { state.error = cause instanceof Error ? cause.message : '登记索引不可核实。'; state.complete = true; }).finally(() => {
      this.jobs.delete(job);
      state.job = undefined; if (!this.closed && !state.error && this.states.get(owner) === state) this.schedule(owner, state);
    });
    state.job = job; this.jobs.add(job);
  }
  mark(owner: string, ...files: string[]) { const state = this.states.get(owner); if (state) for (const file of files) if (state.paths.includes(file)) state.dirty.add(file); }
  async dropped(owner: string, relative: string) { await this.options.request({ type: 'document.catalog.drop', companionId: owner, paths: [relative] }); }
  async forgetOwner(owner: string) { const state = this.states.get(owner); this.states.delete(owner); await state?.job; }
  async close() { this.closed = true; await Promise.allSettled(this.jobs); this.states.clear(); }
}
