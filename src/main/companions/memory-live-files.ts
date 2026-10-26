import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CompanionMemory } from '../../shared/companions';
import { companionMemoryFileReceiptsSchema, type CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';
import type { CompanionMemoryLibrary, MemoryLibraryDocumentSession, MemoryLibraryEntry } from './memory-library';
import type { CompanionMemoryHistoryFiles } from './memory-history-files';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const category = (note: CompanionMemory) => note.diaryName === '资料' || note.diaryName === '自我认识' ? note.diaryName
  : note.sources.some(source => source.sourceType === 'world_observation') ? '世界经历' : ['日记', '世界经历', '时间线'].includes(note.diaryName ?? '') ? note.diaryName! : '日记';
const inside = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
export class CompanionMemoryLiveFileError extends Error {
  readonly code = 'MEMORY_FILE_CHANGED';
  readonly noteIds: readonly string[];
  constructor(message: string, options?: ErrorOptions & { noteIds?: readonly string[] }) { super(message, options); this.name = 'CompanionMemoryLiveFileError'; this.noteIds = options?.noteIds ?? []; }
}
export interface CompanionMemoryFileFlush {
  checked: number; published: number; pending: boolean; nextCursor?: number;
}
type NoteFiles = Map<string, Array<[string, MemoryLibraryEntry]>>;
/** Bound filesystem concurrency, while retaining the caller's complete order. */
async function mapLiveFiles<T, R>(items: readonly T[], operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length); let cursor = 0, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (cursor < items.length && failure === undefined) {
      const index = cursor++;
      try { results[index] = await operation(items[index]!); } catch (error) { failure ??= error; }
    }
  }));
  if (failure !== undefined) throw failure; return results;
}
/** Text files are the current document content. SQL is the immutable revision,
 * provenance and authorization ledger; VCP is a derived retrieval projection.
 * A changed file must first be reconciled through that ledger, never silently
 * substituted into an old authorized revision or overwritten from stale SQL. */
export class CompanionMemoryLiveFiles {
  private readonly bodyCaches = new WeakMap<object, { entries: Map<string, { stamp: string; content: string; bytes: number }>; bytes: number }>();
  private readonly roleWindows = new WeakMap<object, string>();
  // Admission-local only: at the default 128 pending recalls, serialized body
  // residency is at most 8 MiB. Nothing carries across tasks or retains the key.
  private readonly maxBodyCacheBytes = 64 * 1024;
  constructor(private readonly options: { library: CompanionMemoryLibrary; maxFilesPerFlush?: number; history?: Pick<CompanionMemoryHistoryFiles, 'readInSession'> }) {}
  private retainBody(window: object, file: string, value: { stamp: string; content: string; bytes: number }): void {
    let cache = this.bodyCaches.get(window);
    if (!cache) { cache = { entries: new Map(), bytes: 0 }; this.bodyCaches.set(window, cache); }
    const current = cache.entries.get(file);
    if (current) { cache.entries.delete(file); cache.bytes -= current.bytes; }
    while (cache.entries.size && cache.bytes + value.bytes > this.maxBodyCacheBytes) {
      const [oldFile, previous] = cache.entries.entries().next().value!; cache.entries.delete(oldFile); cache.bytes -= previous.bytes;
    }
    if (value.bytes <= this.maxBodyCacheBytes) { cache.entries.set(file, value); cache.bytes += value.bytes; }
  }
  /** The library's storage port must bypass Main's after-write flush hook:
   * reconciliation itself writes a new revision while holding this owner queue. */
  flush(owner: string, input: { noteIds?: readonly string[]; limit?: number; cursor?: number; reconcile?: boolean } = {}): Promise<CompanionMemoryFileFlush> {
    const limit = Math.max(1, Math.min(256, input.limit ?? this.options.maxFilesPerFlush ?? 64)), cursor = Math.max(0, input.cursor ?? 0);
    return this.options.library.withDocuments(owner, async session => {
      const index = this.index(session);
      let notes: CompanionMemory[], pending: boolean, nextCursor: number | undefined;
      if (input.noteIds) {
        const ids = [...new Set(input.noteIds)], selected = ids.slice(cursor, cursor + limit); notes = [];
        for (const id of selected) {
          const note = (await session.request({ type: 'memory.library.read', companionId: owner, id })).memoryRead?.memory;
          if (note) notes.push(note);
        }
        pending = cursor + selected.length < ids.length; nextCursor = pending ? cursor + selected.length : undefined;
      } else {
        const page = (await session.request({ type: 'memory.library.page', companionId: owner, cursor, limit })).memoryPage;
        notes = page?.items.map(item => item.memory) ?? []; pending = page?.hasMore ?? false; nextCursor = page?.nextCursor;
      }
      // Persist the bounded batch's publication intents before any body is
      // written. A crash leaves recoverable projecting entries, while a large
      // notebook no longer rewrites its full manifest once for every new note.
      const creating = new Map<string, string>();
      for (const note of notes) {
        if (note.companionId !== owner) throw new CompanionMemoryLiveFileError('文件提交的伙伴归属不一致。');
        const matches = (index.get(note.id) ?? []).filter(([, entry]) => entry.state !== 'forgotten' || entry.withdrawn);
        if (matches.length > 1) throw new CompanionMemoryLiveFileError('同一记忆关联了多个受管正文，请先核对文档身份。');
        const relative = matches[0]?.[0] ?? `${category(note)}/${note.id}.md`, previous = matches[0]?.[1];
        if (previous && !previous.withdrawn) continue;
        const actual = await session.text(relative, true);
        if (actual !== undefined && actual !== note.content) throw new CompanionMemoryLiveFileError('文件已有不同正文，保留外部修改并停止覆盖。');
        await session.directory(path.posix.dirname(relative));
        creating.set(note.id, relative);
        session.manifest.files[relative] = { noteId: note.id, conversationId: note.sourceConversationId, state: 'projecting', version: note.version, hash: hash(note.content) };
      }
      if (creating.size) await session.save();
      let published = 0;
      for (const note of notes) {
        if (note.companionId !== owner) throw new CompanionMemoryLiveFileError('文件提交的伙伴归属不一致。');
        const matches = (index.get(note.id) ?? []).filter(([, entry]) => entry.state !== 'forgotten' || entry.withdrawn);
        if (matches.length > 1) throw new CompanionMemoryLiveFileError('同一记忆关联了多个受管正文，请先核对文档身份。');
        const relative = matches[0]?.[0] ?? `${category(note)}/${note.id}.md`, previous = matches[0]?.[1];
        if (!creating.has(note.id) && previous && !previous.withdrawn) {
          await session.reconcile(relative);
          const current = session.manifest.files[relative];
          if (!current || current.state === 'forgotten' || current.conflict || current.missingCycle !== undefined
            || await session.text(relative, true) === undefined) throw new CompanionMemoryLiveFileError('正文缺失、撤回或存在并发修改，尚未恢复为可读文件。');
          if (previous.version !== current.version || previous.hash !== current.hash) published++;
        } else {
          await session.project(relative, note); published++;
        }
        const committed = session.manifest.files[relative];
        if (!committed || committed.state !== 'tracked' || committed.withdrawn || committed.pending || committed.conflict)
          throw new CompanionMemoryLiveFileError('正文发布期间来源或版本已变化，本次文件提交尚未完成。', { noteIds: [note.id] });
        index.set(note.id, [[relative, committed]]);
      }
      await session.save(); return { checked: notes.length, published, pending, ...(nextCursor !== undefined ? { nextCursor } : {}) };
    }, { synchronize: input.reconcile !== false });
  }
  private async read(session: MemoryLibraryDocumentSession, relative: string, window?: object): Promise<string> {
    const file = session.file(relative), root = await realpath(session.root);
    const verifyPath = async () => {
      let ancestor = session.root;
      for (const part of path.relative(session.root, path.dirname(file)).split(path.sep).filter(Boolean)) {
        ancestor = path.join(ancestor, part); const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new CompanionMemoryLiveFileError('正文所在目录不能包含链接或目录联接。');
      }
      if (!inside(root, await realpath(file))) throw new CompanionMemoryLiveFileError('正文已离开此伙伴的受管目录。');
    };
    await verifyPath(); const before = await lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1_048_576n) throw new CompanionMemoryLiveFileError('正文不是受管普通文本文件或超过读取上限。');
    const stamp = `${before.dev}:${before.ino}:${before.nlink}:${before.size}:${before.mtimeNs}:${before.ctimeNs}:${before.birthtimeNs}`;
    const same = (left: typeof before, right: typeof before) => left.dev === right.dev && left.ino === right.ino && left.size === right.size
      && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
    const cached = window ? this.bodyCaches.get(window)?.entries.get(file) : undefined;
    if (window && cached?.stamp === stamp) {
      // A content receipt remains authorized by the ledger separately. This
      // cache only avoids rereading identical file bytes: exact OS identity,
      // nanosecond metadata, regular-file/link checks and path checks still run
      // at both sides, including every pre-model validation batch.
      await verifyPath(); const after = await lstat(file, { bigint: true });
      if (!same(before, after) || after.isSymbolicLink() || after.nlink !== 1n) throw new CompanionMemoryLiveFileError('正文在校验期间变化，请重新读取。');
      this.retainBody(window, file, cached); return cached.content;
    }
    const handle = await open(file, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!same(before, opened)) throw new CompanionMemoryLiveFileError('正文在打开期间变化，请重新读取。');
      const buffer = Buffer.alloc(Number(before.size) + 1); let count = 0;
      while (count < buffer.length) { const part = await handle.read(buffer, count, buffer.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
      const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true }); await verifyPath();
      if (!same(before, after) || !same(before, current) || current.isSymbolicLink() || count !== Number(before.size)) throw new CompanionMemoryLiveFileError('正文在读取期间变化，请重新读取。');
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count));
      if (window) this.retainBody(window, file, { stamp, content, bytes: Buffer.byteLength(content) });
      return content;
    } finally { await handle.close(); }
  }
  private index(session: MemoryLibraryDocumentSession): NoteFiles {
    const index: NoteFiles = new Map();
    for (const [relative, entry] of Object.entries(session.manifest.files)) if (entry.noteId) {
      const values = index.get(entry.noteId) ?? []; values.push([relative, entry]); index.set(entry.noteId, values);
    }
    return index;
  }
  private entry(index: NoteFiles, noteId: string) {
    const matches = (index.get(noteId) ?? []).filter(([, entry]) => entry.state !== 'forgotten' && !entry.withdrawn);
    if (matches.length !== 1) throw new CompanionMemoryLiveFileError('记忆正文尚未发布、身份不唯一或已撤回。');
    const [relative, entry] = matches[0]!;
    if (entry.state !== 'tracked' || entry.pending || entry.conflict || entry.missingCycle !== undefined || entry.moveConflict) throw new CompanionMemoryLiveFileError('记忆正文仍在登记或存在待处理修改。');
    return { relative, entry };
  }
  materialize(owner: string, notes: readonly CompanionMemory[]): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
    return this.options.library.withDocuments(owner, async session => {
      const index = this.index(session);
      const values = await mapLiveFiles(notes, async note => {
        try {
        if (note.companionId !== owner || note.contentRevision === undefined) throw new CompanionMemoryLiveFileError('记忆缺少当前伙伴的正文修订。');
        const { relative, entry } = this.entry(index, note.id), current = await session.current(entry), content = await this.read(session, relative);
        if (!current || current.contentRevision !== note.contentRevision || current.content !== content || content !== note.content)
          throw new CompanionMemoryLiveFileError('正文文件与已授权修订不同，必须先登记外部编辑再建立新上下文。');
        return { note: { ...note, content }, receipt: { companionId: owner, noteId: note.id, contentRevision: note.contentRevision, path: relative, contentHash: hash(content) } };
        } catch (error) { throw new CompanionMemoryLiveFileError(error instanceof Error ? error.message : '记忆正文文件不可用。', { cause: error, noteIds: [note.id] }); }
      });
      return { notes: values.map(value => value.note), receipts: values.map(value => value.receipt) };
    }, { synchronize: false, readOnly: true });
  }
  /** A captured native frame may finish while lawful newer bodies are being
   * published. Read its exact immutable historical body, and bind it to a real
   * registered current/host-withdrawn path; arbitrary filesystem edits never
   * qualify. This is only the native projection host port, not a model command. */
  projectionNotes(owner: string, notes: readonly CompanionMemory[]): Promise<{ notes: CompanionMemory[]; receipts: CompanionMemoryFileReceipt[] }> {
    return this.options.library.withDocuments(owner, async session => {
      if (!this.options.history) throw new CompanionMemoryLiveFileError('原生投影尚未连接真实历史正文。');
      const index = this.index(session), scope = (await session.request({ type: 'memory.library.scope', companionId: owner })).conversation;
      if (!scope) throw new CompanionMemoryLiveFileError('原生投影缺少宿主授权入口。');
      const values = await mapLiveFiles(notes, async note => {
        if (note.companionId !== owner || note.contentRevision === undefined) throw new CompanionMemoryLiveFileError('原生投影的正文身份无效。');
        const candidates = (index.get(note.id) ?? []).filter(([, entry]) => entry.state !== 'forgotten' || entry.withdrawn);
        if (candidates.length !== 1) throw new CompanionMemoryLiveFileError('捕获正文尚未发布或文档身份不唯一。');
        const [relative, entry] = candidates[0]!;
        if (entry.pending || entry.conflict || entry.moveConflict || entry.missingCycle !== undefined || entry.state === 'projecting') throw new CompanionMemoryLiveFileError('捕获正文的当前目录仍有未完成修改。');
        if (entry.withdrawn) { if (await session.text(relative, true) !== undefined) throw new CompanionMemoryLiveFileError('已撤回的正文路径出现了未登记内容。'); }
        else if (hash(await this.read(session, relative)) !== entry.hash) throw new CompanionMemoryLiveFileError('当前正文存在未登记修改，不能用历史或SQL内容遮盖。');
        const actual = await this.options.history!.readInSession(session, { companionId: owner, conversationId: scope.id }, note.id, note.contentRevision);
        if (actual.content !== note.content) throw new CompanionMemoryLiveFileError('捕获正文与实际历史文件不一致。');
        return { note: { ...note, content: actual.content }, receipt: { companionId: owner, noteId: note.id, contentRevision: note.contentRevision, path: relative, contentHash: hash(actual.content) } };
      });
      return { notes: values.map(value => value.note), receipts: values.map(value => value.receipt) };
    }, { synchronize: false, readOnly: true, sourceDelivery: true });
  }
  async validate(owner: string, input: readonly CompanionMemoryFileReceipt[], window?: object): Promise<boolean> {
    const parsed = companionMemoryFileReceiptsSchema.safeParse(input);
    if (!parsed.success || parsed.data.some(receipt => receipt.companionId !== owner)) return false;
    const roleOwner = window ? this.roleWindows.get(window) : undefined;
    if (roleOwner !== undefined && roleOwner !== owner) return false;
    try {
      const accepted = await this.options.library.withDocuments(owner, async session => {
        const index = this.index(session);
        const history = async (receipt: CompanionMemoryFileReceipt) => {
          const scope = (await session.request({ type: 'memory.library.scope', companionId: owner })).conversation;
          if (!scope) return false;
          const note = await this.options.history?.readInSession(session, { companionId: owner, conversationId: scope.id }, receipt.noteId, receipt.contentRevision);
          return !!note && hash(note.content) === receipt.contentHash;
        };
        const valid = await mapLiveFiles(parsed.data, async receipt => {
          // Only a host-registered withdrawal can move this check to immutable
          // history. An unregistered missing/edited current file still fails.
          const withdrawn = (index.get(receipt.noteId) ?? []).filter(([relative, entry]) => relative === receipt.path && entry.state === 'forgotten'
            && entry.withdrawn && !entry.pending && !entry.conflict && entry.missingCycle === undefined);
          if (withdrawn.length === 1) return await session.text(receipt.path, true) === undefined && await history(receipt);
          const { relative, entry } = this.entry(index, receipt.noteId);
          const moved = relative !== receipt.path;
          if (moved) {
            const previous = session.manifest.files[receipt.path];
            if (!previous || previous.noteId !== receipt.noteId || previous.state !== 'forgotten' || previous.withdrawn || previous.pending || previous.conflict
              || previous.moveConflict || previous.missingCycle !== undefined || session.manifest.move) return false;
          }
          const content = await this.read(session, relative, window), current = await session.current(entry);
          if (moved && hash(content) !== entry.hash) return false;
          if (!current) return entry.hash === hash(content) && await history(receipt);
          // SQL may have committed a lawful new revision while its atomic file
          // publication is queued. A still-tracked exact old projection is a
          // legal task snapshot; arbitrary external bytes never qualify.
          if (content !== current.content && (hash(content) !== receipt.contentHash || entry.hash !== receipt.contentHash)) return false;
          if (current.contentRevision === receipt.contentRevision && hash(content) === receipt.contentHash) return true;
          // A lawful background revision may publish newer text while an old
          // task keeps its original body. External pending edits, absent files
          // and changed original sources never pass this historical check.
          return history(receipt);
        });
        return valid.every(Boolean);
      // One opaque operation window verifies the role directory once. Every
      // call still verifies physical note/source identity and authorization.
      // Actual provider admission independently loads the current owner role;
      // no window is retained across tasks or standalone context checks.
      }, { synchronize: false, readOnly: true, ...(roleOwner === owner ? { sourceDelivery: true } : {}) });
      if (accepted && window) this.roleWindows.set(window, owner);
      return accepted;
    } catch { return false; }
  }
}
