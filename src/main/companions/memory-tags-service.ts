import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionMemoryTagJob } from '../../shared/companion-memory-tags';
import { CompanionModelError, generateCompanionText, type CompanionModelConfig } from './model';

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
  private running?: Promise<void>;
  private controller?: AbortController;
  private owner?: string;
  private noteId?: string;
  private closed = false;
  constructor(private readonly options: Options) {}
  start(): void {
    if (this.closed || this.timer) return;
    const next = () => { this.timer = undefined; void this.tick().catch(this.options.report).finally(() => {
      if (!this.closed) { this.timer = setTimeout(next, 30000); this.timer.unref(); }
    }); };
    this.timer = setTimeout(next, 1000); this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed || this.options.busy?.()) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.process(); this.running = run;
    void run.finally(() => { if (this.running === run) this.running = undefined; }).catch(() => undefined);
    return run;
  }
  private async process(): Promise<void> {
    for (let count = 0; count < 4 && !this.closed && !this.options.busy?.(); count++) {
      const job = (await this.options.request({ type: 'memory.tags.claim' })).memoryTagJob;
      if (!job) return;
      this.controller = new AbortController(); this.owner = job.companionId; this.noteId = job.noteId;
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
      } finally { this.controller = undefined; this.owner = undefined; this.noteId = undefined; }
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
  async close(): Promise<void> { this.closed = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.running; }
}
