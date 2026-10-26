import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionStorageCommand } from '../shared/companion-storage';
import { z } from 'zod';
import type { CompanionMemoryWriteCause } from './memory-ledger';

const consolidationSchema = z.strictObject({ companionId: z.string().min(1), mergedId: z.string().min(1),
  state: z.enum(['pending', 'published', 'restored', 'stale']),
  inputs: z.array(z.strictObject({ id: z.string().min(1), version: z.number().int().positive(), contentRevision: z.number().int().positive() })).min(2).max(50),
  mergedVersion: z.number().int().positive(), mergedContentRevision: z.number().int().positive(), staleReason: z.string().optional() });
type Consolidation = z.infer<typeof consolidationSchema>;
function parseConsolidation(value: string): Consolidation {
  const parsed = consolidationSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error('整合计划缺少完整正文版本与固定读集，不能发布或从当前数据补填。');
  return parsed.data;
}
type AutomaticClassification = { automaticConsolidation: true; sleepWorldJobId: string };
interface Port {
  load(id: string): CompanionMemory;
  valid(note: CompanionMemory): boolean;
  persist(note: CompanionMemory, cause?: CompanionMemoryWriteCause): void;
  enqueue(note: CompanionMemory, operation: 'remember' | 'forget'): void;
  invalidate(owner: string): void;
  withdraw(id: string): void;
  record(command: Extract<CompanionStorageCommand, { type: 'memory.consolidate' }>, automatic?: AutomaticClassification): CompanionMemory | undefined;
}

/** Archiving changes retrieval visibility, never evidence validity/version.
 * Originals are retained in the same authoritative ledger and dependency DAG. */
export class CompanionMemoryConsolidationStore {
  private cursor = '';
  constructor(private readonly db: CompanionConnection, private readonly port: Port) {}
  initialize(): void {
    // Only pending consolidation metadata is indexed. Ordinary metadata values
    // need not be JSON; never evaluate them or deserialize the complete ledger.
    this.db.exec(`CREATE INDEX IF NOT EXISTS vcp_pending_consolidation_metadata ON metadata(key)
      WHERE key GLOB 'memory-consolidation/*' AND json_extract(value,'$.state')='pending'`);
  }
  private get(id: string): Consolidation | undefined {
    const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-consolidation/' + id) as { value: string } | undefined;
    return found ? parseConsolidation(found.value) : undefined;
  }
  private save(value: Consolidation): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('memory-consolidation/' + value.mergedId, JSON.stringify(value));
  }
  private staleReason(record: Consolidation): string | undefined {
    let merged: CompanionMemory;
    try { merged = this.port.load(record.mergedId); }
    catch { return '整合候选已经不存在，旧计划不再发布。'; }
    if (merged.contentRevision !== record.mergedContentRevision) return '整合候选正文已经修订，旧归档计划停止，保留当前候选版本。';
    if (!this.port.valid(merged)) return '整合的实际来源或授权已经变化，旧计划不再发布。';
    for (const input of record.inputs) {
      let source: CompanionMemory;
      try { source = this.port.load(input.id); }
      catch { return '整合读过的原文已经不存在，旧计划不再发布。'; }
      if (!this.port.valid(source) || source.contentRevision !== input.contentRevision) return '整合读过的具体原文或授权已更新，保留当前版本，等待后续维护重新读取。';
      if (source.archivedAt && source.supersededBy !== record.mergedId) return '原文已由另一项有效整合归档，旧整合计划已被替代，保留现有归档与来源。';
    }
    return undefined;
  }
  private retire(record: Consolidation, reason: string): void {
    if (record.state !== 'pending') return;
    let note: CompanionMemory | undefined;
    try { note = this.port.load(record.mergedId); } catch { /* A deleted candidate has nothing left to archive. */ }
    record.state = 'stale'; record.staleReason = reason; this.save(record);
    if (!note) {
      // The durable plan may outlive a deleted candidate. Its originals remain
      // untouched and its obsolete delivery must not be claimed again.
    } else if (record.mergedContentRevision !== note.contentRevision) {
      // A separately revised candidate has its own delivery. Retiring the old
      // archive plan must not withdraw that newer valid body or its index.
    } else if (this.port.valid(note)) {
      // A competing archive does not invalidate the historical content. Keep
      // it inspectable, but never publish this redundant candidate as active.
      note.archivedAt ??= new Date().toISOString();
      this.port.persist(note, { operation: 'archive', eventId: 'consolidation-retire/' + record.mergedId, planId: record.mergedId }); this.port.enqueue(note, 'forget'); this.port.invalidate(note.companionId);
    } else if (!['invalid', 'forgotten'].includes(note.status)) this.port.withdraw(note.id);
    this.db.prepare(`UPDATE vcp_memory_outbox SET status='stale',error=?,lease_token=NULL,lease_until=NULL
      WHERE note_id=? AND operation='remember' AND status IN('pending','failed') AND note_version=?`).run(reason, record.mergedId, record.mergedVersion);
  }
  /** A bounded, fair pass also recovers historical eight-attempt failures.
   * Native writes with live leases finish their own final read-set check. */
  reconcilePending(limit = 32): number {
    const query = this.db.prepare(`SELECT key,value FROM metadata INDEXED BY vcp_pending_consolidation_metadata
      WHERE key GLOB 'memory-consolidation/*' AND json_extract(value,'$.state')='pending' AND key>? ORDER BY key LIMIT ?`);
    let values = query.all(this.cursor, limit) as Array<{ key: string; value: string }>;
    if (!values.length && this.cursor) { this.cursor = ''; values = query.all('', limit) as Array<{ key: string; value: string }>; }
    let retired = 0;
    for (const value of values) {
      this.cursor = value.key;
      let record: Consolidation;
      try { record = parseConsolidation(value.value); }
      catch { continue; } // No old-plan replay or inferred versions; exact publication also fails closed in get().
      if (this.db.prepare("SELECT 1 FROM vcp_memory_outbox WHERE note_id=? AND operation='remember' AND status='running' AND lease_until>? LIMIT 1").get(record.mergedId, Date.now())) continue;
      const reason = this.staleReason(record);
      if (reason) { this.retire(record, reason); retired++; }
    }
    return retired;
  }
  private waitFor(owner: string, originals: readonly CompanionMemory[], blockers: readonly string[]): void {
    for (const note of originals) this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`memory-consolidation-wait/${owner}/${note.id}`, JSON.stringify({ version: note.version, contentRevision: note.contentRevision, blockers }));
  }
  private pendingOverlap(owner: string, originals: readonly CompanionMemory[]): string[] {
    const ids = originals.map(note => note.id), sources = [...new Set(originals.flatMap(note => note.sources.map(source => source.messageId)))];
    // Both paths use existing source-key indexes. Only this proposed read set
    // competes; unrelated new notes and global corpus revisions do not block it.
    const values = this.db.prepare(`SELECT m.key FROM metadata m WHERE m.key IN(
      SELECT 'memory-consolidation/'||d.note_id FROM vcp_note_dependencies d JOIN vcp_memory_notes n ON n.id=d.note_id
        WHERE n.companion_id=? AND d.source_note_id IN(${ids.map(() => '?').join(',')})
      UNION SELECT 'memory-consolidation/'||s.note_id FROM vcp_note_sources s JOIN vcp_memory_notes n ON n.id=s.note_id
        WHERE n.companion_id=? AND s.message_id IN(${sources.map(() => '?').join(',')}))
      AND json_extract(m.value,'$.state')='pending' ORDER BY m.key LIMIT 32`).all(owner, ...ids, owner, ...sources) as Array<{ key: string }>;
    return values.map(value => value.key.slice('memory-consolidation/'.length));
  }
  prepare(command: Extract<CompanionStorageCommand, { type: 'memory.consolidate' }>, automatic?: AutomaticClassification): CompanionMemory | undefined {
    const originals = command.inputs.map(input => this.port.load(input.id));
    if (originals.some(note => note.procedure)) throw new Error('方法记忆使用自身的修订与实践验证流程维护，不能并入摘要后归档。');
    if (originals.some((note, index) => note.companionId !== command.companionId || note.version !== command.inputs[index]!.version
      || note.archivedAt || note.status !== 'indexed' || !this.port.valid(note))) throw new Error('整合前须重新读取本人尚未归档且已就绪的准确记忆版本。');
    const domain = originals[0]!.sourceConversationId;
    if (originals.some(note => note.sourceConversationId !== domain)) throw new Error('不同来源可见域的日记不能合并发布。');
    this.reconcilePending();
    const blockers = this.pendingOverlap(command.companionId, originals);
    if (blockers.length) { this.waitFor(command.companionId, originals, blockers); return undefined; }
    const sources = new Set(originals.flatMap(note => note.sources.map(source => source.messageId)));
    if (command.candidate.sourceMessageIds.some(id => !sources.has(id))
      || command.candidate.relatedMemoryIds?.some(id => !originals.some(note => note.id === id))) throw new Error('整合只能引用本次固定读集的真实来源。');
    const note = this.port.record({ ...command, candidate: { ...command.candidate,
      relatedMemoryIds: command.inputs.map(input => input.id) } }, automatic);
    if (!note || note.sourceConversationId !== domain || originals.some(source => source.id === note.id)) throw new Error('整合未形成相同可见域的新日记。');
    if (note.contentRevision === undefined || originals.some(source => source.contentRevision === undefined)) throw new Error('整合必须固定当前真实正文版本。');
    const previous = this.get(note.id);
    if (previous && JSON.stringify(previous.inputs.map(input => ({ id: input.id, version: input.version }))) !== JSON.stringify(command.inputs)) throw new Error('相同整合身份不能替换读集。');
    if (!previous) this.save({ companionId: command.companionId, mergedId: note.id, mergedVersion: note.version, mergedContentRevision: note.contentRevision,
      state: 'pending', inputs: command.inputs.map((input, index) => ({ ...input, contentRevision: originals[index]!.contentRevision! })) });
    this.waitFor(command.companionId, originals, [note.id]);
    // A previously indexed identical proposal can safely publish immediately.
    if (note.status === 'indexed') this.publish(note);
    return note;
  }
  publish(note: CompanionMemory): { state: 'completed' | 'stale'; reason?: string } {
    const record = this.get(note.id);
    if (record?.state === 'stale') return record.mergedContentRevision !== note.contentRevision
      ? { state: 'completed' } : { state: 'stale', reason: record.staleReason };
    if (!record || record.state !== 'pending') return { state: 'completed' };
    const reason = this.staleReason(record);
    if (reason) { this.retire(record, reason); return { state: 'stale', reason }; }
    const originals = record.inputs.map(input => this.port.load(input.id));
    if (note.status !== 'indexed' || !this.port.valid(note) || originals.some((source, index) => !this.port.valid(source)
      || source.contentRevision !== record.inputs[index]!.contentRevision
      || source.archivedAt && source.supersededBy !== note.id)) throw new Error('整合发布条件未通过最终核验。');
    this.port.invalidate(note.companionId);
    for (const source of originals) {
      source.archivedAt = new Date().toISOString(); source.supersededBy = note.id;
      this.port.persist(source, { operation: 'archive', eventId: 'consolidation-publish/' + record.mergedId, planId: record.mergedId }); this.port.enqueue(source, 'forget');
    }
    record.state = 'published'; this.save(record); return { state: 'completed' };
  }
  /** A corrected/invalid merged derivative must not strand unrelated valid
   * originals in an archive. Revoked sources still fail valid() and stay out. */
  restore(mergedId: string): void {
    const record = this.get(mergedId);
    if (!record || record.state !== 'published') return;
    for (const input of record.inputs) {
      const source = this.port.load(input.id);
      if (source.supersededBy !== mergedId || !this.port.valid(source)) continue;
      delete source.archivedAt; delete source.supersededBy;
      this.port.persist(source, { operation: 'restore', eventId: 'consolidation-restore/' + mergedId, planId: mergedId }); this.port.enqueue(source, 'remember');
      this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version=? AND operation='remember' AND status!='running'").run(source.id, source.version);
      this.port.invalidate(source.companionId);
    }
    record.state = 'restored'; this.save(record);
  }
}
