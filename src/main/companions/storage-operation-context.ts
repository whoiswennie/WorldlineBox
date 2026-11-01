import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

export type CompanionStorageOperationPriority = 'control' | 'interactive' | 'background';
export interface CompanionStorageOperation { lane: string; priority: CompanionStorageOperationPriority }
type Context = CompanionStorageOperation & { barrier?: boolean; backgroundPoll?: boolean };
const operations = new AsyncLocalStorage<Context>();

/** Host scheduling identity only; this never supplies execution authority. */
export function withCompanionStorageOperation<T>(input: { lane?: string; priority: CompanionStorageOperationPriority }, operation: () => T): T {
  const current = operations.getStore(), lane = input.lane ?? randomUUID();
  return operations.run({ lane, priority: input.priority,
    ...(current?.barrier && current.lane === lane ? { barrier: true } : {}),
    ...(current?.backgroundPoll && current.lane === lane ? { backgroundPoll: true } : {}) }, operation);
}
export function currentCompanionStorageOperation(): Readonly<CompanionStorageOperation> | undefined {
  const current = operations.getStore();
  return current ? { lane: current.lane, priority: current.priority } : undefined;
}
/** Diagnostics only. Never send the private lane or this hash as authority. */
export function currentCompanionStorageOperationHash(): string | undefined {
  const current = operations.getStore();
  return current ? createHash('sha256').update(current.lane).digest('hex') : undefined;
}
/** Final authority reads remain ordered even if their command is otherwise a
 * pure query. This flag cannot be provided by a renderer/model request. */
export function withCompanionStorageBarrier<T>(operation: () => T): T {
  return operations.run({ ...(operations.getStore() ?? { lane: randomUUID(), priority: 'background' as const }), barrier: true }, operation);
}
export function companionStorageSchedulingContext(): Readonly<Context> {
  return { ...(operations.getStore() ?? { lane: 'unmarked-background', priority: 'background' as const }) };
}
/** Only the two host clock/lease polling callsites use this scheduling marker.
 * Paid dispatch checks and independent spawned operations do not inherit it. */
export function withCompanionStorageBackgroundPoll<T>(operation: () => T): T {
  return operations.run({ ...(operations.getStore() ?? { lane: 'unmarked-background', priority: 'background' as const }), backgroundPoll: true }, operation);
}
