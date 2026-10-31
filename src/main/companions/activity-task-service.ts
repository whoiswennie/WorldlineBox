import { companionBehaviorSystem } from './asset-behavior-defaults';
import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation, CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { activityAgentDecisionSchema, activityDecisionJsonSchema, projectCompanionActivityHistoryEntry, type CompanionActivityTask, type CompanionActivityMemoryIntent } from '../../shared/companion-activity-task';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';
import { CompanionModelError, type CompanionModelConfig } from './model';
import { CompanionAgentNoProgressError, CompanionAgentFinalValidationError } from './agent-kernel';
import { runCompanionStructuredAgent, companionTaskInvocation, companionRecallCapabilities } from './structured-agent';
import { companionModelWorld, companionModelPhoneReceipt, COMPANION_WORLD_PERCEPTION_RULES } from './world-perception-context';
import { authorizeCompanionContact, authorizeCompanionSocialInitiative } from './social-model';
import { generateCompanionVisitSpeech } from './visit-speech-model';
import { resolveCompanionGameContactContext, resolveCompanionGameInitiativeContext } from './game-contact-context';
import { companionRuntimeBehavior, companionVisibleRuntimeState, currentCompanionCharacterDevelopment } from './context';
import { verifyCompanionKnowledgeReads } from './knowledge-evidence';
import { reviewCompanionGameSharedUpdate, type CompanionGameTopicUpdate } from './game-topic-privacy';
import { reviewCompanionGameGoalCompletion } from './game-goal-completion';
import { companionRoleResourceBounds } from './role-resource-context';
import { reviewCompanionActivityFeasibility } from './activity-feasibility';
import { COMPANION_ACTIVITY_FINAL_CONTRACT, parseCompanionActivityDecision } from './activity-output-contract';
import { reviewCompanionTopicModeratorTransfer, type CompanionTopicModeratorTransfer } from './topic-moderator-transfer';
import type { CompanionTopicModeratorTransferApproval } from '../../shared/companion-topic';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from './execution-evidence';
import { reviewCompanionSocialProgress } from './social-progress-review';
import { companionThoughtCapabilities } from './thought-capabilities';
import type { DshRecordQuery } from '../../shared/dsh-task-record';
import type { CompanionBrowserExtension } from './browser-capabilities';
import type { CompanionMemorySearch } from '../../shared/companion-memory';
interface Options {
  browserCapabilities?: CompanionBrowserExtension;
  request(input: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  passiveRecall?(query: CompanionMemorySearch, signal?: AbortSignal): Promise<CompanionStorageResponse>;
  configFor(companion: Companion): Promise<CompanionModelConfig>;
  profiles(input: { companionId: string; conversation: Pick<CompanionConversation, 'id' | 'memberIds'>; audience: 'peers' }): Promise<CompanionProfileInput>;
  fetchFn: typeof fetch; excludedIds(): string[]; changed(): void; report(error: unknown): void;
  memoryContextValid?(scope: { companionId: string; conversationId: string; beforeSequence?: number }, context: { revision: string; profileKey: string }): Promise<boolean>;
  think?(input: { taskId: string; leaseToken: string; expectedStep: number; effectId: string; observationFingerprint: string;
    executionReadset: CompanionExecutionReadset; title: string; prompt: string }, signal?: AbortSignal): Promise<unknown>;
  readThought?(input: { taskId: string; companionId: string; conversationId: string; query: DshRecordQuery }, signal?: AbortSignal): Promise<unknown>;
}
class ActivityPassiveRecallWithdrawnError extends Error {}
/** Actual reply identity and bytes, never wall-clock passage or a model plan. */
export function companionActivitySocialObservationFingerprint(messages: readonly CompanionMessage[]): string {
  return JSON.stringify(messages.map(message => [message.id, message.conversationId, message.sequence,
    createHash('sha256').update(message.content).digest('hex')]));
}
export interface CompanionActivityAgendaParent { companionId: string; id: string; agendaRunId: string; agendaLeaseToken: string }
export type CompanionActivityAgendaPhase = 'report' | 'memory' | 'planning' | 'waiting';
/** Sleeps in durable host predicates, not model polling or a held chat/computer lease. */
export class CompanionActivityTaskService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private closed = false;
  private agendaDriven = false;
  private agendaReady?: Promise<void>;
  private jobs = new Map<string, { companionId: string; controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly options: Options) {}
  setAgendaDriven(): Promise<void> {
    if (this.agendaReady) return this.agendaReady;
    this.agendaDriven = true; if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const job of this.jobs.values()) job.controller.abort();
    return this.agendaReady ??= this.options.request({ type: 'activity.agenda.enable' }).then(result => { if (!result.ok) throw new Error(result.error ?? '持续行动日程模式未启用。'); });
  }
  start(): void { if (this.agendaDriven || this.closed || this.timer) return; this.timer = setInterval(() => { void this.tick(); }, 1000); this.timer.unref(); void this.tick(); }
  async tick(): Promise<void> {
    if (this.agendaDriven || this.closed || this.ticking) return;
    this.ticking = (async () => {
      while (!this.agendaDriven && !this.closed && this.jobs.size < 20) {
        const excludedReports = [...new Set([...this.options.excludedIds(), ...[...this.jobs.values()].map(job => job.companionId)])];
        const reporting = await this.options.request({ type: 'activity.report.claim', excludedIds: excludedReports });
        if (reporting.activityReport && reporting.activityTask) {
          const controller = new AbortController(), key = 'report_' + reporting.activityReport.id;
          const promise = this.reportStep(reporting, controller.signal).catch(this.options.report).finally(() => { this.jobs.delete(key); this.options.changed(); });
          this.jobs.set(key, { companionId: reporting.activityTask.companionId, controller, promise }); continue;
        }
        const intent = (await this.options.request({ type: 'activity.memory.claim' })).activityMemoryIntent;
        if (intent) {
          const controller = new AbortController();
          const promise = this.memoryStep(intent, controller.signal).catch(this.options.report).finally(() => { this.jobs.delete(intent.id); this.options.changed(); });
          this.jobs.set(intent.id, { companionId: intent.companionId, controller, promise });
          continue;
        }
        const excludedIds = [...new Set(this.options.excludedIds())];
        const task = (await this.options.request({ type: 'activity.claim', excludedIds })).activityTask;
        if (!task?.leaseToken || this.closed) break;
        const controller = new AbortController();
        const promise = this.step(task, controller.signal).catch(this.options.report).finally(() => { this.jobs.delete(task.id); this.options.changed(); });
        this.jobs.set(task.id, { companionId: task.companionId, controller, promise });
        this.options.changed();
      }
    })().catch(this.options.report).finally(() => { this.ticking = undefined; });
    await this.ticking;
  }
  /** One actual child phase only. Native arrival/reply/model waits remain in
   * SQLite and release the agenda root instead of retaining this processor. */
  async runAgendaQuantum(parent: CompanionActivityAgendaParent, signal: AbortSignal,
    onPhase?: (phase: CompanionActivityAgendaPhase, task: CompanionActivityTask) => Promise<void>): Promise<{ task: CompanionActivityTask; phase: CompanionActivityAgendaPhase }> {
    await this.setAgendaDriven(); signal.throwIfAborted();
    if (this.closed || this.jobs.has(parent.id)) throw new Error('该持续行动已有执行或服务已停止，未重复认领。');
    const read = async () => {
      const response = await this.options.request({ type: 'activity.agenda.get', companionId: parent.companionId, id: parent.id });
      if (!response.ok || !response.activityTask || response.activityTask.id !== parent.id || response.activityTask.companionId !== parent.companionId)
        throw new Error(response.error ?? '持续行动没有返回准确本人回执。');
      return response.activityTask;
    };
    const original = await read();
    if (original.historyAvailable === false) throw new Error('持续行动来源已撤回，旧目标不再执行。');
    const controller = new AbortController(), effective = AbortSignal.any([signal, controller.signal]);
    let phase: CompanionActivityAgendaPhase = 'waiting', failure: unknown;
    const promise = (async () => {
      if (original.reportPending) {
        phase = 'report'; await onPhase?.(phase, original);
        const report = await this.options.request({ type: 'activity.report.claim', ...parent, excludedIds: this.options.excludedIds() });
        if (!report.ok) throw new Error(report.error ?? '本次报告步骤未获准确认领。');
        if (report.activityReport && report.activityTask) await this.reportStep(report, effective);
      } else if (original.memoryIntentId) {
        phase = 'memory'; await onPhase?.(phase, original);
        const response = await this.options.request({ type: 'activity.memory.claim', companionId: parent.companionId, taskId: parent.id,
          agendaRunId: parent.agendaRunId, agendaLeaseToken: parent.agendaLeaseToken });
        if (!response.ok) throw new Error(response.error ?? '本次记忆步骤未获准确认领。');
        if (response.activityMemoryIntent) await this.memoryStep(response.activityMemoryIntent, effective);
      } else if (!['succeeded', 'failed', 'cancelled'].includes(original.status)) {
        const response = await this.options.request({ type: 'activity.claim', ...parent, excludedIds: this.options.excludedIds() });
        if (!response.ok) throw new Error(response.error ?? '本次行动步骤未获准确认领。');
        if (response.activityTask?.leaseToken) {
          if (response.activityTask.id !== parent.id || response.activityTask.agendaRunId !== parent.agendaRunId || response.activityTask.agendaLeaseToken !== parent.agendaLeaseToken)
            throw new Error('持续行动认领没有绑定当前准确父租约。');
          phase = 'planning'; await onPhase?.(phase, response.activityTask); await this.step(response.activityTask, effective);
        }
      }
    })();
    this.jobs.set(parent.id, { companionId: parent.companionId, controller, promise });
    try { await promise; effective.throwIfAborted(); return { task: await read(), phase }; }
    catch (error) { failure = error; throw error; }
    finally {
      this.jobs.delete(parent.id); this.options.changed();
      if (effective.aborted || failure) await this.options.request({ type: 'activity.agenda.release', ...parent, action: 'pause' }).catch(this.options.report);
    }
  }
  private async memoryStep(intent: CompanionActivityMemoryIntent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.options.excludedIds().includes(intent.companionId)) throw new Error('伙伴当前暂停，旧记忆步骤稍后退役。');
    // An old durable proposal is audit history, not permission to restore the
    // retired actor memory channel. Record failure and let the same task plan
    // its next step; never claim that a search/write or the goal completed.
    const result = await this.options.request({ type: 'activity.memory.fail', id: intent.id, leaseToken: intent.leaseToken,
      error: JSON.stringify({ ok: false, code: 'COMPANION_MEMORY_AUTOMATIC_ONLY',
        error: '伙伴记忆操作已退役，本步骤未执行。继续使用本任务系统自动召回的资料。' }) });
    if (!result.ok) throw new Error(result.error ?? '旧记忆步骤尚未成功退役。');
  }
  private async reportStep(claim: CompanionStorageResponse, signal: AbortSignal): Promise<void> {
    const ticket = claim.activityReport!, task = claim.activityTask!;
    try {
      const proof = captureCompanionExecutionReadset({ companionId: task.companionId, conversationId: task.conversationId }, {
        readsets: [ticket.executionReadset], sources: [...claim.activityMessages ?? [], ...claim.activityProgressEvidence?.outbound.map(item => item.message) ?? []]
          .map(message => ({ id: message.id, conversationId: message.conversationId, checksum: createHash('sha256').update(message.content).digest('hex') })) });
      if (!await verifyCompanionExecutionReadset(proof, task, { request: this.options.request, contextValid: this.options.memoryContextValid }))
        throw new CompanionModelError('INVALID_RESPONSE', '待报告结果的真实资料已变化，不能发布旧正文。');
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: task.conversationId })).state;
      const companion = state?.companions.find(role => role.id === task.companionId);
      if (!companion) throw new CompanionModelError('INVALID_RESPONSE', '待报告主体已经失效。');
      const correction = await reviewCompanionSocialProgress(task.stage, [task], await this.options.configFor(companion), signal,
        { fetchFn: this.options.fetchFn, timeoutMs: 30_000, requireReview: true, includeTerminal: true,
          names: state!.companions.map(role => ({ id: role.id, name: role.name })), replies: claim.activityMessages, outbound: claim.activityProgressEvidence });
      if (correction) throw new CompanionModelError('INVALID_RESPONSE', '待报告结果未获当前真实回执支持：' + correction);
      signal.throwIfAborted();
      if (!await verifyCompanionExecutionReadset(proof, task, { request: this.options.request, contextValid: this.options.memoryContextValid }))
        throw new CompanionModelError('INVALID_RESPONSE', '报告复核期间真实资料已变化，未发布。');
      await this.options.request({ type: 'activity.report.complete', id: ticket.id, leaseToken: ticket.leaseToken, executionReadset: proof });
    } catch (error) {
      if (!this.agendaDriven) await this.options.request({ type: 'activity.report.fail', id: ticket.id, leaseToken: ticket.leaseToken,
        error: (error instanceof Error ? error.message : '行动结果暂时不可报告。').slice(0, 1000),
        ...(error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE' ? { terminal: true } : {}) }).catch(() => undefined);
      if (this.agendaDriven) throw error;
    }
  }
  private async step(task: CompanionActivityTask, signal: AbortSignal): Promise<void> {
    const leaseToken = task.leaseToken!;
    try {
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: task.conversationId })).state;
      const companion = state?.companions.find(role => role.id === task.companionId);
      const conversation = state?.conversations.find(room => room.id === task.conversationId);
      if (!companion || !conversation) throw new Error('行动主体或会话不可访问。');
      const observed = await this.options.request({ type: 'activity.observe', id: task.id, leaseToken });
      if (!observed.ok || !observed.activityTask) throw new Error(observed.error ?? '行动观察没有返回有效任务。');
      const expectedStep = observed.activityTask.step;
      const planningState = observed.activityPlanningState;
      if (planningState && !await verifyCompanionKnowledgeReads(planningState.knowledgeReads, task, command => this.options.request(command)))
        throw new Error('完整目标计划使用的资料或文件已变化，旧计划不能继续执行。');
      const source = task.sourceMessageId ? (await this.options.request({ type: 'memory.sources.filter', companionId: task.companionId,
        conversationId: task.conversationId, ids: [task.sourceMessageId] })).memorySources?.find(message => message.id === task.sourceMessageId) : undefined;
      if (task.sourceMessageId && !source) throw new Error('行动委托来源已经撤回。');
      const profiles = await this.options.profiles({ companionId: companion.id, conversation, audience: 'peers' });
      const [latestState, latestCharacter] = await Promise.all([
        this.options.request({ type: 'state.get', companionId: companion.id, conversationId: conversation.id }),
        this.options.request({ type: 'character.development', companionId: companion.id, conversationId: conversation.id, limit: 12 }).catch(error => { this.options.report(error); return undefined; }),
      ]);
      const runtimeState = companionVisibleRuntimeState(latestState.runtimeState, companion.id, conversation);
      const activeCharacterIds = state!.companions.filter(role => role.active).map(role => role.id);
      const resourceBounds = companionRoleResourceBounds({ ownerId: companion.id, activeCharacterIds,
        ...(observed.activityGameRoom && observed.topic ? { game: { conversation: { id: observed.activityGameRoom.conversationId,
          memberIds: observed.activityGameRoom.memberIds }, topic: observed.topic } } : {}) });
      const characterDevelopment = currentCompanionCharacterDevelopment(latestCharacter?.characterDevelopment, companion.id, conversation.id);
      let snapshot = observed.activityPassiveRecall;
      let memory: CompanionStorageResponse | undefined;
      if (!snapshot) {
        const query = { companionId: companion.id, conversationId: conversation.id, query: task.goal, limit: 8 };
        memory = await (this.options.passiveRecall ? this.options.passiveRecall(query, signal)
          : this.options.request({ type: 'memory.search', ...query })).catch(error => {
          if (signal.aborted) throw error;
          this.options.report(error); return undefined;
        });
        signal.throwIfAborted();
        const saved = await this.options.request({ type: 'activity.passive.prepare', id: task.id, leaseToken, expectedStep,
          snapshot: { prepared: true, ...(memory?.memoryContext ? { context: memory.memoryContext } : {}),
            ...(memory?.memoryRetrieval?.authorizedCorpusEmpty === true && memory.memoryPage?.items.length === 0 && !memory.memoryPage.hasMore
              ? { authorizedCorpusEmpty: true, authorizedCorpusRevision: memory.memoryRetrieval.authorizedCorpusRevision } : {}) } });
        if (!saved.ok || !saved.activityPassiveRecall) throw new Error(saved.error ?? '持续任务的被动回忆快照未保存。');
        snapshot = saved.activityPassiveRecall;
      }
      if (snapshot.context && this.options.memoryContextValid && !await this.options.memoryContextValid(task, snapshot.context))
        throw new ActivityPassiveRecallWithdrawnError('原回忆所用的真实资料已经变化或撤回，本持续任务已停止；实际步骤与回执仍保留。可根据当前获权资料重新建立任务。');
      const recall = companionRecallCapabilities(this.options.request, { companionId: companion.id, conversationId: conversation.id });
      const emptyMemoryCorpus = snapshot.authorizedCorpusEmpty === true;
      let executionReadset: CompanionExecutionReadset | undefined;
      let topicModeratorTransferApproval: CompanionTopicModeratorTransferApproval | undefined;
      // A frozen empty result is still the task's completed automatic recall.
      // Current replies and world observations remain separate live inputs.
      const recalledCapabilities = recall;
      let capabilities = this.options.think ? companionThoughtCapabilities(recalledCapabilities, {
        run: async (proposal, effectId, nativeSignal) => {
          if (!executionReadset) throw new Error('当前思考实际读集不可用。');
          return this.options.think!({ taskId: task.id, leaseToken, expectedStep, effectId,
            observationFingerprint: companionActivitySocialObservationFingerprint(observed.activityMessages ?? []),
            executionReadset, ...proposal }, nativeSignal);
        }, ...(this.options.readThought ? { read: (query: DshRecordQuery, nativeSignal?: AbortSignal) => this.options.readThought!({
          taskId: task.id, companionId: companion.id, conversationId: conversation.id, query }, nativeSignal) } : {}),
      }) : recalledCapabilities;
      capabilities = this.options.browserCapabilities?.({ companionId: companion.id, conversationId: conversation.id }, capabilities) ?? capabilities;
      const modelConfig = await this.options.configFor(companion);
      const output = await runCompanionStructuredAgent({
        responseSchema: activityAgentDecisionSchema,
        finalSchema: activityDecisionJsonSchema(),
        evidenceScope: {},
        observeReadset: readset => {
          // A durable task explicitly reads current host material at every
          // step. Its original human sequence is authority, not a permanent
          // cutoff for newly acquired note versions or actual peer replies.
          executionReadset = captureCompanionExecutionReadset({ companionId: task.companionId, conversationId: task.conversationId }, { readsets: [readset], sources: [
              ...observed.activityMessages ?? [], ...observed.activityProgressEvidence?.outbound.map(item => item.message) ?? [],
            ].map(message => ({ id: message.id, conversationId: message.conversationId, checksum: createHash('sha256').update(message.content).digest('hex') })) });
        },
        finalObservationFingerprint: companionActivitySocialObservationFingerprint(observed.activityMessages ?? []),
        reviseFinal: async rejection => {
        const result = await this.options.request({ type: 'agent.run.revise_final', companionId: task.companionId, id: rejection.runId,
          expectedRevision: rejection.expectedRevision, activityTaskId: task.id, leaseToken, expectedStep,
          turnStep: rejection.step, proposalChecksum: rejection.proposalChecksum, reason: rejection.reason,
          ...(rejection.hostObservation ? { hostObservation: rejection.hostObservation } : {}) });
        if (!result.ok) throw new Error(result.error ?? '原活动任务不再允许修订未执行的最终提案。');
        return result.agentRun;
      }, validateOutput: async value => {
        topicModeratorTransferApproval = undefined;
        const decision = parseCompanionActivityDecision(value), operation = decision.topic as Record<string, unknown> | undefined;
        const feasible = await reviewCompanionActivityFeasibility({ task: observed.activityTask!, originalSource: source, resourceBounds,
          topic: observed.topic, shared: observed.topicState?.shared, previousPlan: planningState, decision,
          actualMessages: observed.activityMessages ?? [] }, await this.options.configFor(companion), signal,
          { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
        if (!feasible.allowed) throw new Error('本步计划与实际资源不一致，提案尚未保存或执行：' + feasible.reason
          + ' 依据当前真实资料自行修订模型原先的方案；planningState.constraints是模型提议，只有originalRequest中的限制才是原真人硬约束。');
        if (operation?.action === 'update' || operation?.action === 'transfer_moderator') {
          const currentTask = observed.activityTask!;
          const ports = [currentTask.gamePort, currentTask.peerTopicId ? { conversationId: currentTask.peerConversationId!, topicId: currentTask.peerTopicId } : undefined,
            source?.topicId ? { conversationId: source.conversationId, topicId: source.topicId } : undefined];
          const matches = [...new Map(ports.filter(port => !!port && port.topicId === operation.topicId
            && (!operation.roomId || port.conversationId === operation.roomId)).map(port => [port!.topicId, port!])).values()];
          if (matches.length !== 1) throw new Error('话题修改必须使用本任务实际绑定的唯一端口；提案未执行。');
          const { action: _action, roomId: _roomId, ...parameters } = operation; void _action; void _roomId;
          const command = { ...parameters, type: `topic.${operation.action}`, conversationId: matches[0]!.conversationId,
            readerId: task.companionId, operationId: `activity_${task.id}_${expectedStep}` };
          if (operation.action === 'transfer_moderator') topicModeratorTransferApproval = await reviewCompanionTopicModeratorTransfer({
            command: command as CompanionTopicModeratorTransfer, request: command => this.options.request(command) },
          await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
          else {
            const review = await reviewCompanionGameSharedUpdate({ command: command as CompanionGameTopicUpdate, request: command => this.options.request(command), source },
              await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
            if (!review.allowed) throw new Error('共享话题提案未写入：' + (review.reason ?? '公开字段含未获准共享的游戏秘密，请修订并把秘密留在正确私态。'));
          }
        }
        if (decision.status === 'complete' && (observed.activityTask!.gamePort || task.peerResponsibility && observed.topic?.kind === 'game')) {
          const review = await reviewCompanionGameGoalCompletion({ task: observed.activityTask!, originalSource: source,
            topic: observed.topic, topicState: observed.topicState, messages: observed.activityMessages ?? [], planningState },
            await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
          if (!review.allowed) throw new Error('完整目标尚未标记完成：' + (review.reason ?? '真实结算与归档凭证不足，请按实际进展继续。'));
        }
        if (decision.status !== 'continue' && source) {
          const correction = await reviewCompanionSocialProgress(decision.summary, [observed.activityTask!], await this.options.configFor(companion), signal,
            { fetchFn: this.options.fetchFn, timeoutMs: 30_000, includeTerminal: true,
              requireReview: true,
              names: state!.companions.map(role => ({ id: role.id, name: role.name })), replies: observed.activityMessages,
              outbound: observed.activityProgressEvidence });
          if (correction) throw new Error('本任务最终报告尚未发送：' + correction);
        }
        return decision;
      }, frame: { companion, conversation, messages: [], memories: snapshot.context ? [] : memory?.memoryPage?.items.map(hit => hit.memory) ?? [],
        resourceBounds,
        sourceMessage: source,
        memoryRecall: { reasons: [], pending: false, degraded: false, ...(snapshot.context ? { context: snapshot.context } : {}) },
        proactive: true, audience: 'peers', runtimeState, characterDevelopment, publicProfiles: profiles.publicProfiles,
        invocation: companionTaskInvocation({ companion, conversationId: conversation.id, id: `${task.id}_${expectedStep}${this.agendaDriven ? '_agenda_' + (task.agendaCycle ?? 0) : ''}`, kind: 'activity',
          goal: task.goal, createdAt: task.createdAt, source }) },
        capabilities,
        context: { system: companionBehaviorSystem(modelConfig, 'activity_task_step', `【宿主持续活动合同】当前self仅执行task真实目标和原授权限制；executionContract/resourceBounds/实际成员与本入口schema决定可用提案，不从角色文件扩权。无现实电脑授权，不替其他人参加或改变私态。
${COMPANION_WORLD_PERCEPTION_RULES}
每轮严格返回outputSchema，status=continue/complete/blocked均需summary；action/topic/wait等字段仅是宿主核验前的提案。长期记忆已在任务开始时由系统自动召回一次，本次不提供memory提案或个人经历回顾，不补搜、重建或等待回忆。history的host_receipt只证明对应真实操作；model_summary不是执行事实，wait_registered不证明后续事件已发生。已确认作用不能重发；summary只据实际来源/位置/成果，不把提案或正常退出说成完成。`, companion),
        user: JSON.stringify({ purpose: 'activity_task_step', executionContract: { ownerId: companion.id, persistentGoal: true,
          finalOutputShape: COMPANION_ACTIVITY_FINAL_CONTRACT,
          soleActorIsNotSoleRecipient: true, canContactGoalRecipients: true, canCreateAcquaintanceGroup: true,
          canWaitForReplies: true, canWaitForVirtualDelay: true, waitingDoesNotRequirePlayerSchedule: true,
          resourceBounds,
          actionEffect: 'Only host commit receipts prove execution; proposals and queued retries do not.',
          authority: 'Own virtual character and this original goal only; cannot decide for other members or operate the real computer.' },
        memoryContext: snapshot.context?.text, memoryAvailability: emptyMemoryCorpus ? {
          authorizedCorpusEmpty: true, revision: snapshot.authorizedCorpusRevision,
          notice: '本任务首次准备时获权VCP日记为空，自动回忆已完成且任务内保持固定。实时话题、回信、历史和持续计划仍会更新；不再发起记忆查询，不把空回忆当作整个任务已经完成。' } : undefined,
        planningState, runtimeState, runtimeBehavior: runtimeState ? companionRuntimeBehavior(runtimeState) : undefined, characterDevelopment,
          gameTopic: observed.topic ? { topic: observed.topic, ownState: observed.topicState } : undefined,
          activityPortCandidate: observed.activityPortCandidate,
          task: { ...observed.activityTask, history: observed.activityTask?.history.slice(-12).map(original => {
            const item = projectCompanionActivityHistoryEntry(original);
            if (!['message', 'introduce', 'create_group'].includes(item.action)) return item;
            try { const receipt: unknown = JSON.parse(item.result); return { ...item, result: JSON.stringify(companionModelPhoneReceipt(receipt) ?? receipt) }; }
            catch { return item; }
          }), earlierStepCount: Math.max(0, (observed.activityTask?.step ?? 0) - 12) }, verifiedOutbound: observed.activityProgressEvidence,
          originalRequest: source ? { authorId: source.authorId, content: source.content } : undefined, world: companionModelWorld(observed.world, companion.id),
          recentPeerMessages: observed.activityMessages?.map(message => ({ id: message.id, authorId: message.authorId, conversationId: message.conversationId,
            goalReplyOrigin: observed.activityMessageOrigins?.find(origin => origin.messageId === message.id),
            sequence: message.sequence, topicId: message.topicId, content: message.content.slice(0, 2000), originalChars: message.content.length, truncated: message.content.length > 2000 })), contacts: state!.companions.filter(role => role.id === companion.id || observed.world?.perception?.visibleCompanionIds.includes(role.id)).map(role => ({ id: role.id, name: role.name, active: role.active })),
          publicProfiles: profiles.publicProfiles, outputSchema: activityDecisionJsonSchema() }) } },
      modelConfig, signal, { fetchFn: this.options.fetchFn, timeoutMs: 60_000, visualInputs: profiles.visualInputs });
      const decision = activityAgentDecisionSchema.parse(output);
      if (signal.aborted || this.closed) return;
      const savedPlan = await this.options.request({ type: 'activity.plan.save', id: task.id, leaseToken, expectedStep,
        sourceDigest: createHash('sha256').update(source?.content ?? task.goal).digest('hex') });
      if (!savedPlan.ok || !savedPlan.activityPlanningState) throw new Error(savedPlan.error ?? '完整目标计划未保存，未执行提案。');
      if (!await verifyCompanionKnowledgeReads(savedPlan.activityPlanningState.knowledgeReads, task, command => this.options.request(command)))
        throw new Error('本步计划使用的资料或文件已变化，未执行提案。');
      if ((!source || task.peerResponsibility) && decision.action && ['message', 'social', 'introduce', 'create_group'].includes(decision.action.action)) {
        const action = decision.action;
        if (action.action !== 'message' && action.action !== 'social' && action.action !== 'introduce' && action.action !== 'create_group') throw new Error('联系动作无效。');
        const recipientIds = action.action === 'introduce' ? [action.targetCompanionId] : action.action === 'social' ? action.recipientIds ?? [action.targetCompanionId!] : action.recipientIds;
        const game = source && task.peerResponsibility ? await resolveCompanionGameInitiativeContext(command => this.options.request(command), {
          scope: task, source, recipientIds }) : undefined;
        const allowed = await authorizeCompanionSocialInitiative({ companion, text: action.text,
          recipients: state!.companions.filter(role => recipientIds.includes(role.id)), privateSources: [...source ? [source] : [], ...observed.activityMessages ?? []],
          ...(game ? { game } : {}), ...(source && task.peerResponsibility ? { acceptedResponsibility: { source, goal: task.goal } } : {}) },
        await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
        if (!allowed) { await this.options.request({ type: 'activity.reject', id: task.id, leaseToken, expectedStep, action,
          reason: '这一步没有发送：自主社交只能使用自己的虚拟问候和邀约，不能转发私聊或扩大现实权限。' }); return; }
      }
      if (source && !task.peerResponsibility && decision.action && ['message', 'social', 'visit', 'introduce', 'create_group'].includes(decision.action.action)) {
        const action = decision.action;
        if (action.action !== 'message' && action.action !== 'social' && action.action !== 'visit' && action.action !== 'introduce' && action.action !== 'create_group') throw new Error('联系动作无效。');
        const recipients = action.action === 'message' || action.action === 'create_group' ? action.recipientIds : action.action === 'visit' || action.action === 'introduce' ? [action.targetCompanionId] : action.recipientIds ?? [action.targetCompanionId!];
        const currentTask = observed.activityTask ?? task;
        if (currentTask.visitTargetId) {
          // This target was authorized once when the real player visit was bound.
          // Ordinary follow-up speech uses a separate peer-only composer, never
          // the private planner's draft or a fresh classification of the old ask.
          if (recipients.length !== 1 || recipients[0] !== currentTask.visitTargetId) {
            await this.options.request({ type: 'activity.reject', id: task.id, leaseToken, expectedStep, action,
              reason: '这一步没有发送：收件人超出了已绑定的拜访对象，请继续原目标，不联系无关对象。' }); return;
          }
          if (action.action === 'visit') action.reason = '想来找你坐坐，方便吗？';
          else {
            const target = state!.companions.find(role => role.id === currentTask.visitTargetId);
            if (!target || !observed.world) throw new Error('拜访对象或实际观察不可访问。');
            const peerConversationId = observed.activityMessages?.[0]?.conversationId;
            const peerCharacter = peerConversationId ? await this.options.request({ type: 'character.development', companionId: companion.id, conversationId: peerConversationId, limit: 12 })
              .catch(error => { this.options.report(error); return undefined; }) : undefined;
            const text = await generateCompanionVisitSpeech({ companion, target: { id: target.id, name: target.name }, runtimeState,
              characterDevelopment: peerConversationId ? currentCompanionCharacterDevelopment(peerCharacter?.characterDevelopment, companion.id, peerConversationId) : undefined,
              channel: action.action === 'social' ? 'face_to_face' : 'phone', task: currentTask, world: observed.world,
              messages: observed.activityMessages ?? [], peerConversationId, ...profiles }, await this.options.configFor(companion), signal,
            { fetchFn: this.options.fetchFn, timeoutMs: 30000 });
            if (text === null) {
              await this.options.request({ type: 'activity.reject', id: task.id, leaseToken, expectedStep, action,
                reason: '这一步没有发送：当前来往没有需要补充的新话。根据实际位置和已完成交流重新判断目标，不重复寒暄。' }); return;
            }
            action.text = text;
          }
        } else {
          const game = await resolveCompanionGameContactContext(command => this.options.request(command), {
            scope: { companionId: task.companionId, conversationId: task.conversationId }, source, recipientIds: recipients, turns: [],
            delivery: { channel: action.action === 'social' ? 'face_to_face' : 'phone',
              ...(action.action === 'message' ? { roomId: action.roomId, topicId: action.topicId } : {}) },
          });
          const contact = await authorizeCompanionContact({ source, actor: { id: companion.id, name: companion.name }, text: action.action === 'visit' ? action.reason : action.text,
            recipients: state!.companions.filter(role => recipients.includes(role.id)).map(role => ({ id: role.id, name: role.name, active: role.active })),
            ...(game ? { game } : {}) },
          await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn, timeoutMs: 30_000 });
          if (!contact.allowed || action.action === 'visit' && contact.intent !== 'visit') { await this.options.request({ type: 'activity.reject', id: task.id, leaseToken, expectedStep, action,
            reason: ('这一步没有发送：' + (contact.reason ?? '拟发内容或收件人超出原联系范围。请根据真实目标改写自己的必要问候，不转发玩家私人信息。') + ' 原任务仍保留。').slice(0, 2000) }); return; }
          if (contact.intent === 'visit' && recipients.length === 1 && action.action !== 'social' && action.action !== 'create_group') {
            if (signal.aborted || this.closed) return;
            await this.options.request({ type: 'activity.visit.ensure', companionId: task.companionId, conversationId: task.conversationId,
              sourceMessageId: source.id, targetId: recipients[0]! });
          }
        }
      }
      if (signal.aborted || this.closed) return;
      if (!executionReadset || !await verifyCompanionExecutionReadset(executionReadset, task, { request: this.options.request,
        contextValid: this.options.memoryContextValid }))
        throw new Error('行动提案所依据的真实资料已经变化，未提交。');
      const committed = await this.options.request({ type: 'activity.commit', id: task.id, leaseToken, expectedStep, decision, executionReadset,
        ...(topicModeratorTransferApproval ? { topicModeratorTransferApproval } : {}) });
      if (!this.agendaDriven && committed.activityTask && ['succeeded', 'failed', 'cancelled'].includes(committed.activityTask.status)) {
        const reporting = await this.options.request({ type: 'activity.report.claim', id: task.id, excludedIds: this.options.excludedIds() });
        if (reporting.activityReport && reporting.activityTask) await this.reportStep(reporting, signal);
      }
    } catch (error) {
      if (!signal.aborted && !this.closed) await this.options.request({ type: 'activity.fail', id: task.id, leaseToken,
        terminal: error instanceof ActivityPassiveRecallWithdrawnError || error instanceof CompanionAgentNoProgressError || error instanceof CompanionAgentFinalValidationError
          || error instanceof CompanionModelError && (error.code === 'CONTEXT_CAPACITY' || error.diagnostic === 'structured_repair_exhausted'),
        error: error instanceof Error ? error.message.slice(0, 1000) : '行动规划暂时不可用。' }).catch(() => undefined);
      if (this.agendaDriven) throw error;
    }
  }
  cancel(id: string): void { this.jobs.get(id)?.controller.abort(); }
  cancelCompanion(id: string): void { for (const job of this.jobs.values()) if (job.companionId === id) job.controller.abort(); }
  async drainCompanion(id: string): Promise<void> { await this.ticking; this.cancelCompanion(id); await Promise.allSettled([...this.jobs.values()].filter(job => job.companionId === id).map(job => job.promise)); }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearInterval(this.timer); for (const job of this.jobs.values()) job.controller.abort(); await this.ticking; await Promise.allSettled([...this.jobs.values()].map(job => job.promise)); }
}

/** Keep durable task history bounded, parseable, and tied to every source it contains. */
export function activityMemoryReceipt(result: CompanionStorageResponse): {
  result: string; sourceMessageIds: string[]; noteVersions: Array<{ id: string; version: number }>;
} {
  const notes = [...new Map([...(result.memories ?? []), ...(result.memoryRead ? [result.memoryRead.memory] : []),
    ...(result.memoryPage?.items.map(hit => hit.memory) ?? [])].map(note => [note.id, note])).values()];
  const sources = new Set<string>();
  const included: typeof notes = [];
  const payload: { ok: boolean; memories: unknown[]; sources: unknown[]; truncated: boolean; hasMore: boolean } = {
    ok: result.ok, memories: [], sources: [], truncated: false, hasMore: result.memoryPage?.hasMore ?? false,
  };
  for (const note of notes) {
    const nextSources = new Set([...sources, ...note.sources.map(source => source.messageId),
      ...(note.procedure?.validation.evidence.map(receipt => receipt.sourceMessageId) ?? [])]);
    if (nextSources.size > 100 || included.length >= 100) { payload.truncated = true; continue; }
    const entry = { id: note.id, companionId: note.companionId, version: note.version, contentRevision: note.contentRevision, content: note.content.slice(0, 2000),
      contentTruncated: note.content.length > 2000, tags: note.tags, sourceMessageIds: note.sources.map(source => source.messageId),
      ...(note.procedure ? { procedure: note.procedure } : {}) };
    payload.memories.push(entry);
    if (JSON.stringify(payload).length > 14000) { payload.memories.pop(); payload.truncated = true; continue; }
    included.push(note); for (const id of nextSources) sources.add(id);
    if (entry.contentTruncated) payload.truncated = true;
  }
  // Original LightMemo/RAG context is revision-bound and deliberately not persisted in a task's history.
  for (const source of result.memoryRead?.sources ?? []) {
    if (!sources.has(source.id)) continue;
    const entry = { id: source.id, content: source.content.slice(0, 2000), contentTruncated: source.content.length > 2000 };
    payload.sources.push(entry);
    if (JSON.stringify(payload).length > 15500) { payload.sources.pop(); payload.truncated = true; break; }
  }
  return { result: JSON.stringify(payload), sourceMessageIds: [...sources], noteVersions: included.map(note => ({ id: note.id, version: note.version })) };
}
