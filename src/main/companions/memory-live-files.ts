import { createHash } from 'node:crypto';
import type { CompanionMemory } from '../../shared/companions';
import { companionMemoryFileReceiptsSchema, type CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';
import { companionMemoryRegisteredPath, type CompanionMemoryLibrary, type MemoryLibraryDocumentSession } from './memory-library';
import type { CompanionMemoryHistoryFiles } from './memory-history-files';
import { withCompanionExecutionValidation } from './source-execution-evidence';
import { companionAttestedMemoryFileCurrent, companionAttestedMemoryFileInputs, type CompanionAttestedMemoryFiles } from './execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
export class CompanionMemoryLiveFileError extends Error {
  readonly code = 'MEMORY_FILE_CHANGED'; readonly noteIds: readonly string[];
  constructor(message: string, options?: ErrorOptions & { noteIds?: readonly string[] }) { super(message, options); this.name = 'CompanionMemoryLiveFileError'; this.noteIds = options?.noteIds ?? []; }
}
export interface CompanionMemoryFileFlush { checked: number; published: number; pending: boolean; nextCursor?: number }
/** Only the typed system outbox may publish. Reading never repairs a missing
 * body, imports external bytes, discovers a directory or falls back to SQL. */
export class CompanionMemoryLiveFiles {
  constructor(private readonly options: { library: CompanionMemoryLibrary; maxFilesPerFlush?: number; history?: Pick<CompanionMemoryHistoryFiles, 'readInSession' | 'readManyInSession'> }) {}
  flush(owner: string, input: { noteIds?: readonly string[]; limit?: number; cursor?: number; reconcile?: boolean } = {}): Promise<CompanionMemoryFileFlush> {
    return this.options.library.withDocuments(owner, async session => {
      const limit = Math.max(1, Math.min(256, input.limit ?? this.options.maxFilesPerFlush ?? 64)), cursor = Math.max(0, input.cursor ?? 0);
      let notes: CompanionMemory[] = [], pending: boolean, nextCursor: number | undefined;
      if (input.noteIds) {
        const ids = [...new Set(input.noteIds)], selected = ids.slice(cursor, cursor + limit);
        for (const id of selected) { const note = (await session.request({ type: 'memory.library.read', companionId: owner, id })).memoryRead?.memory; if (note) notes.push(note); }
        pending = cursor + selected.length < ids.length; nextCursor = pending ? cursor + selected.length : undefined;
      } else {
        const page = (await session.request({ type: 'memory.library.page', companionId: owner, cursor, limit })).memoryPage;
        notes = page?.items.map(item => item.memory) ?? []; pending = page?.hasMore ?? false; nextCursor = page?.nextCursor;
      }
      let published = 0;
      for (const note of notes) {
        const relative = companionMemoryRegisteredPath(note), old = await session.registry.get(`memory:${note.id}`);
        await session.project(relative, note);
        if (old?.contentRevision !== session.manifest.files[relative]?.artifact.contentRevision) published++;
      }
      return { checked: notes.length, published, pending, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    });
  }
  private async authorized(session: MemoryLibraryDocumentSession, note: CompanionMemory,
    existing?: Awaited<ReturnType<MemoryLibraryDocumentSession['registry']['read']>>,
    actual?: CompanionMemory, sourceChecks?: Map<string, Promise<unknown>>) {
    if (note.companionId !== session.owner.id || !note.contentRevision) throw new CompanionMemoryLiveFileError('正文缺少当前伙伴的准确修订。');
    const result = existing ?? await session.registry.read({ artifactId: `memory:${note.id}`, consumer: 'audit' });
    if (result.artifact.kind !== note.artifactKind || result.artifact.relativePath !== companionMemoryRegisteredPath(note)) throw new CompanionMemoryLiveFileError('正文登记类型或位置不一致。');
    const checked = actual ?? (await session.request({ type: 'memory.library.read', companionId: note.companionId, id: note.id })).memoryRead?.memory;
    if (!checked || checked.id !== note.id || checked.companionId !== note.companionId || checked.contentRevision !== note.contentRevision || checked.artifactKind !== note.artifactKind || result.text !== note.content || checked.content !== result.text) throw new CompanionMemoryLiveFileError('正文或真实来源修订已变化；必须重新建立上下文。');
    const missing = new Map<string, { artifactId: string; consumer: 'source_verification'; audienceIds: string[] }>();
    const waits: Promise<unknown>[] = [];
    for (const reference of result.artifact.sourceRefs) {
      // Several selected notes can cite the same original message. Verify that
      // exact source once in this gate, with its revision/hash and audience in
      // the key. Each materialize/validate call owns a fresh map, so a later
      // admission still reads the bytes and observes edits or withdrawal.
      const key = JSON.stringify([reference, note.sourceConversationId]);
      const checked = sourceChecks?.get(key);
      if (checked) waits.push(checked);
      else missing.set(key, { artifactId: reference.artifactId, consumer: 'source_verification', audienceIds: [note.sourceConversationId] });
    }
    if (missing.size) {
      const batch = session.registry.readMany([...missing.values()]);
      for (const key of missing.keys()) sourceChecks?.set(key, batch);
      waits.push(batch);
    }
    await Promise.all(waits);
    return result;
  }
  materialize(owner: string, notes: readonly CompanionMemory[]): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
    return withCompanionExecutionValidation(() => this.options.library.withDocuments(owner, async session => {
      const values: Array<{ note: CompanionMemory; receipt: CompanionMemoryFileReceipt }> = [];
      const sourceChecks = new Map<string, Promise<unknown>>();
      for (const note of notes) try {
        const current = await this.authorized(session, note, undefined, undefined, sourceChecks);
        values.push({ note: { ...note, content: current.text }, receipt: { companionId: owner, noteId: note.id, contentRevision: note.contentRevision!, path: current.artifact.relativePath, contentHash: current.artifact.contentHash } });
      } catch (cause) { throw new CompanionMemoryLiveFileError(cause instanceof Error ? cause.message : '正文不可读取。', { cause, noteIds: [note.id] }); }
      return { notes: values.map(value => value.note), receipts: values.map(value => value.receipt) };
    }, { readOnly: true }));
  }
  projectionNotes(owner: string, notes: readonly CompanionMemory[]): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
    return withCompanionExecutionValidation(() => this.options.library.withDocuments(owner, async session => {
      if (!this.options.history) throw new CompanionMemoryLiveFileError('原生投影未连接正式历史正文。');
      const scope = (await session.request({ type: 'memory.library.scope.read', companionId: owner })).conversation;
      if (!scope) throw new CompanionMemoryLiveFileError('原生投影没有授权范围。');
      const result: Array<{ note: CompanionMemory; receipt: CompanionMemoryFileReceipt }> = [];
      for (const note of notes) if (note.companionId !== owner || !note.contentRevision) throw new CompanionMemoryLiveFileError('原生投影修订身份无效。');
      const currentFiles = await session.registry.readMany(notes.map(note => ({ artifactId: `memory:${note.id}`, consumer: 'audit' as const })));
      const histories = await this.options.history.readManyInSession(session, { companionId: owner, conversationId: scope.id },
        notes.map(note => ({ id: note.id, contentRevision: note.contentRevision! })));
      for (let index = 0; index < notes.length; index++) {
        const note = notes[index]!, current = currentFiles[index]!, actual = histories[index]!;
        if (note.companionId !== owner || !note.contentRevision) throw new CompanionMemoryLiveFileError('原生投影修订身份无效。');
        if (actual.content !== note.content || actual.artifactKind !== note.artifactKind) throw new CompanionMemoryLiveFileError('捕获正文与正式历史版本不一致。');
        result.push({ note: { ...note, content: actual.content }, receipt: { companionId: owner, noteId: note.id, contentRevision: note.contentRevision, path: current.artifact.relativePath, contentHash: hash(actual.content) } });
      }
      return { notes: result.map(value => value.note), receipts: result.map(value => value.receipt) };
    }, { readOnly: true, sourceDelivery: true }));
  }
  async validate(owner: string, receipts: readonly CompanionMemoryFileReceipt[], validationWindow?: object): Promise<boolean> {
    return await this.validateWithin(owner, receipts, validationWindow) === true;
  }
  /** Only an outer exact SQL-attested readset can separate current-row
   * authority from the derived execution DAG it is already checking. */
  async validateAttested(authority: CompanionAttestedMemoryFiles,
    request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, receipts?: readonly CompanionMemoryFileReceipt[]): Promise<boolean | undefined> {
    const input = companionAttestedMemoryFileInputs(authority);
    if (!input) return false;
    const selected = companionMemoryFileReceiptsSchema.safeParse(receipts ?? input.receipts);
    const permitted = new Set(input.receipts.map(receipt => JSON.stringify(receipt)));
    if (!selected.success || !selected.data.length || selected.data.some(receipt => !permitted.has(JSON.stringify(receipt)))) return false;
    return this.validateWithin(input.scope.companionId, selected.data, undefined, { authority, request });
  }
  private async validateWithin(owner: string, receipts: readonly CompanionMemoryFileReceipt[], validationWindow?: object,
    attested?: { authority: CompanionAttestedMemoryFiles; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> }): Promise<boolean | undefined> {
    // This port always rechecks canonical bytes and source authorization; a
    // caller's shared validation window must not cache filesystem authority.
    void validationWindow;
    const input = companionMemoryFileReceiptsSchema.safeParse(receipts);
    if (!input.success || input.data.some(receipt => receipt.companionId !== owner)) return false;
    try { return await withCompanionExecutionValidation(() => this.options.library.withDocuments(owner, async session => {
      if (!input.data.length) return true;
      const request = attested ? attested.request : session.request;
      const scope = (await request({ type: 'memory.library.scope.read', companionId: owner })).conversation;
      if (!scope) return false;
      const currentNotes = new Map<string, CompanionMemory>();
      const ids = [...new Set(input.data.map(receipt => receipt.noteId))];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const response = await request({ type: 'memory.records.filter', companionId: owner, conversationId: scope.id, ids: ids.slice(offset, offset + 100) });
        if (!response.ok) return false;
        for (const note of response.memories ?? []) currentNotes.set(note.id, note);
      }
      // Historical/current-version changes keep the original full admission.
      // A partial token can never make an uncovered member a raw SQL read.
      if (attested && input.data.some(receipt => {
        const note = currentNotes.get(receipt.noteId);
        return !note || note.contentRevision !== receipt.contentRevision || !companionAttestedMemoryFileCurrent(attested.authority, note);
      })) return undefined;
      const registrations = await session.registry.getMany(ids.map(id => `memory:${id}`), true);
      const committed = registrations.filter(artifact => artifact.publicationState === 'committed');
      const bodies = await session.registry.readMany(committed.map(artifact => ({ artifactId: artifact.artifactId, consumer: 'audit' as const })));
      const currentFiles = new Map(bodies.map(body => [body.artifact.artifactId, body]));
      const sources = new Map<string, { request: { artifactId: string; consumer: 'source_verification'; audienceIds: string[] };
        contentRevision: number; contentHash: string }>();
      const usedCurrent = new Map<string, CompanionMemory>();
      const historical: CompanionMemoryFileReceipt[] = [];
      for (const receipt of input.data) {
        const registered = registrations.find(artifact => artifact.artifactId === `memory:${receipt.noteId}`);
        if (!registered || registered.relativePath !== receipt.path) return false;
        // A later revision may lawfully lose one of its sources while an old
        // captured revision retains independent authorization. Active current
        // files still fail closed on any external change before history use.
        const current = currentFiles.get(registered.artifactId), actual = currentNotes.get(receipt.noteId);
        // Reuse only the bytes and guarded note just read in this validation.
        // Reopening the same body/derived-source DAG here doubled every gate;
        // no receipt survives into a later validation or skips a source check.
        if (actual?.contentRevision === receipt.contentRevision && current?.artifact.contentHash === receipt.contentHash) {
          if (actual.companionId !== owner || current.artifact.kind !== actual.artifactKind
            || current.artifact.relativePath !== companionMemoryRegisteredPath(actual) || current.text !== actual.content) return false;
          usedCurrent.set(actual.id, actual);
          for (const reference of current.artifact.sourceRefs) sources.set(JSON.stringify([reference, actual.sourceConversationId]),
            { request: { artifactId: reference.artifactId, consumer: 'source_verification', audienceIds: [actual.sourceConversationId] },
              contentRevision: reference.contentRevision, contentHash: reference.contentHash });
        } else historical.push(receipt);
      }
      const witnesses = [...sources.values()], originalSources = await session.registry.readMany(witnesses.map(witness => witness.request));
      if (originalSources.some((source, index) => source.artifact.kind !== 'source_evidence'
        || source.artifact.contentRevision !== witnesses[index]!.contentRevision || source.artifact.contentHash !== witnesses[index]!.contentHash)) return false;
      if (historical.length) {
        if (!this.options.history) return false;
        const originals = await this.options.history.readManyInSession(session, { companionId: owner, conversationId: scope.id },
          historical.map(receipt => ({ id: receipt.noteId, contentRevision: receipt.contentRevision })));
        if (originals.some((note, index) => hash(note.content) !== historical[index]!.contentHash)) return false;
      }
      const selected = [...usedCurrent.values()];
      for (let offset = 0; offset < selected.length; offset += 100) {
        const expected = selected.slice(offset, offset + 100), response = await request({ type: 'memory.records.filter',
          companionId: owner, conversationId: scope.id, ids: expected.map(note => note.id) });
        if (!response.ok || expected.some(note => !response.memories?.some(actual => actual.id === note.id && actual.companionId === owner
          && actual.contentRevision === note.contentRevision && actual.artifactKind === note.artifactKind && actual.content === note.content
          && JSON.stringify(actual.sources) === JSON.stringify(note.sources)))) return false;
      }
      return true;
    }, { readOnly: true, sourceDelivery: true })); } catch { return false; }
  }
}
