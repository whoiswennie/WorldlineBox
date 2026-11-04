import { createHash } from 'node:crypto';

export interface BotActivityBudgetPolicy {
  maxDerivedEvents: number; maxActions: number; maxTasks: number; maxElapsedMs: number;
  maxPendingInbox: number; reservedInteractiveInbox: number; maxPendingTasks: number; reservedInteractiveTasks: number;
}
export const DEFAULT_BOT_ACTIVITY_BUDGET: Readonly<BotActivityBudgetPolicy> = Object.freeze({ maxDerivedEvents: 64, maxActions: 24, maxTasks: 8,
  maxElapsedMs: 10 * 60_000, maxPendingInbox: 512, reservedInteractiveInbox: 64, maxPendingTasks: 64, reservedInteractiveTasks: 16 });
export class BotActivityLimitError extends Error { readonly code = 'BOT_ACTIVITY_LIMIT'; }
export class BotBackpressureError extends Error { readonly code = 'BOT_BACKPRESSURE'; }
type State = { startedAt: number; events: number; actions: number; tasks: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
/** Invoke inside the owning SQLite transaction; no process-local budget can
 * be reset by a crash, duplicate ingress, or a fan-out branch. */
export class BotActivityBudget {
  readonly policy: Readonly<BotActivityBudgetPolicy>;
  constructor(private readonly store: { getMetadata(key: string): string | undefined; setMetadata(key: string, value: string): void }, options: Partial<BotActivityBudgetPolicy> = {}) {
    const policy = { ...DEFAULT_BOT_ACTIVITY_BUDGET, ...options };
    for (const [name, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < (name.startsWith('reserved') ? 0 : 1)) throw Error('活动预算必须是有限正整数。');
    if (policy.reservedInteractiveInbox >= policy.maxPendingInbox || policy.reservedInteractiveTasks >= policy.maxPendingTasks) throw Error('交互保留容量必须小于总容量。');
    this.policy = Object.freeze(policy);
  }
  start(correlationId: string, now = Date.now()): void { this.state(correlationId, now); }
  private state(correlationId: string, now: number): { key: string; value: State } {
    const key = `activity-budget:${digest(correlationId)}`, stored = this.store.getMetadata(key);
    if (stored) {
      const value = JSON.parse(stored) as State;
      if (![value.startedAt, value.events, value.actions, value.tasks].every(number => Number.isSafeInteger(number) && number >= 0)) throw new BotActivityLimitError('活动预算记录损坏，拒绝继续自动活动。');
      return { key, value };
    }
    const value: State = { startedAt: now, events: 0, actions: 0, tasks: 0 }; this.store.setMetadata(key, JSON.stringify(value)); return { key, value };
  }
  reserve(correlationId: string, kind: 'events' | 'actions' | 'tasks', operationId: string, amount = 1, now = Date.now()): void {
    const receipt = `activity-use:${digest(JSON.stringify([correlationId, kind, operationId]))}`;
    if (this.store.getMetadata(receipt)) return;
    const { key, value } = this.state(correlationId, now), limit = kind === 'events' ? this.policy.maxDerivedEvents : kind === 'actions' ? this.policy.maxActions : this.policy.maxTasks;
    if (!Number.isSafeInteger(amount) || amount < 0 || now - value.startedAt >= this.policy.maxElapsedMs || value[kind] + amount > limit) throw new BotActivityLimitError('本次活动的时间或资源预算已用尽，等待新的用户输入。');
    this.store.setMetadata(key, JSON.stringify({ ...value, [kind]: value[kind] + amount })); this.store.setMetadata(receipt, '1');
  }
}
export const isInteractiveBotSource = (source: string): boolean => ['user', 'task', 'gateway'].includes(source);
