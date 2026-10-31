import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation, CompanionMessage, CompanionState } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorldJob, CompanionWorldScope, CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionModelConfig } from './model';
import type { CompanionMemoryRecall, CompanionMemoryService } from './memory-service';
import { CompanionModelError, companionModelAdmissionRetryAfter } from './model';
import { CompanionModelAdmissionError } from './model-quota';
import { companionMemoryProposalIdentity } from './memory-proposal-identity';
import { companionWorldProposalCheckpoint } from './world-proposal-checkpoint';
import { companionWorldMaintenanceProposalSchema, companionWorldNarrativeProposalSchema, type CompanionWorldProposal } from '../../shared/companion-world-proposals';
import type { CompanionMemory } from '../../shared/companions';
import { generateCompanionWorldDecision } from './world-model';
import { companionAutomaticMaintenanceSeeds, generateCompanionMemoryDream, generateCompanionMemoryMaintenance, type CompanionMemoryDreamResult } from './memory-model';
import { generateCompanionDreamNarrative } from './dream-wave-model';
import { CompanionOptionalDreamError } from './optional-dream-error';
import { validateCompanionMemoryProhibitions } from './memory-model';
import type { VcpMemoryDreamWaveResult, VcpMemoryDreamClock } from '../vcp-memory/dream-contracts';
import { CompanionAgentNoProgressError } from './agent-kernel';
import type { CompanionSocialJob, CompanionSocialNotification } from '../../shared/companion-social';
import { authorizeCompanionSocialInitiative, companionSocialInitialFrame, generateCompanionSocialReply } from './social-model';
import { buildCompanionSocialNotification } from './social-notification-model';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';
import { COMPANION_SLEEP_DREAM_CONCURRENCY } from '../../shared/companion-sleep';
import { companionRecallCapabilities } from './structured-agent';
import { companionTopicCapabilities } from './topic-capabilities';
import { reviewCompanionGameSharedUpdate } from './game-topic-privacy';
import { reviewCompanionTopicModeratorTransfer } from './topic-moderator-transfer';
import { resolveCompanionGameInitiativeContext, loadCompanionGameCommunication } from './game-contact-context';
import { companionSocialCapabilities } from './social-capabilities';
import { prepareTopicContinuity } from './topic-compaction';
import { COMPANION_DIALOGUE_WINDOW } from './context-window';
import type { CompanionReplyInput } from './context';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { parseCompanionReplyObservation } from '../../shared/companion-reply-observation-content';
import { companionTaskPreparation, parseCompanionTaskPreparation } from '../../shared/companion-task-preparation';
import { verifyCompanionExecutionReadset } from './execution-evidence';
import { companionAgentRunIdentity } from './agent-journal';
import { companionRoleResourceBounds } from './role-resource-context';
import { companionThoughtCapabilities } from './thought-capabilities';
import type { DshRecordQuery } from '../../shared/dsh-task-record';

import type { CompanionBrowserExtension } from './browser-capabilities';
import type { CompanionMemorySearch } from '../../shared/companion-memory';
class StaleWorldInput extends Error {}
interface WorldServiceOptions {
  browserCapabilities?: CompanionBrowserExtension;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(companion: Companion, task?: CompanionSocialJob): Promise<CompanionModelConfig>;
  taskAssetSources?(task: CompanionSocialJob): Promise<CompanionExecutionReadset['sources']>;
  fetchFn: typeof fetch;
  changed(kind?: 'progress'): void;
  wakeWaiting(): void;
  report(error: unknown): void;
  beginPriority?(owner: string, room: string, source: string): Promise<string | undefined>;
  endPriority?(id: string | undefined): Promise<void>;
  blocked?(companionId: string): boolean;
  tickLife?(): void | Promise<void>;
  profiles?(input: { companionId: string; conversation: Pick<CompanionConversation, 'id' | 'memberIds'>;
    sourceAuthorId?: string; audience?: 'player' | 'peers'; directory?: boolean }): Promise<CompanionProfileInput>;
  memoryContextValid?(scope: CompanionWorldScope, context?: { revision: string; profileKey: string }): Promise<boolean>;
  recall?(input: Parameters<CompanionMemoryService['recall']>[0]): Promise<CompanionMemoryRecall>;
  passiveRecall?(query: CompanionMemorySearch, signal?: AbortSignal): Promise<CompanionStorageResponse>;
  dreamWave?(input: CompanionWorldScope & { now: string; clockDomain: VcpMemoryDreamClock }): Promise<VcpMemoryDreamWaveResult>;
  think?(input: Omit<Extract<CompanionStorageCommand, { type: 'peer.thought.create' }>, 'type'>, signal?: AbortSignal): Promise<unknown>;
  readThought?(input: { jobId: string; companionId: string; conversationId: string; query: DshRecordQuery }, signal?: AbortSignal): Promise<unknown>;
}
export type CompanionAgendaWorldLane = 'decision' | 'dream' | 'social' | 'notification';
export type CompanionAgendaWorldNativeJob = { kind: 'world' | 'social' | 'notification'; id: string; inputVersion?: string; revision?: number; lane?: CompanionAgendaWorldLane };
export type CompanionAgendaWorldInput = { companionId: string; agendaRunId: string; agendaLeaseToken: string; lane?: CompanionAgendaWorldLane; referenceId?: string; nativeInputVersion?: string };
export type CompanionAgendaWorldResult = { outcome: 'complete' | 'no_change' | 'waiting' | 'parked' | 'abandoned' | 'unknown' | 'failed' | 'cancelled';
  companionId: string; reason: string; nativeJob?: CompanionAgendaWorldNativeJob; retryAt?: string; messageId?: string };
type AgendaNative = { lane: 'decision' | 'dream'; job: CompanionWorldJob } | { lane: 'social'; job: CompanionSocialJob } | { lane: 'notification'; job: CompanionSocialNotification };

/** Physics and reservations keep ticking while semantic decisions run separately. */
export class CompanionWorldService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController; companionId: string;
    kind: 'dream' | 'other'; worldJob?: CompanionWorldJob }>();
  private closed = false;
  private agendaDriven = false;
  private readonly agendaOwners = new Set<string>();
  private readonly agendaLaneCursor = new Map<string, number>();
  constructor(private readonly options: WorldServiceOptions) {}
  /** Clock, reservations and body motion remain physical; every semantic
   * model/tool continuation must now belong to a live agenda parent. */
  setAgendaDriven(): void { this.agendaDriven = true; }
  /** Stop exactly one semantic job; its durable lease is revoked by the
   * worker before Main aborts the in-flight model/tool wait. */
  cancelTask(id: string): void {
    this.jobs.get(id)?.controller.abort(Object.assign(new Error('用户手动停止了这项伙伴任务。'), { code: 'USER_STOP' }));
  }
  cancelCompanion(companionId: string): void {
    for (const job of this.jobs.values()) if (job.companionId === companionId) job.controller.abort();
  }
  async drainCompanion(companionId: string): Promise<void> {
    await this.ticking;
    this.cancelCompanion(companionId);
    await Promise.allSettled([...this.jobs.values()].filter(job => job.companionId === companionId).map(job => job.promise));
  }
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 500); this.timer.unref(); void this.tick();
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = (async () => {
      await this.options.request({ type: 'world.tick' });
      for (const job of this.jobs.values()) if (job.worldJob?.kind === 'dream' && job.worldJob.leaseToken) {
        const current = await this.options.request({ type: 'world.job.check', id: job.worldJob.id, leaseToken: job.worldJob.leaseToken });
        if (!current.worldJob || this.options.blocked?.(job.companionId)) job.controller.abort();
      }
      if (!this.agendaDriven) await this.options.tickLife?.();
      this.options.wakeWaiting();
      if (this.closed || this.agendaDriven) return;
      const ordinaryCount = () => [...this.jobs.values()].filter(job => job.kind === 'other').length;
      const continuation = ordinaryCount() < 2 ? (await this.options.request({ type: 'social.notification.claim' })).socialNotification : undefined;
      if (continuation?.leaseToken && !this.closed && !this.options.blocked?.(continuation.companionId)) {
        const controller = new AbortController();
        const promise = this.processNotification(continuation, controller.signal).catch(this.options.report)
          .finally(() => { this.jobs.delete(continuation.id); this.options.changed(); });
        this.jobs.set(continuation.id, { promise, controller, companionId: continuation.companionId, kind: 'other' });
      }
      // Admission is checked for the actual actor by SQLite. An unrelated
      // foreground chat must not freeze everyone else's social replies.
      const delivery = ordinaryCount() < 2 ? await this.options.request({ type: 'social.job.claim' }) : undefined;
      if (delivery?.socialMessage) this.options.changed();
      const social = delivery?.socialJob;
      if (social?.leaseToken && !this.closed && !this.options.blocked?.(social.companionId)) {
        const controller = new AbortController();
        const promise = this.processSocial(social, controller.signal).catch(this.options.report)
          .finally(() => { this.jobs.delete(social.id); this.options.changed(); });
        this.jobs.set(social.id, { promise, controller, companionId: social.companionId, kind: 'other' });
      }
      for (const kind of ['decision', ...Array.from({ length: COMPANION_SLEEP_DREAM_CONCURRENCY }, () => 'dream' as const)] as const) {
        if (this.closed) break;
        if (kind === 'decision' ? ordinaryCount() >= 2
          : [...this.jobs.values()].filter(job => job.kind === 'dream').length >= COMPANION_SLEEP_DREAM_CONCURRENCY) continue;
        const job = (await this.options.request({ type: 'world.job.claim', kind,
          excludedCompanionIds: [...new Set([...this.jobs.values()].filter(job => kind === 'dream' ? job.kind === 'dream' : job.kind === 'other').map(job => job.companionId))] })).worldJob;
        if (!job?.leaseToken || this.options.blocked?.(job.companionId)) continue;
        const controller = new AbortController();
        const promise = this.process(job, controller.signal)
          .catch(this.options.report).finally(() => { this.jobs.delete(job.id); this.options.changed(); });
        this.jobs.set(job.id, { promise, controller, companionId: job.companionId,
          kind: job.kind === 'dream' ? 'dream' : 'other', worldJob: job });
      }
    })().catch(this.options.report).finally(() => { this.ticking = undefined; });
    await this.ticking;
  }
  async runAgendaQuantum(input: CompanionAgendaWorldInput, signal: AbortSignal,
    onProgress?: (stage: string, nativeJob?: CompanionAgendaWorldNativeJob) => void | Promise<void>): Promise<CompanionAgendaWorldResult> {
    const basic = (outcome: CompanionAgendaWorldResult['outcome'], reason: string): CompanionAgendaWorldResult => ({ outcome, companionId: input.companionId, reason });
    if (!this.agendaDriven) throw new Error('世界语义行为尚未切换到统一日程调度。');
    if (this.closed || signal.aborted) return basic('cancelled', '本次世界行为已经停止。');
    if (this.options.blocked?.(input.companionId)) return basic('waiting', '当前伙伴生活尚未恢复。');
    if (this.agendaOwners.has(input.companionId)) return { ...basic('waiting', '等待该伙伴正在进行的世界行为完成。'),
      retryAt: new Date(Date.now() + 1000).toISOString() };
    this.agendaOwners.add(input.companionId);
    try {
      await onProgress?.('正在核对本次世界行为的真实机会'); signal.throwIfAborted();
      const lanes: CompanionAgendaWorldLane[] = input.lane ? [input.lane] : ['notification', 'social', 'decision'];
      const start = input.lane ? 0 : (this.agendaLaneCursor.get(input.companionId) ?? 0) % lanes.length;
      let native: AgendaNative | undefined;
      for (let offset = 0; offset < lanes.length; offset++) {
        const lane = lanes[(start + offset) % lanes.length]!;
        const scope = { companionId: input.companionId, agendaRunId: input.agendaRunId, agendaLeaseToken: input.agendaLeaseToken, ...(input.referenceId ? { id: input.referenceId } : {}), ...(input.nativeInputVersion ? { expectedInputVersion: input.nativeInputVersion } : {}) };
        const response = lane === 'social' ? await this.options.request({ type: 'social.job.claim', ...scope })
          : lane === 'notification' ? await this.options.request({ type: 'social.notification.claim', ...scope })
            : await this.options.request({ type: 'world.job.claim', kind: lane, ...scope });
        if (!response.ok) throw new Error(response.error ?? '当前世界事件不可读取。');
        if (lane === 'social' && response.socialJob) native = { lane, job: response.socialJob };
        else if (lane === 'notification' && response.socialNotification) native = { lane, job: response.socialNotification };
        else if ((lane === 'decision' || lane === 'dream') && response.worldJob) native = { lane, job: response.worldJob };
        if (!input.lane) this.agendaLaneCursor.set(input.companionId, (start + offset + 1) % lanes.length);
        if (native) break;
        if (response.socialMessage) return { ...basic('complete', '已经递送经来源核验的真实伙伴通信。'), messageId: response.socialMessage.message.id };
        if (input.referenceId) {
          // An exact once-only receipt still exists when FIFO, body state or
          // capacity prevented its claim. Consuming that agenda opportunity as
          // "silent" strands the pending task until the minute fallback poll.
          const current = lane === 'social' ? await this.options.request({ type: 'social.job.read', companionId: input.companionId, id: input.referenceId })
            : lane === 'notification' ? await this.options.request({ type: 'social.notification.read', companionId: input.companionId, id: input.referenceId })
              : await this.options.request({ type: 'world.job.read', companionId: input.companionId, id: input.referenceId });
          if (!current.ok) throw new Error(current.error ?? '准确世界事件的等待状态不可核验。');
          const actual = lane === 'social' ? current.socialJob : lane === 'notification' ? current.socialNotification : current.worldJob;
          if (actual?.id === input.referenceId && actual.companionId === input.companionId) {
            const outcome: CompanionAgendaWorldResult['outcome'] = actual.status === 'done' ? actual.stop ? 'cancelled' : 'complete'
              : actual.agendaUncertain || actual.status === 'running' ? 'unknown' : actual.status === 'parked' ? 'parked' : actual.status === 'abandoned' ? 'abandoned'
                : actual.status === 'cancelled' || actual.status === 'stale' ? 'cancelled' : actual.status === 'failed' && actual.terminal ? 'failed' : 'waiting';
            const retryAt = 'agendaRetryAt' in actual ? actual.agendaRetryAt : (actual as CompanionWorldJob).nextAttemptAt;
            return { ...basic(outcome, actual.error ?? (outcome === 'waiting' ? '准确来信任务仍在等待先到消息、身体或并发条件，保留本次日程机会。' : '准确世界事件已结束。')),
              // Release the scheduler permit, then retry the original event
              // promptly. This never skips FIFO or manufactures a new receipt.
              ...(outcome === 'waiting' ? { retryAt: retryAt ?? new Date(Date.now() + 1000).toISOString() } : {}) };
          }
        }
      }
      if (!native) return basic('no_change', '当前没有符合真实条件的世界或社交事件。');
      if (native.job.companionId !== input.companionId || !native.job.leaseToken || input.referenceId && native.job.id !== input.referenceId)
        throw new Error('世界行为实际租约不属于本次伙伴和事件。');
      const leaseToken = native.job.leaseToken;
      let descriptor: CompanionAgendaWorldNativeJob = native.lane === 'social' || native.lane === 'notification'
        ? { kind: native.lane, id: native.job.id, inputVersion: native.job.agendaInputVersion, revision: native.job.agendaRevision, lane: native.lane }
        : { kind: 'world', id: native.job.id, inputVersion: native.job.disposition?.inputVersion, revision: native.job.disposition?.revision, lane: native.lane };
      if (!descriptor.inputVersion || descriptor.revision === undefined) throw new Error('真实世界子行为缺少准确输入版本，未开始推理。');
      const controller = new AbortController(), abort = () => controller.abort(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) controller.abort(signal.reason);
      const selected = native;
      const operation = (async (): Promise<CompanionAgendaWorldResult> => {
        try {
          await onProgress?.('本次世界行为已取得准确事件租约', descriptor); controller.signal.throwIfAborted();
        } catch (error) {
          const cleanup = { id: selected.job.id, leaseToken, error: '日程在语义派发前停止，原始事件等待后续准确接续。', retryAfterMs: 1000 };
          const released = selected.lane === 'social' ? await this.options.request({ type: 'social.job.defer', companionId: input.companionId, ...cleanup })
            : selected.lane === 'notification' ? await this.options.request({ type: 'social.notification.defer', companionId: input.companionId, ...cleanup })
              : await this.options.request({ type: 'world.job.defer', ...cleanup });
          if (!released.ok) this.options.report(new Error(released.error ?? '世界事件派发前释放尚未完成。'));
          throw error;
        }
        if (selected.lane === 'social') await this.processSocial(selected.job, controller.signal);
        else if (selected.lane === 'notification') await this.processNotification(selected.job, controller.signal);
        else await this.process(selected.job, controller.signal);
        const current = selected.lane === 'social' ? await this.options.request({ type: 'social.job.read', companionId: input.companionId, id: selected.job.id })
          : selected.lane === 'notification' ? await this.options.request({ type: 'social.notification.read', companionId: input.companionId, id: selected.job.id })
            : await this.options.request({ type: 'world.job.read', companionId: input.companionId, id: selected.job.id });
        if (!current.ok) throw new Error(current.error ?? '实际世界行为结果尚未核验。');
        const actual = selected.lane === 'social' ? current.socialJob : selected.lane === 'notification' ? current.socialNotification : current.worldJob;
        if (!actual || actual.companionId !== input.companionId || actual.id !== selected.job.id) return { ...basic('unknown', '实际世界行为结果不可确认，原始事件仍然保留。'), nativeJob: descriptor };
        if (selected.lane === 'social' || selected.lane === 'notification') {
          const social = actual as CompanionSocialJob | CompanionSocialNotification;
          descriptor = { ...descriptor, inputVersion: social.agendaInputVersion, revision: social.agendaRevision };
        } else descriptor = { ...descriptor, inputVersion: (actual as CompanionWorldJob).disposition?.inputVersion, revision: (actual as CompanionWorldJob).disposition?.revision };
        const retryAt = 'agendaRetryAt' in actual ? actual.agendaRetryAt : (actual as CompanionWorldJob).nextAttemptAt;
        const outcome: CompanionAgendaWorldResult['outcome'] = actual.status === 'done' ? actual.stop ? 'cancelled' : 'complete'
          : actual.agendaUncertain || actual.status === 'running' ? 'unknown' : actual.status === 'parked' ? 'parked' : actual.status === 'abandoned' ? 'abandoned'
            : actual.status === 'cancelled' || actual.status === 'stale' ? 'cancelled' : actual.status === 'failed' ? 'failed' : 'waiting';
        const result = { ...basic(outcome, actual.error ?? (outcome === 'complete' ? '已完成本次真实世界或社交行为。' : '实际世界事件等待后续准确接续。')), nativeJob: descriptor, ...(retryAt ? { retryAt } : {}) };
        try { await onProgress?.(result.reason.slice(0, 1000), descriptor); } catch (error) { this.options.report(error); }
        return result;
      })();
      this.jobs.set(native.job.id, { promise: operation.then(() => undefined, () => undefined), controller, companionId: input.companionId,
        kind: native.lane === 'dream' ? 'dream' : 'other', ...(native.lane === 'decision' || native.lane === 'dream' ? { worldJob: native.job } : {}) });
      try { return await operation; } finally { signal.removeEventListener('abort', abort); this.jobs.delete(native.job.id); this.options.changed(); }
    } finally { this.agendaOwners.delete(input.companionId); }
  }
  async ready(input: CompanionWorldScope & { workId: string; kind: 'chat' | 'action' | 'schedule' | 'learning'; sourceMessageId?: string;
    urgent?: boolean; fixed?: boolean; learningGrantId?: string; learningLeaseToken?: string;
    authorizationGrantId?: string; invocationId?: string }, signal?: AbortSignal, onWaiting?: (reason: string) => void | Promise<void>): Promise<void> {
    if (signal?.aborted || this.closed) throw cancelled();
    try {
      let work = (await this.options.request({ type: 'world.work.begin', ...input })).worldWork;
      this.options.changed('progress');
      while (work?.status !== 'ready') {
        if (signal?.aborted || this.closed) throw cancelled();
        if (!work || work.status === 'ended') throw new Error('伙伴当前无法使用电脑，任务仍需等待。');
        await onWaiting?.(work.reason ?? (input.kind === 'chat' ? '正在结束当前动作，准备查看消息' : '正在前往电脑，准备处理任务'));
        await delay(250, signal);
        await this.options.request({ type: 'world.tick' });
        work = (await this.options.request({ type: 'world.work.ready', companionId: input.companionId, workId: input.workId })).worldWork;
      }
      if (signal?.aborted || this.closed) throw cancelled();
    } catch (error) { await this.end(input.companionId, input.workId); throw error; }
  }
  async end(companionId: string, workId: string): Promise<void> {
    await this.options.request({ type: 'world.work.end', companionId, workId }); this.options.changed('progress');
  }
  async observe(scope: CompanionWorldScope): Promise<CompanionWorldSnapshot | undefined> {
    return (await this.options.request({ type: 'world.observe', ...scope })).world;
  }
  private async processSocial(job: CompanionSocialJob, signal: AbortSignal): Promise<void> {
    if (!job.leaseToken) return;
    const leaseToken = job.leaseToken; let interruptionId: string | undefined;
    const progress = async (phase: 'context' | 'memory' | 'thinking' | 'waiting', detail: string,
      memory?: { status: 'running' | 'completed' | 'unavailable'; count?: number; injected?: boolean; pending?: boolean }, recalled?: Partial<CompanionMemoryRecall>) => {
      await this.options.request({ type: 'social.job.progress', id: job.id, leaseToken, phase, detail, ...(memory ? { memory } : {}),
        ...(recalled ? { memoryRecall: { reasons: recalled.reasons ?? [], pending: recalled.pending === true,
          degraded: recalled.degraded === true, ...(recalled.context ? { context: recalled.context } : {}) } } : {}) });
      this.options.changed('progress');
    };
    try {
      const routed = await this.options.request({ type: 'activity.social.route', companionId: job.companionId,
        conversationId: job.conversationId, jobId: job.id, leaseToken });
      if (routed.activitySocialRoute) {
        // The durable owner task consumes this exact event. Do not start a second planner.
        const wait = Date.parse(job.typingNotBefore) - Date.now();
        if (wait > 0) await delay(wait, signal);
        if (signal.aborted || this.closed) throw cancelled();
        await this.options.request({ type: 'social.job.complete', id: job.id, leaseToken, text: null });
        this.options.wakeWaiting(); this.options.changed(); return;
      }
      await progress('context', '正在核验这条来信与实际参与者');
      if (job.urgent) interruptionId = await this.options.beginPriority?.(job.companionId, job.conversationId, job.sourceMessageId);
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: job.conversationId })).state;
      const companion = state?.companions.find(member => member.id === job.companionId);
      const conversation = state?.conversations.find(room => room.id === job.conversationId && room.memberIds.includes(job.companionId));
      if (!companion || !conversation) throw new Error('伙伴通信会话不存在。');
      const scope = { companionId: companion.id, conversationId: conversation.id, beforeSequence: job.throughSequence };
      const source = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [job.sourceMessageId] })).memorySources?.[0];
      if (!source || source.authorId === 'user') throw new Error('伙伴通信实际来信已不可访问。');
      const loadPort = async () => {
        const topicView = source.topicId ? await this.options.request({ type: 'topic.read', conversationId: conversation.id,
          topicId: source.topicId, readerId: companion.id }) : undefined;
        if (source.topicId && topicView?.topic?.status !== 'active') throw new Error('本人话题已暂停、结束或删除。');
        const joined = !source.topicId || topicView?.topic?.participantIds.includes(companion.id);
        const recent: CompanionMessage[] = []; let before = job.throughSequence + 1;
        if (joined) while (recent.length < COMPANION_DIALOGUE_WINDOW.maxMessages) {
          const limit = Math.min(100, COMPANION_DIALOGUE_WINDOW.maxMessages - recent.length);
          const page = (await this.options.request({ type: 'messages', conversationId: conversation.id, topicId: source.topicId ?? null,
            before, limit })).messages ?? [];
          if (!page.length) break;
          recent.unshift(...page); const next = page[0]!.sequence; if (next >= before) break; before = next;
          if (page.length < limit) break;
        }
        const visible: CompanionMessage[] = [];
        for (let start = 0; start < recent.length; start += 100) visible.push(...((await this.options.request({ type: 'memory.sources.filter', ...scope,
          ids: recent.slice(start, start + 100).map(message => message.id) })).memorySources ?? []));
        return { topic: topicView?.topic, topicState: joined ? topicView?.topicState : undefined,
          messages: joined ? visible.filter(message => message.topicId === source.topicId) : [source], joined };
      };
      const resources = async (current: CompanionState, currentPort: Awaited<ReturnType<typeof loadPort>>,
        game: Awaited<ReturnType<typeof loadCompanionGameCommunication>>) => {
        const topic = game?.topic ?? currentPort.topic;
        const room = topic?.kind === 'game' ? current.conversations.find(room => room.id === topic.conversationId)
          ?? (await this.options.request({ type: 'state', companionId: companion.id, includeHidden: true, conversationId: topic.conversationId })).state?.conversations.find(room => room.id === topic.conversationId) : undefined;
        return companionRoleResourceBounds({ ownerId: companion.id, activeCharacterIds: current.companions.filter(role => role.active).map(role => role.id),
          ...(room && topic ? { game: { conversation: room, topic } } : {}) });
      };
      let executionReadset: CompanionExecutionReadset | undefined;
      const preparationBinding = { kind: 'social' as const, ownerId: companion.id, conversationId: conversation.id,
        sourceMessageId: source.id, invocationKey: job.id };
      type SocialPreparation = { input: Omit<Parameters<typeof generateCompanionSocialReply>[0], 'job'>; frame: CompanionReplyInput };
      const sealed = job.preparation ? parseCompanionTaskPreparation(job.preparation, preparationBinding) : undefined;
      let preparation = sealed?.payload as SocialPreparation | undefined;
      const config = this.socialFencedConfig(await this.options.configFor(companion, job), job, signal, sealed?.revocationEpoch);
      if (!preparation) {
      const port = await loadPort(), sources = port.messages;
      const gameCommunication = await loadCompanionGameCommunication(this.options.request, { job, source });
      const resourceBounds = await resources(state!, port, gameCommunication);
      const received = job.receivedState ? parseCompanionReplyObservation(job.receivedState, companion.id) : undefined;
      const world = received?.world ?? await this.observe(scope);
      if (!world) throw new Error('伙伴当前世界不可访问。');
      const runtime = received?.runtimeState ?? (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
      const currentRoutine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
      const routine = currentRoutine && runtime?.routine ? { ...currentRoutine, runtime: runtime.routine } : currentRoutine;
      // A retried lease is still the same invocation. The existing journal is
      // the durable receipt, including a successful empty passive result.
      // An unavailable journal fails closed before any semantic query starts.
      const savedRun = (await this.options.request({ type: 'agent.run.get', companionId: companion.id,
        id: companionAgentRunIdentity(companion.id, conversation.id, job.id) })).agentRun;
      if (!savedRun) await progress('memory', '正在回忆与这条来信有关的经历', { status: 'running' });
      const recalled: Partial<CompanionMemoryRecall> | undefined = savedRun ? { memories: [], sources: [], reasons: [], pending: false, degraded: false,
        ...(savedRun.passiveRecall?.context ? { context: savedRun.passiveRecall.context } : {}) }
        : this.options.recall ? await this.options.recall({ companion, conversation, messages: sources,
        currentMessage: source, beforeSequence: job.throughSequence, config, signal,
        queryClock: { virtualNow: world.clock.virtualNow, timeZone: world.settings.timeZone, mode: world.settings.mode } })
        : await this.options.request({ type: 'memory.search', ...scope, query: source.content.slice(0, 16000), limit: 8 })
          .then(response => ({ memories: response.memoryPage?.items.map(hit => hit.memory) ?? [], context: response.memoryContext }))
          .catch(error => { this.options.report(error); return undefined; });
      if (signal.aborted || this.closed) throw cancelled();
      await progress('thinking', '正在组织给伙伴的回应', { status: recalled?.degraded ? 'unavailable' : 'completed',
        count: recalled?.reasons?.length ?? recalled?.memories?.length ?? 0, injected: !!recalled?.context?.text.trim(), pending: recalled?.pending === true }, recalled);
      const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, sourceAuthorId: source.authorId, audience: conversation.peerOnly === false ? 'player' : 'peers' });
      const currentScope = { companionId: companion.id, conversationId: conversation.id };
      const developmentResponse = await this.options.request({ type: 'character.development', ...currentScope, limit: 12 });
      const initialInput: SocialPreparation['input'] = { companion, conversation, source, messages: sources, world, routine, ...profiles,
        topic: port.topic, topicState: port.topicState, gameCommunication, resourceBounds,
        memoryRecall: { ...recalled, reasons: recalled?.reasons ?? [], pending: recalled?.pending ?? false, degraded: recalled?.degraded ?? false },
        characterDevelopment: developmentResponse.characterDevelopment,
        memories: recalled?.memories ?? [], memoryContext: recalled?.context?.text,
        ...(runtime ? { selfState: { energy: runtime.energy, expression: runtime.expression, experience: runtime.experience } } : {}),
        members: state!.companions.filter(member => conversation.memberIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) };
      const initialFrame = companionSocialInitialFrame({ ...initialInput, job });
      const frame = port.joined ? await prepareTopicContinuity({ frame: initialFrame, request: this.options.request,
        config, signal, fetchFn: this.options.fetchFn }) : initialFrame;
      const created: SocialPreparation = { input: { ...initialInput, messages: [...frame.messages], topic: frame.topic, topicState: frame.topicState }, frame };
      preparation = created;
      const epoch = job.receivedState?.revocationEpoch ?? (await this.options.request({ type: 'memory.lifecycle.state', companionId: companion.id })).memoryLifecycleState?.revocationEpoch;
      if (epoch === undefined) throw new Error('伙伴来信的来源撤销状态暂不可核验。');
      job.preparation = companionTaskPreparation(preparationBinding, created, { capturedAt: job.receivedState?.capturedAt ?? world.clock.realNow, revocationEpoch: epoch });
      const saved = await this.options.request({ type: 'social.job.preparation.save', companionId: companion.id, id: job.id, leaseToken, preparation: job.preparation });
      if (!saved.ok) throw new Error(saved.error ?? '伙伴来信初始上下文未能保存。');
      }
      const initial = preparation;
      if (!initial) throw new Error('伙伴来信初始输入尚未完整保存。');
      if (!initial.frame || initial.frame.companion?.id !== companion.id || initial.frame.conversation?.id !== conversation.id
        || initial.frame.invocation?.id !== job.id || initial.input?.source?.id !== source.id || initial.input.source.content !== source.content
        || initial.input.source.authorId !== source.authorId || initial.input.source.topicId !== source.topicId
        || initial.input.companion.id !== companion.id || initial.input.conversation.id !== conversation.id)
        throw new Error('本轮伙伴来信初始输入与当前真实来源不一致。');
      const sources = initial.input.messages, gameCommunication = initial.input.gameCommunication, recalled = initial.input.memoryRecall;
      const validateInitial = async () => {
        signal.throwIfAborted();
        const current = await this.options.request({ type: 'social.job.check', companionId: companion.id, id: job.id, leaseToken });
        if (!current.ok || !current.socialJob) throw cancelled();
        const expectedEpoch = sealed?.revocationEpoch ?? job.receivedState?.revocationEpoch;
        if (expectedEpoch !== undefined && current.socialJob.receivedState?.revocationEpoch !== expectedEpoch)
          throw new Error('本任务初始观察引用的来源已经撤回。');
        // Revalidate precisely the sealed window; a newer message is another
        // task and must never be selected into this invocation.
        const originals = [...new Map([...sources, initial.input.source].map(message => [message.id, message])).values()];
        for (let offset = 0; offset < originals.length; offset += 100) {
          const batch = originals.slice(offset, offset + 100), actual = (await this.options.request({ type: 'memory.sources.filter', ...scope,
            ids: batch.map(message => message.id) })).memorySources ?? [];
          if (batch.some(original => !actual.some(message => message.id === original.id && message.content === original.content
            && message.authorId === original.authorId && message.conversationId === original.conversationId && message.topicId === original.topicId
            && message.sequence === original.sequence))) throw new Error('本任务初始消息窗口的来源已改变或不可访问。');
        }
        if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, recalled?.context))
          throw new Error('本任务初始回忆的来源已经撤回，不重新召回或替换初始输入。');
      };
      const socialCapabilities = companionSocialCapabilities(this.options.request, { ...scope, sourceMessageId: source.id },
        companionTopicCapabilities(this.options.request, scope, companionRecallCapabilities(this.options.request, scope), {
          reviewUpdate: (command, actionSignal) => reviewCompanionGameSharedUpdate({ command, request: this.options.request, source },
            config, actionSignal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 }),
          reviewTransfer: (command, actionSignal) => reviewCompanionTopicModeratorTransfer({ command, request: this.options.request },
            config, actionSignal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 }),
        }), async (proposed, actionSignal) => {
          const recipients = state!.companions.filter(role => proposed.recipientIds.includes(role.id));
          if (recipients.length !== proposed.recipientIds.length) return false;
          const game = proposed.action === 'message' ? await resolveCompanionGameInitiativeContext(this.options.request, {
            scope, source, recipientIds: proposed.recipientIds, job,
          }) : undefined;
          return authorizeCompanionSocialInitiative({ companion: initial.input.companion, recipients, text: proposed.text, privateSources: sources, game }, config, actionSignal, { fetchFn: this.options.fetchFn });
        }, { ...(gameCommunication ? { gamePort: gameCommunication.gamePort }
          : initial.frame.topic?.kind === 'game' ? { gamePort: { conversationId: initial.frame.topic.conversationId, topicId: initial.frame.topic.id } } : {}),
        executionReadset: () => executionReadset });
      let capabilities = this.options.think ? companionThoughtCapabilities(socialCapabilities, {
        run: async (proposal, effectId, thoughtSignal) => {
          if (!executionReadset) throw new Error('伙伴思考实际读集不可用。');
          return this.options.think!({ companionId: companion.id, conversationId: conversation.id, jobId: job.id, leaseToken,
            effectId, executionReadset, ...proposal }, thoughtSignal);
        }, ...(this.options.readThought ? { read: (query: DshRecordQuery, thoughtSignal?: AbortSignal) => this.options.readThought!({
          companionId: companion.id, conversationId: conversation.id, jobId: job.id, query }, thoughtSignal) } : {}),
      }) : socialCapabilities;
      capabilities = this.options.browserCapabilities?.(scope, capabilities) ?? capabilities;
      // Continuity selection has already happened before sealing. Subsequent
      // capacity retries may compact actual tool turns, but cannot select a new
      // topic window through the generic agent refresh hook.
      capabilities = { ...capabilities, continuityRequest: undefined };
      const result = await generateCompanionSocialReply({ ...initial.input, job },
      config, signal, { fetchFn: this.options.fetchFn,
        capabilities, initialFrame: initial.frame,
        observeReadset: async readset => {
          if (!await verifyCompanionExecutionReadset(readset, scope, { request: this.options.request,
            contextValid: this.options.memoryContextValid })) throw new Error('伙伴本轮实际读取的来源、游戏私态或记忆已撤回，不能发布或继续行动。');
          executionReadset = readset;
        },
        prepareFrame: async () => { await validateInitial(); return initial.frame; },
        publicationFrame: async frame => {
          await validateInitial();
          if (!source.topicId) return frame;
          // Membership and game privacy are current publication checks. These
          // bytes are never installed into the author's sealed task input.
          const current = await this.options.request({ type: 'topic.read', conversationId: conversation.id,
            topicId: source.topicId, readerId: companion.id });
          if (!current.topic || current.topic.status !== 'active') throw cancelled();
          return { ...frame, topic: current.topic, topicState: current.topicState };
        } });
      const wait = Date.parse(job.typingNotBefore) - Date.now();
      await progress('waiting', '回应已准备好，正在核验并发送');
      if (wait > 0) await delay(wait, signal);
      if (signal.aborted || this.closed) throw cancelled();
      if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, recalled?.context)) {
        throw new Error('伙伴回忆来源已经变化，本轮发言将重新读取。');
      }
      if (executionReadset && this.options.taskAssetSources) {
        const sources = [...executionReadset.sources, ...await this.options.taskAssetSources(job)];
        executionReadset = { ...executionReadset, sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] };
      }
      if (!executionReadset || !await verifyCompanionExecutionReadset(executionReadset, scope,
        { request: this.options.request, contextValid: this.options.memoryContextValid })) throw new Error('伙伴交付使用的来源或游戏检查点已失效。');
      await this.options.request({ type: 'social.job.complete', id: job.id, leaseToken, text: result.text,
        executionReadset,
        memoryRecall: { reasons: recalled?.reasons ?? [], pending: recalled?.pending === true, degraded: recalled?.degraded === true,
          ...(recalled?.context ? { context: recalled.context } : {}) },
        ...(recalled?.context && recalled.context.evidence?.snapshotPolicy !== 'task_passive_v1'
          ? { expectedMemoryRevision: recalled.context.revision } : {}),
        ...(result.shareAddress ? { shareAddress: true } : {}),
        ...(result.nextRecipientId ? { nextRecipientId: result.nextRecipientId } : {}), ...(result.workOffer ? { workOffer: result.workOffer } : {}) });
      this.options.changed();
    } catch (error) {
      if (userStopped(signal)) return;
      if (this.agendaDriven && signal.aborted) {
        await this.options.request({ type: 'social.job.defer', companionId: job.companionId, id: job.id, leaseToken,
          error: '日程已停止，先前回复结果尚未确认；保留来源等待明确核验。', retryAfterMs: 1000, uncertain: true }); return;
      }
      const admission = companionModelAdmissionRetryAfter(error) ?? (error instanceof CompanionModelError && error.code === 'CONFIG' ? 60000 : undefined);
      if (this.agendaDriven && admission !== undefined) {
        await this.options.request({ type: 'social.job.defer', companionId: job.companionId, id: job.id, leaseToken,
          error: '模型发送前不可用，保留真实来信等待配置或工程资源恢复。', retryAfterMs: Math.max(1000, admission) }); return;
      }
      if (!signal.aborted && !this.closed) this.options.report(error);
      await this.options.request({ type: 'social.job.fail', id: job.id, leaseToken,
        error: error instanceof Error ? error.message : '伙伴通信稍后继续。', ...(terminalInferenceFailure(error) ? { terminal: true } : {}) });
    } finally { await this.options.endPriority?.(interruptionId); }
  }
  private async processNotification(notification: CompanionSocialNotification, signal: AbortSignal): Promise<void> {
    if (!notification.leaseToken) return; const leaseToken = notification.leaseToken;
    try {
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: notification.conversationId })).state;
      const companion = state?.companions.find(member => member.id === notification.companionId);
      const conversation = state?.conversations.find(room => room.id === notification.conversationId && room.memberIds.includes(notification.companionId));
      if (!companion || !conversation) throw cancelled();
      const scope = { companionId: companion.id, conversationId: conversation.id };
      const source = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [notification.sourceMessageId] })).memorySources?.[0];
      if (!source || source.authorId !== 'user') throw cancelled();
      const participants = new Set([companion.id, notification.origin.initiatorId, notification.evidence.authorId, ...(notification.events?.map(event => event.evidence.authorId) ?? [])]);
      const eventMessages: CompanionMessage[] = [];
      for (const event of notification.events ?? [notification]) if (event.peerConversationId && event.evidence.messageId) {
        const message = (await this.options.request({ type: 'memory.sources.filter', companionId: companion.id,
          conversationId: event.peerConversationId, ids: [event.evidence.messageId] })).memorySources?.find(message => message.id === event.evidence.messageId);
        if (!message || message.content !== event.evidence.text || message.authorId !== event.evidence.authorId) throw cancelled();
        eventMessages.push(message);
      }
      let executionReadset: CompanionExecutionReadset | undefined;
      const text = buildCompanionSocialNotification({ companion, conversation, source, notification, eventMessages,
        members: state!.companions.filter(member => participants.has(member.id)).map(member => ({ id: member.id, name: member.name })) },
      { observeReadset: readset => { executionReadset = readset; } });
      if (signal.aborted || this.closed) throw cancelled();
      if (!executionReadset || !await verifyCompanionExecutionReadset(executionReadset, scope,
        { request: this.options.request, contextValid: this.options.memoryContextValid })) throw new Error('后续回报使用的实际来源已经变化，未发送。');
      await this.options.request({ type: 'social.notification.complete', id: notification.id, leaseToken, text, executionReadset });
    } catch (error) {
      if (userStopped(signal)) return;
      if (this.agendaDriven && signal.aborted) {
        await this.options.request({ type: 'social.notification.defer', companionId: notification.companionId, id: notification.id, leaseToken,
          error: '日程已停止，后续回报的实际发送结果尚未确认。', retryAfterMs: 1000, uncertain: true }); return;
      }
      await this.options.request({ type: 'social.notification.fail', id: notification.id, leaseToken,
        error: error instanceof CompanionModelError ? error.message : '这次后续回报尚未完成，稍后继续。',
        ...(terminalInferenceFailure(error) || error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE' ? { terminal: true } : {}) });
    }
  }
  private async process(job: CompanionWorldJob, signal: AbortSignal): Promise<void> {
    const { id: jobId, leaseToken, kind, companionId } = job;
    if (!leaseToken) return;
    try {
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: job.conversationId })).state;
      const companion = state?.companions.find(companion => companion.id === companionId);
      const conversation = state?.conversations.find(conversation => conversation.id === job.conversationId && conversation.memberIds.includes(companionId));
      if (!companion || !conversation) throw new Error('伙伴世界认知范围不可访问。');
      const scope = { companionId, conversationId: conversation.id }, world = await this.observe(scope);
      if (!world) throw new Error('伙伴当前世界快照不可访问。');
      const config = this.sourceFencedConfig(await this.hostConfig(companion), job, leaseToken, signal);
      if (kind === 'decision') {
        const routine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
        const memoryQuery = world.events.slice(-8).map(event => event.text).filter(Boolean).join('\n').slice(0, 4000)
          || '我自己的真实世界经历、实际学习过的资料，以及在这些经历中形成的个人认识、兴趣和价值判断';
        const journalId = companionAgentRunIdentity(companionId, conversation.id, jobId);
        const savedRunResponse = await this.options.request({ type: 'agent.run.get', companionId, id: journalId });
        if (!savedRunResponse.ok) throw new Error(savedRunResponse.error ?? '世界任务原始推理记录不可恢复。');
        const savedRun = savedRunResponse.agentRun;
        const query = { ...scope, query: memoryQuery, limit: 8 };
        const memoryResponse: CompanionStorageResponse | undefined = savedRun ? { ok: true, memoryContext: savedRun.passiveRecall?.context }
          : await (this.options.passiveRecall ? this.options.passiveRecall(query, signal)
            : this.options.request({ type: 'memory.search', ...query })).catch(() => undefined);
        const memories = memoryResponse?.memoryPage?.items.map(hit => hit.memory) ?? [];
        const [runtimeResponse, developmentResponse, latestWorld] = await Promise.all([
          this.options.request({ type: 'state.get', ...scope }), this.options.request({ type: 'character.development', ...scope, limit: 12 }), this.observe(scope),
        ]);
        const runtime = runtimeResponse.runtimeState;
        if (!latestWorld) throw new Error('伙伴最新世界状态不可访问。');
        const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, audience: 'peers', directory: false,
          sourceAuthorId: world.events.findLast(event => event.targetId === companion.id && event.actorId !== companion.id)?.actorId });
        let executionReadset: CompanionExecutionReadset | undefined;
        const decision = await generateCompanionWorldDecision({ companion, world: latestWorld, job, characterDevelopment: developmentResponse.characterDevelopment,
          memories, memoryContext: memoryResponse?.memoryContext?.text,
          memoryRecall: { reasons: [], pending: false, degraded: false, ...(memoryResponse?.memoryContext ? { context: memoryResponse.memoryContext } : {}) },
          ...profiles, routine, ...(runtime ? { selfState: { energy: runtime.energy, expression: runtime.expression,
            experience: runtime.experience, focus: runtime.focus, busy: world.works.some(work => work.companionId === companion.id && work.status !== 'ended') } } : {}),
          members: state!.companions.filter(member => member.id === companion.id || world.perception?.visibleCompanionIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) }, config, signal,
        { fetchFn: this.options.fetchFn, capabilities: companionRecallCapabilities(this.options.request, scope),
          observeReadset: async readset => {
            executionReadset = readset;
            const bound = await this.options.request({ type: 'world.job.bind-inputs', id: jobId, leaseToken, readset });
            if (!bound.ok || !bound.worldInputAccepted) throw new StaleWorldInput('本轮实际读取来源已经变化，旧世界输入未继续发送。');
          } });
        if (signal.aborted || this.closed) throw cancelled();
        if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, memoryResponse?.memoryContext)) {
          throw new StaleWorldInput('本任务原回忆来源已撤回，不能继续提交旧世界决策。');
        }
        const frozen = memoryResponse?.memoryContext?.evidence?.snapshotPolicy === 'task_passive_v1';
        if (frozen && (!executionReadset || !await verifyCompanionExecutionReadset(executionReadset, scope,
          { request: this.options.request, contextValid: this.options.memoryContextValid }))) throw new StaleWorldInput('世界决策实际读取的来源已撤回。');
        const task = decision.task ?? (decision.action?.action === 'query' ? { title: '查询并核实世界资料',
          goal: `按需查询外部资料：${JSON.stringify(decision.action)}。查询动机：${decision.reason}。根据实际结果判断是否需要内化；如需记住，先搜索已有记忆，再引用查询凭证进行记录或整理。` } : undefined);
        if (task) {
          if (decision.task && decision.action) throw new Error('本轮只能创建持续行动目标或执行一个原子动作。');
        }
        await this.options.request({ type: 'world.job.complete', id: jobId, leaseToken, ...(decision.action && !task ? { action: decision.action } : {}),
          ...(executionReadset?.complete ? { executionReadset } : {}),
          ...(task ? { activityTask: task } : {}),
          sourceMemoryIds: memories.map(note => note.id),
          ...(memoryResponse?.memoryContext && memoryResponse.memoryContext.evidence?.snapshotPolicy !== 'task_passive_v1'
            ? { expectedMemoryRevision: memoryResponse.memoryContext.revision } : {}) });
      } else await this.dream(job, leaseToken, companion, conversation, config, signal);
    } catch (error) {
      if (userStopped(signal)) return;
      if (this.agendaDriven && signal.aborted) {
        await this.options.request({ type: 'world.job.defer', id: jobId, leaseToken,
          error: '日程已停止，世界语义处理结果尚未确认；保留固定输入等待明确核验。', retryAfterMs: 1000, uncertain: true }); return;
      }
      const admission = companionModelAdmissionRetryAfter(error);
      if (admission !== undefined) {
        await this.options.request({ type: 'world.job.defer', id: jobId, leaseToken,
          error: '模型请求尚未发送，等待模型配置或工程队列恢复；已完成的记忆维护阶段保留。', retryAfterMs: admission }); return;
      }
      await this.options.request({ type: 'world.job.fail', id: jobId, leaseToken,
        failureKind: this.closed || signal.aborted || error instanceof CompanionModelError && error.code === 'CONFIG' ? 'waiting'
          : error instanceof StaleWorldInput || error instanceof CompanionModelError && error.code === 'CANCELLED' ? 'stale' : 'processing',
        error: error instanceof CompanionModelError || error instanceof CompanionAgentNoProgressError ? error.message : '伙伴世界认知暂未完成，稍后会继续。',
        ...(terminalInferenceFailure(error) ? { terminal: true } : {}) });
    }
  }
  private socialFencedConfig(config: CompanionModelConfig, job: CompanionSocialJob, signal: AbortSignal,
    initialEpoch = job.receivedState?.revocationEpoch): CompanionModelConfig {
    const verify = async () => {
      signal.throwIfAborted();
      const current = await this.options.request({ type: 'social.job.check', companionId: job.companionId, id: job.id, leaseToken: job.leaseToken! });
      if (!current.ok || !current.socialJob) throw new CompanionModelError('CANCELLED', '伙伴通信的日程、准确来源或执行租约已变化，未发送旧请求。');
      if (initialEpoch !== undefined && current.socialJob.receivedState?.revocationEpoch !== initialEpoch)
        throw new CompanionModelError('CANCELLED', '本任务收到消息时观察的来源已经撤回，未继续发送旧状态。');
    };
    return { ...config, providerLifecycle: { beforeDispatch: async () => {
      await verify(); const finish = await config.providerLifecycle?.beforeDispatch();
      try { await verify(); } catch (error) { await finish?.('cancelled_before_send', 0); throw error; }
      return finish ?? (async () => undefined);
    } } };
  }
  private async hostConfig(companion: Companion): Promise<CompanionModelConfig> {
    try { return await this.options.configFor(companion); }
    catch (error) {
      if (companionModelAdmissionRetryAfter(error) !== undefined) throw error;
      throw new CompanionModelAdmissionError('configuration_unavailable', error instanceof CompanionModelError ? error.message : '伙伴当前角色文件或模型配置不可用，修复后继续维护。');
    }
  }
  private sourceFencedConfig(config: CompanionModelConfig, job: CompanionWorldJob, leaseToken: string, signal: AbortSignal): CompanionModelConfig {
    const verify = async () => {
      signal.throwIfAborted();
      const current = (await this.options.request({ type: 'world.job.check', id: job.id, leaseToken })).worldJob;
      if (!current) throw new CompanionModelError('CANCELLED', '维护或世界决策的实际任务来源、正文或租约已变化，未发送模型请求。');
      for (const id of current.sourceMemoryIds) {
        const read = (await this.options.request({ type: 'memory.read', companionId: current.companionId, conversationId: current.conversationId, id, sourceLimit: 100 })).memoryRead;
        if (!read || read.hasMore) throw new CompanionModelError('CANCELLED', '本次固定记忆的真实文件或完整来源不可核验，未发送模型请求。');
      }
      signal.throwIfAborted();
      if (!(await this.options.request({ type: 'world.job.check', id: job.id, leaseToken })).worldJob)
        throw new CompanionModelError('CANCELLED', '读取期间本次固定来源已变化，未发送模型请求。');
    };
    return { ...config, providerLifecycle: { beforeDispatch: async () => {
      await verify(); const finish = await config.providerLifecycle?.beforeDispatch();
      try { await verify(); } catch (error) { await finish?.('cancelled_before_send', 0); throw error; }
      return finish ?? (async () => undefined);
    } } };
  }
  private async proposal(job: CompanionWorldJob, leaseToken: string, companion: Companion, phase: CompanionWorldProposal['phase'], notes: readonly CompanionMemory[],
    prohibitionRevision: string, config: CompanionModelConfig, expectedStateRevision?: number) {
    const purpose = phase === 'reflection' ? 'vcp_sleep_reflection' : phase === 'real' ? 'vcp_sleep_memory_maintenance' : 'companion_dream_wave_narrative';
    const identity = await companionMemoryProposalIdentity(config, companion.id, purpose);
    const basis = createHash('sha256').update(JSON.stringify(['world-paid-proposal-v1', job.id, job.companionId, job.conversationId,
      job.maintenanceSessionId, job.maintenanceMode, phase, identity, prohibitionRevision,
      { id: companion.id, name: companion.name, persona: companion.persona, description: companion.description },
      [...notes].sort((a, b) => a.id.localeCompare(b.id)).map(note => ({ id: note.id, contentRevision: note.contentRevision,
        sources: note.sources.map(source => ({ id: source.messageId, revision: source.revision, checksum: source.checksum, conversationId: source.conversationId })) }))])).digest('hex');
    return companionWorldProposalCheckpoint({ id: job.id, leaseToken, phase, basis, prohibitionRevision, expectedStateRevision,
      request: this.options.request, current: async () => identity === await companionMemoryProposalIdentity(await this.hostConfig(companion), companion.id, purpose) });
  }
  private async dream(job: CompanionWorldJob, leaseToken: string, companion: Companion, conversation: CompanionConversation,
    config: CompanionModelConfig, signal: AbortSignal): Promise<void> {
    const scope = { companionId: companion.id, conversationId: conversation.id };
    const readAtoms = async (ids: readonly string[]) => {
      const reads = await Promise.all([...new Set(ids)].map(id => this.options.request({ type: 'memory.read', ...scope, id, sourceLimit: 100 })));
      const notes = reads.flatMap(read => read.memoryRead?.memory ? [read.memoryRead.memory] : []);
      if (notes.length !== new Set(ids).size || notes.some(note => !['indexed', 'queued'].includes(note.status))
        || reads.some(read => read.memoryRead?.hasMore)) throw new Error('本次维护的记忆已撤回或尚未完整读取。');
      const sources = new Map(reads.flatMap(read => read.memoryRead?.sources ?? []).map(source => [source.id, source]));
      return { reads, notes, sources };
    };
    const initialIds = [...new Set([...job.sourceMemoryIds, ...(job.maintenanceMemoryIds ?? [])])];
    if (!job.realCompletedAt) {
      const { reads, notes: atoms, sources } = await readAtoms(initialIds);
      await this.options.request({ type: 'world.job.bind-memories', id: job.id, leaseToken,
        memoryVersions: atoms.map(note => ({ id: note.id, version: note.version })) });
      const seedIds = new Set(job.sourceMemoryIds), maintenanceIds = new Set(job.maintenanceMemoryIds ?? job.sourceMemoryIds);
      const seedAtoms = atoms.filter(note => seedIds.has(note.id) && ['episode_memory', 'knowledge', 'procedure'].includes(note.artifactKind));
      const actualSeedIds = new Set(seedAtoms.map(note => note.id));
      const seedSources = new Map(reads.filter(read => actualSeedIds.has(read.memoryRead!.memory.id))
        .flatMap(read => read.memoryRead?.sources ?? []).map(source => [source.id, source]));
      const maintenanceAtoms = companionAutomaticMaintenanceSeeds(atoms.filter(note => maintenanceIds.has(note.id) && note.artifactKind === 'episode_memory'));
      const actualMaintenanceIds = new Set(maintenanceAtoms.map(note => note.id));
      const maintenanceSources = new Map(reads.filter(read => actualMaintenanceIds.has(read.memoryRead!.memory.id))
        .flatMap(read => read.memoryRead?.sources ?? []).map(source => [source.id, source]));
      const prohibitions = await this.options.request({ type: 'memory.prohibitions', ...scope, worldJobId: job.id });
      const runtimeState = (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
      const characterDevelopment = (await this.options.request({ type: 'character.development', ...scope, limit: 12 })).characterDevelopment;
      // Reflection, integration and fiction have separate durable failure
      // boundaries. A retry resumes the first unfinished stage only.
      if (!job.reflectionCompletedAt) {
        const checkpoint = seedAtoms.length ? await this.proposal(job, leaseToken, companion, 'reflection', seedAtoms, prohibitions.memoryProhibitionRevision!, config, runtimeState?.revision) : undefined;
        const result: CompanionMemoryDreamResult = seedAtoms.length ? await generateCompanionMemoryDream({ companion, conversation, messages: [...seedSources.values()], relevantMemories: seedAtoms,
        runtimeState, characterDevelopment, maintenanceMode: job.maintenanceMode ?? 'background',
        dreamAllowed: job.dreamAllowed, reflectionOnly: true, maintenanceSeparated: true, prohibitions: prohibitions.memoryProhibitions,
        intent: '根据本批真实经历与实际学习资料进行独立后台回顾，不要求身体睡眠。没有新的具体认识时notes=[]；旧总结的改写、同源反思和梦不能成为新的经历。保持来源原本的作者、时间和可见域。' },
        config, signal, { fetchFn: this.options.fetchFn, ...checkpoint?.options }) : { notes: [], dream: null };
        signal.throwIfAborted();
        await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, stage: 'reflection',
          expectedProhibitionRevision: prohibitions.memoryProhibitionRevision,
          ...(result.stateProposal ? { stateProposal: result.stateProposal, expectedStateRevision: checkpoint?.expectedStateRevision } : {}),
          sourceMemoryIds: [...new Set(result.notes.flatMap(note => note.relatedMemoryIds ?? []))],
          memoryCandidates: result.notes.map(candidate => ({ ...candidate,
            sourceChecksums: Object.fromEntries(candidate.sourceMessageIds.map(id => [id, createHash('sha256').update(sources.get(id)!.content).digest('hex')])) })) });
      }
      const checkpoint = maintenanceAtoms.length ? await this.proposal(job, leaseToken, companion, 'real', maintenanceAtoms, prohibitions.memoryProhibitionRevision!, config) : undefined;
      if (checkpoint?.options.proposal) {
        const writer = companionWorldMaintenanceProposalSchema.parse(checkpoint.options.proposal);
        // Annotation-only revisions do not buy another writer call. Rebind CAS
        // versions only after the checkpoint's fixed body/source proof passes.
        checkpoint.options.proposal = { ...writer, consolidations: writer.consolidations.map(plan => ({ ...plan,
          inputs: plan.inputs.map(reference => ({ ...reference, version: maintenanceAtoms.find(note => note.id === reference.id)!.version })) })) };
      }
      const maintenance = maintenanceAtoms.length ? await generateCompanionMemoryMaintenance({ companion, conversation,
        messages: [...maintenanceSources.values()], relevantMemories: maintenanceAtoms, maintenanceMode: job.maintenanceMode ?? 'background',
        prohibitions: prohibitions.memoryProhibitions }, config, signal, { fetchFn: this.options.fetchFn, ...checkpoint!.options }) : undefined;
      signal.throwIfAborted();
      await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, stage: 'real',
        expectedProhibitionRevision: prohibitions.memoryProhibitionRevision,
        sourceMemoryIds: maintenanceAtoms.map(note => note.id),
        ...(maintenance ? { maintenance: { decision: maintenance.decision, reason: maintenance.reason,
          reviewedMemoryVersions: maintenanceAtoms.map(note => ({ id: note.id, version: note.version })) },
          ...(maintenance.consolidations.length ? { consolidations: maintenance.consolidations } : {}) } : {}) });
    }
    if (!job.dreamAllowed) return;
    signal.throwIfAborted();
    await this.options.request({ type: 'world.job.narrative.begin', id: job.id, leaseToken });
    const { reads, notes: atoms, sources } = await readAtoms(initialIds);
    let prohibitions = await this.options.request({ type: 'memory.prohibitions', ...scope, worldJobId: job.id });
    let checkpoint = await this.proposal(job, leaseToken, companion, 'dream', atoms, prohibitions.memoryProhibitionRevision!, config);
    let imagined: Awaited<ReturnType<typeof generateCompanionDreamNarrative>> | undefined = checkpoint.writer === undefined
      ? undefined : companionWorldNarrativeProposalSchema.parse(checkpoint.writer);
    let wave: VcpMemoryDreamWaveResult | undefined;
    let dreamComponentFailure: CompanionWorldJob['dreamComponentFailure'];
    const optionalFailure = (error: CompanionOptionalDreamError) => {
      if (signal.aborted || this.closed) throw cancelled();
      dreamComponentFailure = error.diagnostic; this.options.report(error);
    };
    let dream: { text: string; relatedMemoryIds: string[]; sourceMessageIds: string[]; evidence: Array<{ sourceMessageId: string; quote: string }> } | undefined;
    if (imagined === undefined) {
      if (!this.options.dreamWave) optionalFailure(new CompanionOptionalDreamError('runtime_unavailable'));
      const world = await this.observe(scope);
      if (!world) throw new Error('记忆联想的实际时钟不可访问。');
      if (this.options.dreamWave) try { wave = await this.options.dreamWave({ ...scope, now: world.clock.virtualNow, clockDomain: 'world' }); }
      catch (error) { if (!(error instanceof CompanionOptionalDreamError)) throw error; optionalFailure(error); }
      const stages = wave?.stages;
      const items = stages ? [...new Map([...stages.recent.seeds, ...stages.recent.resonanceL1, ...stages.recent.cascadeL2,
        ...stages.mid.seeds, ...stages.mid.cascadeL1, ...stages.deep.recalls].map(item => [item.id, item])).values()] : [];
      for (const item of items) {
        const read = await this.options.request({ type: 'memory.library.read', companionId: companion.id, id: item.id, sourceLimit: 100 });
        const note = read.memoryRead?.memory;
        if (!note || note.companionId !== companion.id || note.status !== 'indexed' || note.version !== item.version || read.memoryRead?.hasMore)
          throw new Error('梦境浪潮的真实来源已变化或尚未完整读取。');
        if (!atoms.some(seed => seed.id === note.id)) { reads.push(read); atoms.push(note); }
        for (const source of read.memoryRead?.sources ?? []) sources.set(source.id, source);
      }
      await this.options.request({ type: 'world.job.bind-memories', id: job.id, leaseToken,
        memoryVersions: atoms.map(note => ({ id: note.id, version: note.version })) });
      prohibitions = await this.options.request({ type: 'memory.prohibitions', ...scope, worldJobId: job.id });
      checkpoint = await this.proposal(job, leaseToken, companion, 'dream', atoms, prohibitions.memoryProhibitionRevision!, config);
      if (wave) {
        try {
          imagined = await generateCompanionDreamNarrative({ companion, wave,
            mode: job.maintenanceMode === 'sleep' && world.actors.some(actor => actor.companionId === companion.id && actor.activity === 'sleeping')
              ? 'sleep_dream' : 'rehearsal_dream' }, config, signal, { fetchFn: this.options.fetchFn });
          await checkpoint.options.onProposal!(imagined);
        } catch (error) {
          if (companionModelAdmissionRetryAfter(error) !== undefined) throw error;
          if (!(error instanceof CompanionModelError) || error.code === 'CANCELLED' || signal.aborted || this.closed) throw error;
          imagined = null; optionalFailure(new CompanionOptionalDreamError('narrative_generation_failed'));
        }
      }
    }
    if (imagined) {
      try {
        if (!await validateCompanionMemoryProhibitions({ content: imagined.text, tags: ['梦境'],
          prohibitions: prohibitions.memoryProhibitions ?? [] }, config, signal, { fetchFn: this.options.fetchFn, ...checkpoint.options })) imagined = null;
      } catch (error) {
        if (companionModelAdmissionRetryAfter(error) !== undefined) throw error;
        if (!(error instanceof CompanionModelError) || error.code === 'CANCELLED' || signal.aborted || this.closed) throw error;
        imagined = null; optionalFailure(new CompanionOptionalDreamError('narrative_generation_failed'));
      }
      if (imagined) {
        const evidence = imagined.relatedMemoryIds.map(id => {
          const note = atoms.find(note => note.id === id)!;
          const source = note.sources.map(source => sources.get(source.messageId)).find(Boolean);
          if (!source) throw new Error('联想依赖缺少可核验的本人真实来源。');
          return { sourceMessageId: source.id, quote: source.content.slice(0, 300) };
        });
        dream = { ...imagined, sourceMessageIds: [...new Set(evidence.map(item => item.sourceMessageId))], evidence };
      }
    }
    signal.throwIfAborted();
    await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, stage: 'dream', ...(dream ? { dream } : {}),
      ...(dreamComponentFailure ? { dreamComponentFailure } : {}), expectedProhibitionRevision: prohibitions.memoryProhibitionRevision,
      sourceMemoryIds: dream?.relatedMemoryIds ?? [] });
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await this.ticking; await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}
function userStopped(signal: AbortSignal): boolean {
  return signal.aborted && !!signal.reason && typeof signal.reason === 'object' && signal.reason.code === 'USER_STOP';
}
function cancelled() { return new CompanionModelError('CANCELLED', '伙伴本次世界工作已停止。'); }
function terminalInferenceFailure(error: unknown): boolean {
  return error instanceof CompanionAgentNoProgressError || error instanceof CompanionModelError && error.code === 'CONTEXT_CAPACITY';
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
