import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorldJob, CompanionWorldScope, CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionModelConfig } from './model';
import { CompanionModelError } from './model';
import { generateCompanionWorldDecision } from './world-model';
import { generateCompanionMemoryDream } from './memory-model';
import type { CompanionSocialJob, CompanionSocialNotification } from '../../shared/companion-social';
import { generateCompanionSocialReply } from './social-model';
import { generateCompanionSocialNotification } from './social-notification-model';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';

interface WorldServiceOptions {
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
}

/** Physics and reservations keep ticking while semantic decisions run separately. */
export class CompanionWorldService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController; companionId: string }>();
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
      await this.options.tickLife?.();
      this.options.wakeWaiting();
      if (this.closed || this.jobs.size >= 2) return;
      const continuation = (await this.options.request({ type: 'social.notification.claim' })).socialNotification;
      if (continuation?.leaseToken && !this.closed && !this.options.blocked?.(continuation.companionId)) {
        const controller = new AbortController();
        const promise = this.processNotification(continuation, controller.signal).catch(this.options.report)
          .finally(() => { this.jobs.delete(continuation.id); this.options.changed(); });
        this.jobs.set(continuation.id, { promise, controller, companionId: continuation.companionId });
      }
      // Admission is checked for the actual actor by SQLite. An unrelated
      // foreground chat must not freeze everyone else's social replies.
      if (this.jobs.size >= 2) return;
      const delivery = await this.options.request({ type: 'social.job.claim' });
      if (delivery.socialMessage) this.options.changed();
      const social = delivery.socialJob;
      if (social?.leaseToken && !this.closed && !this.options.blocked?.(social.companionId)) {
        const controller = new AbortController();
        const promise = this.processSocial(social, controller.signal).catch(this.options.report)
          .finally(() => { this.jobs.delete(social.id); this.options.changed(); });
        this.jobs.set(social.id, { promise, controller, companionId: social.companionId });
      }
      for (const kind of ['decision', 'dream'] as const) {
        if (this.closed || this.jobs.size >= 2) break;
        const job = (await this.options.request({ type: 'world.job.claim', kind })).worldJob;
        if (!job?.leaseToken || this.options.blocked?.(job.companionId)) continue;
        const controller = new AbortController();
        const promise = this.process(job, controller.signal)
          .catch(this.options.report).finally(() => { this.jobs.delete(job.id); this.options.changed(); });
        this.jobs.set(job.id, { promise, controller, companionId: job.companionId });
      }
    })().catch(this.options.report).finally(() => { this.ticking = undefined; });
    await this.ticking;
  }
  async ready(input: CompanionWorldScope & { workId: string; kind: 'chat' | 'action' | 'schedule'; sourceMessageId?: string;
    urgent?: boolean; fixed?: boolean }, signal?: AbortSignal, onWaiting?: (reason: string) => void): Promise<void> {
    if (signal?.aborted || this.closed) throw cancelled();
    try {
      let work = (await this.options.request({ type: 'world.work.begin', ...input })).worldWork;
      this.options.changed();
      while (work?.status !== 'ready') {
        if (signal?.aborted || this.closed) throw cancelled();
        if (!work || work.status === 'ended') throw new Error('伙伴当前无法使用电脑，任务仍需等待。');
        onWaiting?.(work.reason ?? (input.kind === 'chat' ? '正在结束当前动作，准备查看消息' : '正在前往电脑，准备处理任务'));
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
    try {
      if (job.urgent) interruptionId = await this.options.beginPriority?.(job.companionId, job.conversationId, job.sourceMessageId);
      const state = (await this.options.request({ type: 'state', includeHidden: true, conversationId: job.conversationId })).state;
      const companion = state?.companions.find(member => member.id === job.companionId);
      const conversation = state?.conversations.find(room => room.id === job.conversationId && room.memberIds.includes(job.companionId));
      if (!companion || !conversation) throw new Error('伙伴通信会话不存在。');
      const scope = { companionId: companion.id, conversationId: conversation.id, beforeSequence: job.throughSequence };
      const recent = (await this.options.request({ type: 'messages', conversationId: conversation.id, before: job.throughSequence + 1, limit: 50 })).messages ?? [];
      const sources = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: [...new Set([...recent.map(message => message.id), job.sourceMessageId])] })).memorySources ?? [];
      const source = sources.find(message => message.id === job.sourceMessageId);
      if (!source || source.authorId === 'user') throw new Error('伙伴通信实际来信已不可访问。');
      const world = await this.observe(scope);
      if (!world) throw new Error('伙伴当前世界不可访问。');
      const routine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
      const runtime = (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
      const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, sourceAuthorId: source.authorId, audience: 'peers' });
      const result = await generateCompanionSocialReply({ companion, conversation, source, messages: sources, job, world, routine, ...profiles,
        ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression, affect: runtime.affect } } : {}),
        members: state!.companions.filter(member => conversation.memberIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) },
      await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn });
      const wait = Date.parse(job.typingNotBefore) - Date.now();
      if (wait > 0) await delay(wait, signal);
      if (signal.aborted || this.closed) throw cancelled();
      await this.options.request({ type: 'social.job.complete', id: job.id, leaseToken, text: result.text,
        ...(result.shareAddress ? { shareAddress: true } : {}),
        ...(result.nextRecipientId ? { nextRecipientId: result.nextRecipientId } : {}), ...(result.workOffer ? { workOffer: result.workOffer } : {}) });
    } catch (error) {
      await this.options.request({ type: 'social.job.fail', id: job.id, leaseToken,
        error: error instanceof CompanionModelError ? error.message : '伙伴通信稍后继续。' });
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
      const world = await this.observe(scope);
      if (!source || source.authorId !== 'user' || !world) throw cancelled();
      const activityTask = (await this.options.request({ type: 'activity.list', ...scope, limit: 20 })).activityTasks?.find(task => task.sourceMessageId === source.id);
      const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, audience: 'player', sourceAuthorId: 'user' });
      const participants = new Set([companion.id, notification.origin.initiatorId, notification.evidence.authorId, ...(notification.events?.map(event => event.evidence.authorId) ?? [])]);
      const text = await generateCompanionSocialNotification({ companion, conversation, source, notification, world, activityTask, ...profiles,
        members: state!.companions.filter(member => participants.has(member.id)).map(member => ({ id: member.id, name: member.name })) }, await this.options.configFor(companion), signal,
      { fetchFn: this.options.fetchFn });
      if (signal.aborted || this.closed) throw cancelled();
      await this.options.request({ type: 'social.notification.complete', id: notification.id, leaseToken, text });
    } catch (error) {
      await this.options.request({ type: 'social.notification.fail', id: notification.id, leaseToken,
        error: error instanceof CompanionModelError ? error.message : '这次后续回报尚未完成，稍后继续。' });
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
        const runtime = (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
        const profiles = await this.options.profiles?.({ companionId: companion.id, conversation, audience: 'peers', directory: false,
          sourceAuthorId: world.events.findLast(event => event.targetId === companion.id && event.actorId !== companion.id)?.actorId });
        const decision = await generateCompanionWorldDecision({ companion, world, job,
          ...profiles, routine, ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression,
            affect: runtime.affect, focus: runtime.focus, busy: world.works.some(work => work.companionId === companion.id && work.status !== 'ended') } } : {}),
          members: state!.companions.filter(member => member.id === companion.id || world.perception?.visibleCompanionIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) }, config, signal, { fetchFn: this.options.fetchFn });
        if (signal.aborted || this.closed) throw cancelled();
        const task = decision.task ?? (decision.action?.action === 'query' ? { title: '查询并核实世界资料',
          goal: `按需查询外部资料：${JSON.stringify(decision.action)}。查询动机：${decision.reason}。根据实际结果判断是否需要内化；如需记住，先搜索已有记忆，再引用查询凭证进行记录或整理。` } : undefined);
        if (task) {
          if (decision.task && decision.action) throw new Error('本轮只能创建持续行动目标或执行一个原子动作。');
          await this.options.request({ type: 'activity.start', companionId: companion.id, conversationId: 'world_' + companion.id,
            clientId: 'world_activity_' + job.id, title: task.title, goal: task.goal });
        }
        await this.options.request({ type: 'world.job.complete', id: jobId, leaseToken, ...(decision.action && !task ? { action: decision.action } : {}),
          appraisals: decision.appraisals.map(({ quote: _quote, ...appraisal }) => { void _quote; return appraisal; }), sourceMemoryIds: [] });
      } else await this.dream(job, leaseToken, companion, conversation, config, signal);
    } catch (error) {
      await this.options.request({ type: 'world.job.fail', id: jobId, leaseToken,
        error: error instanceof CompanionModelError ? error.message : '伙伴世界认知暂未完成，稍后会继续。' });
    }
  }
  private async dream(job: CompanionWorldJob, leaseToken: string, companion: Companion, conversation: CompanionConversation,
    config: CompanionModelConfig, signal: AbortSignal): Promise<void> {
    const scope = { companionId: companion.id, conversationId: conversation.id };
    const reads = await Promise.all(job.sourceMemoryIds.map(id => this.options.request({ type: 'memory.read', ...scope, id, sourceLimit: 100 })));
    const atoms = reads.flatMap(read => read.memoryRead?.memory ? [read.memoryRead.memory] : []).filter(memory => memory.status === 'active'
      && ['fact', 'preference', 'agreement', 'event', 'task'].includes(memory.kind ?? ''));
    if (atoms.length !== job.sourceMemoryIds.length) throw new Error('本次睡眠整理的实际记忆已经变化。');
    const sources = new Map<string, NonNullable<CompanionStorageResponse['message']>>();
    for (const read of reads) for (const message of read.memoryRead?.sources ?? []) sources.set(message.id, message);
    if (!atoms.length || !sources.size) {
      await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, sourceMemoryIds: [] }); return;
    }
    const result = await generateCompanionMemoryDream({ companion, conversation, messages: [...sources.values()], relevantMemories: atoms,
      intent: '睡眠中整理本次真实经历与有证据的经验，保留原始细节和可撤回来源。' }, config, signal, { fetchFn: this.options.fetchFn });
    if (signal.aborted || this.closed) throw cancelled();
    await this.options.request({ type: 'world.job.complete', id: job.id, leaseToken, ...(result.dream ? { dream: result.dream } : {}),
      sourceMemoryIds: [...new Set([...(result.dream?.relatedMemoryIds ?? []), ...result.candidates.flatMap(candidate => candidate.relatedMemoryIds ?? [])])],
      memoryCandidates: result.candidates.map(candidate => ({ ...candidate,
        sourceChecksums: Object.fromEntries(candidate.sourceMessageIds.map(id => [id, createHash('sha256').update(sources.get(id)!.content).digest('hex')])) })) });
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const job of this.jobs.values()) job.controller.abort();
    await this.ticking; await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }
}
function cancelled() { return new CompanionModelError('CANCELLED', '伙伴本次世界工作已停止。'); }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
