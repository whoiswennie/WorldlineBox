import type { CompanionLoopCheckpoint } from '../../shared/companion-loop';
import type { CompanionMemoryRecall } from './memory-service';
import type { CompanionMemory, CompanionMessage } from '../../shared/companions';

/** A restored task owns its already prepared passive input, including an empty
 * or withdrawn receipt. Rebuilding a step/profile is not a new task. */
export function restoredCompanionTaskRecall(checkpoint: CompanionLoopCheckpoint): CompanionMemoryRecall | undefined {
  if (!checkpoint.context) return;
  const data = JSON.parse(checkpoint.context.user) as { memoryRecall?: CompanionMemoryRecall; memories?: CompanionMemory[]; memorySources?: CompanionMessage[] };
  const recall = data.memoryRecall;
  // Old task checkpoints may predate the receipt. Continue from their exact
  // saved task/tool input rather than retroactively starting another query.
  return { memories: recall?.context ? [] : data.memories ?? [], sources: data.memorySources ?? [], reasons: recall?.reasons ?? [], pending: recall?.pending ?? false,
    degraded: recall?.degraded ?? false, ...(recall?.context ? { context: recall.context } : {}),
    ...(recall?.continuation ? { continuation: recall.continuation } : {}), ...(recall?.timings ? { timings: recall.timings } : {}) };
}
