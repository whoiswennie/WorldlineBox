import type { CompanionConnection } from './store';
import type { CompanionMemory } from '../shared/companions';
import type { CompanionStorageCommand } from '../shared/companion-storage';

type Consolidation = { companionId: string; mergedId: string; state: 'pending' | 'published' | 'restored';
  inputs: Array<{ id: string; version: number }> };
type AutomaticClassification = { automaticConsolidation: true; sleepWorldJobId: string };
interface Port {
  load(id: string): CompanionMemory;
  valid(note: CompanionMemory): boolean;
  persist(note: CompanionMemory): void;
  enqueue(note: CompanionMemory, operation: 'remember' | 'forget'): void;
  invalidate(owner: string): void;
  record(command: Extract<CompanionStorageCommand, { type: 'memory.consolidate' }>, automatic?: AutomaticClassification): CompanionMemory | undefined;
}

/** Archiving changes retrieval visibility, never evidence validity/version.
 * Originals are retained in the same authoritative ledger and dependency DAG. */
export class CompanionMemoryConsolidationStore {
  constructor(private readonly db: CompanionConnection, private readonly port: Port) {}
  private get(id: string): Consolidation | undefined {
    const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('memory-consolidation/' + id) as { value: string } | undefined;
    return found ? JSON.parse(found.value) as Consolidation : undefined;
  }
  private save(value: Consolidation): void {
    this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('memory-consolidation/' + value.mergedId, JSON.stringify(value));
  }
  prepare(command: Extract<CompanionStorageCommand, { type: 'memory.consolidate' }>, automatic?: AutomaticClassification): CompanionMemory | undefined {
    const originals = command.inputs.map(input => this.port.load(input.id));
    if (originals.some((note, index) => note.companionId !== command.companionId || note.version !== command.inputs[index]!.version
      || note.archivedAt || note.status !== 'indexed' || !this.port.valid(note))) throw new Error('整合前须重新读取本人尚未归档且已就绪的准确记忆版本。');
    const domain = originals[0]!.sourceConversationId;
    if (originals.some(note => note.sourceConversationId !== domain)) throw new Error('不同来源可见域的日记不能合并发布。');
    const sources = new Set(originals.flatMap(note => note.sources.map(source => source.messageId)));
    if (command.candidate.sourceMessageIds.some(id => !sources.has(id))
      || command.candidate.relatedMemoryIds?.some(id => !originals.some(note => note.id === id))) throw new Error('整合只能引用本次固定读集的真实来源。');
    const note = this.port.record({ ...command, candidate: { ...command.candidate,
      relatedMemoryIds: command.inputs.map(input => input.id) } }, automatic);
    if (!note || note.sourceConversationId !== domain || originals.some(source => source.id === note.id)) throw new Error('整合未形成相同可见域的新日记。');
    const previous = this.get(note.id);
    if (previous && JSON.stringify(previous.inputs) !== JSON.stringify(command.inputs)) throw new Error('相同整合身份不能替换读集。');
    if (!previous) this.save({ companionId: command.companionId, mergedId: note.id, state: 'pending', inputs: command.inputs });
    // A previously indexed identical proposal can safely publish immediately.
    if (note.status === 'indexed') this.publish(note);
    return note;
  }
  publish(note: CompanionMemory): void {
    const record = this.get(note.id);
    if (!record || record.state !== 'pending') return;
    const originals = record.inputs.map(input => this.port.load(input.id));
    if (note.status !== 'indexed' || !this.port.valid(note) || originals.some((source, index) => !this.port.valid(source)
      || source.version !== record.inputs[index]!.version || source.archivedAt)) throw new Error('整合索引完成前读集已变化，不归档原文。');
    this.port.invalidate(note.companionId);
    for (const source of originals) {
      source.archivedAt = new Date().toISOString(); source.supersededBy = note.id;
      this.port.persist(source); this.port.enqueue(source, 'forget');
    }
    record.state = 'published'; this.save(record);
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
      this.port.persist(source); this.port.enqueue(source, 'remember');
      this.db.prepare("UPDATE vcp_memory_outbox SET status='pending',attempts=0,next_attempt=0,error=NULL,lease_token=NULL,lease_until=NULL WHERE note_id=? AND note_version=? AND operation='remember' AND status!='running'").run(source.id, source.version);
      this.port.invalidate(source.companionId);
    }
    record.state = 'restored'; this.save(record);
  }
}
