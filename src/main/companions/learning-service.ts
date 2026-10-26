import type { AssetSummary } from '../../shared/asset-types';
import type { CompanionLearningGrant, CompanionLearningJob, CompanionLearningStatus, CompanionLearningWorkspaceCommand } from '../../shared/companion-learning';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { CompanionMemoryInvestigation } from '../../shared/companion-memory-investigation';

export type CompanionLearningPendingQuestion = Pick<CompanionMemoryInvestigation, 'id'> & { question: string; hypothesis: string; nonFactual: true };

export interface CompanionLearningAssets {
  catalog(): Promise<NonNullable<CompanionLearningStatus['libraries']>>;
  grant(input: { libraryId: string; folderId?: string }): Promise<{ libraryName: string; libraryPath: string; folderName?: string }>;
  /** Existing authorization metadata only; may reopen its exact persisted library. */
  describe?(grant: CompanionLearningGrant): Promise<{ libraryName: string; libraryPath: string; folderName?: string }>;
  page(grant: CompanionLearningGrant, afterId?: string, focus?: { pendingQuestions: CompanionLearningPendingQuestion[] }): Promise<{ assets: AssetSummary[]; hasMore: boolean; nextCursor?: string }>;
  asset?(grant: CompanionLearningGrant, assetId: string): Promise<AssetSummary | undefined>;
  read(grant: CompanionLearningGrant, asset: AssetSummary): Promise<{ content: string; revisionId: string; truncated: boolean }>;
}
/** A specific unreadable candidate may be skipped without blocking later files. */
export class CompanionLearningReadError extends Error {
  constructor(readonly code: 'private-source' | 'unsupported-text' | 'source-moved', message: string) { super(message); }
}
class CompanionLearningWaitingError extends Error {}
interface Options {
  assets: CompanionLearningAssets;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  ready?(owner: string, workId: string, signal: AbortSignal, job: CompanionLearningJob): Promise<boolean>;
  end?(owner: string, workId: string): Promise<void>;
  blocked?(owner: string): boolean;
  configured?(owner: string): boolean | Promise<boolean>;
  changed(): void; report(error: unknown): void;
}
/** Bounded actual reading, independent from the user's asset semantic-search switch. */
export class CompanionLearningService {
  private timer?: ReturnType<typeof setTimeout>;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void>; grantId: string }>();
  private pumping?: Promise<void>;
  private closed = false;
  constructor(private readonly options: Options) {}
  start(): void {
    if (this.closed || this.timer) return;
    const next = () => { this.timer = undefined; void this.tick().catch(this.options.report).finally(() => {
      if (!this.closed) { this.timer = setTimeout(next, 5000); this.timer.unref(); }
    }); };
    this.timer = setTimeout(next, 1000); this.timer.unref();
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pumping) return this.pumping;
    const pending = this.pump(); this.pumping = pending;
    void pending.finally(() => { if (this.pumping === pending) this.pumping = undefined; }).catch(() => undefined);
    return pending;
  }
  private async request(command: CompanionStorageCommand): Promise<CompanionStorageResponse> {
    const response = await this.options.request(command); if (!response.ok) throw new Error(response.error ?? '学习存储不可用。'); return response;
  }
  private async pump(): Promise<void> {
    while (!this.closed && this.active.size < 2) {
      const job = (await this.request({ type: 'learning.claim', excludedOwners: [...this.active.keys()], leaseMs: 120000 })).learningJob;
      if (!job || this.closed) break;
      const controller = new AbortController();
      const promise = new Promise<void>(resolve => setImmediate(resolve)).then(() => this.process(job, controller.signal))
        .catch(this.options.report).finally(() => { this.active.delete(job.grant.companionId); this.options.changed(); });
      this.active.set(job.grant.companionId, { controller, promise, grantId: job.grant.id });
    }
  }
  private async process(job: CompanionLearningJob, signal: AbortSignal): Promise<void> {
    const owner = job.grant.companionId, workId = 'learning_' + job.leaseToken;
    try {
      if (this.options.configured && !await this.options.configured(owner)) throw new CompanionLearningWaitingError('等待此伙伴可用的聊天模型配置，尚未读取或内化资料。');
      signal.throwIfAborted();
      if (this.options.blocked?.(owner) || this.options.ready && !await this.options.ready(owner, workId, signal, job)) throw new CompanionLearningWaitingError('等待伙伴醒来或完成手头的事情。');
      signal.throwIfAborted();
      const queued = job.grant.autonomous ? (await this.request({ type: 'world.investigations.list', companionId: owner, limit: 20 })).memoryInvestigations ?? [] : [];
      const pendingQuestions: CompanionLearningPendingQuestion[] = queued.filter(item => item.status === 'pending').slice(0, 3)
        .map(item => ({ id: item.id, question: item.proposal.question, hypothesis: item.proposal.hypothesis, nonFactual: true }));
      const page = await this.options.assets.page(job.grant, job.afterAssetId, { pendingQuestions });
      signal.throwIfAborted();
      // Questions can prioritize a matching title within the already authorized
      // bounded page. They cannot choose a new root, grant or network source,
      // interrupt a partial read, or replace an explicit learning goal.
      const focused = page.assets.find(asset => { const title = asset.displayName.replace(/\.[^.]+$/u, '').trim();
        return title.length >= 2 && pendingQuestions.some(item => item.question.includes(title)); });
      const asset = job.assetId ? page.assets.find(asset => asset.assetId === job.assetId) : focused ?? page.assets[0];
      if (!asset) {
        await this.request({ type: 'learning.advance', id: job.id, leaseToken: job.leaseToken, afterAssetId: job.assetId ?? page.nextCursor, more: !!job.assetId || page.hasMore,
          ...(page.assets.length ? { reason: '上次阅读的资料已经移动或删除，正在继续核对。' } : {}) }); return;
      }
      let document: Awaited<ReturnType<CompanionLearningAssets['read']>>;
      try { document = await this.options.assets.read(job.grant, asset); }
      catch (error) {
        if (!(error instanceof CompanionLearningReadError)) throw error;
        signal.throwIfAborted();
        await this.request({ type: 'learning.advance', id: job.id, leaseToken: job.leaseToken, afterAssetId: asset.assetId,
          more: page.hasMore || page.assets.length > 1, reason: error.message.slice(0, 500) }); return;
      }
      signal.throwIfAborted();
      // A partial preview cannot be represented as a complete reading. Large sources
      // remain pending for an appropriate reader instead of silently losing their tail.
      if (document.truncated) {
        await this.request({ type: 'learning.advance', id: job.id, leaseToken: job.leaseToken, afterAssetId: asset.assetId,
          more: page.hasMore || page.assets.length > 1, reason: '此资料超过 2 MiB 文本阅读范围，未读取或内化；可拆分后重试，正在继续其它资料。' }); return;
      }
      const offset = job.assetRevisionId === document.revisionId ? job.offset : 0;
      let end = Math.min(document.content.length, offset + 12000);
      if (end < document.content.length && /[\uD800-\uDBFF]/u.test(document.content[end - 1]!) && /[\uDC00-\uDFFF]/u.test(document.content[end]!)) end--;
      const content = document.content.slice(offset, end);
      if (!content.trim()) { await this.request({ type: 'learning.advance', id: job.id, leaseToken: job.leaseToken, afterAssetId: asset.assetId, more: page.hasMore || page.assets.length > 1 }); return; }
      const nextOffset = offset + content.length < document.content.length ? offset + content.length : undefined;
      await this.request({ type: 'learning.commit', id: job.id, leaseToken: job.leaseToken, assetId: asset.assetId,
        assetRevisionId: document.revisionId, assetName: asset.displayName, offset, content,
        nextOffset, afterAssetId: job.afterAssetId, more: page.hasMore || page.assets.length > 1 });
    } catch (error) {
      await this.request({ type: 'learning.defer', id: job.id, leaseToken: job.leaseToken,
        state: signal.aborted || error instanceof CompanionLearningWaitingError ? 'waiting' : 'failed',
        error: signal.aborted ? '学习已停止，尚未提交的读取不会进入记忆。' : error instanceof Error ? error.message.slice(0, 500) : '学习尚未完成。', retryAfterMs: 30000 }).catch(() => undefined);
      if (!signal.aborted && !(error instanceof Error && /等待|资料超过|资料来源|取消|权限/u.test(error.message))) this.options.report(error);
    } finally { await this.options.end?.(owner, workId).catch(this.options.report); }
  }
  async handle(command: CompanionLearningWorkspaceCommand): Promise<CompanionWorkspaceResponse> {
    if (this.closed) return { ok: false, error: '学习服务已关闭。' };
    let response: CompanionStorageResponse;
    if (command.type === 'memory.learning.grant') {
      const resolved = await this.options.assets.grant(command);
      response = await this.request({ ...command, ...resolved, type: 'learning.grant' });
    } else {
      const type = command.type.replace('memory.', '') as 'learning.status' | 'learning.update' | 'learning.revoke' | 'learning.run';
      response = await this.request({ ...command, type } as CompanionStorageCommand);
      if (type === 'learning.revoke' || type === 'learning.update') this.cancel(command.companionId);
    }
    const learning = response.learning;
    if (!learning) throw new Error('无法读取学习来源。');
    try { learning.libraries = await this.options.assets.catalog(); }
    catch (error) {
      // Source discovery is auxiliary. In particular, a committed revocation
      // must remain reviewable even while the separate asset Worker is down.
      this.options.report(error); learning.libraries = [];
    }
    if (command.type !== 'memory.learning.status') { this.options.changed(); void this.tick().catch(this.options.report); }
    return { ok: true, learning };
  }
  cancel(owner: string): void { this.active.get(owner)?.controller.abort(); }
  stopGrant(owner: string, grantId: string): void {
    const job = this.active.get(owner); if (job?.grantId === grantId) job.controller.abort();
  }
  async drain(owner: string): Promise<void> {
    // A cancellation can race the asynchronous claim before it enters active.
    await this.pumping;
    this.cancel(owner);
    await this.active.get(owner)?.promise;
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer);
    for (const job of this.active.values()) job.controller.abort();
    await this.pumping; await Promise.allSettled([...this.active.values()].map(job => job.promise));
  }
}
