import type { CompanionConnection } from './store';
import type { CompanionSocialJob } from '../shared/companion-social';
import type { CompanionReplyProgress } from '../shared/companion-reply-progress';
import { advanceCompanionReplyTiming } from '../shared/companion-reply-progress';
import type { CompanionSocialRecall, CompanionSocialReplyProgressEntry, CompanionSocialReplyReceipt } from '../shared/companion-social-reply';
import type { CompanionStorageCommand } from '../shared/companion-storage';
import { createHash } from 'node:crypto';

type Job = CompanionSocialJob & { resultMessageId?: string };
type Row = { data: string; lease_until?: string };
const sourceChecksum = (content: string) => createHash('sha256').update(content).digest('hex');

/** Durable public milestones and the exact focused recall used for one peer reply. */
export class CompanionSocialReplyStore {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_reply_progress(job_id TEXT PRIMARY KEY REFERENCES companion_social_jobs(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_social_reply_receipts(message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_social_reply_pending(job_id TEXT PRIMARY KEY REFERENCES companion_social_jobs(id) ON DELETE CASCADE,lease_token TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  private progress(job: Job): CompanionReplyProgress {
    const saved = this.db.prepare('SELECT data FROM companion_social_reply_progress WHERE job_id=?').get(job.id) as Row | undefined;
    const previous: CompanionReplyProgress | undefined = saved ? JSON.parse(saved.data) : undefined;
    const phase = job.status === 'done' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'failed' ? 'failed' : undefined;
    if (previous && !phase) return previous;
    if (previous && previous.phase === phase) return previous;
    const updatedAt = job.finishedAt ?? job.updatedAt ?? previous?.updatedAt ?? job.createdAt;
    return advanceCompanionReplyTiming(previous, { ...previous, workId: job.id, sourceMessageId: job.sourceMessageId, revision: (previous?.revision ?? 0) + 1,
      phase: phase ?? (job.status === 'running' ? 'context' : 'queued'),
      detail: phase === 'completed' ? '本轮伙伴回复已完成' : phase === 'failed' ? job.terminal ? (job.error ?? '本轮未能继续，等待新资料或明确处理后再试').slice(0, 500) : '本轮伙伴回复尚未完成，等待重试'
        : phase === 'cancelled' ? '本轮伙伴回复已停止' : job.status === 'running' ? '正在核验来信与参与者' : '等待处理这条伙伴来信',
      startedAt: previous?.startedAt ?? job.createdAt, updatedAt, ...(phase ? { finishedAt: updatedAt } : {}) });
  }
  update(input: Extract<CompanionStorageCommand, { type: 'social.job.progress' }>): void {
    const row = this.db.prepare('SELECT data,lease_until FROM companion_social_jobs WHERE id=?').get(input.id) as Row | undefined;
    if (!row) throw new Error('伙伴回复任务不存在。');
    const job = JSON.parse(row.data) as Job;
    const leaseUntil = Date.parse(row.lease_until ?? '');
    if (job.status !== 'running' || job.leaseToken !== input.leaseToken || !Number.isFinite(leaseUntil) || leaseUntil <= Date.now()) throw new Error('伙伴回复租约已经失效。');
    const previous = this.progress(job), progress: CompanionReplyProgress = advanceCompanionReplyTiming(previous, { ...previous,
      phase: input.phase, detail: input.detail, revision: previous.revision + 1, updatedAt: new Date().toISOString(),
      finishedAt: undefined, ...(input.memory ? { memory: input.memory } : {}) });
    this.db.prepare('INSERT INTO companion_social_reply_progress VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(progress));
    if (input.memoryRecall) {
      const source = this.db.prepare('SELECT content FROM messages WHERE id=?').get(job.sourceMessageId) as { content: string } | undefined;
      if (!source) throw new Error('伙伴来信来源已不存在。');
      const receipt: CompanionSocialReplyReceipt = { companionId: job.companionId, conversationId: job.conversationId,
        sourceMessageId: job.sourceMessageId, messageId: job.id, contextThroughSequence: job.throughSequence,
        sourceChecksum: sourceChecksum(source.content), leaseToken: job.leaseToken, progress, context: { user: JSON.stringify({ memories: [], memoryRecall: input.memoryRecall }) } };
      this.db.prepare('INSERT INTO companion_social_reply_pending VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET lease_token=excluded.lease_token,data=excluded.data')
        .run(job.id, job.leaseToken, JSON.stringify(receipt));
    }
  }
  list(conversationId: string, companionId: string | undefined, limit: number): CompanionSocialReplyProgressEntry[] {
    const rows = this.db.prepare(`SELECT data FROM companion_social_jobs WHERE conversation_id=? ${companionId ? 'AND companion_id=?' : ''}
      ORDER BY CASE WHEN status='running' THEN 0 WHEN status='pending' THEN 1 WHEN status='failed' THEN 2 ELSE 3 END,created_at DESC,id DESC LIMIT ?`)
      .all(conversationId, ...(companionId ? [companionId] : []), limit) as Row[];
    return rows.map(row => { const job = JSON.parse(row.data) as Job;
      return { jobId: job.id, companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: job.sourceMessageId,
        ...(job.resultMessageId ? { messageId: job.resultMessageId } : {}), status: job.status, progress: this.progress(job) };
    });
  }
  complete(job: Job, messageId: string | undefined, sourceContent: string, recall?: CompanionSocialRecall): void {
    const previous = this.progress(job), now = new Date().toISOString();
    const progress = advanceCompanionReplyTiming(previous, { ...previous, phase: 'completed', detail: messageId ? '已发送本轮伙伴回复' : '本轮无需继续发言', updatedAt: now, finishedAt: previous.finishedAt ?? now });
    this.db.prepare('INSERT INTO companion_social_reply_progress VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(progress));
    if (!messageId || !recall) return;
    const receipt: CompanionSocialReplyReceipt = { companionId: job.companionId, conversationId: job.conversationId,
      sourceMessageId: job.sourceMessageId, messageId, contextThroughSequence: job.throughSequence,
      sourceChecksum: sourceChecksum(sourceContent), progress, context: { user: JSON.stringify({ memories: [], memoryRecall: recall }) } };
    this.db.prepare('INSERT INTO companion_social_reply_receipts VALUES(?,?)').run(messageId, JSON.stringify(receipt));
  }
  receipt(messageId: string): CompanionSocialReplyReceipt | undefined {
    const found = this.db.prepare('SELECT data FROM companion_social_reply_receipts WHERE message_id=?').get(messageId) as Row | undefined;
    return found ? JSON.parse(found.data) as CompanionSocialReplyReceipt : undefined;
  }
  terminal(job: Job, detail?: string): void {
    if (!['pending', 'done', 'failed', 'cancelled'].includes(job.status)) return;
    const previous = this.progress(job);
    const progress = advanceCompanionReplyTiming(previous, { ...previous, ...(job.status === 'pending' ? { phase: 'queued' as const,
      detail: '等待重新处理这条伙伴来信', memory: undefined, finishedAt: undefined } : {}),
      ...(detail ? { detail: detail.slice(0, 500) } : {}), updatedAt: new Date().toISOString() });
    this.db.prepare('INSERT INTO companion_social_reply_progress VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET data=excluded.data').run(job.id, JSON.stringify(progress));
    this.db.prepare('DELETE FROM companion_social_reply_pending WHERE job_id=?').run(job.id);
  }
  pending(jobId: string): CompanionSocialReplyReceipt | undefined {
    const found = this.db.prepare(`SELECT p.data FROM companion_social_reply_pending p JOIN companion_social_jobs j ON j.id=p.job_id
      WHERE p.job_id=? AND j.status='running' AND j.lease_until>? AND json_extract(j.data,'$.leaseToken')=p.lease_token`).get(jobId, new Date().toISOString()) as Row | undefined;
    return found ? JSON.parse(found.data) as CompanionSocialReplyReceipt : undefined;
  }
}
