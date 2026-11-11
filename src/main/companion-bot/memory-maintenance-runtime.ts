import path from 'node:path';
import type { BotMemoryMaintenanceRequest } from '../../shared/companion-bot-maintenance';
import type { BotMemoryJobClaim } from './types';
import type { BotMemoryScope, BotMemoryService, BotMaintenanceWorkStats, BotMaintenanceWorkBatch, BotMaintenanceWorkProgress } from './memory-service';
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
}
/** Maintenance is a low-priority consumer of the same durable domain queue as
 * capture. Its model never holds the VCP session's RPC/FIFO lock. */
export class BotMaintenanceRuntime {
  readonly journal: BotMaintenanceStore;
  private readonly core: BotMemoryMaintenance;
  private readonly reviewer: BotMemoryMaintenanceReviewer;
  private readonly active = new Map<string, { scope: BotMemoryScope; automatic: boolean; operation: unknown; controller: AbortController; finished: Promise<void> }>();
  private lastPoll = 0;
  private polling?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: BotMaintenanceRuntimeOptions) {
    this.journal = new BotMaintenanceStore(options.store);
    this.core = new BotMemoryMaintenance({ brain: options.brain, memory: options.memory, model: options.model, callback: options.callback,
      cwd: (scope, operationId) => path.join(options.root, 'memory-maintenance', maintenanceDomain(scope), operationId) });
    this.reviewer = new BotMemoryMaintenanceReviewer({ brain: options.brain, memory: options.memory, callback: options.callback, root: options.root });
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
      case 'memory.maintenance.run': { const job = this.journal.enqueue(scope, input.kind, input.requestId, false, input.cursor); this.options.changed(scope.conversationId); return job; }
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
          if (!this.journal.get(scope, input.jobId).plan) await this.releaseBatch(scope, input.jobId, '用户停止本任务，来源保留供后续增量整理。', false);
          else await this.syncReviewedVersions(scope, input.jobId);
        }
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
    const runs = [...this.active.values()].filter(run => maintenanceDomain(run.scope) === maintenanceDomain(scope) && (includeManual || run.automatic && run.operation === 'plan'));
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
    if (!this.options.model().apiKey) return;
    const review = this.journal.queueAutomaticReview();
    if (review) { this.options.changed(review.conversationId); return; }
    const recovered = this.journal.recoverAutomatic();
    if (recovered) { this.options.changed(recovered.conversationId); return; }
    const scope = this.journal.due(); if (!scope) return;
    const settings = this.journal.settings(scope);
    try {
      await this.initializeIncremental(scope);
      const work = await this.options.memory.maintenanceWork(scope, { action: 'stats', kind: settings.kind }) as BotMaintenanceWorkStats;
      if (this.closed) return;
      if (work.mode !== 'incremental-v1' || !Number.isSafeInteger(work.ready) || work.ready < 0) throw new Error('增量维护队列缺少有效进度。');
      if (!work.ready) { this.journal.defer(scope, work.retryAt ? Math.max(60000, work.retryAt - Date.now()) : settings.intervalHours * 3600000, work.retrying ? '未完成的日记版本已保留，稍后自动重试。' : undefined); return; }
      const oldest = Date.parse(work.oldestReadyAt || '');
      if (work.ready < settings.minNotes && !work.resumable && (!Number.isFinite(oldest) || Date.now() - oldest < settings.intervalHours * 3600000)) { this.journal.defer(scope, 3600000, '新增日记暂待合批；达到维护间隔后少量日记也会处理。'); return; }
      // Recheck the inexpensive gates after the awaited read, so incoming chat
      // cannot turn a stale eligibility check into an automatic model call.
      const due = this.journal.due(); if (!due || maintenanceDomain(due) !== maintenanceDomain(scope)) return;
      const job = this.journal.enqueue(scope, settings.kind, `automatic:${settings.nextEligibleAt}`, true);
      this.journal.defer(scope, settings.intervalHours * 3600000, undefined, true); this.options.changed(scope.conversationId);
      this.journal.diagnostic(scope, job.id, 'scheduled', { policy: 'incremental-safe-idle', minNotes: settings.minNotes, pendingVersions: work.ready });
    } catch (error) { if (this.closed) return; this.journal.defer(scope, 6 * 3600000, message(error)); throw error; }
  }
  async run(claim: BotMemoryJobClaim, parentSignal: AbortSignal): Promise<{ status: 'done' | 'failed' | 'retry'; error?: string; retryDelayMs?: number }> {
    const scope = claim.job.payload.scope as BotMemoryScope, jobId = String(claim.job.payload.jobId), operation = claim.job.payload.operation;
    const original = this.journal.get(scope, jobId);
    if ((original.job.status === 'cancelled' || original.job.status === 'completed') && operation !== 'reconcile' && !(operation === 'plan' && original.plan?.scan.incremental)) return { status: 'done' };
    if (original.job.automatic && operation === 'plan') {
      const settings = this.journal.settings(scope);
      if (!settings.enabled) { this.journal.progress(scope, jobId, 'cancelled', 'cancelled'); return { status: 'done' }; }
      if (Date.now() - Date.parse(settings.lastActivityAt) < settings.idleMinutes * 60000) return { status: 'retry', retryDelayMs: settings.idleMinutes * 60000 };
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
          const batch = await this.options.memory.maintenanceWork(scope, { action: 'claim', kind: record.job.kind, jobId, limit: 24 }) as BotMaintenanceWorkBatch;
          if (batch.state !== 'processing') throw Object.assign(new Error('本任务来源已交给其他任务处理，请查看当前方案。'), { code: 'MEMORY_MAINTENANCE_BATCH_CHANGED' });
        }
        const plan = record.plan ?? await this.core.preparePlan({ scope, kind: record.job.kind, operationId: jobId, contextEpoch: record.snapshot?.contextEpoch ?? 1, admissionAttempt: record.epoch, snapshot: record.snapshot, cursor: record.cursor, signal,
          selectBatch: async () => {
            await this.initializeIncremental(scope);
            return await this.options.memory.maintenanceWork(scope, { action: 'claim', kind: record.job.kind, jobId, limit: 24 }) as BotMaintenanceWorkBatch;
          }, associate: async retrieval => {
            const result = await this.options.memory.maintenanceWork(scope, { action: 'associate', kind: record.job.kind, jobId, retrieval }) as { items: Array<{ id: string; checksum: string }> }; return result.items;
          }, continuation: savedContinuation ? JSON.parse(savedContinuation) as BotMaintenanceContinuation : undefined,
          onContinuation: async checkpoint => { this.options.store.setMetadata(continuationKey, JSON.stringify(checkpoint)); },
          onSnapshot: async snapshot => { signal.throwIfAborted(); this.journal.snapshot(scope, jobId, snapshot); }, onProgress, onDiagnostic });
        signal.throwIfAborted(); if (!record.plan) this.journal.savePlan(scope, jobId, plan);
        const remaining = await this.completeBatch(scope, jobId, plan);
        if (record.plan) this.journal.refreshPlanState(scope, jobId);
        this.options.store.setMetadata(continuationKey, '');
        // Page size bounds an individual model envelope, never the amount of
        // diary material the background scan is allowed to finish.
        if (record.job.automatic && plan.scan.nextCursor) this.journal.enqueue(scope, record.job.kind, `automatic-page:${jobId}`, true, plan.scan.nextCursor);
        // Lossless is an explicit opt-in, deterministic concatenation only.
        // Dream insights/archives always require individual human review.
        const settings = this.journal.settings(scope);
        if (record.job.automatic && !plan.scan.nextCursor) this.journal.defer(scope, remaining?.retryAt ? Math.min(settings.intervalHours * 3600000, Math.max(60000, remaining.retryAt - Date.now())) : settings.intervalHours * 3600000, undefined, true);
        if (settings.autoApply === 'lossless' && record.job.kind === 'organize') {
          let cursor: string | undefined;
          for (;;) {
            const page = this.journal.candidates(scope, jobId, cursor);
            for (const candidate of page.items.filter(item => item.type === 'organize')) this.journal.review(scope, jobId, candidate.id, candidate.revision, 'approve', `lossless:${jobId}:${candidate.id}`, 'lossless');
            if (!page.nextCursor) break;
            cursor = page.nextCursor;
          }
        }
        if (settings.autoReview) this.journal.queueAutomaticReview(scope);
        return { status: 'done' };
      }
      if (operation === 'review') {
        const candidateId = String(claim.job.payload.candidateId), candidate = this.journal.candidate(scope, jobId, candidateId);
        if (!this.journal.settings(scope).autoReview || candidate.status !== 'pending' || !record.plan) return { status: 'done' };
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
      // Suppress legacy v1 resurrection before admitting any managed effect,
      // including a write whose acknowledgement could be lost.
      this.options.store.setMetadata(`memory-capture-backfill-v2-suppressed:${maintenanceDomain(scope)}`, jobId);
      this.options.store.clearMemoryInspections(scope.companionId, scope.securityDomainId);
      const receipt = await this.core.applyCandidate({ scope, plan: record.plan, candidateId, contextEpoch: record.plan.contextEpoch,
        approval: claim.job.payload.approval === 'lossless' ? 'lossless' : 'review', signal, onProgress, onDiagnostic });
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
        return { status: 'retry', retryDelayMs: this.journal.settings(scope).idleMinutes * 60000 };
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
      if (original.job.automatic && operation !== 'plan') this.journal.defer(scope, this.journal.settings(scope).intervalHours * 3600000, message(error));
      this.options.report?.(error); return { status: 'failed', error: message(error) };
    } finally { this.active.delete(jobId); finish(); this.options.changed(scope.conversationId); }
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
      if (record.plan) await this.completeBatch(scope, settlement.value, record.plan, true);
      this.options.store.setMetadata(settlement.key, '');
    }
  }
  private async completeBatch(scope: BotMemoryScope, jobId: string, plan: NonNullable<ReturnType<BotMaintenanceStore['get']>['plan']>, includeLegacy = false): Promise<BotMaintenanceWorkProgress | undefined> {
    if (!plan.scan.incremental && !includeLegacy) return;
    const deferred = new Set(plan.scan.deferred.map(source => source.id));
    return await this.options.memory.maintenanceWork(scope, { action: 'complete', kind: plan.kind, jobId, sources: plan.sources.filter(source => !deferred.has(source.id)).map(({ id, checksum }) => ({ id, checksum })), reserved: this.journal.reservedSources(scope, jobId) }) as BotMaintenanceWorkProgress;
  }
  private async syncReviewedVersions(scope: BotMemoryScope, jobId: string): Promise<void> {
    this.options.store.setMetadata(`maintenance-work-settle:${maintenanceDomain(scope)}:${jobId}`, jobId);
    try { await this.initializeIncremental(scope); } catch (error) { this.options.report?.(error); }
  }
  private async releaseBatch(scope: BotMemoryScope, jobId: string, reason: string, wake = true): Promise<void> {
    const key = `maintenance-work-release:${maintenanceDomain(scope)}:${jobId}`, kind = this.journal.get(scope, jobId).job.kind;
    this.options.store.setMetadata(key, JSON.stringify({ kind, jobId, reason }));
    try { await this.options.memory.maintenanceWork(scope, { action: 'release', kind, jobId, reason }); this.options.store.setMetadata(key, ''); }
    catch (error) { this.options.report?.(error); }
    if (wake && this.journal.settings(scope).enabled) this.journal.defer(scope, Math.min(300000, Math.max(0, Date.parse(this.journal.settings(scope).nextEligibleAt) - Date.now())));
  }
  private async reconcileCandidate(scope: BotMemoryScope, jobId: string, candidateId: string, key: string, signal: AbortSignal): Promise<void> {
    const record = this.journal.get(scope, jobId), candidate = this.journal.candidate(scope, jobId, candidateId);
    if (!record.plan || !candidate.approval) throw new Error('缺少已批准的原始方案，不能继续执行。');
    if (['applied', 'superseded', 'rejected'].includes(candidate.status)) return;
    const approval = this.options.store.getMetadata(`maintenance-approval:${jobId}:${candidateId}`) === 'lossless' ? 'lossless' as const : 'review' as const;
    const receipt = await this.core.applyCandidate({ scope, plan: record.plan, candidateId, contextEpoch: record.plan.contextEpoch, approval, inspectOnly: true, signal });
    signal.throwIfAborted(); this.journal.diagnostic(scope, jobId, 'reconciliation', receipt);
    if (receipt.status === 'indexed' || receipt.status === 'archived') { this.journal.candidateResult(scope, jobId, candidateId, 'applied', receipt); return; }
    if (receipt.status === 'conflict' || receipt.status === 'withdrawn') { this.journal.candidateResult(scope, jobId, candidateId, 'conflict', receipt); return; }
    // An admitted native operation must continue under its original identity;
    // partially archived parents are never treated as a different completed plan.
    if (receipt.receipt || !['organize', 'update'].includes(candidate.type)) { this.journal.continueCandidate(scope, jobId, candidateId, key); return; }
    const originals = await Promise.all(candidate.sources.map(source => this.options.memory.readNote(scope, { id: source.id }) as Promise<Record<string, unknown>>));
    signal.throwIfAborted();
    const unchanged = originals.every((note, index) => note.checksum === candidate.sources[index]!.checksum);
    if (unchanged && originals.every(note => note.indexState === 'archived') && candidate.type === 'organize') {
      for (const prior of this.journal.coveringCandidates(scope, jobId, candidateId)) {
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
