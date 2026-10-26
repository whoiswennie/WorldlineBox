import { createHash } from 'node:crypto';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionMemoryProjectionNote, CompanionMemoryProjectionState } from '../shared/companion-memory-projection';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionConnection } from './store';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type NoteRow = { id: string; metadata: string; body_hash: string | null; published_after: number | null };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Compact invalidation journal: one latest stamp per note, including status
 * acknowledgements. No body, prompt, semantic index or second recall engine. */
export class CompanionMemoryProjectionStore {
  private readonly lastPruned = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly captures = new Map<string, { state: CompanionMemoryProjectionState; scope: string; notes: CompanionMemoryProjectionNote[];
    changes: Array<{ sequence: number; id: string; note?: CompanionMemoryProjectionNote }>; base: number; bytes: number; active: boolean; used: number }>();
  constructor(private readonly db: CompanionConnection, private readonly ports: {
    requireScope(scope: Scope): unknown; visible(scope: Scope, note: CompanionMemory): boolean;
    lifecycle(owner: string): { revocationEpoch: number };
  }) {}
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_memory_projection_state(companion_id TEXT PRIMARY KEY,sequence INTEGER NOT NULL DEFAULT 0,floor_sequence INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS companion_memory_projection_mutations(companion_id TEXT NOT NULL,note_id TEXT NOT NULL,sequence INTEGER NOT NULL,PRIMARY KEY(companion_id,note_id));
      CREATE INDEX IF NOT EXISTS companion_memory_projection_owner_sequence ON companion_memory_projection_mutations(companion_id,sequence);
    `);
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
      const prefix = operation === 'DELETE' ? 'OLD' : 'NEW';
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS companion_memory_projection_${operation.toLowerCase()} AFTER ${operation} ON vcp_memory_notes BEGIN
        INSERT INTO companion_memory_projection_state(companion_id,sequence) VALUES(${prefix}.companion_id,1)
          ON CONFLICT(companion_id) DO UPDATE SET sequence=sequence+1;
        INSERT INTO companion_memory_projection_mutations(companion_id,note_id,sequence)
          SELECT ${prefix}.companion_id,${prefix}.id,sequence FROM companion_memory_projection_state WHERE companion_id=${prefix}.companion_id
          ON CONFLICT(companion_id,note_id) DO UPDATE SET sequence=excluded.sequence;
      END;`);
    }
  }
  invalidate(owner: string): void { this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1); this.captures.delete(owner); this.lastPruned.delete(owner); }
  cacheGeneration(owner: string): number { return this.generations.get(owner) ?? 0; }
  private state(scope: Scope): CompanionMemoryProjectionState {
    this.ports.requireScope(scope);
    const found = this.db.prepare('SELECT sequence,floor_sequence FROM companion_memory_projection_state WHERE companion_id=?').get(scope.companionId) as
      { sequence: number; floor_sequence: number } | undefined;
    const reset = this.db.prepare('SELECT revision FROM vcp_memory_management_epochs WHERE companion_id=?').get(scope.companionId) as { revision: number } | undefined;
    const version = this.db.prepare('PRAGMA data_version').get() as { data_version: number };
    return { companionId: scope.companionId, sequence: found?.sequence ?? 0, floorSequence: found?.floor_sequence ?? 0,
      revocationEpoch: this.ports.lifecycle(scope.companionId).revocationEpoch, resetRevision: reset?.revision ?? 0, externalVersion: version.data_version,
      generation: this.generations.get(scope.companionId) ?? 0 };
  }
  private prune(scope: Scope): void {
    const state = this.state(scope), last = this.lastPruned.get(scope.companionId);
    if (last !== undefined && state.sequence >= last && state.sequence - last < 256) return;
    this.lastPruned.set(scope.companionId, state.sequence);
    const cutoff = state.sequence - 8192; if (cutoff <= 0) return;
    const expired = this.db.prepare(`SELECT MAX(sequence) AS sequence FROM companion_memory_projection_mutations m WHERE m.companion_id=? AND m.sequence<?
      AND NOT EXISTS(SELECT 1 FROM vcp_memory_notes n WHERE n.id=m.note_id AND n.companion_id=m.companion_id)`).get(scope.companionId, cutoff) as { sequence: number | null };
    if (expired.sequence === null) return;
    this.db.prepare(`DELETE FROM companion_memory_projection_mutations AS m WHERE m.companion_id=? AND m.sequence<=?
      AND NOT EXISTS(SELECT 1 FROM vcp_memory_notes n WHERE n.id=m.note_id AND n.companion_id=m.companion_id)`).run(scope.companionId, expired.sequence);
    this.db.prepare('UPDATE companion_memory_projection_state SET floor_sequence=MAX(floor_sequence,?) WHERE companion_id=?').run(expired.sequence, scope.companionId);
  }
  private fence(scope: Scope, expected: CompanionMemoryProjectionState): void {
    const actual = this.state(scope);
    if (Object.keys(actual).some(key => actual[key as keyof typeof actual] !== expected[key as keyof typeof expected]))
      throw Object.assign(new Error('原生投影的来源、状态或授权在分页期间变化，请重新同步。'), { code: 'MEMORY_PROJECTION_CHANGED' });
  }
  private authorityFence(scope: Scope, expected: CompanionMemoryProjectionState): void {
    const actual = this.state(scope);
    if (actual.companionId !== expected.companionId || actual.revocationEpoch !== expected.revocationEpoch || actual.resetRevision !== expected.resetRevision
      || actual.externalVersion !== expected.externalVersion || actual.generation !== expected.generation) throw Object.assign(new Error('捕获元数据的来源或授权已撤回。'), { code: 'MEMORY_PROJECTION_CHANGED' });
  }
  private capture(scope: Scope, expected: CompanionMemoryProjectionState, deltaAfter?: number) {
    for (const [owner, value] of this.captures) if (Date.now() - value.used > 600000) this.captures.delete(owner);
    this.authorityFence(scope, expected);
    const scopeKey = JSON.stringify([scope.conversationId, scope.beforeSequence ?? null, deltaAfter === undefined ? 'page' : 'delta']);
    const previous = this.captures.get(scope.companionId);
    if (previous && previous.scope === scopeKey && JSON.stringify(previous.state) === JSON.stringify(expected)
      && (deltaAfter === undefined || deltaAfter >= previous.base)) { previous.used = Date.now(); return previous; }
    if (previous?.active) {
      const current = this.state(scope);
      if (previous.state.revocationEpoch === current.revocationEpoch && previous.state.resetRevision === current.resetRevision
        && previous.state.generation === current.generation && previous.state.externalVersion === current.externalVersion)
        throw Object.assign(new Error('Owner metadata capture is still in use.'), { code: 'VCP_MEMORY_NATIVE_CAPACITY' });
      this.captures.delete(scope.companionId);
    }
    const target = this.state(scope);
    if (deltaAfter !== undefined && (deltaAfter < target.floorSequence || deltaAfter > target.sequence))
      throw Object.assign(new Error('原生投影差量游标已超出保留范围，请冷重建。'), { code: 'MEMORY_PROJECTION_RESET_REQUIRED' });
    const notes: CompanionMemoryProjectionNote[] = [], changes: Array<{ sequence: number; id: string; note?: CompanionMemoryProjectionNote }> = []; let bytes = 0;
    const reserve = () => {
      for (;;) {
        const other = [...this.captures].filter(([owner]) => owner !== scope.companionId), occupied = other.reduce((sum, [, value]) => sum + value.bytes, 0);
        if (bytes <= 128 * 1024 * 1024 && other.length < 4 && (!occupied || occupied + bytes <= 64 * 1024 * 1024)) return;
        const victim = other.filter(([, value]) => !value.active).sort((a, b) => a[1].used - b[1].used)[0];
        if (!victim) throw Object.assign(new Error('Native metadata capture capacity is busy.'), { code: 'VCP_MEMORY_NATIVE_CAPACITY' }); this.captures.delete(victim[0]);
      }
    };
    // One short SQLite metadata read captures a consistent list. This is not
    // native graph MVCC: original graph construction remains in its own lane.
    // Later pages may survive ordinary writes, while hard authority changes
    // reject them. No SQL body is copied into this paging cache.
    if (deltaAfter === undefined) {
      const statement = this.db.prepare(this.select + " WHERE n.companion_id=? AND json_extract(n.data,'$.status')='indexed' ORDER BY n.id") as
        ReturnType<CompanionConnection['prepare']> & { iterate(...args: unknown[]): IterableIterator<NoteRow> };
      if (typeof statement.iterate !== 'function') throw new Error('Native projection capture requires the actual streaming SQLite port.');
      for (const row of statement.iterate(scope.companionId)) {
        const note = this.descriptor(scope, row); if (!note) continue;
        bytes += Buffer.byteLength(JSON.stringify(note)); reserve(); notes.push(note);
      }
    } else {
      const statement = this.db.prepare('SELECT note_id,sequence FROM companion_memory_projection_mutations WHERE companion_id=? AND sequence>? AND sequence<=? ORDER BY sequence') as
        ReturnType<CompanionConnection['prepare']> & { iterate(...args: unknown[]): IterableIterator<{ note_id: string; sequence: number }> };
      if (typeof statement.iterate !== 'function') throw new Error('Native projection delta requires the actual streaming SQLite port.');
      for (const item of statement.iterate(scope.companionId, deltaAfter, target.sequence)) {
        const row = this.db.prepare(this.select + ' WHERE n.id=? AND n.companion_id=?').get(item.note_id, scope.companionId) as NoteRow | undefined;
        const note = row && this.descriptor(scope, row), change = { sequence: item.sequence, id: item.note_id, ...(note ? { note } : {}) };
        bytes += Buffer.byteLength(JSON.stringify(change)); reserve(); changes.push(change);
      }
    }
    this.fence(scope, target); const captured = { state: target, scope: scopeKey, notes, changes, base: deltaAfter ?? 0, bytes, active: true, used: Date.now() };
    this.captures.set(scope.companionId, captured); return captured;
  }
  private descriptor(scope: Scope, row: NoteRow): CompanionMemoryProjectionNote | undefined {
    const metadata = JSON.parse(row.metadata) as Omit<CompanionMemory, 'content'>;
    if (metadata.companionId !== scope.companionId || metadata.status !== 'indexed' || metadata.archivedAt
      || !this.ports.visible(scope, { ...metadata, content: '' })) return;
    if (!row.body_hash) throw new Error('获权记忆缺少完整的宿主正文修订，不生成不完整投影。');
    const projectionFingerprint = sha(['native-projection-note-v1', row.body_hash, metadata]);
    return { ...metadata, bodyFingerprint: row.body_hash, projectionFingerprint,
      notBeforeSequence: Math.max(0, ...metadata.sources.map(source => source.sequence), row.published_after === null ? 0 : row.published_after + 1) };
  }
  private select = `SELECT n.id,json_remove(n.data,'$.content') AS metadata,r.body_hash,
    (SELECT MAX(CAST(m.value AS INTEGER)) FROM vcp_note_sources s JOIN metadata m ON m.key='message-published-after/'||s.message_id WHERE s.note_id=n.id) AS published_after
    FROM vcp_memory_notes n LEFT JOIN companion_memory_content_revisions r ON r.note_id=n.id AND r.content_revision=json_extract(n.data,'$.contentRevision')`;
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'memory.projection.release') {
      const value = this.captures.get(command.companionId);
      if (value && JSON.stringify(value.state) === JSON.stringify(command.expected)) value.active = false;
      return { ok: true };
    }
    if (command.type === 'memory.projection.state') { this.prune(command); return { ok: true, memoryProjectionState: this.state(command) }; }
    if (command.type !== 'memory.projection.page' && command.type !== 'memory.projection.delta') return;
    try { return this.db.transaction(() => {
      const limit = command.limit ?? 128;
      if (command.type === 'memory.projection.page') {
        const captured = this.capture(command, command.expected); let offset = 0, end = captured.notes.length;
        if (command.afterId) while (offset < end) { const mid = Math.floor((offset + end) / 2);
          if (captured.notes[mid]!.id <= command.afterId) offset = mid + 1; else end = mid; }
        const notes = captured.notes.slice(offset, offset + limit), hasMore = offset + notes.length < captured.notes.length;
        captured.active = hasMore; this.authorityFence(command, captured.state);
        return { ok: true, memoryProjectionPage: { state: captured.state, notes, removedIds: [], hasMore,
          ...(hasMore ? { nextId: notes.at(-1)!.id } : {}) } };
      }
      const captured = this.capture(command, command.expected, command.afterSequence); let offset = 0, end = captured.changes.length;
      while (offset < end) { const mid = Math.floor((offset + end) / 2); if (captured.changes[mid]!.sequence <= command.afterSequence) offset = mid + 1; else end = mid; }
      const page = captured.changes.slice(offset, offset + limit), hasMore = offset + page.length < captured.changes.length;
      captured.active = hasMore; this.authorityFence(command, captured.state);
      return { ok: true, memoryProjectionPage: { state: captured.state, notes: page.flatMap(change => change.note ? [change.note] : []),
        removedIds: page.filter(change => !change.note).map(change => change.id), hasMore, nextSequence: page.at(-1)?.sequence ?? captured.state.sequence } };
    }).immediate(); } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
      if (code === 'VCP_MEMORY_NATIVE_CAPACITY' || code === 'MEMORY_PROJECTION_RESET_REQUIRED') return { ok: true,
        memoryProjectionDisposition: code === 'VCP_MEMORY_NATIVE_CAPACITY' ? 'capacity' : 'reset_required' };
      throw error;
    }
  }
}
