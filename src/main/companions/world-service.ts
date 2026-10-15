import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorldJob, CompanionWorldScope, CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionModelConfig } from './model';
import { CompanionModelError } from './model';
import { generateCompanionWorldDecision } from './world-model';
import { generateCompanionMemoryDream } from './memory-model';
import type { CompanionSocialJob } from '../../shared/companion-social';
import { generateCompanionSocialReply } from './social-model';

interface WorldServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(companion: Companion): Promise<CompanionModelConfig>;
  fetchFn: typeof fetch;
  changed(): void;
  wakeWaiting(): void;
  report(error: unknown): void;
  busy(): boolean;
}

/** Physics and reservations keep ticking while semantic decisions run separately. */
export class CompanionWorldService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private readonly jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private closed = false;
  constructor(private readonly options: WorldServiceOptions) {}
  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 500); this.timer.unref(); void this.tick();
  }
  async tick(): Promise<void> {
    if (this.closed || this.ticking) return;
    this.ticking = (async () => {
      await this.options.request({ type: 'world.tick' });
      this.options.wakeWaiting();
      if (this.closed || this.options.busy() || this.jobs.size >= 2) return;
      const delivery = await this.options.request({ type: 'social.job.claim' });
      if (delivery.socialMessage) this.options.changed();
      const social = delivery.socialJob;
      if (social?.leaseToken && !this.closed) {
        const controller = new AbortController();
        const promise = this.processSocial(social, controller.signal).catch(this.options.report)
          .finally(() => { this.jobs.delete(social.id); this.options.changed(); });
        this.jobs.set(social.id, { promise, controller });
      }
      for (const kind of ['decision', 'dream'] as const) {
        if (this.closed || this.jobs.size >= 2) break;
        const job = (await this.options.request({ type: 'world.job.claim', kind })).worldJob;
        if (!job?.leaseToken) continue;
        const controller = new AbortController();
        const promise = this.process(job, controller.signal)
          .catch(this.options.report).finally(() => { this.jobs.delete(job.id); this.options.changed(); });
        this.jobs.set(job.id, { promise, controller });
      }
    })().catch(this.options.report).finally(() => { this.ticking = undefined; });
    await this.ticking;
  }
  async ready(input: CompanionWorldScope & { workId: string; kind: 'chat' | 'action' | 'schedule'; sourceMessageId?: string;
    urgent?: boolean; fixed?: boolean }, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.closed) throw cancelled();
    try {
      let work = (await this.options.request({ type: 'world.work.begin', ...input })).worldWork;
      this.options.changed();
      while (work?.status !== 'ready') {
        if (signal?.aborted || this.closed) throw cancelled();
        if (!work || work.status === 'ended') throw new Error('伙伴当前无法使用电脑，任务仍需等待。');
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
    const leaseToken = job.leaseToken;
    try {
      const state = (await this.options.request({ type: 'state', includeHidden: true })).state;
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
      const result = await generateCompanionSocialReply({ companion, conversation, source, messages: sources, job, world, routine,
        ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression, affect: runtime.affect } } : {}),
        members: state!.companions.filter(member => conversation.memberIds.includes(member.id)).map(member => ({ id: member.id, name: member.name, description: member.description })) },
      await this.options.configFor(companion), signal, { fetchFn: this.options.fetchFn });
      const wait = Date.parse(job.typingNotBefore) - Date.now();
      if (wait > 0) await delay(wait, signal);
      if (signal.aborted || this.closed) throw cancelled();
      await this.options.request({ type: 'social.job.complete', id: job.id, leaseToken, text: result.text,
        ...(result.nextRecipientId ? { nextRecipientId: result.nextRecipientId } : {}) });
    } catch (error) {
      await this.options.request({ type: 'social.job.fail', id: job.id, leaseToken,
        error: error instanceof CompanionModelError ? error.message : '伙伴通信稍后继续。' });
    }
  }
  private async process(job: CompanionWorldJob, signal: AbortSignal): Promise<void> {
    const { id: jobId, leaseToken, kind, companionId } = job;
    if (!leaseToken) return;
    try {
      const state = (await this.options.request({ type: 'state', includeHidden: true })).state;
      const companion = state?.companions.find(companion => companion.id === companionId);
      const conversation = state?.conversations.find(conversation => conversation.id === job.conversationId && conversation.memberIds.includes(companionId));
      if (!companion || !conversation) throw new Error('伙伴世界认知范围不可访问。');
      const scope = { companionId, conversationId: conversation.id }, world = await this.observe(scope);
      if (!world) throw new Error('伙伴当前世界快照不可访问。');
      const config = await this.options.configFor(companion);
      if (kind === 'decision') {
        const routine = (await this.options.request({ type: 'routine.get', ...scope })).routine;
        const runtime = (await this.options.request({ type: 'state.get', ...scope })).runtimeState;
        const decision = await generateCompanionWorldDecision({ companion, world, job,
          routine, ...(runtime ? { selfState: { energy: runtime.energy, mood: runtime.mood, expression: runtime.expression,
            affect: runtime.affect, focus: runtime.focus, busy: world.works.some(work => work.companionId === companion.id && work.status !== 'ended') } } : {}),
          members: state!.companions.map(member => ({ id: member.id, name: member.name, description: member.description })) }, config, signal, { fetchFn: this.options.fetchFn });
        if (signal.aborted || this.closed) throw cancelled();
        await this.options.request({ type: 'world.job.complete', id: jobId, leaseToken, ...(decision.action ? { action: decision.action } : {}),
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
