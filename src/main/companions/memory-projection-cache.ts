import { createHash } from 'node:crypto';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryProjectionNote, CompanionMemoryProjectionState } from '../../shared/companion-memory-projection';
import type { CompanionMemoryFileReceipt } from '../../shared/companion-memory-files';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
export interface CompanionMemoryProjectionSnapshot {
  state: CompanionMemoryProjectionState; notes: readonly CompanionMemoryProjectionNote[]; byId: ReadonlyMap<string, CompanionMemoryProjectionNote>;
  fingerprints: Readonly<Record<string, string>>; corpusHash: string; semanticHash: string; notBeforeSequence: number;
  receipts: ReadonlyMap<string, CompanionMemoryFileReceipt>;
}
interface Entry { owner: string; value: CompanionMemoryProjectionSnapshot; bytes: number; metadataBytes: number; receiptBytes: number; references: number; used: number; invalid: boolean }
export interface CompanionMemoryProjectionLease { value: CompanionMemoryProjectionSnapshot;
  setReceipts(receipts: readonly CompanionMemoryFileReceipt[]): void; assertCurrent(): void; release(): void }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameAuthority = (left: CompanionMemoryProjectionState, right: CompanionMemoryProjectionState) => left.companionId === right.companionId
  && left.revocationEpoch === right.revocationEpoch && left.resetRevision === right.resetRevision && left.externalVersion === right.externalVersion && left.generation === right.generation;
const capacity = () => Object.assign(new Error('The authorized native projection metadata cache is at capacity.'), { code: 'VCP_MEMORY_NATIVE_CAPACITY' });
const receiptBytes = (receipt: CompanionMemoryFileReceipt) => Buffer.byteLength(JSON.stringify(receipt)) + 2;

/** Four active owner catalogues; immutable metadata only, never SQL/file prose.
 * A retained task sees its original objects while ordinary deltas create a new
 * catalogue. Eviction means a complete authorized rebuild, never a partial one. */
export class CompanionMemoryProjectionCache {
  private readonly entries = new Map<string, Entry>();
  private readonly retired = new Set<Entry>();
  private readonly loading = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private pending = 0;
  private readonly generations = new Map<string, number>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxSingleBytes: number;
  private readonly maxOwners: number;
  constructor(private readonly request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, limits: { maxBytes?: number; maxSingleBytes?: number; maxOwners?: number } = {}) {
    this.maxBytes = limits.maxBytes ?? 64 * 1024 * 1024; this.maxSingleBytes = limits.maxSingleBytes ?? 128 * 1024 * 1024; this.maxOwners = limits.maxOwners ?? 4;
    if (![this.maxBytes, this.maxSingleBytes, this.maxOwners].every(value => Number.isSafeInteger(value) && value > 0)
      || this.maxSingleBytes < this.maxBytes) throw new Error('Invalid native projection metadata capacity.');
  }
  private async call(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const response = await this.request(command); if (!response.ok) throw new Error(response.error ?? '原生投影元数据暂不可用。');
    if (response.memoryProjectionDisposition === 'capacity') throw capacity();
    if (response.memoryProjectionDisposition === 'reset_required') throw Object.assign(new Error('Native metadata cursor requires a complete authorized rebuild.'), { code: 'MEMORY_PROJECTION_RESET_REQUIRED' });
    return response;
  }
  private discard(entry: Entry, invalidate = true): void {
    if (this.entries.get(entry.owner) === entry) this.entries.delete(entry.owner);
    if (entry.references) this.retired.add(entry); else { this.bytes -= entry.bytes; this.retired.delete(entry); }
    if (invalidate) entry.invalid = true;
  }
  invalidate(owner: string): void { this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1); const entry = this.entries.get(owner); if (entry) this.discard(entry);
    for (const value of this.retired) if (value.owner === owner) value.invalid = true; }
  clear(): void { for (const owner of new Set([...this.entries.keys(), ...[...this.retired].map(entry => entry.owner), ...this.loading.keys(), ...this.tails.keys()])) this.invalidate(owner); }
  snapshot() { return { owners: this.entries.size, metadataBytes: this.bytes, maxMetadataBytes: this.maxBytes, maxSingleMetadataBytes: this.maxSingleBytes,
    maxOwners: this.maxOwners, loading: this.loading.size, pending: this.pending, retiredCatalogues: this.retired.size,
    references: [...this.entries.values(), ...this.retired].reduce((sum, entry) => sum + entry.references, 0) }; }
  private admit(owner: string, bytes: number): void {
    if (bytes > this.maxSingleBytes) throw capacity();
    for (;;) {
      const other = [...this.entries.values()].filter(entry => entry.owner !== owner);
      const previous = this.entries.get(owner), retained = [...this.retired, ...(previous?.references && bytes ? [previous] : [])];
      const occupied = [...other, ...retained, ...[...this.loading].filter(([key]) => key !== owner).map(([owner, bytes]) => ({ owner, bytes }))];
      const occupiedBytes = occupied.reduce((sum, entry) => sum + entry.bytes, 0);
      if (new Set([owner, ...occupied.map(entry => entry.owner)]).size <= this.maxOwners && (!occupiedBytes || occupiedBytes + bytes <= this.maxBytes)) return;
      const victim = other.filter(entry => !entry.references).sort((a, b) => a.used - b.used)[0]; if (!victim) throw capacity(); this.discard(victim);
    }
  }
  acquire(scope: Scope, signal?: AbortSignal): Promise<CompanionMemoryProjectionLease | undefined> {
    if (this.pending >= 128) return Promise.reject(capacity()); this.pending++;
    const generation = this.generations.get(scope.companionId) ?? 0;
    const pending = (this.tails.get(scope.companionId) ?? Promise.resolve()).catch(() => undefined).then(() => this.acquireNow(scope, generation, signal));
    this.tails.set(scope.companionId, pending);
    void pending.finally(() => { this.pending--; if (this.tails.get(scope.companionId) === pending) this.tails.delete(scope.companionId); }).catch(() => undefined);
    return pending;
  }
  private async acquireNow(scope: Scope, generation: number, signal?: AbortSignal): Promise<CompanionMemoryProjectionLease | undefined> {
    const owner = scope.companionId;
    const current = () => { signal?.throwIfAborted(); if ((this.generations.get(owner) ?? 0) !== generation) throw new Error('伙伴投影元数据已撤回。'); };
    current(); this.admit(owner, 0);
    let state = (await this.call({ type: 'memory.projection.state', ...scope })).memoryProjectionState;
    if (!state) throw new Error('原生投影状态缺少宿主凭证。'); current();
    let entry = this.entries.get(owner);
    const canDelta = entry && !entry.invalid && sameAuthority(entry.value.state, state)
      && entry.value.state.sequence <= state.sequence && entry.value.state.sequence >= state.floorSequence;
    if (!canDelta || entry!.value.state.sequence !== state.sequence) {
      this.loading.set(owner, 0);
      try {
      const byId = canDelta ? new Map(entry!.value.byId) : new Map<string, CompanionMemoryProjectionNote>();
      const receipts = canDelta ? new Map(entry!.value.receipts) : new Map<string, CompanionMemoryFileReceipt>();
      let bytes = canDelta ? entry!.metadataBytes : 0, fileBytes = canDelta ? entry!.receiptBytes : 0;
      let afterSequence = canDelta ? entry!.value.state.sequence : 0, afterId: string | undefined;
      const dropReceipt = (id: string) => { const old = receipts.get(id); if (old) fileBytes -= receiptBytes(old); receipts.delete(id); };
      const metadataScope = { companionId: owner, conversationId: scope.conversationId }; let firstPage = true;
      for (;;) {
        current();
        const response = await this.call(canDelta ? { type: 'memory.projection.delta', ...metadataScope, expected: state, afterSequence, limit: 128 }
          : { type: 'memory.projection.page', ...metadataScope, expected: state, afterId, limit: 128 });
        const page = response.memoryProjectionPage; if (!page) throw new Error('原生投影分页缺少完整元数据。');
        if (!sameAuthority(page.state, state) || page.state.sequence !== state.sequence && (!firstPage || page.state.sequence < state.sequence))
          throw Object.assign(new Error('原生投影分页的固定宿主凭证已变化。'), { code: 'MEMORY_PROJECTION_CHANGED' });
        state = page.state; firstPage = false;
        for (const id of page.removedIds) { const old = byId.get(id); if (old) bytes -= Buffer.byteLength(JSON.stringify(old)); byId.delete(id); dropReceipt(id); }
        for (const note of page.notes) {
          const old = byId.get(note.id); if (old) bytes -= Buffer.byteLength(JSON.stringify(old));
          if (old?.projectionFingerprint !== note.projectionFingerprint) dropReceipt(note.id);
          byId.set(note.id, note); bytes += Buffer.byteLength(JSON.stringify(note)); this.admit(owner, bytes + fileBytes); this.loading.set(owner, bytes + fileBytes);
        }
        if (!page.hasMore) break; afterId = page.nextId; afterSequence = page.nextSequence!;
      }
      current(); const notes = [...byId.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const fingerprints = Object.fromEntries(notes.map(note => [note.id, note.projectionFingerprint]));
      const value: CompanionMemoryProjectionSnapshot = { state, notes, byId, fingerprints,
        corpusHash: digest(['native-projection-corpus-v1', notes.map(note => [note.id, note.projectionFingerprint])]),
        semanticHash: digest(['native-projection-semantic-v1', notes.map(note => [note.id, note.bodyFingerprint])]),
        notBeforeSequence: notes.reduce((max, note) => Math.max(max, note.notBeforeSequence), 0), receipts };
      if (entry) this.discard(entry, false);
      entry = { owner, value, bytes: bytes + fileBytes, metadataBytes: bytes, receiptBytes: fileBytes, references: 0, used: Date.now(), invalid: false };
      this.entries.set(owner, entry); this.bytes += entry.bytes;
      } finally { this.loading.delete(owner);
        await this.call({ type: 'memory.projection.release', companionId: owner, expected: state }).catch(() => undefined);
      }
    }
    if (scope.beforeSequence !== undefined && scope.beforeSequence < entry!.value.notBeforeSequence) return;
    current(); const held = entry!; held.references++; held.used = Date.now(); let released = false;
    const assertHeld = () => { current(); if (held.invalid || released) throw new Error('伙伴投影元数据已失效或释放。'); };
    return { get value() { return held.value; }, assertCurrent: assertHeld,
      setReceipts: values => { assertHeld(); const next = new Map(held.value.receipts); let size = held.receiptBytes;
        for (const receipt of values) {
          const note = held.value.byId.get(receipt.noteId);
          if (!note || receipt.companionId !== owner || receipt.contentRevision !== note.contentRevision) throw new Error('实际文件凭证与授权投影不一致。');
          const previous = next.get(receipt.noteId); if (previous) size -= receiptBytes(previous);
          next.set(receipt.noteId, receipt); size += receiptBytes(receipt);
        }
        // Mutating the envelope only installs newly verified physical receipts;
        // immutable metadata arrays/maps remain fixed for existing task readers.
        const nextBytes = held.metadataBytes + size, otherBytes = this.bytes - held.bytes + [...this.loading.values()].reduce((sum, value) => sum + value, 0);
        if (nextBytes > this.maxSingleBytes || otherBytes && otherBytes + nextBytes > this.maxBytes) throw capacity();
        this.bytes += nextBytes - held.bytes; held.bytes = nextBytes; held.receiptBytes = size; held.value = { ...held.value, receipts: next };
      }, release: () => { if (!released) { released = true; held.references--; held.used = Date.now();
        if (!held.references && this.retired.delete(held)) this.bytes -= held.bytes;
      } } };
  }
}
