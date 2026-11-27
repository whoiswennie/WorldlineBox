import path from 'node:path';
import { COMPANION_IDLE_MAINTENANCE, VCP_DREAM_SCHEDULE, type MaintenanceBriefInput, type MemoMasterMode, type BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import type { BotMemoryJobClaim } from './types';
import type { BotMemoryScope, BotMemoryService, BotMaintenanceWorkBatch, BotMaintenanceWorkProgress, BotMaintenanceWorkStats } from './memory-service';
import type { BotBrain } from './brain-router';
import { BotDshTurnFailedError, type BotDshCallback, type BotDshModel } from './dsh-brain';
import { BotMemoryMaintenance, type BotMaintenanceContinuation } from './memory-maintenance';
import { BotMaintenanceStore, maintenanceDomain, maintenanceOwner } from './memory-maintenance-store';
import { BotMemoryMaintenanceReviewer, MEMORY_REVIEW_PROMPT_VERSION } from './memory-maintenance-reviewer';
import type { BotStore } from './store';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export interface BotMaintenanceRuntimeOptions {
  store: BotStore; root: string; brain: BotBrain; memory: BotMemoryService; model(): BotDshModel; callback(): Promise<BotDshCallback>;
  changed(conversationId?: string): void; report?(error: unknown): void;
  companionBusy?(companionId: string): boolean;
}
/** Maintenance consumes the durable audience queue. Its model never holds
 * the VCP session's RPC lock while a companion is answering. */
export class BotMaintenanceRuntime {
  readonly journal: BotMaintenanceStore;
  private readonly core: BotMemoryMaintenance;
  private readonly reviewer: BotMemoryMaintenanceReviewer;
  private readonly active = new Map<string, { scope: BotMemoryScope; automatic: boolean; operation: unknown; controller: AbortController; finished: Promise<void> }>();
  private lastPoll = 0;
  private lastReviewPoll = 0;
  private awakeSince = Date.now();
  private polling?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: BotMaintenanceRuntimeOptions) {
    const workRoot = path.join(options.root, 'vcp-maintenance-v2');
    this.journal = new BotMaintenanceStore(options.store);
    this.core = new BotMemoryMaintenance({ brain: options.brain, memory: options.memory, model: options.model, callback: options.callback,
      dreamer: scope => {
        const companion = options.store.getCompanion(scope.companionId);
        return companion && { name: companion.name, persona: companion.persona };
      },
      cwd: (scope, operationId) => path.join(workRoot, 'plans', maintenanceDomain(scope), operationId) });
    this.reviewer = new BotMemoryMaintenanceReviewer({ brain: options.brain, memory: options.memory, callback: options.callback, root: path.join(workRoot, 'reviews') });
  }
  async handle(input: BotMemoryMaintenanceRequest, scope: BotMemoryScope): Promise<unknown> {
    this.journal.assertScope(scope);
    switch (input.type) {
      case 'memory.maintenance.settings.get': return this.journal.settings(scope);
      case 'memory.maintenance.settings.update': {
        const previous = this.journal.settings(scope);
        const settings = this.journal.updateSettings(scope, input.settings);
        if (settings.autoReview && !previous.autoReview) {
          const key = `maintenance-review-cycle:${maintenanceOwner(scope)}`;
          this.options.store.setMetadata(key, String(Number(this.options.store.getMetadata(key) || '0') + 1));
          this.journal.queueAutomaticReview(scope);
        }
        if (previous.autoReview && !settings.autoReview) for (const run of this.active.values()) if (run.operation === 'review' && maintenanceDomain(run.scope) === maintenanceDomain(scope)) run.controller.abort(Object.assign(new Error('自动审阅已关闭，保留人工审阅。'), { code: 'MAINTENANCE_REVIEW_DISABLED' }));
        if (previous.enabled && !settings.enabled) await this.abortScope(scope, false);
        this.options.changed(scope.conversationId); return settings;
      }
      case 'memory.maintenance.run': { const job = this.journal.enqueue(scope, input.kind, input.requestId, false, input.cursor, undefined, undefined, input.mode, undefined, input.brief); this.options.changed(scope.conversationId); return job; }
      case 'memory.maintenance.list': return this.journal.list(scope, input.cursor, input.limit);
      case 'memory.maintenance.get': return this.journal.get(scope, input.jobId).job;
      case 'memory.maintenance.candidates': return this.journal.candidates(scope, input.jobId, input.cursor, input.limit);
      case 'memory.maintenance.candidate': return this.journal.candidate(scope, input.jobId, input.candidateId);
      case 'memory.maintenance.resume': {
        const candidate = this.journal.resumeCandidate(scope, input.jobId, input.candidateId, input.revision, input.requestId);
        this.options.changed(scope.conversationId); return candidate;
      }
      case 'memory.maintenance.reviews': return this.journal.reviews(scope, input.jobId, input.candidateId, input.cursor, input.limit);
      case 'memory.maintenance.diagnostics': return this.journal.diagnostics(scope, input.jobId, input);
      case 'memory.maintenance.review': {
        const candidate = this.journal.review(scope, input.jobId, input.candidateId, input.revision, input.decision, input.requestId);
        await this.syncReviewedVersions(scope, input.jobId);
        this.options.changed(scope.conversationId); return candidate;
      }
      case 'memory.maintenance.cancel': case 'memory.maintenance.retry': {
        const operation = input.type === 'memory.maintenance.cancel' ? 'cancel' : 'retry', job = this.journal.control(scope, input.jobId, operation, input.requestId);
        if (operation === 'cancel') {
          this.active.get(input.jobId)?.controller.abort(Object.assign(new Error('用户停止维护任务。'), { code: 'MAINTENANCE_CANCEL' }));
          if (!this.journal.get(scope, input.jobId).plan) await this.releaseBatch(scope, input.jobId, '用户停止本任务，来源保留供后续增量整理。');
          else await this.syncReviewedVersions(scope, input.jobId);
        }
        this.options.changed(scope.conversationId); return job;
      }
    }
  }
  activity(scope: BotMemoryScope, changeId?: string): void {
    this.journal.activity(scope, changeId);
    this.yieldPlanning(scope);
  }
  userMessage(scope: BotMemoryScope, substantive: boolean): void {
    if (substantive || this.journal.hasSettings(scope)) this.journal.activity(scope);
    this.foreground(scope.companionId);
  }
  awaken(): void {
    this.awakeSince = Date.now();
    this.lastPoll = 0;
    for (const run of this.active.values()) if (run.automatic && run.operation === 'plan') {
      run.controller.abort(Object.assign(new Error('桌面恢复，稍后核实伙伴是否空闲。'), { code: 'MAINTENANCE_YIELD' }));
    }
  }
  foreground(companionId: string): void {
    if (this.closed) return;
    this.journal.recordForeground(companionId);
    for (const run of this.active.values()) {
      if (run.scope.companionId === companionId && (run.operation === 'plan' || run.operation === 'review')) {
        run.controller.abort(Object.assign(new Error('伙伴正在聊天，整理将在空闲后继续。'), { code: 'MAINTENANCE_YIELD' }));
      }
    }
  }
  private idle(companionId: string, now: number): boolean {
    return now - this.awakeSince >= COMPANION_IDLE_MAINTENANCE.wakeGraceMs
      && now - this.journal.lastForegroundAt(companionId) >= COMPANION_IDLE_MAINTENANCE.quietMs
      && !this.options.companionBusy?.(companionId);
  }
  private yieldPlanning(scope: BotMemoryScope): void {
    const domain = maintenanceDomain(scope);
    for (const run of this.active.values()) {
      if ((run.operation === 'plan' || run.operation === 'review') && maintenanceDomain(run.scope) === domain) {
        run.controller.abort(Object.assign(new Error('聊天优先，维护任务稍后续接。'), { code: 'MAINTENANCE_YIELD' }));
      }
    }
  }
  tool(scope: BotMemoryScope, input: { operation: 'plan' | 'status'; kind?: 'organize' | 'dream'; mode?: MemoMasterMode; brief?: MaintenanceBriefInput; jobId?: string }, requestId: string): unknown {
    if (input.operation === 'status') {
      const compact = (job: ReturnType<BotMaintenanceStore['get']>['job']) => ({ ...job, narrative: job.narrative?.slice(0, 800), error: job.error?.slice(0, 800) });
      if (input.jobId) return compact(this.journal.get(scope, input.jobId).job);
      const found = this.journal.list(scope, undefined, 6); return { ...found, items: found.items.map(compact) };
    }
    return this.journal.planTool(scope, input.kind ?? (input.mode || input.brief ? 'organize' : 'dream'), requestId, input.mode, input.brief);
  }
  async abortScope(scope: BotMemoryScope, includeManual = true): Promise<void> {
    const runs = [...this.active.values()].filter(run => maintenanceDomain(run.scope) === maintenanceDomain(scope) && (includeManual || run.automatic && run.operation === 'plan'));
    for (const run of runs) run.controller.abort(Object.assign(new Error('记忆正在撤回或后台设置已关闭，维护停止。'), { code: 'MAINTENANCE_CANCEL' }));
    await Promise.allSettled(runs.map(run => run.finished));
  }
  invalidate(scope: BotMemoryScope): void {
    for (const run of this.active.values()) if (maintenanceDomain(run.scope) === maintenanceDomain(scope)) run.controller.abort(Object.assign(new Error('来源已撤回，旧维护资料不再可用。'), { code: 'MAINTENANCE_CANCEL' }));
    this.journal.invalidate(scope); this.options.changed(scope.conversationId);
  }
  poll(): void {
    if (this.closed || this.polling || Date.now() - this.lastPoll < COMPANION_IDLE_MAINTENANCE.checkMs) return;
    this.lastPoll = Date.now();
    this.polling = this.pollOnce().catch(error => this.options.report?.(error)).finally(() => { this.polling = undefined; });
  }
  private async pollOnce(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastReviewPoll >= 60000) {
      this.lastReviewPoll = now;
      const review = this.journal.queueAutomaticReview();
      if (review) this.options.changed(review.conversationId);
    }
    await this.journal.scheduleDreams({ onScheduled: scope => this.options.changed(scope.conversationId), stopped: () => this.closed });
    if (!this.closed && now - this.awakeSince >= COMPANION_IDLE_MAINTENANCE.wakeGraceMs) {
      await this.journal.scheduleIdleDream({ now, isIdle: id => this.idle(id, now), onScheduled: scope => this.options.changed(scope.conversationId), stopped: () => this.closed });
    }
  }
  async run(claim: BotMemoryJobClaim, parentSignal: AbortSignal): Promise<{ status: 'done' | 'failed' | 'retry'; error?: string; retryDelayMs?: number }> {
    const scope = claim.job.payload.scope as BotMemoryScope, jobId = String(claim.job.payload.jobId), operation = claim.job.payload.operation;
    const original = this.journal.get(scope, jobId);
    if (original.job.phase === 'planner_retired' || claim.job.payload.approval === 'lossless') return { status: 'done' };
    if ((operation === 'review' || original.job.survey && operation === 'plan') && this.options.companionBusy?.(scope.companionId)) return { status: 'retry', retryDelayMs: COMPANION_IDLE_MAINTENANCE.checkMs };
    if ((original.job.status === 'cancelled' || original.job.status === 'completed') && operation !== 'reconcile' && !(operation === 'plan' && original.plan?.scan.incremental)) return { status: 'done' };
    if (original.job.automatic && operation === 'plan') {
      const settings = this.journal.settings(scope);
      if (!settings.enabled || (original.job.kind !== 'dream' && original.job.trigger !== 'idle')) { this.journal.progress(scope, jobId, 'cancelled', 'cancelled'); return { status: 'done' }; }
      if (!original.plan) {
        if ([...this.active.values()].some(run => run.automatic && run.operation === 'plan')) {
          return { status: 'retry', retryDelayMs: VCP_DREAM_SCHEDULE.agentGapSeconds * 1000 };
        }
        const now = Date.now(), trigger = original.job.trigger ?? 'night';
        // Even a sampled night job must yield to a live turn. A recovered
        // night job may use the same quiet daytime opportunity as an idle job.
        if (this.options.companionBusy?.(scope.companionId)) return { status: 'retry', retryDelayMs: COMPANION_IDLE_MAINTENANCE.checkMs };
        const quietAt = this.journal.lastForegroundAt(scope.companionId) + COMPANION_IDLE_MAINTENANCE.quietMs;
        if (quietAt > now) return { status: 'retry', retryDelayMs: quietAt - now };
        const delay = original.job.kind === 'dream'
          ? this.journal.dreamExecutionDelay(scope, now, { allowDaytime: this.idle(scope.companionId, now), trigger })
          : Math.max(0, this.awakeSince + COMPANION_IDLE_MAINTENANCE.wakeGraceMs - now);
        if (delay > 0) return { status: 'retry', retryDelayMs: delay };
        // Desktop credential resolution can access secure storage. Do this
        // only for an admitted job, never on the idle timer's polling path.
        let configured = false;
        try { configured = !!this.options.model().apiKey; } catch (error) { this.options.report?.(error); }
        if (!configured) {
          this.journal.progress(scope, jobId, 'waiting_executor', 'queued', '等待应用的聊天模型可用。');
          return { status: 'retry', retryDelayMs: 300_000 };
        }
      }
    }
    const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal]);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    this.active.set(jobId, { scope, automatic: operation === 'review' || operation === 'plan' && original.job.automatic, operation, controller, finished });
    let reviewModel: BotDshModel | undefined;
    try {
      if (operation === 'plan') this.journal.consumeAdmission(scope, jobId);
      const record = operation === 'review' || operation === 'reconcile' || original.plan ? this.journal.get(scope, jobId) : this.journal.start(scope, jobId, operation === 'apply'); this.options.changed(scope.conversationId);
      const onProgress = (progress: { phase: string }) => { signal.throwIfAborted(); this.journal.progress(scope, jobId, progress.phase); this.options.changed(scope.conversationId); };
      const onDiagnostic = async (phase: string, value: unknown) => { this.journal.diagnostic(scope, jobId, phase, value); };
      if (operation === 'plan') {
        const continuationKey = `maintenance-output:${jobId}:${record.epoch}`;
        const savedContinuation = this.options.store.getMetadata(continuationKey);
        if (!record.plan && record.snapshot?.scan.incremental) {
          const batch = await this.options.memory.maintenanceWork(scope, { action: 'claim', kind: record.job.kind, jobId, limit: 20 }) as BotMaintenanceWorkBatch;
          if (batch.state !== 'processing') throw Object.assign(new Error('本任务来源已交给其他任务处理，请查看当前方案。'), { code: 'MEMORY_MAINTENANCE_BATCH_CHANGED' });
        }
        const plan = record.plan ?? await this.core.preparePlan({ scope, kind: record.job.kind, mode: record.job.mode, brief: record.job.brief, operationId: jobId, contextEpoch: record.snapshot?.contextEpoch ?? 1, admissionAttempt: record.epoch, snapshot: record.snapshot, cursor: record.cursor, signal,
          ...(record.job.kind === 'organize' && !record.job.survey ? { selectBatch: async () => {
            await this.initializeIncremental(scope);
            return await this.options.memory.maintenanceWork(scope, { action: 'claim', kind: record.job.kind, jobId, limit: 20 }) as BotMaintenanceWorkBatch;
          }, associate: async retrieval => {
            const result = await this.options.memory.maintenanceWork(scope, { action: 'associate', kind: record.job.kind, jobId, retrieval }) as { items: Array<{ id: string; checksum: string }> }; return result.items;
          } } : {}), continuation: savedContinuation ? JSON.parse(savedContinuation) as BotMaintenanceContinuation : undefined,
          onContinuation: async checkpoint => { this.options.store.setMetadata(continuationKey, JSON.stringify(checkpoint)); },
          onSnapshot: async snapshot => { signal.throwIfAborted(); this.journal.snapshot(scope, jobId, snapshot); }, onProgress, onDiagnostic });
        signal.throwIfAborted();
        if (!record.plan) this.options.store.taskTransaction(() => {
          this.journal.savePlan(scope, jobId, plan);
          if (record.job.automatic && plan.kind === 'dream' && plan.sources.some(source => source.role === 'seed')) {
            this.journal.recordDreamSuccess(scope);
          } else if (record.job.trigger === 'idle' && plan.kind === 'dream' && !plan.scan.deferred.some(item => item.retryable !== false)) {
            // The native wave uses the diaries' actual ages. After a long
            // absence, inspect unprocessed versions through the organizer.
            this.journal.enqueueIdleOrganization(scope, jobId);
          }
        });
        const batch = await this.completeBatch(scope, jobId, plan);
        if (plan.kind === 'organize' && batch?.maturityAt) this.journal.scheduleMaturity(scope, batch.maturityAt);
        if (record.job.trigger === 'idle' && plan.kind === 'organize' && batch) {
          const remaining = await this.options.memory.maintenanceWork(scope, { action: 'stats', kind: 'organize' }) as BotMaintenanceWorkStats;
          this.journal.finishIdleOrganization(scope, jobId, {
            hasMore: remaining.ready > 0 || remaining.retrying > 0 || remaining.processing > 0, retryAt: remaining.ready ? undefined : remaining.retryAt,
          });
        }
        if (record.plan) this.journal.refreshPlanState(scope, jobId);
        this.options.store.setMetadata(continuationKey, '');
        if (record.job.kind === 'organize' && (!record.job.mode || record.job.mode === 'organize') && this.journal.settings(scope).autoReview) this.journal.queueAutomaticReview(scope);
        return { status: 'done' };
      }
      if (operation === 'review') {
        const candidateId = String(claim.job.payload.candidateId), candidate = this.journal.candidate(scope, jobId, candidateId);
        if (record.job.kind === 'dream' || record.job.mode && record.job.mode !== 'organize' || !this.journal.settings(scope).autoReview || candidate.status !== 'pending' || !record.plan) return { status: 'done' };
        this.journal.progress(scope, jobId, 'auto_reviewing', 'review', record.job.error); this.options.changed(scope.conversationId);
        reviewModel = this.options.model();
        const key = `maintenance-output:${jobId}:review:${claim.job.id}`, saved = this.options.store.getMetadata(key);
        const admission = this.options.store.getMetadata(`maintenance-review-admission:${claim.job.id}`) || '0';
        const result = await this.reviewer.review({ scope, plan: record.plan, candidate, operationId: `${claim.job.id}:${admission}`, model: reviewModel, signal,
          continuation: saved ? JSON.parse(saved) as BotMaintenanceContinuation : undefined,
          saveContinuation: value => this.options.store.setMetadata(key, value ? JSON.stringify(value) : ''), diagnostic: (phase, value) => this.journal.diagnostic(scope, jobId, phase, value) });
        signal.throwIfAborted();
        if (!this.journal.settings(scope).autoReview) return { status: 'done' };
        const current = this.journal.candidate(scope, jobId, candidateId);
        const cycle = Number(this.options.store.getMetadata(`maintenance-review-cycle:${maintenanceOwner(scope)}`) || '0');
        if (current.status !== 'pending' || current.revision !== candidate.revision) {
          this.journal.recordReview(scope, jobId, candidateId, claim.job.id, { ...result, cycle, actor: 'model', candidateRevision: candidate.revision, decision: 'manual', reason: '审阅期间用户已处理候选或候选版本发生变化，保留已有决定。' });
        } else if (result.decision === 'manual') this.journal.recordReview(scope, jobId, candidateId, claim.job.id, { ...result, cycle, actor: 'model', candidateRevision: candidate.revision });
        else this.journal.review(scope, jobId, candidateId, candidate.revision, result.decision, claim.job.id, 'model', { ...result, cycle });
        if (result.decision !== 'manual') await this.syncReviewedVersions(scope, jobId);
        const final = this.journal.get(scope, jobId).job;
        if (final.phase === 'auto_reviewing') this.journal.progress(scope, jobId, 'pending_review', final.status, final.error);
        this.journal.queueAutomaticReview(scope); this.options.changed(scope.conversationId); return { status: 'done' };
      }
      if (operation === 'reconcile') {
        await this.reconcileCandidate(scope, jobId, String(claim.job.payload.candidateId), claim.job.id, signal);
        await this.syncReviewedVersions(scope, jobId);
        return { status: 'done' };
      }
      if (operation !== 'apply') throw new Error('维护队列操作无效。');
      const candidateId = String(claim.job.payload.candidateId), candidate = this.journal.candidate(scope, jobId, candidateId);
      if (candidate.status === 'applied' || candidate.status === 'rejected' || candidate.status === 'superseded') return { status: 'done' };
      if (!['approved', 'applying', 'unknown', 'conflict'].includes(candidate.status) || !record.plan) throw new Error('这项候选尚未获得批准。');
      if ((record.job.kind === 'dream' || record.job.mode && record.job.mode !== 'organize') && candidate.approval?.actor !== 'user') {
        this.journal.candidateResult(scope, jobId, candidateId, 'conflict', { error: '需要这项候选的人工批准记录。' });
        return { status: 'done' };
      }
      if (claim.job.payload.approval === 'model') {
        if (this.options.store.getMetadata(`maintenance-approval:${jobId}:${candidateId}`) !== 'model') return { status: 'done' };
        if (!this.journal.settings(scope).autoReview && candidate.status === 'approved') { this.journal.candidateResult(scope, jobId, candidateId, 'pending'); return { status: 'done' }; }
        const review = this.journal.reviews(scope, jobId, candidateId).items.find(item => item.actor === 'model' && item.decision === 'approve' && item.candidateRevision === candidate.revision);
        if (!review) { this.journal.candidateResult(scope, jobId, candidateId, 'conflict', { error: '未取得与候选版本相符的模型批准记录，保留人工检查。' }); return { status: 'done' }; }
        if (candidate.type === 'archive') for (const evidence of review.evidence ?? []) {
          const expected = review.sources?.find(source => source.id === evidence.sourceId), note = await this.options.memory.readNote(scope, { id: evidence.sourceId }) as Record<string, unknown>;
          if (!expected || note.checksum !== expected.checksum || ['archived', 'forgotten', 'withdrawing'].includes(String(note.indexState))) { this.journal.candidateResult(scope, jobId, candidateId, 'conflict', { error: '归档依赖的覆盖证据已变化，未执行归档，需重新审阅。' }); return { status: 'done' }; }
        }
      }
      this.journal.candidateResult(scope, jobId, candidateId, 'applying');
      this.options.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
      const receipt = await this.core.applyCandidate({ scope, plan: record.plan, candidateId, contextEpoch: record.plan.contextEpoch,
        approval: 'review', signal, onProgress, onDiagnostic });
      const status = receipt.status === 'indexed' || receipt.status === 'archived' ? 'applied' : receipt.status === 'conflict' || receipt.status === 'withdrawn' ? 'conflict' : 'unknown';
      this.journal.candidateResult(scope, jobId, candidateId, status, receipt);
      if (receipt.error?.code === 'MEMORY_NOTE_UNAVAILABLE') {
        await this.reconcileCandidate(scope, jobId, candidateId, claim.job.id, signal);
        await this.syncReviewedVersions(scope, jobId);
        return { status: 'done' };
      }
      await this.syncReviewedVersions(scope, jobId);
      // Native receipts classify the output version as derived. It remains
      // searchable context but does not dirty/trigger the next maintenance run.
      if (['pending', 'partial'].includes(receipt.status)) { this.journal.progress(scope, jobId, 'waiting_index', 'applying'); return { status: 'retry', retryDelayMs: Math.min(300000, claim.job.attempts * 5000) }; }
      return { status: 'done' };
    } catch (error) {
      const reason = signal.aborted ? signal.reason : error, code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined;
      const originalCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (operation === 'plan' && ['BOT_ABORT_ACKNOWLEDGED', 'MEMORY_MAINTENANCE_MODEL_CANCELLED', 'MEMORY_MAINTENANCE_MODEL_FAILED', 'MEMORY_MAINTENANCE_NO_PROGRESS', 'MEMORY_MAINTENANCE_INVALID_PLAN'].includes(String(originalCode))) this.options.store.setMetadata(`maintenance-new-admission:${jobId}`, '1');
      if (parentSignal.aborted || code === 'BOT_SUSPEND') { this.journal.progress(scope, jobId, 'queued', 'queued'); return { status: 'retry', retryDelayMs: 0 }; }
      if (code === 'MAINTENANCE_REVIEW_DISABLED') return { status: 'done' };
      if (code === 'MAINTENANCE_YIELD') {
        this.journal.progress(scope, jobId, 'waiting_idle', 'queued', message(reason));
        return { status: 'retry', retryDelayMs: VCP_DREAM_SCHEDULE.agentGapSeconds * 1000 };
      }
      if (code === 'MAINTENANCE_CANCEL') { if (operation === 'apply') this.journal.candidateResult(scope, jobId, String(claim.job.payload.candidateId), 'unknown', { status: 'unknown', error: '取消时写入回执待核实，恢复后先查同一操作回执。' }); if (operation === 'plan' && !this.journal.get(scope, jobId).plan) await this.releaseBatch(scope, jobId, '任务已停止。'); this.journal.progress(scope, jobId, 'cancelled', 'cancelled'); return { status: 'done' }; }
      if (operation === 'reconcile') {
        this.journal.candidateResult(scope, jobId, String(claim.job.payload.candidateId), 'unknown', { error: { code: String(code || 'MEMORY_RECEIPT_UNAVAILABLE'), message: message(error) } });
        this.journal.diagnostic(scope, jobId, 'reconciliation', { status: 'unknown', error: message(error) });
        return { status: 'done', error: message(error) };
      }
      if (operation === 'review') {
        const candidate = this.journal.candidate(scope, jobId, String(claim.job.payload.candidateId));
        const transient = ['DSH_HOST_UNAVAILABLE', 'BOT_LANE_BUSY', 'BOT_DELIVERY_UNKNOWN', 'BOT_SUSPEND', 'MEMORY_REVIEW_MODEL_FAILED', 'MEMORY_WORKSPACE_BUSY', 'SESSION_CLOSED', 'MEMORY_PROCESS_EXITED'].includes(String(originalCode))
          || /(?:HTTP\s*(?:408|429|5\d\d)|timeout|timed out|ECONNRESET|ECONNREFUSED|temporar(?:y|ily)|fetch failed)/iu.test(message(error));
        if (transient && candidate.status === 'pending') {
          if (error instanceof BotDshTurnFailedError || originalCode === 'MEMORY_REVIEW_MODEL_FAILED') {
            const admissionKey = `maintenance-review-admission:${claim.job.id}`;
            this.options.store.setMetadata(admissionKey, String(Number(this.options.store.getMetadata(admissionKey) || '0') + 1));
            this.options.store.setMetadata(`maintenance-output:${jobId}:review:${claim.job.id}`, '');
          }
          const reason = '自动审阅暂时中断，已保留任务并稍后重试；其他候选继续处理：' + message(error);
          this.journal.recordReview(scope, jobId, candidate.id, `${claim.job.id}:retry:${claim.job.attempts}`, { actor: 'model', decision: 'retry', candidateRevision: candidate.revision,
            cycle: Number(this.options.store.getMetadata(`maintenance-review-cycle:${maintenanceOwner(scope)}`) || '0'), model: reviewModel?.model, promptVersion: MEMORY_REVIEW_PROMPT_VERSION, reason });
          this.journal.diagnostic(scope, jobId, 'model-review-retry', { message: message(error), attempt: claim.job.attempts });
          this.journal.progress(scope, jobId, 'auto_review_waiting', 'review', this.journal.get(scope, jobId).job.error);
          this.journal.queueAutomaticReview(scope);
          return { status: 'retry', retryDelayMs: Math.min(300000, Math.max(30000, claim.job.attempts * 30000)), error: message(error) };
        }
        this.journal.recordReview(scope, jobId, candidate.id, claim.job.id, { actor: 'model', decision: 'manual', candidateRevision: candidate.revision, cycle: Number(this.options.store.getMetadata(`maintenance-review-cycle:${maintenanceOwner(scope)}`) || '0'), model: reviewModel?.model, promptVersion: MEMORY_REVIEW_PROMPT_VERSION, reason: '自动审阅未取得可核实的结论，转交人工：' + message(error) });
        const final = this.journal.get(scope, jobId).job;
        if (final.phase === 'auto_reviewing') this.journal.progress(scope, jobId, 'pending_review', final.status, final.error);
        this.journal.diagnostic(scope, jobId, 'model-review-error', { message: message(error) }); this.journal.queueAutomaticReview(scope);
        this.options.report?.(error); return { status: 'done', error: message(error) };
      }
      this.journal.diagnostic(scope, jobId, 'error', { message: message(error), code: code ?? null });
      if (operation === 'plan' && this.journal.get(scope, jobId).plan?.scan.incremental) {
        this.journal.progress(scope, jobId, 'waiting_checkpoint', 'queued', message(error));
        return { status: 'retry', retryDelayMs: Math.min(300000, Math.max(30000, claim.job.attempts * 30000)), error: message(error) };
      }
      if (operation === 'plan' && code === 'MEMORY_MAINTENANCE_INVALID_PLAN') {
        await this.releaseBatch(scope, jobId, message(error));
        if (error && typeof error === 'object' && 'validationIssues' in error) this.journal.diagnostic(scope, jobId, 'candidate-validation', { issues: error.validationIssues });
        this.journal.progress(scope, jobId, 'invalid_plan', 'blocked', message(error));
        return { status: 'failed', error: message(error) };
      }
      if (original.job.automatic && operation === 'plan' && ['DSH_HOST_UNAVAILABLE', 'BOT_LANE_BUSY', 'MEMORY_MAINTENANCE_MODEL_FAILED', 'MEMORY_MAINTENANCE_NO_PROGRESS'].includes(String(code))) {
        this.journal.progress(scope, jobId, 'waiting_executor', 'queued', message(error));
        return { status: 'retry', retryDelayMs: Math.min(300000, Math.max(30000, original.job.attempts * 30000)), error: message(error) };
      }
      if (operation === 'plan' && originalCode === 'BOT_DELIVERY_UNKNOWN') {
        this.journal.progress(scope, jobId, 'waiting_executor', 'queued', message(error)); this.options.report?.(error);
        return { status: 'retry', retryDelayMs: Math.min(300000, Math.max(30000, claim.job.attempts * 30000)), error: message(error) };
      }
      this.journal.progress(scope, jobId, 'blocked', 'blocked', message(error));
      if (operation === 'plan') await this.releaseBatch(scope, jobId, message(error));
      this.options.report?.(error); return { status: 'failed', error: message(error) };
    } finally {
      this.active.delete(jobId);
      finish();
      if (original.job.automatic && original.job.kind === 'dream' && operation === 'plan' && !original.plan) this.journal.recordDreamAttemptFinished();
      this.options.changed(scope.conversationId);
    }
  }
  private async initializeIncremental(scope: BotMemoryScope): Promise<void> {
    // One resumable import of successful historical analysis. It records source
    // versions only; no candidate, audit, native file or approval is rewritten.
    const key = `maintenance-incremental-import-v1:${maintenanceDomain(scope)}`;
    if (this.closed) throw Object.assign(new Error('应用关闭，稍后继续导入增量进度。'), { code: 'BOT_SUSPEND' });
    const identity = await this.options.memory.maintenanceWork(scope, { action: 'identity' }) as { generation: string };
    if (typeof identity.generation !== 'string' || !identity.generation) throw new Error('增量维护队列缺少持久身份。');
    if (this.closed) throw Object.assign(new Error('应用关闭，稍后继续导入增量进度。'), { code: 'BOT_SUSPEND' });
    const generationKey = `maintenance-incremental-native-generation:${maintenanceDomain(scope)}`;
    if (this.options.store.getMetadata(generationKey) !== identity.generation) {
      this.options.store.setMetadata(key, '0'); this.options.store.setMetadata(generationKey, identity.generation);
    }
    let cursor = this.options.store.getMetadata(key);
    while (cursor !== 'done') {
      const page = this.journal.historicalVersions(scope, Number(cursor || '0'));
      await this.options.memory.maintenanceWork(scope, { action: 'seed', records: page.records });
      if (this.closed) throw Object.assign(new Error('应用关闭，稍后继续导入增量进度。'), { code: 'BOT_SUSPEND' });
      cursor = page.more ? String(page.after) : 'done'; this.options.store.setMetadata(key, cursor);
    }
    const releases = this.options.store.taskTransaction(sql => sql.prepare("SELECT key,value FROM bot_metadata WHERE key LIKE ? AND value<>'' LIMIT 20").all(`maintenance-work-release:${maintenanceDomain(scope)}:%`)) as Array<{ key: string; value: string }>;
    for (const release of releases) {
      const input = JSON.parse(release.value) as { jobId: string; kind: 'organize' | 'dream'; reason: string };
      await this.options.memory.maintenanceWork(scope, { action: 'release', ...input }); this.options.store.setMetadata(release.key, '');
    }
    const settlements = this.options.store.taskTransaction(sql => sql.prepare("SELECT key,value FROM bot_metadata WHERE key LIKE ? AND value<>'' LIMIT 20").all(`maintenance-work-settle:${maintenanceDomain(scope)}:%`)) as Array<{ key: string; value: string }>;
    for (const settlement of settlements) {
      const record = this.journal.get(scope, settlement.value);
      if (record.job.phase !== 'planner_retired' && record.plan) await this.completeBatch(scope, settlement.value, record.plan);
      this.options.store.setMetadata(settlement.key, '');
    }
  }
  private async completeBatch(scope: BotMemoryScope, jobId: string, plan: NonNullable<ReturnType<BotMaintenanceStore['get']>['plan']>): Promise<BotMaintenanceWorkProgress | undefined> {
    if (plan.kind === 'dream' || plan.brief || plan.mode && plan.mode !== 'organize' || !plan.scan.incremental) return;
    const deferred = new Set(plan.scan.deferred.map(source => source.id));
    return await this.options.memory.maintenanceWork(scope, { action: 'complete', kind: plan.kind, jobId, sources: plan.sources.filter(source => !deferred.has(source.id)).map(({ id, checksum }) => ({ id, checksum })), reserved: this.journal.reservedSources(scope, jobId) }) as BotMaintenanceWorkProgress;
  }
  private async syncReviewedVersions(scope: BotMemoryScope, jobId: string): Promise<void> {
    const { job } = this.journal.get(scope, jobId);
    if (job.kind === 'dream' || job.survey) return;
    this.options.store.setMetadata(`maintenance-work-settle:${maintenanceDomain(scope)}:${jobId}`, jobId);
    try { await this.initializeIncremental(scope); } catch (error) { this.options.report?.(error); }
  }
  private async releaseBatch(scope: BotMemoryScope, jobId: string, reason: string): Promise<void> {
    const key = `maintenance-work-release:${maintenanceDomain(scope)}:${jobId}`, { job } = this.journal.get(scope, jobId);
    if (job.kind === 'dream' || job.survey) return;
    const kind = job.kind;
    this.options.store.setMetadata(key, JSON.stringify({ kind, jobId, reason }));
    try { await this.options.memory.maintenanceWork(scope, { action: 'release', kind, jobId, reason }); this.options.store.setMetadata(key, ''); }
    catch (error) { this.options.report?.(error); }
  }
  private async reconcileCandidate(scope: BotMemoryScope, jobId: string, candidateId: string, key: string, signal: AbortSignal): Promise<void> {
    const record = this.journal.get(scope, jobId), candidate = this.journal.candidate(scope, jobId, candidateId);
    if (!record.plan || !candidate.approval) throw new Error('缺少已批准的原始方案，不能继续执行。');
    if (['applied', 'superseded', 'rejected'].includes(candidate.status)) return;
    const receipt = await this.core.applyCandidate({ scope, plan: record.plan, candidateId, contextEpoch: record.plan.contextEpoch, approval: 'review', inspectOnly: true, signal });
    signal.throwIfAborted(); this.journal.diagnostic(scope, jobId, 'reconciliation', receipt);
    if (receipt.status === 'indexed' || receipt.status === 'archived') { this.journal.candidateResult(scope, jobId, candidateId, 'applied', receipt); return; }
    if (receipt.status === 'conflict' || receipt.status === 'withdrawn') { this.journal.candidateResult(scope, jobId, candidateId, 'conflict', receipt); return; }
    // An admitted native operation must continue under its original identity;
    // partially archived parents are never treated as a different completed plan.
    if (receipt.receipt || !['organize', 'update'].includes(candidate.type)) { this.journal.continueCandidate(scope, jobId, candidateId, key); return; }
    const originals = await Promise.all(candidate.sources.map(source => this.options.memory.readNote(scope, { id: source.id }) as Promise<Record<string, unknown>>));
    signal.throwIfAborted();
    const unchanged = originals.every((note, index) => note.checksum === candidate.sources[index]!.checksum);
    if (unchanged && originals.every(note => note.indexState === 'archived') && candidate.type === 'organize' && !candidate.crystal) {
      for (const prior of this.journal.coveringCandidates(scope, jobId, candidateId)) {
        if (prior.plan.candidates.find(item => item.id === prior.candidateId)?.crystal) continue;
        const proof = await this.core.applyCandidate({ scope, plan: prior.plan, candidateId: prior.candidateId, contextEpoch: prior.plan.contextEpoch, approval: prior.approval, inspectOnly: true, signal });
        if (proof.status !== 'indexed' || typeof proof.receipt?.id !== 'string' || typeof proof.receipt.checksum !== 'string') continue;
        const note = await this.options.memory.readNote(scope, { id: proof.receipt.id }) as Record<string, unknown>;
        if (note.indexState !== 'indexed' || note.checksum !== proof.receipt.checksum) continue;
        signal.throwIfAborted();
        if ((await this.options.memory.withdrawnSources(scope)).revision !== record.plan.sourceRevision) throw new Error('核实期间来源已撤回，请依据当前资料重新生成。');
        this.journal.candidateResult(scope, jobId, candidateId, 'superseded', { actionId: candidateId, operationId: receipt.operationId, status: 'superseded',
          message: '人工批准已保留；所有来源已由另一方案整理，此方案未重复写入。',
          resolution: { jobId: prior.jobId, candidateId: prior.candidateId, operationId: proof.operationId, noteId: proof.receipt.id, checksum: proof.receipt.checksum } });
        return;
      }
    }
    if (receipt.status === 'not_started' && unchanged && originals.every(note => note.indexState === 'indexed' || note.indexState === 'pending')) {
      this.journal.continueCandidate(scope, jobId, candidateId, key); return;
    }
    this.journal.candidateResult(scope, jobId, candidateId, 'conflict', { actionId: candidateId, operationId: receipt.operationId, status: 'conflict',
      error: { code: 'MEMORY_SOURCE_CHANGED', message: '人工批准已保留，但来源已归档或版本发生变化；请依据当前日记重新生成方案。' } });
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; for (const run of this.active.values()) run.controller.abort(Object.assign(new Error('应用关闭，维护保留待恢复。'), { code: 'BOT_SUSPEND' }));
    this.closing = (async () => {
      await this.polling;
      await Promise.allSettled([...this.active.values()].map(run => run.finished));
    })();
    return this.closing;
  }
}
