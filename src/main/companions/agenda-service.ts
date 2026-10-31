import { createHash } from 'node:crypto';
import type {
  CompanionAgendaClaim, CompanionAgendaCommand, CompanionAgendaResponse, CompanionAgendaRun, CompanionAgendaStep,
} from '../../shared/companion-agenda';

export type CompanionAgendaFacts = Record<string, boolean | string | number>;
export interface CompanionAgendaExecutionResult {
  outcome: 'completed' | 'silent' | 'waiting' | 'failed' | 'cancelled' | 'parked' | 'abandoned' | 'unknown';
  result?: string;
  error?: string;
  stage?: string;
  notBefore?: string;
  nextCondition?: string;
}
export interface CompanionAgendaExecutionContext {
  /** A successful checkpoint is durable before this promise resolves. */
  checkpoint(stage: string, value: unknown): Promise<void>;
  /** Records a small effect receipt under a stable key. Repeated successful
   * effects return the stored JSON value; uncertain effects are never replayed. */
  effect<T>(key: string, title: string, operation: (effectId: string) => Promise<T>): Promise<T>;
  /** A pure local calculation may use this stable identity without issuing an effect. */
  effectId(key: string): string;
  /** Bind a goal-derived grant after the host resolves it, so revocation also
   * interrupts an event whose rule did not repeat that grant ID. */
  bindGrant(grantId: string): void;
}
export interface CompanionAgendaServiceOptions {
  request(command: CompanionAgendaCommand): Promise<CompanionAgendaResponse>;
  owners(): Promise<readonly string[]>;
  execute(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext, signal: AbortSignal): Promise<CompanionAgendaExecutionResult>;
  /** Cheap host facts only. Reading a calendar must never call this or advance chance. */
  facts?(companionId: string, now: Date, signal: AbortSignal): Promise<CompanionAgendaFacts>;
  blocked?(companionId: string): boolean;
  classifyError?(error: unknown): CompanionAgendaExecutionResult | undefined;
  changed(): void;
  report(error: unknown): void;
  /** Engineering concurrency, not an allowance per day or per companion. The
   * store atomically applies the companion's own configured concurrency. */
  activeLimit?: number;
  pollMs?: number;
  leaseMs?: number;
  now?(): Date;
}

/** Domain adapters use this for resources/configuration they cannot yet use.
 * It preserves the run and does not consume its processing-failure cycle. */
export class CompanionAgendaDeferred extends Error {
  constructor(message: string, readonly notBefore?: string, readonly nextCondition?: string) {
    super(message); this.name = 'CompanionAgendaDeferred';
  }
}
/** Only throw this when the external owner explicitly confirmed no effect took
 * place. Transport errors do not establish that fact. */
export class CompanionAgendaEffectNotApplied extends Error {
  constructor(message: string) { super(message); this.name = 'CompanionAgendaEffectNotApplied'; }
}
/** Requires actual receipt reconciliation. Neither a lease expiry nor retry is
 * evidence that a message/file/external action did not already take effect. */
export class CompanionAgendaOutcomeUnknown extends Error {
  constructor(message: string) { super(message); this.name = 'CompanionAgendaOutcomeUnknown'; }
}

interface Job { owner: string; ruleId: string; grants: Set<string>; controller: AbortController; promise: Promise<void> }
const textError = (error: unknown) => (error instanceof Error ? error.message : '伙伴事件暂未处理完成。').slice(0, 2000);
const json = (value: unknown, maximum: number, label: string) => {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || serialized.length > maximum) throw new Error(`${label}必须是可序列化且在容量内的数据。`);
  return serialized;
};

/** The only semantic event pump. SQL owns opportunities, owner concurrency,
 * resources, leases and failure dispositions; adapters own their domain work.
 * A waiting adapter returns promptly instead of holding a cognition permit. */
export class CompanionAgendaService {
  private readonly jobs = new Map<string, Job>();
  private readonly observedRevisions = new Map<string, number>();
  private readonly controller = new AbortController();
  private readonly activeLimit: number;
  private readonly pollMs: number;
  private readonly leaseMs: number;
  private ticking?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private closed = false;
  private wakeAgain = false;
  private nextOwner = 0;

  constructor(private readonly options: CompanionAgendaServiceOptions) {
    this.activeLimit = options.activeLimit ?? 32;
    this.pollMs = options.pollMs ?? 1000;
    this.leaseMs = options.leaseMs ?? 30000;
    if (!Number.isSafeInteger(this.activeLimit) || this.activeLimit < 1 || this.activeLimit > 1000
      || !Number.isSafeInteger(this.pollMs) || this.pollMs < 10
      || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000 || this.leaseMs > 600000)
      throw new RangeError('伙伴事件调度参数无效。');
  }

  start(): void { if (this.closed || this.started) return; this.started = true; this.wake(); }
  wake(): void {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.ticking) { this.wakeAgain = true; return; }
    void this.tick().catch(error => this.report(error));
  }
  tick(now = this.now()): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const task = this.pump(now);
    this.ticking = task;
    void task.finally(() => {
      if (this.ticking !== task) return;
      this.ticking = undefined;
      const immediate = this.wakeAgain; this.wakeAgain = false;
      if (this.started && !this.closed) this.arm(immediate ? 0 : this.pollMs);
    }).catch(() => undefined);
    return task;
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }
  private report(error: unknown): void { try { this.options.report(error); } catch { /* Observers do not own event state. */ } }
  private changed(): void { try { this.options.changed(); } catch (error) { this.report(error); } }
  private classify(error: unknown): CompanionAgendaExecutionResult {
    if (error instanceof CompanionAgendaDeferred) return { outcome: 'waiting', stage: error.message.slice(0, 1000),
      notBefore: error.notBefore, nextCondition: (error.nextCondition ?? error.message).slice(0, 1000) };
    if (error instanceof CompanionAgendaOutcomeUnknown) return { outcome: 'unknown', error: error.message.slice(0, 2000), stage: '等待核对实际作用结果' };
    try { return this.options.classifyError?.(error) ?? { outcome: 'failed', error: textError(error) }; }
    catch (classificationError) { this.report(classificationError); return { outcome: 'failed', error: textError(error) }; }
  }
  private arm(ms: number): void {
    if (this.closed || !this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; this.wake(); }, ms); this.timer.unref();
  }
  private async request(command: CompanionAgendaCommand): Promise<CompanionAgendaResponse> {
    const response = await this.options.request(command);
    if (!response.ok) throw new Error(response.error ?? '伙伴日程账本暂不可用。');
    return response;
  }
  private async pump(now: Date): Promise<void> {
    const owners = [...new Set(await this.options.owners())];
    if (this.closed || !owners.length) return;
    const offset = this.nextOwner % owners.length;
    const ordered = [...owners.slice(offset), ...owners.slice(0, offset)];
    this.nextOwner = (offset + 1) % owners.length;
    // Probability and due-state checks continue even when execution is full.
    // One owner's unavailable facts must not suppress every other owner's day.
    const eligible: string[] = [];
    for (const owner of ordered) {
      if (this.closed) return;
      if (this.options.blocked?.(owner)) continue;
      try {
        const facts = await this.options.facts?.(owner, now, this.controller.signal) ?? {};
        if (this.closed || this.options.blocked?.(owner)) continue;
        const tick = await this.request({ type: 'agenda.tick', companionId: owner, now: now.toISOString(), facts });
        if (tick.agendaRevision !== undefined && this.observedRevisions.get(owner) !== tick.agendaRevision) {
          this.observedRevisions.set(owner, tick.agendaRevision); this.changed();
        }
        eligible.push(owner);
      } catch (error) { if (!this.closed) this.report(error); }
    }
    // One claim per owner per round retains fairness without a short list of
    // globally excluded owners or a hidden limit on the number of companions.
    while (!this.closed && this.jobs.size < this.activeLimit && eligible.length) {
      let claimedAny = false;
      for (const owner of eligible) {
        if (this.closed || this.jobs.size >= this.activeLimit) return;
        if (this.options.blocked?.(owner)) continue;
        try {
          const response = await this.request({ type: 'agenda.claim', companionId: owner, now: new Date(Math.max(now.getTime(), this.now().getTime())).toISOString(),
            leaseMs: this.leaseMs, limit: 1, excludedOwners: [] });
          const claim = response.agendaClaim ?? response.agendaClaims?.[0];
          if (!claim) continue;
          if (claim.rule.companionId !== owner || claim.run.companionId !== owner || claim.occurrence.companionId !== owner
            || claim.run.ruleId !== claim.rule.id || claim.occurrence.ruleId !== claim.rule.id
            || claim.rule.revision !== claim.occurrence.ruleRevision
            || claim.run.occurrenceId !== claim.occurrence.id || claim.run.leaseToken !== claim.leaseToken
            || this.jobs.has(claim.run.id)) throw new Error('日程领取返回了不匹配的伙伴、发生或租约，未执行能力。');
          claimedAny = true;
          this.startJob(claim);
        } catch (error) { if (!this.closed) this.report(error); }
      }
      if (!claimedAny) break;
    }
  }

  private startJob(claim: CompanionAgendaClaim): void {
    const controller = new AbortController();
    // Register before the first adapter instruction or callback can run.
    const promise = Promise.resolve().then(() => this.dispatch(claim, controller))
      .catch(error => { if (!this.closed && !controller.signal.aborted) this.report(error); })
      .finally(() => {
        this.jobs.delete(claim.run.id); this.changed();
        if (this.started && !this.closed) this.arm(0);
      });
    this.jobs.set(claim.run.id, { owner: claim.run.companionId, ruleId: claim.rule.id,
      grants: new Set(claim.rule.grantId ? [claim.rule.grantId] : []), controller, promise }); this.changed();
  }

  private async dispatch(claim: CompanionAgendaClaim, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    const scope = { companionId: claim.run.companionId, id: claim.run.id, leaseToken: claim.leaseToken };
    let finished = false, refreshing: Promise<void> | undefined;
    const assertLive = () => {
      signal.throwIfAborted();
      if (finished) throw new Error('本次事件已经交还账本，不能继续提交步骤。');
      if (this.closed || this.options.blocked?.(scope.companionId)) throw new CompanionAgendaDeferred('伙伴当前不可运行，等待恢复。');
    };
    const heartbeat = setInterval(() => {
      if (finished || refreshing || signal.aborted) return;
      const task = (async () => {
        const response = await this.request({ type: 'agenda.run.heartbeat', ...scope, now: this.now().toISOString(), leaseMs: this.leaseMs });
        if (finished) return;
        if (!response.agendaRun || response.agendaRun.status !== 'running' || response.agendaRun.leaseToken !== scope.leaseToken)
          throw new Error('伙伴日程租约已失效，旧执行已停止。');
      })().catch(error => {
        if (!finished) { controller.abort(error); this.report(error); }
      }).finally(() => { if (refreshing === task) refreshing = undefined; });
      refreshing = task;
    }, Math.max(250, Math.floor(this.leaseMs / 3))); heartbeat.unref();
    const effectId = (key: string) => {
      if (!key || key.length > 1000) throw new Error('事件步骤需要稳定的有限标识。');
      return 'agenda_' + createHash('sha256').update(JSON.stringify([scope.companionId, scope.id, key])).digest('hex');
    };
    const effectJobs = new Map<string, Promise<unknown>>();
    const context: CompanionAgendaExecutionContext = {
      effectId,
      bindGrant: grantId => { assertLive(); this.jobs.get(scope.id)?.grants.add(grantId); },
      checkpoint: async (stage, value) => {
        assertLive();
        const serialized = json(value, 256000, '日程检查点');
        const response = await this.request({ type: 'agenda.run.checkpoint', ...scope, now: this.now().toISOString(), stage, checkpoint: serialized });
        if (response.agendaRun?.id !== scope.id || response.agendaRun.companionId !== scope.companionId
          || response.agendaRun.leaseToken !== scope.leaseToken || response.agendaRun.checkpoint !== serialized)
          throw new Error('日程检查点没有返回匹配的持久回执，后续步骤尚未执行。');
        assertLive(); this.changed();
      },
      effect: <T>(key: string, title: string, operation: (id: string) => Promise<T>): Promise<T> => {
        const existingJob = effectJobs.get(key);
        if (existingJob) return existingJob as Promise<T>;
        const task = (async (): Promise<T> => {
        assertLive();
        const identity = effectId(key), effectScope = { companionId: scope.companionId, runId: scope.id, effectKey: identity };
        const response = await this.request({ type: 'agenda.step.read', ...effectScope });
        const existing = response.agendaStep;
        assertLive();
        if (existing && (existing.companionId !== scope.companionId || existing.runId !== scope.id || existing.effectKey !== identity))
          throw new CompanionAgendaOutcomeUnknown('步骤回执不属于当前伙伴与执行，未继续读取或调用能力。');
        if (existing?.status === 'succeeded') {
          if (existing.result === undefined) throw new CompanionAgendaOutcomeUnknown('已完成步骤缺少可核对回执，不能重新执行。');
          try { return JSON.parse(existing.result) as T; }
          catch { throw new CompanionAgendaOutcomeUnknown('已完成步骤的回执不可读取，不能重新执行。'); }
        }
        if (existing && ['dispatched', 'unknown'].includes(existing.status))
          throw new CompanionAgendaOutcomeUnknown('该事件步骤已经发出但结果尚未核对，未重复执行。');
        const record = async (status: CompanionAgendaStep['status'], result?: string) => {
          assertLive();
          const recorded = await this.request({ type: 'agenda.step.record', ...effectScope, leaseToken: scope.leaseToken,
            now: this.now().toISOString(), title, status, ...(result !== undefined ? { result } : {}) });
          if (!recorded.agendaStep || recorded.agendaStep.companionId !== scope.companionId || recorded.agendaStep.runId !== scope.id
            || recorded.agendaStep.effectKey !== identity || recorded.agendaStep.status !== status)
            throw new Error('事件步骤未返回匹配的持久回执，不能据此继续外部操作。');
          return recorded.agendaStep;
        };
        await record('prepared');
        const dispatched = await record('dispatched');
        if (dispatched && dispatched.status !== 'dispatched') throw new CompanionAgendaOutcomeUnknown('步骤状态已变化，未重新调用外部能力。');
        // From this point, interruption/transport loss is uncertain. A failed
        // receipt commit cannot turn an already applied effect into a retry.
        let value: T;
        try { assertLive(); value = await operation(identity); }
        catch (error) {
          if (error instanceof CompanionAgendaEffectNotApplied && !signal.aborted) {
            await record('failed', textError(error)); throw error;
          }
          if (!signal.aborted) await record('unknown', textError(error)).catch(failure => this.report(failure));
          throw new CompanionAgendaOutcomeUnknown(textError(error));
        }
        try { assertLive(); await record('succeeded', json(value, 32000, '步骤回执')); }
        catch (error) { throw new CompanionAgendaOutcomeUnknown('能力已返回，但成功回执尚未确认：' + textError(error)); }
        this.changed(); return value;
        })();
        // Keep rejected results too: one invocation cannot repeat an effect by
        // issuing the same native step concurrently or catching its rejection.
        effectJobs.set(key, task); void task.catch(() => undefined); return task;
      },
    };
    let outcome: CompanionAgendaExecutionResult;
    try {
      assertLive();
      outcome = await this.options.execute(claim, context, signal);
      assertLive();
    } catch (error) {
      if (signal.aborted || this.closed) { finished = true; clearInterval(heartbeat); await refreshing; return; }
      outcome = this.classify(error);
    }
    // Even a buggy adapter which forgot to await a started effect cannot mark
    // its parent complete while that effect still has an unconfirmed outcome.
    const effects = await Promise.allSettled([...effectJobs.values()]);
    const uncertain = effects.find(result => result.status === 'rejected' && result.reason instanceof CompanionAgendaOutcomeUnknown);
    const failed = uncertain ?? effects.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') outcome = this.classify(failed.reason);
    // Marking finished first also ignores a heartbeat which was in flight when
    // settlement relinquished its token. Unknown commit results never trigger
    // a second settlement or execute call.
    finished = true; clearInterval(heartbeat); await refreshing;
    if (signal.aborted || this.closed) return;
    await this.request({ type: 'agenda.run.settle', ...scope, now: this.now().toISOString(), ...outcome });
    this.changed();
  }

  /** The host must commit the manual control/revocation before aborting its
   * adapter. Cancellation itself never rewrites a completed/unknown receipt. */
  cancelRun(runId: string): void { this.jobs.get(runId)?.controller.abort(); }
  cancelRule(companionId: string, ruleId: string): void {
    for (const job of this.jobs.values()) if (job.owner === companionId && job.ruleId === ruleId) job.controller.abort();
  }
  cancelGrant(grantId: string): void {
    for (const job of this.jobs.values()) if (job.grants.has(grantId)) job.controller.abort();
  }
  cancelCompanion(companionId: string): void {
    for (const job of this.jobs.values()) if (job.owner === companionId) job.controller.abort();
  }
  async drainCompanion(companionId: string): Promise<void> {
    await this.ticking;
    this.cancelCompanion(companionId);
    await Promise.allSettled([...this.jobs.values()].filter(job => job.owner === companionId).map(job => job.promise));
  }
  snapshot(): { active: number; owners: Array<{ companionId: string; active: number }> } {
    const owners = new Map<string, number>();
    for (const job of this.jobs.values()) owners.set(job.owner, (owners.get(job.owner) ?? 0) + 1);
    return { active: this.jobs.size, owners: [...owners].map(([companionId, active]) => ({ companionId, active })) };
  }
  async close(): Promise<void> {
    this.closed = true; this.started = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.controller.abort();
    await this.ticking;
    // Shutdown owners abort their external work before drain(). Keeping these
    // phases separate prevents a circular wait with the DSH/action owner.
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}

/** Small typed helper for domain adapters which persist JSON checkpoints. */
export function companionAgendaCheckpoint<T>(run: Pick<CompanionAgendaRun, 'checkpoint'>): T | undefined {
  if (run.checkpoint === undefined) return undefined;
  try { return JSON.parse(run.checkpoint) as T; }
  catch { throw new CompanionAgendaOutcomeUnknown('日程检查点不可读取，旧执行未自动重放。'); }
}
