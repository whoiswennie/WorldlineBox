import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation, CompanionMessage, CompanionState } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorldJob, CompanionWorldScope, CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionModelConfig } from './model';
import type { CompanionMemoryRecall, CompanionMemoryService } from './memory-service';
import { CompanionModelError } from './model';
import { generateCompanionWorldDecision } from './world-model';
import { companionAutomaticMaintenanceSeeds, generateCompanionMemoryDream, generateCompanionMemoryMaintenance } from './memory-model';
import { generateCompanionDreamNarrative } from './dream-wave-model';
import { CompanionOptionalDreamError } from './optional-dream-error';
import { validateCompanionMemoryProhibitions } from './memory-model';
import type { VcpMemoryDreamWaveResult, VcpMemoryDreamClock } from '../vcp-memory/dream-contracts';
import { CompanionAgentNoProgressError } from './agent-kernel';
import type { CompanionSocialJob, CompanionSocialNotification } from '../../shared/companion-social';
import { authorizeCompanionSocialInitiative, generateCompanionSocialReply } from './social-model';
import { buildCompanionSocialNotification } from './social-notification-model';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';
import { COMPANION_SLEEP_DREAM_CONCURRENCY } from '../../shared/companion-sleep';
import { companionRecallCapabilities } from './structured-agent';
import { companionTopicCapabilities } from './topic-capabilities';
import { reviewCompanionGameSharedUpdate } from './game-topic-privacy';
import { reviewCompanionTopicModeratorTransfer } from './topic-moderator-transfer';
import { resolveCompanionGameInitiativeContext, loadCompanionGameCommunication } from './game-contact-context';
import { companionSocialCapabilities } from './social-capabilities';
import { ensureTopicContinuity } from './topic-compaction';
import { COMPANION_DIALOGUE_WINDOW } from './context-window';
import type { CompanionReplyInput } from './context';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { verifyCompanionExecutionReadset } from './execution-evidence';
import { companionRoleResourceBounds } from './role-resource-context';
import { companionThoughtCapabilities } from './thought-capabilities';
import type { DshRecordQuery } from '../../shared/dsh-task-record';

import type { CompanionBrowserExtension } from './browser-capabilities';
interface WorldServiceOptions {
  browserCapabilities?: CompanionBrowserExtension;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(companion: Companion): Promise<CompanionModelConfig>;
  fetchFn: typeof fetch;
  changed(): void;
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
  dreamWave?(input: CompanionWorldScope & { now: string; clockDomain: VcpMemoryDreamClock }): Promise<VcpMemoryDreamWaveResult>;
  think?(input: Omit<Extract<CompanionStorageCommand, { type: 'peer.thought.create' }>, 'type'>, signal?: AbortSignal): Promise<unknown>;
  readThought?(input: { jobId: string; companionId: string; conversationId: string; query: DshRecordQuery }, signal?: AbortSignal): Promise<unknown>;
}

/** Physics and reservations keep ticking while semantic decisions run separately. */
export class CompanionWorldService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController; companionId: string;
    kind: 'dream' | 'other'; worldJob?: CompanionWorldJob }>();
  private closed = false;
  constructor(private readonly options: WorldServiceOptions) {}
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
      await this.options.tickLife?.();
      this.options.wakeWaiting();
      if (this.closed) return;
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
          excludedCompanionIds: [...new Set([...this.jobs.values()].map(job => job.companionId))] })).worldJob;
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
  async ready(input: CompanionWorldScope & { workId: string; kind: 'chat' | 'action' | 'schedule' | 'learning'; sourceMessageId?: string;
    urgent?: boolean; fixed?: boolean; learningGrantId?: string; learningLeaseToken?: string;
    authorizationGrantId?: string; invocationId?: string }, signal?: AbortSignal, onWaiting?: (reason: string) => void | Promise<void>): Promise<void> {
    if (signal?.aborted || this.closed) throw cancelled();
    try {
      let work = (await this.options.request({ type: 'world.work.begin', ...input })).worldWork;
      this.options.changed();
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
    await this.options.request({ type: 'world.work.end', companionId, workId }); this.options.changed();
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
      this.options.changed();
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
      const port = await loadPort(), sources = port.messages;
      const gameCommunication = await loadCompanionGameCommunication(this.options.request, { job, source });
      const resources = async (current: CompanionState, currentPort: typeof port, game: typeof gameCommunication) => {
        const topic = game?.topic ?? currentPort.topic;
        const room = topic?.kind === 'game' ? current.conversations.find(room => room.id === topic.conversationId)
          ?? (await this.options.request({ type: 'state', includeHidden: true, conversationId: topic.conversationId })).state?.conversations.find(room => room.id === topic.conversationId) : undefined;
        return companionRoleResourceBounds({ ownerId: companion.id, activeCharacterIds: current.companions.filter(role => role.active).map(role => role.id),
          ...(room && topic ? { game: { conversation: room, topic } } : {}) });
      };
      const resourceBounds = await resources(state!, port, gameCommunication);
      let executionReadset: CompanionExecutionReadset | undefined;
      const world = await this.observe(scope);
      if (!world) throw new Error('伙伴当前世界不可访问。');
      const routine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
      const config = await this.options.configFor(companion);
      await progress('memory', '正在回忆与这条来信有关的经历', { status: 'running' });
      let recalled: Partial<CompanionMemoryRecall> | undefined = this.options.recall ? await this.options.recall({ companion, conversation, messages: sources,
        currentMessage: source, beforeSequence: job.throughSequence, config, signal })
        : await this.options.request({ type: 'memory.search', ...scope, query: source.content.slice(0, 16000), limit: 8 })
          .then(response => ({ memories: response.memoryPage?.items.map(hit => hit.memory) ?? [], context: response.memoryContext }))
          .catch(error => { this.options.report(error); return undefined; });
      if (signal.aborted || this.closed) throw cancelled();
      await progress('thinking', '正在组织给伙伴的回应', { status: recalled?.degraded ? 'unavailable' : 'completed',
        count: recalled?.reasons?.length ?? recalled?.memories?.length ?? 0, injected: !!recalled?.context?.text.trim(), pending: recalled?.pending === true }, recalled);
      const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, sourceAuthorId: source.authorId, audience: conversation.peerOnly === false ? 'player' : 'peers' });
      const currentScope = { companionId: companion.id, conversationId: conversation.id };
      const [stateResponse, developmentResponse, latestWorld] = await Promise.all([
        this.options.request({ type: 'state.get', ...currentScope }),
        this.options.request({ type: 'character.development', ...currentScope, limit: 12 }), this.observe(currentScope),
      ]);
      const runtime = stateResponse.runtimeState;
      if (!latestWorld) throw new Error('伙伴最新世界状态不可访问。');
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
          return authorizeCompanionSocialInitiative({ companion, recipients, text: proposed.text, privateSources: sources, game }, config, actionSignal, { fetchFn: this.options.fetchFn });
        }, { ...(gameCommunication ? { gamePort: gameCommunication.gamePort }
          : port.topic?.kind === 'game' ? { gamePort: { conversationId: port.topic.conversationId, topicId: port.topic.id } } : {}),
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
      const result = await generateCompanionSocialReply({ companion, conversation, source, messages: sources, job, world: latestWorld, routine, ...profiles,
        topic: port.topic, topicState: port.topicState, gameCommunication, resourceBounds,
        memoryRecall: { ...recalled, reasons: recalled?.reasons ?? [], pending: recalled?.pending ?? false, degraded: recalled?.degraded ?? false },
        characterDevelopment: developmentResponse.characterDevelopment,
        memories: recalled?.memories ?? [], memoryContext: recalled?.context?.text,
        ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression, affect: runtime.affect } } : {}),
        members: state!.companions.filter(member => conversation.memberIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) },
      config, signal, { fetchFn: this.options.fetchFn,
        capabilities,
        observeReadset: async readset => {
          if (!await verifyCompanionExecutionReadset(readset, scope, { request: this.options.request,
            contextValid: this.options.memoryContextValid })) throw new Error('伙伴本轮实际读取的来源、游戏私态或记忆已撤回，不能发布或继续行动。');
          executionReadset = readset;
        },
        prepareFrame: async (frame: CompanionReplyInput) => {
          const [currentPort, currentState, validSource] = await Promise.all([loadPort(),
            this.options.request({ type: 'state', includeHidden: true, conversationId: conversation.id }),
            this.options.request({ type: 'memory.sources.filter', ...scope, ids: [source.id] })]);
          const currentSource = validSource.memorySources?.[0];
          if (!currentSource || currentSource.content !== source.content || currentSource.topicId !== source.topicId) throw new Error('本轮伙伴来信来源已经改变。');
          const owner = currentState.state?.companions.find(role => role.id === companion.id);
          if (!owner || owner.active === false) throw cancelled();
          if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, recalled?.context)) {
            recalled = this.options.recall ? await this.options.recall({ companion: owner, conversation, messages: currentPort.messages,
              currentMessage: currentSource, beforeSequence: job.throughSequence, config, signal })
              : await this.options.request({ type: 'memory.search', ...scope, query: currentSource.content.slice(0, 16000), limit: 8 })
                .then(response => ({ memories: response.memoryPage?.items.map(hit => hit.memory) ?? [], context: response.memoryContext }));
          }
          const currentGame = await loadCompanionGameCommunication(this.options.request, { job, source: currentSource });
          const next = { ...frame, companion: owner, ...currentPort, gameCommunication: currentGame,
            resourceBounds: await resources(currentState.state!, currentPort, currentGame),
            memories: recalled?.context ? [] : recalled?.memories ?? [], memoryRecall: { ...recalled, reasons: recalled?.reasons ?? [],
              pending: recalled?.pending ?? false, degraded: recalled?.degraded ?? false },
            invocation: frame.invocation ? { ...frame.invocation, messagePort: currentPort.joined
              ? { kind: 'conversation' as const } : { kind: 'invocation' as const, messageIds: [source.id] } } : undefined };
          return currentPort.joined ? ensureTopicContinuity({ frame: next, request: this.options.request, config,
            signal, fetchFn: this.options.fetchFn }) : next;
        } });
      const wait = Date.parse(job.typingNotBefore) - Date.now();
      await progress('waiting', '回应已准备好，正在核验并发送');
      if (wait > 0) await delay(wait, signal);
      if (signal.aborted || this.closed) throw cancelled();
      if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, recalled?.context)) {
        throw new Error('伙伴回忆来源已经变化，本轮发言将重新读取。');
      }
      if (!executionReadset || !await verifyCompanionExecutionReadset(executionReadset, scope,
        { request: this.options.request, contextValid: this.options.memoryContextValid })) throw new Error('伙伴交付使用的来源或游戏检查点已失效。');
      await this.options.request({ type: 'social.job.complete', id: job.id, leaseToken, text: result.text,
        executionReadset,
        memoryRecall: { reasons: recalled?.reasons ?? [], pending: recalled?.pending === true, degraded: recalled?.degraded === true,
          ...(recalled?.context ? { context: recalled.context } : {}) },
        ...(recalled?.context ? { expectedMemoryRevision: recalled.context.revision } : {}),
        ...(result.shareAddress ? { shareAddress: true } : {}),
        ...(result.nextRecipientId ? { nextRecipientId: result.nextRecipientId } : {}), ...(result.workOffer ? { workOffer: result.workOffer } : {}) });
      this.options.changed();
    } catch (error) {
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
      const config = await this.options.configFor(companion);
      if (kind === 'decision') {
        const routine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
        const memoryQuery = world.events.slice(-8).map(event => event.text).filter(Boolean).join('\n').slice(0, 4000)
          || '我自己的真实世界经历、实际学习过的资料，以及在这些经历中形成的个人认识、兴趣和价值判断';
        const memoryResponse = await this.options.request({ type: 'memory.search', ...scope,
          query: memoryQuery, limit: 8 }).catch(() => undefined);
        const memories = memoryResponse?.memoryPage?.items.map(hit => hit.memory) ?? [];
        const [runtimeResponse, developmentResponse, latestWorld] = await Promise.all([
          this.options.request({ type: 'state.get', ...scope }), this.options.request({ type: 'character.development', ...scope, limit: 12 }), this.observe(scope),
        ]);
        const runtime = runtimeResponse.runtimeState;
        if (!latestWorld) throw new Error('伙伴最新世界状态不可访问。');
        const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, audience: 'peers', directory: false,
          sourceAuthorId: world.events.findLast(event => event.targetId === companion.id && event.actorId !== companion.id)?.actorId });
        const decision = await generateCompanionWorldDecision({ companion, world: latestWorld, job, characterDevelopment: developmentResponse.characterDevelopment,
          memories, memoryContext: memoryResponse?.memoryContext?.text,
          ...profiles, routine, ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression,
            affect: runtime.affect, focus: runtime.focus, busy: world.works.some(work => work.companionId === companion.id && work.status !== 'ended') } } : {}),
          members: state!.companions.filter(member => member.id === companion.id || world.perception?.visibleCompanionIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) }, config, signal,
        { fetchFn: this.options.fetchFn, capabilities: companionRecallCapabilities(this.options.request, scope) });
        if (signal.aborted || this.closed) throw cancelled();
        if (this.options.memoryContextValid && !await this.options.memoryContextValid(scope, memoryResponse?.memoryContext)) {
          throw new Error('本轮回忆来源已经变化，世界决策将重新读取。');
        }
        const task = decision.task ?? (decision.action?.action === 'query' ? { title: '查询并核实世界资料',
          goal: `按需查询外部资料：${JSON.stringify(decision.action)}。查询动机：${decision.reason}。根据实际结果判断是否需要内化；如需记住，先搜索已有记忆，再引用查询凭证进行记录或整理。` } : undefined);
        if (task) {
          if (decision.task && decision.action) throw new Error('本轮只能创建持续行动目标或执行一个原子动作。');
        }
        await this.options.request({ type: 'world.job.complete', id: jobId, leaseToken, ...(decision.action && !task ? { action: decision.action } : {}),
          ...(task ? { activityTask: task } : {}),
          appraisals: decision.appraisals.map(({ quote: _quote, ...appraisal }) => { void _quote; return appraisal; }), sourceMemoryIds: memories.map(note => note.id),
          ...(memoryResponse?.memoryContext ? { expectedMemoryRevision: memoryResponse.memoryContext.revision } : {}) });
      } else await this.dream(job, leaseToken, companion, conversation, config, signal);
    } catch (error) {
      await this.options.request({ type: 'world.job.fail', id: jobId, leaseToken,
        error: error instanceof CompanionModelError || error instanceof CompanionAgentNoProgressError ? error.message : '伙伴世界认知暂未完成，稍后会继续。',
        ...(terminalInferenceFailure(error) ? { terminal: true } : {}) });
    }
  }
  private async dream(job: CompanionWorldJob, leaseToken: string, companion: Companion, conversation: CompanionConversation,
    config: CompanionModelConfig, signal: AbortSignal): Promise<void> {
    const scope = { companionId: companion.id, conversationId: conversation.id };
    const seedIds = new Set(job.sourceMemoryIds), maintenanceIds = new Set(job.maintenanceMemoryIds ?? job.sourceMemoryIds);
    const initialIds = [...new Set([...seedIds, ...maintenanceIds])];
    const reads = await Promise.all(initialIds.map(id => this.options.request({ type: 'memory.read', ...scope, id, sourceLimit: 100 })));
    const atoms = reads.flatMap(read => read.memoryRead?.memory ? [read.memoryRead.memory] : []).filter(memory => memory.status === 'indexed');
    if (atoms.length !== initialIds.length || reads.some(read => read.memoryRead?.hasMore)) throw new Error('本次睡眠整理的实际记忆已经变化或尚未完整读取。');
    const seedAtoms = atoms.filter(note => seedIds.has(note.id)), seedReads = reads.filter(read => seedIds.has(read.memoryRead!.memory.id));
    const maintenanceAtoms = atoms.filter(note => maintenanceIds.has(note.id)), maintenanceReads = reads.filter(read => maintenanceIds.has(read.memoryRead!.memory.id));
    let wave: VcpMemoryDreamWaveResult | undefined;
    let dreamComponentFailure: CompanionWorldJob['dreamComponentFailure'];
    const optionalFailure = (error: CompanionOptionalDreamError) => {
      if (signal.aborted || this.closed) throw cancelled();
      dreamComponentFailure = error.diagnostic;
      this.options.report(error);
    };
    if (job.dreamAllowed) {
      if (!this.options.dreamWave) optionalFailure(new CompanionOptionalDreamError('runtime_unavailable'));
      const world = await this.observe(scope);
      if (!world) throw new Error('睡眠的实际世界时钟不可访问。');
      if (this.options.dreamWave) try { wave = await this.options.dreamWave({ ...scope, now: world.clock.virtualNow, clockDomain: 'world' }); }
      catch (error) {
        if (!(error instanceof CompanionOptionalDreamError)) throw error;
        optionalFailure(error);
      }
      const stages = wave?.stages;
      const items = stages ? [...new Map([...stages.recent.seeds, ...stages.recent.resonanceL1, ...stages.recent.cascadeL2,
        ...stages.mid.seeds, ...stages.mid.cascadeL1, ...stages.deep.recalls].map(item => [item.id, item])).values()] : [];
      for (const item of items) {
        const read = await this.options.request({ type: 'memory.library.read', companionId: companion.id, id: item.id, sourceLimit: 100 });
        const note = read.memoryRead?.memory;
        if (!note || note.companionId !== companion.id || note.status !== 'indexed' || note.version !== item.version || read.memoryRead?.hasMore) throw new Error('梦境浪潮的真实来源已变化或尚未完整读取。');
        if (!atoms.some(seed => seed.id === note.id)) { reads.push(read); atoms.push(note); }
      }
    }
    if (signal.aborted || this.closed) throw cancelled();
    await this.options.request({ type: 'world.job.bind-memories', id: job.id, leaseToken,
      memoryVersions: atoms.map(note => ({ id: note.id, version: note.version })) });
    const sources = new Map<string, NonNullable<CompanionStorageResponse['message']>>();
    for (const read of reads) for (const message of read.memoryRead?.sources ?? []) sources.set(message.id, message);
    if (!atoms.length || !sources.size) {
      await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, sourceMemoryIds: [] }); return;
    }
    const prohibitions = await this.options.request({ type: 'memory.prohibitions', ...scope, worldJobId: job.id });
    const runtimeState = (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
    const characterDevelopment = (await this.options.request({ type: 'character.development', ...scope, limit: 12 })).characterDevelopment;
    const realSeedSources = new Map(seedReads.flatMap(read => read.memoryRead?.sources ?? []).map(source => [source.id, source]));
    // Real reflections see only their actual seed evidence. The invented dream
    // is generated separately and never becomes the reflection's input.
    const result = await generateCompanionMemoryDream({ companion, conversation, messages: [...realSeedSources.values()], relevantMemories: seedAtoms,
      runtimeState, characterDevelopment,
      dreamAllowed: job.dreamAllowed, reflectionOnly: true, maintenanceSeparated: true,
      prohibitions: prohibitions.memoryProhibitions,
      intent: '睡眠中只对本批真实种子经历、实际学习资料与有据主观认识作可追溯反思。不同入口的来源各保留实际域；无新反思时notes=[]。本调用不生成梦，任何虚构联想都不是本批知识或经历证据。' }, config, signal, { fetchFn: this.options.fetchFn });
    let dream: { text: string; relatedMemoryIds: string[]; sourceMessageIds: string[]; evidence: Array<{ sourceMessageId: string; quote: string }> } | undefined;
    if (wave) {
      let imagined: Awaited<ReturnType<typeof generateCompanionDreamNarrative>>;
      try {
        imagined = await generateCompanionDreamNarrative({ companion, wave }, config, signal, { fetchFn: this.options.fetchFn });
        if (imagined && !await validateCompanionMemoryProhibitions({ content: imagined.text, tags: ['梦境'], prohibitions: prohibitions.memoryProhibitions ?? [] }, config, signal, { fetchFn: this.options.fetchFn })) imagined = null;
      } catch (error) {
        if (!(error instanceof CompanionModelError) || error.code === 'CANCELLED' || signal.aborted || this.closed) throw error;
        imagined = null;
        optionalFailure(new CompanionOptionalDreamError('narrative_generation_failed'));
      }
      if (imagined) {
        const evidence = imagined.relatedMemoryIds.map(id => {
          const note = atoms.find(note => note.id === id)!;
          const source = note.sources.map(source => sources.get(source.messageId)).find(Boolean);
          if (!source) throw new Error('梦境依赖缺少可核验的本人真实来源。');
          return { sourceMessageId: source.id, quote: source.content.slice(0, 300) };
        });
        dream = { ...imagined, sourceMessageIds: [...new Set(evidence.map(item => item.sourceMessageId))], evidence };
      }
    }
    const maintenanceSeeds = companionAutomaticMaintenanceSeeds(maintenanceAtoms);
    const maintenanceSources = new Map(maintenanceReads.flatMap(read => read.memoryRead?.sources ?? []).map(source => [source.id, source]));
    const maintenance = maintenanceSeeds.length ? await generateCompanionMemoryMaintenance({ companion, conversation,
      messages: [...maintenanceSources.values()], relevantMemories: maintenanceSeeds, prohibitions: prohibitions.memoryProhibitions },
      config, signal, { fetchFn: this.options.fetchFn }) : undefined;
    if (signal.aborted || this.closed) throw cancelled();
    await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, ...(dream ? { dream } : {}),
      ...(dreamComponentFailure ? { dreamComponentFailure } : {}),
      expectedProhibitionRevision: prohibitions.memoryProhibitionRevision,
      ...(result.stateProposal ? { stateProposal: result.stateProposal, expectedStateRevision: runtimeState?.revision } : {}),
      sourceMemoryIds: [...new Set([...(dream?.relatedMemoryIds ?? []), ...result.notes.flatMap(note => note.relatedMemoryIds ?? []),
        ...maintenanceSeeds.map(note => note.id)])],
      ...(maintenance ? { maintenance: { decision: maintenance.decision, reason: maintenance.reason,
        reviewedMemoryVersions: maintenanceSeeds.map(note => ({ id: note.id, version: note.version })) },
        ...(maintenance.consolidations.length ? { consolidations: maintenance.consolidations } : {}) } : {}),
      memoryCandidates: result.notes.map(candidate => ({ ...candidate,
        sourceChecksums: Object.fromEntries(candidate.sourceMessageIds.map(id => [id, createHash('sha256').update(sources.get(id)!.content).digest('hex')])) })) });
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await this.ticking; await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
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
