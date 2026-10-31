import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryTagJob } from '../../shared/companion-memory-tags';
import { CompanionModelError, companionModelAdmissionRetryAfter, generateCompanionText, repairCompanionStructured, type CompanionModelConfig } from './model';
import type { CompanionMemoryJobSchedule } from '../../shared/companion-memory-processing';
import { memorySchedule } from './memory-processing-schedule';
import { z } from 'zod';
import { companionMemoryTagSchema } from '../../shared/companion-memory';
import type { CompanionAgendaExecutionResult } from './agenda-service';

interface Options {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  /** Global chat policy; no per-resident credential or separate tagging model. */
  config(companionId?: string): Promise<CompanionModelConfig>;
  /** Original vendored Plugin/DailyNote/TagMaster.txt, loaded once by the host. */
  prompt(companionId?: string): Promise<string>;
  /** Canonical exact-body read after queue admission; never SQL prose fallback. */
  validateInput?(job: CompanionMemoryTagJob, signal: AbortSignal): Promise<void>;
  validate?(job: CompanionMemoryTagJob, tags: readonly string[], signal: AbortSignal): Promise<void>;
  fetchFn: typeof fetch; changed(): void; report(error: unknown): void; busy?(): boolean;
}
class StaleTagInput extends CompanionModelError {
  constructor() { super('CANCELLED', '标签处理的原始文档、来源或租约已经失效，旧正文未继续发送。', 'tag_input_stale'); }
}
class TagAgendaLinkPending extends Error {}
export interface CompanionTagAgendaProgress { kind: 'tags'; id: string; stage: string }
const repairedTagsSchema = z.strictObject({ tags: z.array(companionMemoryTagSchema).min(1).max(50) });

/** Parse the original TagMaster envelope; semantic tags come exclusively from the chat model. */
export function parseVcpTagMasterOutput(raw: string): string[] {
  const match = raw.length <= 8192 && raw.match(/^\s*\[\[Tag:\s*([^\r\n]+?)\]\]\s*$/iu);
  if (!match) throw new CompanionModelError('INVALID_RESPONSE', '自动标签格式无效，稍后会重试。');
  // The original DailyNote.fixTagFormat normalizes these separators and trailing punctuation.
  const tags = [...new Set(match[1]!.replace(/：/gu, '').replace(/[，、]/gu, ',').replace(/[。.]+$/gu, '').split(',').map(tag => tag.trim()))];
  if (!tags.length || tags.length > 50 || tags.some(tag => !tag || tag.length > 100 || /[\r\n]/u.test(tag))) {
    throw new CompanionModelError('INVALID_RESPONSE', '自动标签数量或长度无效，稍后会重试。');
  }
  return tags;
}

export class CompanionMemoryTagService {
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt?: number;
  private running?: Promise<void>;
  private readonly activeJobs = new Map<string, { job: CompanionMemoryTagJob; controller: AbortController }>();
  private readonly agendaQuanta = new Map<string, { controller: AbortController; promise: Promise<CompanionAgendaExecutionResult> }>();
  private agendaWake?: (companionId: string) => void;
  private closed = false;
  constructor(private readonly options: Options) {}
  async schedulingFor(companionId?: string): Promise<CompanionMemoryJobSchedule> {
    let configured = false;
    try { const config = await this.options.config(companionId); configured = !!config.model?.trim() && !!config.apiKey?.trim(); } catch { /* Read-only configuration check; never an API request. */ }
    const nextCheckAt = this.timer && this.scheduledAt && this.scheduledAt > Date.now() && !this.running ? new Date(this.scheduledAt).toISOString() : undefined;
    const base = memorySchedule('tags', { ...(nextCheckAt ? { nextCheckAt, scheduleKind: 'timer' as const } : {}),
      condition: nextCheckAt ? '已安排下一轮标签队列检查，每轮按原文版本依次核验。' : '尚未登记下一轮标签检查；手工导入、文档操作或当前后台轮次结束后继续核验。' });
    if (this.closed) return { ...base, scheduleKind: 'condition', nextCheckAt: undefined, waitingReason: 'app_stopped', condition: '标签后台已停止，重新打开资产库后继续检查。' };
    const owned = [...this.activeJobs.values()].some(entry => entry.job.companionId === companionId);
    if (this.running || owned) return { ...base, scheduleKind: owned ? 'running' : 'condition', nextCheckAt: undefined,
      waitingReason: owned ? undefined : 'worker_busy', condition: owned ? '正在整理这位伙伴实际文档的标签。'
        : '标签后台当前轮次尚未结束，正在核验或处理已领取文档；空出资源后继续。' };
    if (!configured) return { ...base, scheduleKind: 'condition', waitingReason: 'model_unconfigured',
      condition: '无明确 Tag 行的文档需要“设置 → 全局模型”中的可用聊天模型；已有明确 Tag 行的文档仍可直接核验。正文会保留。' };
    return this.agendaWake ? { ...base, scheduleKind: 'condition', nextCheckAt: undefined, waitingReason: 'agenda', condition: '标签作为来源整理事件的子步骤，由伙伴统一日程领取；不再启动独立的模型轮询。' } : base;
  }
  setAgendaDriven(wakeOwner: (companionId: string) => void): void {
    this.agendaWake = wakeOwner;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.scheduledAt = undefined;
  }
  start(): void {
    if (this.closed || this.agendaWake || this.timer) return;
    const next = () => { this.timer = undefined; this.scheduledAt = undefined; this.options.changed(); void this.tick().catch(this.options.report).finally(() => {
      if (!this.closed && !this.agendaWake) { this.scheduledAt = Date.now() + 30000; this.timer = setTimeout(next, 30000); this.timer.unref(); this.options.changed(); }
    }); };
    this.scheduledAt = Date.now() + 1000; this.timer = setTimeout(next, 1000); this.timer.unref(); this.options.changed();
  }
  tick(): Promise<void> {
    if (this.closed || this.agendaWake) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.process(); this.running = run;
    this.options.changed();
    void run.finally(() => { if (this.running === run) { this.running = undefined; this.options.changed(); } }).catch(() => undefined);
    return run;
  }
  private async process(): Promise<void> {
    for (let count = 0; count < 4 && !this.closed; count++) {
      const job = (await this.options.request({ type: 'memory.tags.claim' })).memoryTagJob;
      if (!job) return;
      const outcome = await this.processJob(job);
      if (outcome.outcome === 'waiting') return;
    }
  }

  async runAgendaQuantum(companionId: string, signal: AbortSignal,
    onProgress?: (progress: CompanionTagAgendaProgress) => Promise<void>): Promise<CompanionAgendaExecutionResult> {
    if (this.closed || signal.aborted) return { outcome: 'cancelled', stage: '本次标签阶段已停止。' };
    if (this.agendaQuanta.has(companionId) || [...this.activeJobs.values()].some(entry => entry.job.companionId === companionId))
      return this.wait('同一伙伴的标签阶段正在收尾。', 1000);
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, signal]);
    const promise = Promise.resolve().then(async (): Promise<CompanionAgendaExecutionResult> => {
      combined.throwIfAborted();
      const response = await this.options.request({ type: 'memory.tags.claim', companionId, leaseMs: 120000 });
      if (!response.ok) throw new Error(response.error ?? '标签阶段尚未领取。');
      const job = response.memoryTagJob;
      if (!job) {
        const inspected = await this.options.request({ type: 'memory.tags.status', companionId });
        const status = inspected.memoryTagStatus;
        if (!inspected.ok || !status) throw new Error(inspected.error ?? '本人标签队列状态尚不可核实。');
        return status && (status.pending || status.running || status.waitingModel || status.failed) ? this.wait('等待剩余文档的标签条件恢复。')
          : { outcome: 'silent', stage: '没有需要补充标签的文档。' };
      }
      if (job.companionId !== companionId) throw new Error('标签领取返回了其他伙伴的文档，未继续读取或发送。');
      return this.processJob(job, combined, onProgress);
    }).finally(() => { if (this.agendaQuanta.get(companionId)?.promise === promise) this.agendaQuanta.delete(companionId); });
    this.agendaQuanta.set(companionId, { controller, promise }); return promise;
  }
  private wait(stage: string, delay = 30000): CompanionAgendaExecutionResult {
    return { outcome: 'waiting', stage: stage.slice(0, 1000), nextCondition: stage.slice(0, 1000), notBefore: new Date(Date.now() + delay).toISOString() };
  }
  private async processJob(job: CompanionMemoryTagJob, parentSignal?: AbortSignal,
    onProgress?: (progress: CompanionTagAgendaProgress) => Promise<void>): Promise<CompanionAgendaExecutionResult> {
      const controller = new AbortController(), signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
      this.activeJobs.set(job.id, { job, controller }); this.options.changed();
      let finished = false, renewing: Promise<void> | undefined;
      const heartbeat = setInterval(() => {
        if (finished || signal.aborted || renewing) return;
        const task = this.options.request({ type: 'memory.tags.heartbeat', id: job.id, leaseToken: job.leaseToken, leaseMs: 120000 })
          .then(response => { if (!finished && (!response.ok || !response.memoryTagValid || response.memoryTagJob?.id !== job.id
            || response.memoryTagJob.leaseToken !== job.leaseToken)) controller.abort(new StaleTagInput()); })
          .catch(error => { if (!finished) { controller.abort(error); this.options.report(error); } })
          .finally(() => { if (renewing === task) renewing = undefined; });
        renewing = task;
      }, 30000); heartbeat.unref();
      try {
        signal.throwIfAborted();
        if (onProgress) {
          try { await onProgress({ kind: 'tags', id: job.id, stage: '核对正式正文后补充检索标签。' }); }
          catch { throw new TagAgendaLinkPending('本次标签阶段尚未登记到所属日程，保留正文等待继续。'); }
        }
        // Original DailyNote honors an explicit final Tag line before invoking TagMaster.
        const explicit = job.content.trimEnd().split(/\r?\n/u).at(-1)?.match(/^Tag:\s*(.+)$/iu);
        if (explicit) {
          await this.publish(job, parseVcpTagMasterOutput(`[[Tag: ${explicit[1]}]]`), signal);
          return await this.completed(job);
        }
        let config: CompanionModelConfig;
        try { config = await this.options.config(job.companionId); }
        catch { await this.defer(job, 'needs_model'); return this.wait('等待全局标签模型配置。'); }
        const context = { system: await this.options.prompt(job.companionId), user: job.content };
        let resolvedContext: Awaited<ReturnType<NonNullable<CompanionModelConfig['resolveAssetContext']>>> | undefined;
        const resolver = config.resolveAssetContext, lifecycle = config.providerLifecycle;
        const guarded: CompanionModelConfig = { ...config, ownerId: job.companionId, workPriority: 'background', requestPurpose: 'tags',
          ...(resolver ? { resolveAssetContext: async (value, kind) => { const resolved = await resolver(value, kind); resolvedContext = resolved; return resolved; } } : {}),
          providerLifecycle: { beforeDispatch: async () => {
            await this.validateInput(job, signal);
            const finish = await lifecycle?.beforeDispatch();
            try { await this.validateInput(job, signal); }
            catch (error) { await finish?.('cancelled_before_send', 0); throw error; }
            return finish ?? (async () => undefined);
          } } };
        const raw = await generateCompanionText(context, guarded, signal, { fetchFn: this.options.fetchFn, timeoutMs: 45000 });
        let tags: string[];
        try { tags = parseVcpTagMasterOutput(raw); }
        catch (error) {
          if (!(error instanceof CompanionModelError) || error.code !== 'INVALID_RESPONSE') throw error;
          await this.validateInput(job, signal);
          const repaired = repairedTagsSchema.parse(await repairCompanionStructured({ context: resolvedContext ?? context, raw, config: guarded, signal, resolvedContext,
            options: { fetchFn: this.options.fetchFn, timeoutMs: 45000, responseSchema: repairedTagsSchema,
              repairPreserveCollections: [{ path: ['tags'], fields: [] }] } }));
          tags = [...new Set(repaired.tags)];
        }
        await this.publish(job, tags, signal);
        return await this.completed(job);
      } catch (error) {
        const admission = companionModelAdmissionRetryAfter(error);
        if (admission !== undefined) {
          await this.options.request({ type: 'memory.tags.defer', id: job.id, leaseToken: job.leaseToken, reason: 'admission',
            error: '模型请求尚未发送，等待工程队列或连接恢复；正文和标签任务已保留。', retryAfterMs: admission }).catch(this.options.report);
          this.options.changed(); return this.wait('等待模型工程队列或连接恢复。', admission);
        }
        const reason = error instanceof CompanionModelError && error.diagnostic === 'tag_input_stale' ? 'stale' : this.closed || error instanceof TagAgendaLinkPending ? 'admission' : signal.aborted || error instanceof CompanionModelError && error.code === 'CANCELLED'
          ? 'cancelled' : error instanceof CompanionModelError && error.code === 'CONFIG' ? 'needs_model' : 'retry';
        await this.defer(job, reason);
        if (!(error instanceof CompanionModelError) && !signal.aborted && !(error instanceof TagAgendaLinkPending)) this.options.report(error);
        if (reason === 'needs_model' || reason === 'admission') return this.wait(error instanceof Error ? error.message : '等待标签处理条件恢复。');
        if (reason === 'cancelled') return { outcome: 'cancelled', stage: '本次标签处理已停止，原始正文保留。' };
        if (reason === 'stale') return { outcome: 'silent', stage: '原文或来源已变化，旧标签未发布。' };
        const disposition = (await this.options.request({ type: 'jobs.inspect', ownerId: job.companionId, kind: 'tags', id: job.id })).jobDisposition;
        return { outcome: disposition?.state === 'parked' ? 'parked' : disposition?.state === 'abandoned' ? 'abandoned' : 'failed',
          error: (error instanceof Error ? error.message : '标签阶段未完成。').slice(0, 2000) };
      } finally {
        finished = true; clearInterval(heartbeat); await renewing;
        this.activeJobs.delete(job.id); this.options.changed();
      }
    }
  private async completed(job: CompanionMemoryTagJob): Promise<CompanionAgendaExecutionResult> {
    const response = await this.options.request({ type: 'memory.tags.status', companionId: job.companionId, noteId: job.noteId });
    const status = response.memoryTagStatus, state = status?.note?.state;
    if (!response.ok || status?.note?.noteId !== job.noteId) throw new Error('标签完成回执不属于当前文档。');
    if (state === 'completed') return status.pending || status.running || status.waitingModel || status.failed
      ? this.wait('本篇文档标签已保存，后续文档在下一次日程接续中继续。', 1000)
      : { outcome: 'completed', stage: '本篇文档标签已核对并保存。' };
    if (state === 'stale' || state === 'cancelled') return { outcome: 'silent', stage: '原文或记忆权限已变化，旧标签未发布。' };
    throw new Error('标签写回尚未返回可核对的完成状态。');
  }
  private async validateInput(job: CompanionMemoryTagJob, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const checked = await this.options.request({ type: 'memory.tags.validate', id: job.id, leaseToken: job.leaseToken });
    if (checked.memoryTagValid !== true || !checked.memoryTagJob || checked.memoryTagJob.id !== job.id || checked.memoryTagJob.leaseToken !== job.leaseToken
      || checked.memoryTagJob.companionId !== job.companionId || checked.memoryTagJob.noteId !== job.noteId || checked.memoryTagJob.content !== job.content) throw new StaleTagInput();
    // The worker keeps body/source identity fixed. A harmless annotation CAS
    // revision may advance while waiting, without creating a fresh attempt.
    job.version = checked.memoryTagJob.version;
    await this.options.validateInput?.(job, signal); signal.throwIfAborted();
  }
  private async publish(job: CompanionMemoryTagJob, tags: string[], signal: AbortSignal): Promise<void> {
    await this.validateInput(job, signal); await this.options.validate?.(job, tags, signal); signal.throwIfAborted();
    await this.options.request({ type: 'memory.tags.complete', id: job.id, leaseToken: job.leaseToken, tags }); this.options.changed();
  }
  private async defer(job: CompanionMemoryTagJob, reason: 'needs_model' | 'retry' | 'cancelled' | 'stale' | 'admission'): Promise<void> {
    await this.options.request({ type: 'memory.tags.defer', id: job.id, leaseToken: job.leaseToken, reason,
      error: reason === 'needs_model' ? '等待全局聊天模型配置；正文已保存，稍后自动补充标签。' : reason === 'cancelled' ? '本轮标签处理已停止，原始正文保留。' : '自动标签尚未完成，正文已保存，稍后会重试。',
      retryAfterMs: reason === 'needs_model' ? 30000 : Math.min(300000, 5000 * 2 ** Math.min(job.cycleFailureCount + 1, 6)) }).catch(this.options.report);
    this.options.changed();
  }
  cancelCompanion(owner: string): void {
    this.agendaQuanta.get(owner)?.controller.abort();
    for (const entry of this.activeJobs.values()) if (entry.job.companionId === owner) entry.controller.abort();
  }
  cancelJob(owner: string, id: string): void { const entry = this.activeJobs.get(id); if (entry?.job.companionId === owner) entry.controller.abort(); }
  cancelNote(noteId?: string): void { for (const entry of this.activeJobs.values()) if (noteId && entry.job.noteId === noteId) entry.controller.abort(); }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.scheduledAt = undefined;
    for (const entry of this.activeJobs.values()) entry.controller.abort();
    for (const quantum of this.agendaQuanta.values()) quantum.controller.abort();
    await this.running; await Promise.allSettled([...this.agendaQuanta.values()].map(quantum => quantum.promise));
  }
}
