import path from 'node:path';
import type { BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import type { BotMemoryJobClaim } from './types';
import type { BotMemoryScope, BotMemoryService } from './memory-service';
import type { BotBrain } from './brain-router';
import type { BotDshCallback, BotDshModel } from './dsh-brain';
import { BotMemoryMaintenance } from './memory-maintenance';
import { BotMaintenanceStore, maintenanceDomain } from './memory-maintenance-store';
import type { BotStore } from './store';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface BotMaintenanceRuntimeOptions {
  store: BotStore; root: string; brain: BotBrain; memory: BotMemoryService; model(): BotDshModel; callback(): Promise<BotDshCallback>;
  changed(conversationId?: string): void; report?(error: unknown): void;
}
/** Maintenance is a low-priority consumer of the same durable domain queue as
 * capture. Its model never holds the VCP session's RPC/FIFO lock. */
export class BotMaintenanceRuntime {
  readonly journal: BotMaintenanceStore;
  private readonly core: BotMemoryMaintenance;
  private readonly active = new Map<string, { scope: BotMemoryScope; automatic: boolean; controller: AbortController; finished: Promise<void> }>();
  private lastPoll = 0;
  private polling?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: BotMaintenanceRuntimeOptions) {
    this.journal = new BotMaintenanceStore(options.store);
    this.core = new BotMemoryMaintenance({ brain: options.brain, memory: options.memory, model: options.model, callback: options.callback,
      cwd: (scope, operationId) => path.join(options.root, 'memory-maintenance', maintenanceDomain(scope), operationId) });
  }
  async handle(input: BotMemoryMaintenanceRequest, scope: BotMemoryScope): Promise<unknown> {
    this.journal.assertScope(scope);
    switch (input.type) {
      case 'memory.maintenance.settings.get': return this.journal.settings(scope);
      case 'memory.maintenance.settings.update': {
        const settings = this.journal.updateSettings(scope, input.settings);
        if (!settings.enabled) await this.abortScope(scope, false);
        this.options.changed(scope.conversationId); return settings;
      }
      case 'memory.maintenance.run': { const job = this.journal.enqueue(scope, input.kind, input.requestId, false, input.cursor); this.options.changed(scope.conversationId); return job; }
      case 'memory.maintenance.list': return this.journal.list(scope, input.cursor, input.limit);
      case 'memory.maintenance.get': return this.journal.get(scope, input.jobId).job;
      case 'memory.maintenance.candidates': return this.journal.candidates(scope, input.jobId, input.cursor, input.limit);
      case 'memory.maintenance.candidate': return this.journal.candidate(scope, input.jobId, input.candidateId);
      case 'memory.maintenance.diagnostics': return this.journal.diagnostics(scope, input.jobId, input);
      case 'memory.maintenance.review': {
        const candidate = this.journal.review(scope, input.jobId, input.candidateId, input.revision, input.decision, input.requestId);
        this.options.changed(scope.conversationId); return candidate;
      }
      case 'memory.maintenance.cancel': case 'memory.maintenance.retry': {
        const operation = input.type === 'memory.maintenance.cancel' ? 'cancel' : 'retry', job = this.journal.control(scope, input.jobId, operation, input.requestId);
        if (operation === 'cancel') this.active.get(input.jobId)?.controller.abort(Object.assign(new Error('用户停止维护任务。'), { code: 'MAINTENANCE_CANCEL' }));
        this.options.changed(scope.conversationId); return job;
      }
    }
  }
  activity(scope: BotMemoryScope, changeId?: string): void {
    this.journal.activity(scope, changeId);
    for (const run of this.active.values()) if (run.automatic && maintenanceDomain(run.scope) === maintenanceDomain(scope)) run.controller.abort(Object.assign(new Error('即时聊天优先，后台维护待闲置后继续。'), { code: 'MAINTENANCE_YIELD' }));
  }
  userMessage(scope: BotMemoryScope, substantive: boolean): void {
    if (substantive || this.journal.hasSettings(scope)) this.activity(scope);
    else for (const run of this.active.values()) if (run.automatic && maintenanceDomain(run.scope) === maintenanceDomain(scope)) run.controller.abort(Object.assign(new Error('即时聊天优先，后台维护待闲置后继续。'), { code: 'MAINTENANCE_YIELD' }));
  }
  tool(scope: BotMemoryScope, input: { operation: 'plan' | 'status'; kind?: 'organize' | 'dream'; jobId?: string }, requestId: string): unknown {
    if (input.operation === 'status') {
      const compact = (job: ReturnType<BotMaintenanceStore['get']>['job']) => ({ ...job, narrative: job.narrative?.slice(0, 800), error: job.error?.slice(0, 800) });
      if (input.jobId) return compact(this.journal.get(scope, input.jobId).job);
      const found = this.journal.list(scope, undefined, 6); return { ...found, items: found.items.map(compact) };
    }
    return this.journal.planTool(scope, input.kind ?? 'organize', requestId);
  }
  async abortScope(scope: BotMemoryScope, includeManual = true): Promise<void> {
    const runs = [...this.active.values()].filter(run => maintenanceDomain(run.scope) === maintenanceDomain(scope) && (includeManual || run.automatic));
    for (const run of runs) run.controller.abort(Object.assign(new Error('记忆正在撤回或后台设置已关闭，维护停止。'), { code: 'MAINTENANCE_CANCEL' }));
    await Promise.allSettled(runs.map(run => run.finished));
  }
  invalidate(scope: BotMemoryScope): void {
    for (const run of this.active.values()) if (maintenanceDomain(run.scope) === maintenanceDomain(scope)) run.controller.abort(Object.assign(new Error('来源已撤回，旧维护资料不再可用。'), { code: 'MAINTENANCE_CANCEL' }));
    this.journal.invalidate(scope); this.options.changed(scope.conversationId);
  }
  poll(): void {
    if (this.closed || this.polling || Date.now() - this.lastPoll < 60000) return;
    this.lastPoll = Date.now();
    this.polling = this.pollOnce().catch(error => this.options.report?.(error)).finally(() => { this.polling = undefined; });
  }
  private async pollOnce(): Promise<void> {
    const scope = this.journal.due(); if (!scope || !this.options.model().apiKey) return;
    const settings = this.journal.settings(scope);
    try {
      // One cheap bounded catalog RPC, after SQL eligibility. No startup sweep,
      // vector recall, or model admission is performed by this poll.
      const catalog = await this.options.memory.catalog(scope, { limit: 24 }) as { total?: unknown; items?: Array<{ indexState?: string }>; liveEligibleCount?: unknown };
      if (this.closed) return;
      const total = typeof catalog.liveEligibleCount === 'number' && Number.isSafeInteger(catalog.liveEligibleCount) && catalog.liveEligibleCount >= 0 ? catalog.liveEligibleCount : 0;
      if (total < settings.minNotes) { this.journal.defer(scope, 3600000, '可用日记尚未达到后台整理阈值。'); return; }
      // Recheck the inexpensive gates after the awaited read, so incoming chat
      // cannot turn a stale eligibility check into an automatic model call.
      const due = this.journal.due(); if (!due || maintenanceDomain(due) !== maintenanceDomain(scope)) return;
      const job = this.journal.enqueue(scope, settings.kind, `automatic:${new Date().toISOString().slice(0, 10)}`, true);
      this.journal.defer(scope, settings.intervalHours * 3600000, undefined, true); this.options.changed(scope.conversationId);
      this.journal.diagnostic(scope, job.id, 'scheduled', { policy: 'safe-idle', minNotes: settings.minNotes, catalogCount: total });
    } catch (error) { if (this.closed) return; this.journal.defer(scope, 6 * 3600000, message(error)); throw error; }
  }
  async run(claim: BotMemoryJobClaim, parentSignal: AbortSignal): Promise<{ status: 'done' | 'failed' | 'retry'; error?: string; retryDelayMs?: number }> {
    const scope = claim.job.payload.scope as BotMemoryScope, jobId = String(claim.job.payload.jobId), operation = claim.job.payload.operation;
    const original = this.journal.get(scope, jobId);
    if (original.job.status === 'cancelled' || original.job.status === 'completed') return { status: 'done' };
    if (operation === 'plan' && original.plan) return { status: 'done' };
    if (original.job.automatic) {
      const settings = this.journal.settings(scope);
      if (!settings.enabled) { this.journal.progress(scope, jobId, 'cancelled', 'cancelled'); return { status: 'done' }; }
      if (Date.now() - Date.parse(settings.lastActivityAt) < settings.idleMinutes * 60000) return { status: 'retry', retryDelayMs: settings.idleMinutes * 60000 };
      if (original.job.attempts >= 2 && !original.plan) { this.journal.progress(scope, jobId, 'blocked', 'blocked', '自动计划已用完本次恢复预算；请人工检查后继续。'); return { status: 'failed' }; }
    }
    const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(120000)]);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(jobId, { scope, automatic: original.job.automatic, controller, finished });
    try {
      if (operation === 'plan') this.journal.consumeAdmission(scope, jobId);
      const record = this.journal.start(scope, jobId, operation === 'apply'); this.options.changed(scope.conversationId);
      const onProgress = (progress: { phase: string }) => { signal.throwIfAborted(); this.journal.progress(scope, jobId, progress.phase); this.options.changed(scope.conversationId); };
      const onDiagnostic = async (phase: string, value: unknown) => { this.journal.diagnostic(scope, jobId, phase, value); };
      if (operation === 'plan') {
        const plan = await this.core.preparePlan({ scope, kind: record.job.kind, operationId: jobId, contextEpoch: record.snapshot?.contextEpoch ?? 1, admissionAttempt: record.epoch, snapshot: record.snapshot, cursor: record.cursor, signal,
          onSnapshot: async snapshot => { signal.throwIfAborted(); this.journal.snapshot(scope, jobId, snapshot); }, onProgress, onDiagnostic });
        signal.throwIfAborted(); this.journal.savePlan(scope, jobId, plan);
        // Lossless is an explicit opt-in, deterministic concatenation only.
        // Dream insights/archives always require individual human review.
        const settings = this.journal.settings(scope);
        if (settings.autoApply === 'lossless' && record.job.kind === 'organize') {
          for (const candidate of this.journal.candidates(scope, jobId).items.filter(item => item.type === 'organize')) this.journal.review(scope, jobId, candidate.id, candidate.revision, 'approve', `lossless:${jobId}:${candidate.id}`, 'lossless');
        }
        return { status: 'done' };
      }
      if (operation !== 'apply') throw new Error('维护队列操作无效。');
      const candidateId = String(claim.job.payload.candidateId), candidate = this.journal.candidate(scope, jobId, candidateId);
      if (candidate.status === 'applied' || candidate.status === 'rejected') return { status: 'done' };
      if (!['approved', 'applying', 'unknown', 'conflict'].includes(candidate.status) || !record.plan) throw new Error('这项候选尚未获得批准。');
      this.journal.candidateResult(scope, jobId, candidateId, 'applying');
      // Suppress legacy v1 resurrection before admitting any managed effect,
      // including a write whose acknowledgement could be lost.
      this.options.store.setMetadata(`memory-capture-backfill-v2-suppressed:${maintenanceDomain(scope)}`, jobId);
      this.options.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
      const receipt = await this.core.applyCandidate({ scope, plan: record.plan, candidateId, contextEpoch: record.plan.contextEpoch,
        approval: claim.job.payload.approval === 'lossless' ? 'lossless' : 'review', signal, onProgress, onDiagnostic });
      const status = receipt.status === 'indexed' || receipt.status === 'archived' ? 'applied' : receipt.status === 'conflict' || receipt.status === 'withdrawn' ? 'conflict' : 'unknown';
      this.journal.candidateResult(scope, jobId, candidateId, status, receipt);
      if (status === 'applied') this.journal.activity(scope, `maintenance:${receipt.operationId}`);
      if (['pending', 'partial'].includes(receipt.status) && claim.job.attempts < 5) { this.journal.progress(scope, jobId, 'waiting_index', 'applying'); return { status: 'retry', retryDelayMs: claim.job.attempts * 5000 }; }
      return { status: 'done' };
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error, code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined;
      const originalCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (operation === 'plan' && ['BOT_ABORT_ACKNOWLEDGED', 'MEMORY_MAINTENANCE_MODEL_CANCELLED', 'MEMORY_MAINTENANCE_MODEL_FAILED'].includes(String(originalCode))) this.options.store.setMetadata(`maintenance-new-admission:${jobId}`, '1');
      if (parentSignal.aborted || code === 'BOT_SUSPEND') { this.journal.progress(scope, jobId, 'queued', 'queued'); return { status: 'retry', retryDelayMs: 0 }; }
      if (code === 'MAINTENANCE_YIELD') {
        this.journal.progress(scope, jobId, 'waiting_idle', 'queued', message(reason));
        return { status: 'retry', retryDelayMs: this.journal.settings(scope).idleMinutes * 60000 };
      }
      if (code === 'MAINTENANCE_CANCEL') { if (operation === 'apply') this.journal.candidateResult(scope, jobId, String(claim.job.payload.candidateId), 'unknown', { status: 'unknown', error: '取消时写入回执待核实，恢复后先查同一操作回执。' }); this.journal.progress(scope, jobId, 'cancelled', 'cancelled'); return { status: 'done' }; }
      this.journal.diagnostic(scope, jobId, 'error', { message: message(error), code: code ?? null });
      this.journal.progress(scope, jobId, 'blocked', 'blocked', message(error));
      if (original.job.automatic) this.journal.defer(scope, 24 * 3600000, message(error));
      this.options.report?.(error); return { status: 'failed', error: message(error) };
    } finally { this.active.delete(jobId); finish(); this.options.changed(scope.conversationId); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; for (const run of this.active.values()) run.controller.abort(Object.assign(new Error('应用关闭，维护保留待恢复。'), { code: 'BOT_SUSPEND' }));
    this.closing = (async () => {
      await Promise.allSettled([...this.active.values()].map(run => run.finished));
      if (this.polling) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([this.polling, new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]); }
        finally { clearTimeout(timer); }
      }
      // A remaining read belongs to BotMemoryService and is terminated by its
      // subsequent close. pollOnce checks closed after both resolve and reject.
    })();
    return this.closing;
  }
}
