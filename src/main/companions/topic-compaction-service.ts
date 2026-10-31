import type { Companion } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionTopicCompactionJob } from '../../shared/companion-topic-compaction-jobs';
import { CompanionModelError, companionModelAdmissionRetryAfter, type CompanionModelConfig } from './model';
import { CompanionTopicCompactionChanged, ensureTopicContinuity } from './topic-compaction';
import { COMPANION_DIALOGUE_WINDOW } from './context-window';
import { createHash } from 'node:crypto';

export interface CompanionTopicCompactionServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(companion: Companion): Promise<CompanionModelConfig>;
  fetchFn?: typeof fetch;
  blocked?(ownerId: string): boolean;
  changed?(kind?: 'progress'): void;
  report(error: unknown): void;
}
type Running = { ownerId: string; controller: AbortController; finished: Promise<void> };

/** Durable history maintenance has its own lane. One claim processes one
 * complete source chunk, then yields to other owners and foreground work. */
export class CompanionTopicCompactionService {
  private readonly active = new Map<string, Running>();
  private timer?: ReturnType<typeof setInterval>;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private pumping?: Promise<void>;
  private claimTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: CompanionTopicCompactionServiceOptions) {}
  private report(error: unknown): void { try { this.options.report(error); } catch { /* Diagnostics cannot create another failed job. */ } }
  private changed(kind?: 'progress'): void { try { this.options.changed?.(kind); } catch (error) { this.report(error); } }
  private async request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const result = await this.options.request(command);
    if (!result.ok) throw new Error(result.error ?? '对话历史整理存储暂不可用。');
    if (command.type === 'topic.update') this.changed();
    return result;
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  wake(): void {
    if (this.closed || this.wakeTimer || this.pumping) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      const work = this.pump(); this.pumping = work;
      void work.catch(error => this.report(error)).finally(() => { if (this.pumping === work) this.pumping = undefined; });
    }, 0); this.wakeTimer.unref();
  }
  private async pump(): Promise<void> {
    while (!this.closed && this.active.size < 2) { if (!await this.launch()) break; }
  }
  private launch(): Promise<{ finished: Promise<void> } | undefined> {
    const next = this.claimTail.then(async () => {
      if (this.closed || this.active.size >= 2) return;
      const job = (await this.request({ type: 'topic.compaction.claim',
        excludedCompanionIds: [...this.active.values()].map(run => run.ownerId), leaseMs: 120000 })).topicCompactionJob;
      if (!job) return;
      const controller = new AbortController();
      if (this.closed) controller.abort();
      const run: Running = { ownerId: job.companionId, controller, finished: Promise.resolve() };
      this.active.set(job.id, run);
      run.finished = this.process(job, controller).finally(() => {
        if (this.active.get(job.id) === run) this.active.delete(job.id);
        this.changed('progress'); this.wake();
      });
      void run.finished.catch(error => this.report(error));
      return { finished: run.finished };
    });
    this.claimTail = next.catch(() => undefined); return next;
  }
  async runOnce(): Promise<boolean> {
    const run = await this.launch(); if (!run) return false;
    await run.finished; return true;
  }
  cancel(ownerId: string, jobId?: string): void {
    for (const [id, run] of this.active) if (run.ownerId === ownerId && (!jobId || id === jobId)) run.controller.abort();
  }
  async cancelAndWait(ownerId: string): Promise<void> {
    this.cancel(ownerId); await this.claimTail;
    this.cancel(ownerId);
    await Promise.allSettled([...this.active.values()].filter(run => run.ownerId === ownerId).map(run => run.finished));
  }
  private async process(job: CompanionTopicCompactionJob, controller: AbortController): Promise<void> {
    const token = job.leaseToken; if (!token) throw new Error('后台话题整理缺少准确租约。');
    const pendingOperations = new Set<Promise<unknown>>();
    let openDispatches = 0, unknownOutcome = false, heartbeatError: unknown;
    const check = async (renew = false) => {
      controller.signal.throwIfAborted();
      if (this.options.blocked?.(job.companionId)) throw new CompanionModelError('CONFIG', '伙伴暂时停止，整理欠账保留。');
      const result = await this.request({ type: 'topic.compaction.check', id: job.id, leaseToken: token,
        ...(renew ? { extendLeaseMs: 120000 } : {}) });
      if (!result.topicCompactionJob) throw new CompanionTopicCompactionChanged('话题整理租约或原始来源已变化，旧结果不会发布。');
    };
    let renewing = false, renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return; renewing = true;
      renewal = check(true).catch(error => { heartbeatError = error; controller.abort(); }).finally(() => { renewing = false; });
    }, 30000); heartbeat.unref();
    // attempts is the worker's durable claim counter. A crashed running row is
    // held, so only an explicit resume can authorize its next paid attempt.
    // Identical work within this attempt keeps the same identity; format
    // repairs retain the central repair's deterministic child identity.
    const attemptPrefix = `topic-compaction:${job.id}:attempt:${job.attempts}:`;
    const attemptContext = (context: { system: string; user: string }) => {
      const payload: unknown = JSON.parse(context.user);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('purpose' in payload) || typeof payload.purpose !== 'string')
        throw new CompanionModelError('CONFIG', '话题整理职能缺少明确用途，未发送请求。');
      const value = payload as Record<string, unknown>;
      if (value.purpose === 'companion_structured_repair') {
        const repair = value.structuredRepair as { rootInvocationId?: unknown; attempt?: unknown } | undefined;
        const invocation = value.invocation as { id?: unknown; conversationId?: unknown } | undefined;
        if (typeof repair?.rootInvocationId !== 'string' || !repair.rootInvocationId.startsWith(attemptPrefix)
          || ![1, 2].includes(Number(repair.attempt)) || invocation?.conversationId !== job.conversationId
          || invocation.id !== `structured-repair:${createHash('sha256').update(repair.rootInvocationId).digest('hex')}:${repair.attempt}`)
          throw new CompanionModelError('CONFIG', '话题整理的结构修复不属于当前正式尝试，未发送请求。');
        return context;
      }
      const digest = createHash('sha256').update(JSON.stringify([context.system, context.user])).digest('hex');
      return { ...context, user: JSON.stringify({ ...value, invocation: { id: attemptPrefix + digest, conversationId: job.conversationId } }) };
    };
    const guarded = (config: CompanionModelConfig): CompanionModelConfig => ({ ...config, workPriority: 'background',
      ...(config.resolveAssetContext ? { resolveAssetContext: (context, kind) => config.resolveAssetContext!(attemptContext(context), kind) } : {}),
      ...(config.transportObserver ? { transportObserver: { prepareAttempt: async input => {
        const attempt = await config.transportObserver!.prepareAttempt(input);
        return { ...attempt, beforeDispatch: async () => {
          // Snapshot publication may yield to park/resume, a source withdrawal
          // or owner stop. Its completion is not a fresh job authorization.
          await check(); await attempt.beforeDispatch(); await check();
        } };
      } } } : {}),
      trackOperation: operation => {
        config.trackOperation?.(operation); pendingOperations.add(operation);
        void operation.finally(() => pendingOperations.delete(operation)).catch(() => undefined);
      },
      ...(config.resolveStructuredRepairConfig ? { resolveStructuredRepairConfig: async () => guarded(await config.resolveStructuredRepairConfig!()) } : {}),
      providerLifecycle: { beforeDispatch: async () => {
        await check(); const finish = await config.providerLifecycle?.beforeDispatch();
        try { await check(); } catch (error) { await finish?.('cancelled_before_send', 0); throw error; }
        openDispatches++;
        return async (outcome, duration, status) => {
          openDispatches--; if (outcome === 'network_error') unknownOutcome = true;
          await finish?.(outcome, duration, status);
        };
      } },
    });
    try {
      await check();
      const state = (await this.request({ type: 'state', companionId: job.companionId, conversationId: job.conversationId, includeHidden: true })).state;
      const companion = state?.companions.find(owner => owner.id === job.companionId), conversation = state?.conversations.find(room => room.id === job.conversationId);
      if (!companion || !conversation) throw new CompanionTopicCompactionChanged('整理话题或伙伴已不可读。');
      const source = (await this.request({ type: 'memory.sources.filter', companionId: job.companionId,
        conversationId: job.conversationId, beforeSequence: (job.claimedThroughSequence ?? job.requestedThroughSequence) + 1,
        ids: [job.sourceMessageId] })).memorySources?.find(message => message.id === job.sourceMessageId);
      if (!source) throw new CompanionTopicCompactionChanged('整理的准确原始消息已撤回。');
      const view = await this.request({ type: 'topic.read', conversationId: job.conversationId, topicId: job.topicId, readerId: job.companionId });
      const config = guarded(await this.options.configFor(companion));
      const result = await ensureTopicContinuity({ frame: { companion, conversation, sourceMessage: source,
        messages: [source], memories: [], topic: view.topic, topicState: view.topicState,
        contextThroughSequence: job.claimedThroughSequence ?? job.requestedThroughSequence,
        contextThroughPublicationRevision: job.claimedPublicationRevision,
        dialogueWindow: COMPANION_DIALOGUE_WINDOW }, request: command => this.request(command.type === 'topic.update' && command.compaction
          ? { ...command, compaction: { ...command.compaction, jobGuard: { id: job.id, leaseToken: token } } }
          : command.type === 'topic.compaction.sources' ? { ...command, jobGuard: { id: job.id, leaseToken: token } } : command), config,
        signal: controller.signal, fetchFn: this.options.fetchFn, singleChunk: true,
        bindInputs: async input => {
          await check();
          const bound = await this.request({ type: 'topic.compaction.bind', id: job.id, leaseToken: token,
            sources: input.sourceVersions, checkpointEventIds: input.checkpointEventIds });
          if (!bound.topicCompactionJob) throw new CompanionTopicCompactionChanged('整理的实际读取来源已变化，旧结果不会发布。');
        } });
      await check();
      await this.request({ type: 'topic.compaction.settle', id: job.id, leaseToken: token,
        hasMore: result.topicCompactionPending === true,
        ...(result.topicCompactionPending ? { checkpointEventId: result.topicState?.workingState?.sourceEventId } : {}) });
    } catch (error) {
      await Promise.allSettled([...pendingOperations]);
      const cause = heartbeatError ?? error;
      const admission = companionModelAdmissionRetryAfter(cause);
      const waiting = admission !== undefined || cause instanceof CompanionModelError && ['CONFIG', 'CANCELLED'].includes(cause.code)
        || cause instanceof CompanionTopicCompactionChanged
        || cause instanceof Error && ['CompanionAssetProfileError', 'CompanionArtifactError'].includes(cause.name);
      const unknown = unknownOutcome || openDispatches > 0 || cause instanceof CompanionModelError && cause.code === 'CONTEXT_RECORD_FAILED';
      // Model/reviewer exception text may quote any source in this chunk. The
      // queue stores metadata and safe diagnostics, never unbound source prose.
      const diagnostic = unknown ? '上次派发结果未确认，已搁置；不会自动重发。'
        : waiting || controller.signal.aborted ? '等待可用模型、准确来源或运行条件；原始记录和已确认摘要保留。'
          : '本轮摘要未通过处理或连续性核验；原始记录和覆盖水位保持不变。';
      await this.request({ type: 'topic.compaction.fail', id: job.id, leaseToken: token,
        error: diagnostic,
        failureKind: unknown || waiting || controller.signal.aborted ? 'waiting' : cause instanceof CompanionTopicCompactionChanged ? 'stale' : 'processing',
        ...(unknown ? { unknownOutcome: true } : {}), retryAfterMs: admission ?? 30000 });
    } finally { clearInterval(heartbeat); await renewal; }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer); if (this.wakeTimer) clearTimeout(this.wakeTimer);
    for (const run of this.active.values()) run.controller.abort();
    await this.pumping; await this.claimTail;
    for (const run of this.active.values()) run.controller.abort();
    await Promise.allSettled([...this.active.values()].map(run => run.finished));
  }
}
