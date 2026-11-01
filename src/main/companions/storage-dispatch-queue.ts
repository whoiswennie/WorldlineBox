import type { CompanionStorageCommand } from '../../shared/companion-storage';
import type { CompanionStorageOperation } from './storage-operation-context';

// Explicit semantic query ports only. Unknown commands and every mutation
// remain global ordinal barriers, without name heuristics.
const queries = new Set<CompanionStorageCommand['type']>([
  'message.get', 'messages', 'action.get', 'checkpoint.get', 'execution.sources', 'social.notifications.receipts',
  'memory.sources.filter', 'memory.sources.headers', 'memory.records.filter', 'memory.records.describe', 'memory.procedures.status',
  'memory.revision.describe', 'memory.revisions.describe', 'memory.library.read', 'memory.library.read-many',
  'memory.library.scope.read', 'memory.frozen.valid', 'memory.files.inspect', 'memory.files.state',
  'memory.snapshot', 'memory.snapshot.revisions', 'memory.documents.authority', 'topic.compaction.sources', 'memory.references.validate',
  'cognition.registry.read', 'cognition.registry.page', 'cognition.registry.refs.validate',
  'cognition.registry.publication.read', 'cognition.registry.publication.pending',
  'work.list',
]);
type SchedulingContext = CompanionStorageOperation & { barrier?: boolean; backgroundPoll?: boolean };
export interface CompanionStorageDispatchPolicy { kind: 'pureQuery' | 'readFence' | 'writeBarrier'; pipelineable: boolean }
export function companionStorageDispatchPolicy(command: CompanionStorageCommand, context?: SchedulingContext): CompanionStorageDispatchPolicy {
  // The explicit primary-topic entrance may initialize its topic/membership.
  if (queries.has(command.type) && !(command.type === 'messages' && command.topicId === null))
    return { kind: context?.barrier ? 'readFence' : 'pureQuery', pipelineable: true };
  if (!context?.barrier && context?.backgroundPoll && context.priority === 'background'
    && (command.type === 'world.tick' || command.type === 'world.job.check' || command.type === 'world.job.poll'))
    return { kind: 'pureQuery', pipelineable: false };
  return { kind: 'writeBarrier', pipelineable: false };
}
export function companionStorageReorderableQuery(command: CompanionStorageCommand, context?: SchedulingContext): boolean {
  return companionStorageDispatchPolicy(command, context).kind !== 'writeBarrier';
}
const settlements = new Set<CompanionStorageCommand['type']>([
  'loop.progress.finish', 'agenda.run.settle', 'world.work.end', 'world.job.complete', 'world.job.fail',
  'memory.jobs.complete', 'memory.jobs.fail', 'cognition.registry.publication.commit',
  'memory.jobs.proposal.save', 'world.job.proposal.save',
  'cognition.registry.publication.stages-cleaned',
]);
export function companionStorageSettlement(command: CompanionStorageCommand): boolean {
  return settlements.has(command.type) || command.type === 'loop.save' && ['done', 'cancelled', 'failed', 'interrupted'].includes(command.checkpoint.status)
    || command.type === 'cognition.registry.publication.transition' && ['conflict', 'revoked', 'cancelled'].includes(command.nextState);
}
export interface CompanionStorageDispatchEntry<T> extends CompanionStorageOperation {
  id: string; policy: CompanionStorageDispatchPolicy; settlement: boolean; value: T;
}
/** Two strict-pure credits, at most one background credit. Mutating polls are
 * reorderable but exclusive. A write waits for every posted real settlement;
 * the first queued writer may pass only independent ordinary pure reads.
 * read fences can pass independent pure reads, never an earlier write. */
export class CompanionStorageDispatchQueue<T> {
  private queued: CompanionStorageDispatchEntry<T>[] = [];
  private posted = new Map<string, CompanionStorageDispatchEntry<T>>();
  private interactiveTurns = 0;
  constructor(private readonly capacity = 256, private readonly controlReserve = 16, private readonly settlementReserve = 16) {}
  get inFlightCount(): number { return this.posted.size; }
  get queuedCount(): number { return this.queued.length; }
  get size(): number { return this.queued.length + this.posted.size; }
  enqueue(entry: CompanionStorageDispatchEntry<T>): boolean {
    const limit = this.capacity + (entry.settlement ? this.controlReserve + this.settlementReserve : entry.priority === 'control' ? this.controlReserve : 0);
    if (this.size >= limit) return false;
    this.queued.push(entry); return true;
  }
  remove(id: string): boolean {
    const index = this.queued.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    this.queued.splice(index, 1); return true;
  }
  rejectQueued(): CompanionStorageDispatchEntry<T>[] { return this.queued.splice(0); }
  settle(id: string): boolean {
    return this.posted.delete(id);
  }
  reset(): void { this.queued.length = 0; this.posted.clear(); this.interactiveTurns = 0; }
  take(allowBackground = true): CompanionStorageDispatchEntry<T> | undefined {
    if (this.posted.size >= 2 || !this.queued.length || [...this.posted.values()].some(entry => !entry.policy.pipelineable)) return;
    const barrier = this.queued.findIndex(entry => entry.policy.kind === 'writeBarrier');
    if (barrier === 0 && this.posted.size) return;
    const prefix = barrier < 0 ? this.queued : this.queued.slice(0, Math.max(1, barrier));
    const writer = barrier >= 0 ? this.queued[barrier] : undefined;
    const writerCanPass = barrier > 0 && prefix.every(entry => entry.policy.kind === 'pureQuery'
      && entry.policy.pipelineable && entry.lane !== writer!.lane);
    const candidates = writerCanPass ? [...prefix, writer!] : prefix;
    // A service budget cannot hold a prerequisite of foreground work hostage.
    // The existing order still decides which prerequisite is eligible first.
    const foregroundBehindWrite = barrier >= 0 && this.queued.slice(barrier).some(entry => entry.priority !== 'background');
    const foregroundLanes = new Set((barrier < 0 ? this.queued : this.queued.slice(0, barrier))
      .filter(entry => entry.priority !== 'background').map(entry => entry.lane));
    if (foregroundBehindWrite && !writerCanPass && barrier > 0) {
      // Only these lane frontiers prevent the first writer from passing.
      // Independent ordinary reads remain optional even ahead of that writer.
      for (const entry of prefix) if (entry.policy.kind !== 'pureQuery' || !entry.policy.pipelineable || entry.lane === writer!.lane)
        foregroundLanes.add(entry.lane);
    }
    const requiredWriter = foregroundBehindWrite && (barrier === 0 || writerCanPass) ? writer!.id : undefined;
    const backgroundPosted = [...this.posted.values()].some(entry => entry.priority === 'background');
    const lanes = new Set<string>(), eligible = candidates.filter(entry => {
      if (lanes.has(entry.lane)) return false; lanes.add(entry.lane);
      return !(backgroundPosted && entry.priority === 'background') && (allowBackground || entry.priority !== 'background'
        || entry.settlement || foregroundLanes.has(entry.lane) || entry.id === requiredWriter);
    });
    const choose = (priority: CompanionStorageOperation['priority']) => eligible.find(entry => entry.priority === priority && entry.policy.kind === 'readFence')
      ?? eligible.find(entry => entry.priority === priority);
    let selected = choose('control');
    if (!selected) {
      const interactive = choose('interactive'), background = choose('background');
      selected = this.interactiveTurns >= 8 && background ? background : interactive ?? background;
    }
    if (!selected || this.posted.size && !selected.policy.pipelineable) return;
    if (selected.priority === 'interactive') this.interactiveTurns = Math.min(8, this.interactiveTurns + 1);
    else if (selected.priority === 'background') this.interactiveTurns = 0;
    this.queued.splice(this.queued.indexOf(selected), 1); this.posted.set(selected.id, selected); return selected;
  }
}
