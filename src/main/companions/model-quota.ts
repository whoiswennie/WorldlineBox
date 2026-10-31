import { createHash } from 'node:crypto';

export type CompanionModelPriority = 'foreground' | 'background';
export class CompanionModelAdmissionError extends Error {
  readonly code = 'RATE_LIMIT';
  constructor(readonly reason: 'queue_full' | 'connection_full' | 'owner_full' | 'queue_timeout' | 'preflight_timeout' | 'configuration_unavailable' | 'files_pending', message: string, readonly retryAt?: string) { super(message); this.name = 'CompanionModelAdmissionError'; }
}
export interface CompanionModelQuotaLimits {
  active: number; connection: number; background: number; foregroundBurst: number;
  pending?: number; pendingPerConnection?: number; pendingPerOwner?: number;
}
export interface CompanionModelWork {
  ownerId: string;
  connectionId: string;
  priority: CompanionModelPriority;
  estimatedInputTokens?: number;
}
interface Pending {
  work: CompanionModelWork;
  signal?: AbortSignal;
  queuedAt: number;
  invoke(): Promise<void>;
  reject(reason: unknown): void;
  abort?(): void;
}

/** A shared admission gate for actual companion provider operations. A permit
 * spans the response body/stream, not merely receipt of the HTTP headers. */
export class CompanionModelQuota {
  private readonly pending: Pending[] = [];
  private readonly connections = new Map<string, number>();
  private readonly connectionLimits = new Map<string, Map<string, number>>();
  private readonly backgrounds = new Map<string, number>();
  private active = 0;
  private activeBackground = 0;
  private foregroundBurst = 0;
  private readonly ownerTurns = new Map<string, number>();
  private turn = 0;
  private scheduled = false;
  private completed = 0;
  private estimatedTokens = 0;
  constructor(private readonly limits: CompanionModelQuotaLimits = { active: 4, connection: 4, background: 2, foregroundBurst: 8,
    pending: 128, pendingPerConnection: 64, pendingPerOwner: 16 }) {
    if (Object.values(limits).some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) throw new RangeError('Invalid companion model quota.');
  }

  run<T>(work: CompanionModelWork, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!work.ownerId || !work.connectionId) return Promise.reject(new Error('Model admission requires a trusted owner and connection.'));
    if (this.pending.length >= (this.limits.pending ?? 128)) return Promise.reject(new CompanionModelAdmissionError('queue_full', '模型待处理队列已满，来源仍保留，请稍后重试。'));
    if (this.pending.filter(item => item.work.connectionId === work.connectionId).length >= (this.limits.pendingPerConnection ?? 64))
      return Promise.reject(new CompanionModelAdmissionError('connection_full', '这个模型连接的待处理队列已满，请稍后重试。'));
    if (this.pending.filter(item => item.work.ownerId === work.ownerId).length >= (this.limits.pendingPerOwner ?? 16))
      return Promise.reject(new CompanionModelAdmissionError('owner_full', '这位伙伴的模型待处理队列已满，现有工作会继续，请稍后重试。'));
    return new Promise<T>((resolve, reject) => {
      const item: Pending = { work, signal, queuedAt: Date.now(), reject,
        invoke: async () => { try { resolve(await operation()); } catch (error) { reject(error); } } };
      item.abort = () => {
        const index = this.pending.indexOf(item);
        if (index < 0) return; // An executing operation retains its permit until it really settles.
        this.pending.splice(index, 1); signal?.removeEventListener('abort', item.abort!);
        reject(signal?.reason); this.schedule();
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.pending.push(item); this.schedule();
    });
  }

  snapshot() {
    return { active: this.active, activeBackground: this.activeBackground, queued: this.pending.length,
      oldestQueuedAt: this.pending.length ? Math.min(...this.pending.map(item => item.queuedAt)) : undefined,
      completed: this.completed, estimatedInputTokens: this.estimatedTokens, limits: { ...this.limits } };
  }

  configureConnection(connectionId: string, concurrent: number, policyOwner = 'host'): void {
    if (!Number.isSafeInteger(concurrent) || concurrent < 1 || concurrent > this.limits.connection) throw new RangeError('Invalid connection concurrency.');
    const policies = this.connectionLimits.get(connectionId) ?? new Map<string, number>();
    policies.set(policyOwner, concurrent); this.connectionLimits.set(connectionId, policies); this.schedule();
  }
  releaseConnectionPolicy(connectionId: string, policyOwner = 'host'): void {
    const policies = this.connectionLimits.get(connectionId); policies?.delete(policyOwner);
    if (!policies?.size) this.connectionLimits.delete(connectionId); this.schedule();
  }

  private eligible(item: Pending): boolean {
    return (this.connections.get(item.work.connectionId) ?? 0) < Math.min(this.limits.connection, ...this.connectionLimits.get(item.work.connectionId)?.values() ?? [])
      && (item.work.priority !== 'background' || this.activeBackground < this.limits.background
        && !(this.backgrounds.get(item.work.ownerId) ?? 0));
  }
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump(): void {
    while (this.active < this.limits.active) {
      const candidates = this.pending.filter(item => this.eligible(item));
      if (!candidates.length) return;
      const backgroundTurn = candidates.some(item => item.work.priority === 'background')
        && (this.foregroundBurst >= this.limits.foregroundBurst || !candidates.some(item => item.work.priority === 'foreground'));
      const priority = backgroundTurn ? 'background' : 'foreground';
      const turn = candidates.filter(item => item.work.priority === priority);
      // Least recently served owner wins, then its FIFO head. Merely avoiding
      // the previous owner can starve a third resident behind two busy ones.
      const next = turn.reduce<Pending | undefined>((selected, item) => !selected
        || (this.ownerTurns.get(item.work.ownerId) ?? 0) < (this.ownerTurns.get(selected.work.ownerId) ?? 0) ? item : selected, undefined);
      if (!next) return;
      this.pending.splice(this.pending.indexOf(next), 1);
      next.signal?.removeEventListener('abort', next.abort!);
      if (next.signal?.aborted) { next.reject(next.signal.reason); continue; }
      this.active++;
      this.connections.set(next.work.connectionId, (this.connections.get(next.work.connectionId) ?? 0) + 1);
      if (backgroundTurn) {
        this.activeBackground++; this.backgrounds.set(next.work.ownerId, 1); this.foregroundBurst = 0;
      } else this.foregroundBurst = Math.min(this.limits.foregroundBurst, this.foregroundBurst + 1);
      this.ownerTurns.set(next.work.ownerId, ++this.turn);
      this.estimatedTokens += next.work.estimatedInputTokens ?? 0;
      void next.invoke().finally(() => {
        this.active--; this.completed++;
        const remaining = (this.connections.get(next.work.connectionId) ?? 1) - 1;
        if (remaining) this.connections.set(next.work.connectionId, remaining); else this.connections.delete(next.work.connectionId);
        if (backgroundTurn) { this.activeBackground--; this.backgrounds.delete(next.work.ownerId); }
        this.schedule();
      });
    }
  }
}

export const companionModelQuota = new CompanionModelQuota();

/** Only the digest is retained in the gate; no provider credential is logged. */
export function companionModelConnection(config: { apiFormat: string; baseUrl?: string; apiKey: string }): string {
  return createHash('sha256').update(JSON.stringify([config.apiFormat, config.baseUrl ?? '', config.apiKey])).digest('hex');
}
