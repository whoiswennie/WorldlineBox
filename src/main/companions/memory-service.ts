import { createHash } from 'node:crypto';
import type { Companion, CompanionConversation, CompanionMemory, CompanionMessage } from '../../shared/companions';
import type { CompanionMemorySearch } from '../../shared/companion-memory';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionModelConfig, CompanionModelOptions } from './model';
import {
  buildDirectCompanionMemoryQuery, generateCompanionMemoryExtraction, generateCompanionMemoryMaintenance, planCompanionMemoryQuery,
} from './memory-model';

interface MemoryServiceOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(companion: Companion): Promise<CompanionModelConfig>;
  fetchFn: typeof fetch;
  changed(): void;
  report(error: unknown): void;
  busy(): boolean;
  blocked?(companionId: string): boolean;
}

export interface CompanionMemoryRecall {
  memories: CompanionMemory[];
  sources: CompanionMessage[];
  reasons: Array<{ id: string; reasons: string[]; path: string[] }>;
  pending: boolean;
  degraded: boolean;
  continuation?: { query: Omit<CompanionMemorySearch, 'companionId' | 'conversationId' | 'beforeSequence'>;
    memoryCursor?: number; sourceCursor?: number; memoryHasMore: boolean; sourceHasMore: boolean };
}

/** Model work stays outside SQLite transactions. Durable leases and watermarks live in the worker. */
export class CompanionMemoryService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private controllerCompanionId: string | undefined;
  private controllerSettled: Promise<void> | undefined;
  private closed = false;
  private again = false;
  private deferredSince: number | undefined;

  constructor(private readonly options: MemoryServiceOptions) {}

  cancelCompanion(companionId: string): void {
    if (this.controllerCompanionId === companionId) this.controller?.abort();
  }
  async drainCompanion(companionId: string): Promise<void> {
    this.cancelCompanion(companionId);
    if (this.controllerCompanionId === companionId) await this.controllerSettled;
  }

  schedule(delay = 2_000): void {
    if (this.closed) return;
    if (this.running) { this.again = true; return; }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.process().catch(this.options.report).finally(() => {
        this.running = undefined;
        if (!this.closed) {
          const delay = this.again ? 2_000 : 30_000;
          this.again = false;
          this.schedule(delay);
        }
      });
    }, delay);
    this.timer.unref();
  }

  async recall(input: {
    companion: Companion; conversation: CompanionConversation; messages: readonly CompanionMessage[];
    currentMessage: CompanionMessage; referencedMessage?: CompanionMessage; beforeSequence?: number; config: CompanionModelConfig; signal?: AbortSignal;
  }): Promise<CompanionMemoryRecall> {
    const { companion, conversation, currentMessage, signal } = input;
    const scope = { companionId: companion.id, conversationId: conversation.id, beforeSequence: input.beforeSequence ?? currentMessage.sequence };
    const allowed = (await this.options.request({ type: 'memory.sources.filter', ...scope,
      ids: [...new Set([...input.messages.map(message => message.id), currentMessage.id,
        ...(input.referencedMessage ? [input.referencedMessage.id] : [])])] })).memorySources ?? [];
    if (!allowed.some(message => message.id === currentMessage.id)) {
      return { memories: [], sources: [], reasons: [], pending: false, degraded: false };
    }
    const queryInput = { companion, conversation, messages: allowed,
      currentMessageId: currentMessage.id, currentMessage: currentMessage.content,
      referencedMessage: input.referencedMessage && allowed.find(message => message.id === input.referencedMessage!.id) };
    const direct = buildDirectCompanionMemoryQuery(queryInput);
    const initial = await this.options.request({ type: 'memory.search', ...direct, ...scope });
    const status = (await this.options.request({ type: 'memory.status', companionId: companion.id, conversationId: conversation.id })).memoryStatus;
    let query: Omit<CompanionMemorySearch, 'companionId' | 'conversationId' | 'beforeSequence'> = direct;
    let degraded = false;
    // No semantic call is needed for an empty memory library. Exact lookups have a deterministic path.
    const simple = initial.memoryPage?.items.length && /^(?:名字|生日|职业|地址|电话|邮箱|name|birthday)$/iu.test(currentMessage.content.trim());
    if (status?.memories && !simple) {
      try {
        query = await planCompanionMemoryQuery({ ...queryInput,
          tags: initial.memoryPage?.items.flatMap(hit => hit.memory.tags ?? []) ?? [] }, input.config, signal, this.modelOptions());
      } catch (error) {
        if (signal?.aborted) throw error;
        degraded = true;
        // Retrieval remains available without the model; failure is visible in the reply evidence.
      }
    }
    const planned = query === direct ? initial : await this.options.request({ type: 'memory.search', ...query, ...scope });
    const hits = [...(planned.memoryPage?.items ?? []), ...(initial.memoryPage?.items ?? [])];
    const unique = new Map<string, typeof hits[number]>();
    for (const hit of hits) if (!unique.has(hit.memory.id)) unique.set(hit.memory.id, hit);
    // A missing atomic memory is not proof that its archived source never existed.
    const raw = await this.options.request({ type: 'memory.sources.search', ...query, ...scope });
    this.schedule();
    return {
      memories: [...unique.values()].map(hit => hit.memory), sources: raw.memorySources ?? [],
      reasons: [...unique.values()].map(hit => ({ id: hit.memory.id, reasons: hit.reasons, path: hit.path })),
      pending: !!status && status.extractionWatermark < currentMessage.sequence,
      degraded,
      continuation: { query, memoryCursor: planned.memoryPage?.nextCursor, sourceCursor: raw.sourceNextCursor,
        memoryHasMore: planned.memoryPage?.hasMore ?? false, sourceHasMore: raw.sourceHasMore ?? false },
    };
  }

  private modelOptions(): CompanionModelOptions { return { fetchFn: this.options.fetchFn }; }

  private async process(): Promise<void> {
    if (this.closed) return;
    // A present-day source must not affect the simulated past. Leave the
    // extraction lease and watermark untouched until physical catch-up is done.
    if ((await this.options.request({ type: 'world.clock' })).worldClock?.backlog) { this.again = true; return; }
    // Reconcile current-schema sources durably after a crash or an interrupted index rebuild.
    const backfill = await this.options.request({ type: 'memory.jobs.backfill', limit: 200 });
    if (!backfill.backfillComplete) this.again = true;
    const busy = this.options.busy();
    if (busy) {
      this.deferredSince ??= Date.now();
      if (Date.now() - this.deferredSince < 15_000) { this.again = true; return; }
    } else this.deferredSince = undefined;
    const state = (await this.options.request({ type: 'state', includeConversations: false, activeOnly: true })).state;
    if (!state) return;
    let processed = 0;
    for (const companion of state.companions) {
      if (this.closed || processed >= 8 || processed > 0 && this.options.busy()) break;
      if (this.options.blocked?.(companion.id)) continue;
      let config: CompanionModelConfig;
      try { config = await this.options.configFor(companion); }
      catch { continue; }
      if (!config.apiKey?.trim() || !config.model?.trim()) continue;
      const job = (await this.options.request({ type: 'memory.jobs.claim', companionId: companion.id, leaseMs: 600_000 })).memoryJob;
      if (!job) continue;
      if (this.options.blocked?.(companion.id)) continue;
      processed++;
      this.deferredSince = undefined;
      const controller = new AbortController();
      this.controller = controller;
      this.controllerCompanionId = companion.id;
      let settled!: () => void;
      this.controllerSettled = new Promise(resolve => { settled = resolve; });
      try {
        const context = (await this.options.request({ type: 'state', includeHidden: true, activeOnly: true, conversationId: job.conversationId })).state;
        const conversation = context?.conversations.find(item => item.id === job.conversationId);
        if (!conversation || !conversation.memberIds.includes(companion.id)) throw new Error('记忆来源聊天已不可访问。');
        let sources: CompanionMessage[] = [];
        for (const id of job.sourceMessageIds) {
          const message = (await this.options.request({ type: 'message.get', id })).message;
          if (message) sources.push(message);
        }
        sources.sort((a, b) => a.sequence - b.sequence);
        if (!sources.length) throw new Error('记忆来源消息已不可读取。');
        const beforeRows = (await this.options.request({ type: 'messages', conversationId: conversation.id,
          before: sources[0]!.sequence, limit: 8 })).messages ?? [];
        const scope = { companionId: companion.id, conversationId: conversation.id, beforeSequence: job.throughSequence };
        sources = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: sources.map(source => source.id) })).memorySources ?? [];
        const before = (await this.options.request({ type: 'memory.sources.filter', ...scope, ids: beforeRows.map(source => source.id) })).memorySources ?? [];
        if (!sources.length) {
          await this.options.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates: [] });
          this.again = true; this.options.changed(); continue;
        }
        const query = buildDirectCompanionMemoryQuery({ companion, conversation, messages: before,
          currentMessageId: sources.at(-1)!.id, currentMessage: sources.map(source => source.content).join('\n') });
        const related = await this.options.request({ type: 'memory.search', ...query,
          companionId: companion.id, conversationId: conversation.id, beforeSequence: job.throughSequence });
        const oldMemories = related.memoryPage?.items.map(hit => hit.memory) ?? [];
        const extracted = await generateCompanionMemoryExtraction({ companion, conversation, messages: sources,
          contextMessages: before, relevantMemories: oldMemories,
          runtimeState: (await this.options.request({ type: 'state.get', ...scope })).runtimeState,
          tags: oldMemories.flatMap(memory => memory.tags ?? []) }, config, controller.signal, this.modelOptions());
        if (this.closed || controller.signal.aborted) throw new Error('记忆整理已中断，稍后自动继续。');
        const candidates = extracted.candidates.map(candidate => ({ ...candidate, sourceChecksums: job.sourceChecksums }));
        const recorded: CompanionMemory[] = [];
        for (const candidate of candidates) {
          const response = await this.options.request({ type: 'memory.record', ...scope, candidate });
          recorded.push(...(response.memories ?? []));
        }
        const atoms = [...new Map([...recorded, ...oldMemories].filter(memory => memory.status === 'active'
          && memory.sourceConversationId === conversation.id && ['fact', 'preference', 'agreement', 'event', 'task'].includes(memory.kind ?? ''))
          .map(memory => [memory.id, memory])).values()].slice(0, 20);
        // New atomic evidence triggers bounded, source-based phase/event maintenance; never summarize summaries.
        if (recorded.length && (atoms.length >= 3 || recorded.some(memory => memory.kind === 'task' || memory.eventStatus === 'completed' || memory.eventStatus === 'cancelled'))) {
          const sourceMap = new Map(sources.map(source => [source.id, source]));
          for (const atom of atoms) {
            const read = await this.options.request({ type: 'memory.read', ...scope, id: atom.id, sourceLimit: 50 });
            for (const source of read.memoryRead?.sources ?? []) sourceMap.set(source.id, source);
          }
          const maintenance = await generateCompanionMemoryMaintenance({ companion, conversation,
            messages: [...sourceMap.values()], relevantMemories: atoms, tags: atoms.flatMap(memory => memory.tags ?? []),
            intent: '整理本次发生变化的事件或年月阶段目录，保留可展开原子记录与来源；有结果证据时提炼带适用条件和局限的经验。概览使用稳定的subject/factKey标识同一事件或年月主题，不能因复述生成重复独立目录。' },
          config, controller.signal, this.modelOptions());
          for (const candidate of maintenance.candidates) {
            await this.options.request({ type: 'memory.record', ...scope, candidate: { ...candidate,
              sourceChecksums: Object.fromEntries(candidate.sourceMessageIds.map(id => [id,
                createHash('sha256').update(sourceMap.get(id)!.content).digest('hex')])) } });
          }
        }
        await this.options.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, candidates,
          ...(extracted.stateProposal ? { stateProposal: extracted.stateProposal } : {}) });
        this.options.changed();
        this.again = true;
      } catch (error) {
        await this.options.request({ type: 'memory.jobs.fail', id: job.id, leaseToken: job.leaseToken,
          error: error instanceof Error ? error.message : '记忆整理失败。',
          retryAfterMs: this.closed ? 0 : Math.min(300_000, 5_000 * 2 ** Math.min(job.attempts - 1, 6)) });
        if (!this.closed) this.options.changed();
      } finally { settled(); if (this.controller === controller) { this.controller = undefined; this.controllerCompanionId = undefined; this.controllerSettled = undefined; } }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.controller?.abort();
    await this.running;
  }
}
