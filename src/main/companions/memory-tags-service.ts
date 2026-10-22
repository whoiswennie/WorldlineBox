import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryTagJob } from '../../shared/companion-memory-tags';
import { CompanionModelError, generateCompanionText, type CompanionModelConfig } from './model';
import type { CompanionMemoryJobSchedule } from '../../shared/companion-memory-processing';
import { memorySchedule } from './memory-processing-schedule';

interface Options {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  /** Global chat policy; no per-resident credential or separate tagging model. */
  config(): Promise<CompanionModelConfig>;
  /** Original vendored Plugin/DailyNote/TagMaster.txt, loaded once by the host. */
  prompt(): Promise<string>;
  validate?(job: CompanionMemoryTagJob, tags: readonly string[], signal: AbortSignal): Promise<void>;
  fetchFn: typeof fetch; changed(): void; report(error: unknown): void; busy?(): boolean;
}

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
  private controller?: AbortController;
  private owner?: string;
  private noteId?: string;
  private closed = false;
  constructor(private readonly options: Options) {}
  async schedulingFor(companionId?: string): Promise<CompanionMemoryJobSchedule> {
    let configured = false;
    try { const config = await this.options.config(); configured = !!config.model?.trim() && !!config.apiKey?.trim(); } catch { /* Read-only configuration check; never an API request. */ }
    const nextCheckAt = this.timer && this.scheduledAt && this.scheduledAt > Date.now() && !this.running ? new Date(this.scheduledAt).toISOString() : undefined;
    const base = memorySchedule('tags', { ...(nextCheckAt ? { nextCheckAt, scheduleKind: 'timer' as const } : {}),
      condition: nextCheckAt ? '已安排下一轮标签队列检查，每轮按原文版本依次核验。' : '尚未登记下一轮标签检查；手工导入、文档操作或当前后台轮次结束后继续核验。' });
    if (this.closed) return { ...base, scheduleKind: 'condition', nextCheckAt: undefined, waitingReason: 'app_stopped', condition: '标签后台已停止，重新打开资产库后继续检查。' };
    if (this.running) return { ...base, scheduleKind: this.owner === companionId ? 'running' : 'condition', nextCheckAt: undefined,
      waitingReason: this.owner === companionId ? undefined : 'worker_busy', condition: this.owner === companionId ? '正在整理这位伙伴实际文档的标签。'
        : '标签后台当前轮次尚未结束，正在核验或处理已领取文档；空出资源后继续。' };
    if (this.options.busy?.()) return { ...base, scheduleKind: 'condition', waitingReason: 'foreground_busy', condition: '前台正在生成回复，标签后台本轮让出资源；下一次实际检查时再次核验忙闲。' };
    if (!configured) return { ...base, scheduleKind: 'condition', waitingReason: 'model_unconfigured',
      condition: '无明确 Tag 行的文档需要“设置 → 全局模型”中的可用聊天模型；已有明确 Tag 行的文档仍可直接核验。正文会保留。' };
    return base;
  }
  start(): void {
    if (this.closed || this.timer) return;
    const next = () => { this.timer = undefined; this.scheduledAt = undefined; this.options.changed(); void this.tick().catch(this.options.report).finally(() => {
      if (!this.closed) { this.scheduledAt = Date.now() + 30000; this.timer = setTimeout(next, 30000); this.timer.unref(); this.options.changed(); }
    }); };
    this.scheduledAt = Date.now() + 1000; this.timer = setTimeout(next, 1000); this.timer.unref(); this.options.changed();
  }
  tick(): Promise<void> {
    if (this.closed || this.options.busy?.()) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.process(); this.running = run;
    this.options.changed();
    void run.finally(() => { if (this.running === run) { this.running = undefined; this.options.changed(); } }).catch(() => undefined);
    return run;
  }
  private async process(): Promise<void> {
    for (let count = 0; count < 4 && !this.closed && !this.options.busy?.(); count++) {
      const job = (await this.options.request({ type: 'memory.tags.claim' })).memoryTagJob;
      if (!job) return;
      this.controller = new AbortController(); this.owner = job.companionId; this.noteId = job.noteId;
      this.options.changed();
      try {
        // Original DailyNote honors an explicit final Tag line before invoking TagMaster.
        const explicit = job.content.trimEnd().split(/\r?\n/u).at(-1)?.match(/^Tag:\s*(.+)$/iu);
        if (explicit) {
          await this.publish(job, parseVcpTagMasterOutput(`[[Tag: ${explicit[1]}]]`), this.controller.signal); continue;
        }
        let config: CompanionModelConfig;
        try { config = await this.options.config(); }
        catch { await this.defer(job, 'needs_model'); return; }
        const tags = parseVcpTagMasterOutput(await generateCompanionText({ system: await this.options.prompt(), user: job.content },
          config, this.controller.signal, { fetchFn: this.options.fetchFn, timeoutMs: 45000 }));
        await this.publish(job, tags, this.controller.signal);
      } catch (error) {
        await this.defer(job, error instanceof CompanionModelError && error.code === 'CONFIG' ? 'needs_model' : 'retry');
        if (!(error instanceof CompanionModelError) && !this.controller.signal.aborted) this.options.report(error);
      } finally { this.controller = undefined; this.owner = undefined; this.noteId = undefined; this.options.changed(); }
    }
  }
  private async publish(job: CompanionMemoryTagJob, tags: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.options.validate?.(job, tags, signal); signal.throwIfAborted();
    await this.options.request({ type: 'memory.tags.complete', id: job.id, leaseToken: job.leaseToken, tags }); this.options.changed();
  }
  private async defer(job: CompanionMemoryTagJob, reason: 'needs_model' | 'retry'): Promise<void> {
    await this.options.request({ type: 'memory.tags.defer', id: job.id, leaseToken: job.leaseToken, reason,
      error: reason === 'needs_model' ? '等待全局聊天模型配置；正文已保存，稍后自动补充标签。' : '自动标签尚未完成，正文已保存，稍后会重试。',
      retryAfterMs: reason === 'needs_model' ? 30000 : Math.min(300000, 5000 * 2 ** Math.min(job.attempts, 6)) }).catch(this.options.report);
    this.options.changed();
  }
  cancelCompanion(owner: string): void { if (this.owner === owner) this.controller?.abort(); }
  cancelNote(noteId?: string): void { if (noteId && this.noteId === noteId) this.controller?.abort(); }
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.scheduledAt = undefined; this.controller?.abort(); await this.running; }
}
