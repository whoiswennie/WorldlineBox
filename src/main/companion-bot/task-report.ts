import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotStore } from './store';
import type { BotTask } from './types';
import { BotDshBrain } from './dsh-brain';

export const botWorkerReportSchema = z.strictObject({
  state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  summary: z.string().trim().min(1).max(16000),
  verification: z.array(z.string().trim().min(1).max(2000)).max(16).default([]),
}).refine(value => value.state !== 'ready' || value.verification.length > 0,
  { message: '完成报告必须说明实际核验了什么；文字交付也可以核验，不要求生成文件。' });
export type BotWorkerReport = z.infer<typeof botWorkerReportSchema>;
export interface BotStoredWorkerReport extends BotWorkerReport {
  callId: string; nativeSessionId: string; nativeCallId: string; receivedAt: string; effectRow: number;
}

/** Optional business reports belong to the task's root executor. They can
 * explain a pause or failure; child reports cannot close the parent task. */
export class BotTaskReports {
  constructor(private readonly store: BotStore) {}
  /** The native ending and the root business report are independent receipts.
   * A short closing sentence must not erase the actual deliverable submitted
   * through worker_report. Preserve both, without guessing which prose is
   * useful. Only a current, durably recorded ready report can supplement it. */
  deliveryText(task: BotTask, nativeText: string): string {
    const report = this.currentReady(task);
    if (!report) return nativeText;
    const body = nativeText.trim(), summary = report.summary;
    if (body.includes(summary)) return nativeText;
    if (!body || summary.includes(body)) return summary;
    return summary + '\n\n【执行器补充正文】\n' + nativeText;
  }
  currentReady(task: BotTask): BotStoredWorkerReport | undefined {
    const report = this.current(task);
    return report?.state === 'ready' && this.readyIsCurrent(task, report) ? report : undefined;
  }
  record(task: BotTask, callId: string, input: unknown): BotStoredWorkerReport {
    const wire = z.object({ nativeSessionId: z.string().min(1), nativeCallId: z.string().min(1) }).passthrough().parse(input);
    const { nativeSessionId, nativeCallId, ...body } = wire;
    if (nativeSessionId !== BotDshBrain.sessionId(`worker-${task.id}`) || nativeCallId !== callId)
      throw new Error('只有任务根执行器可以提交本任务业务报告，子任务不能结束父任务。');
    const report = botWorkerReportSchema.parse(body), fingerprint = createHash('sha256').update(JSON.stringify(report)).digest('hex');
    return this.store.taskTransaction(sql => {
      const key = `task-report:${task.id}:${callId}`, prior = this.store.getMetadata(key);
      if (prior) {
        const saved = JSON.parse(prior) as { fingerprint: string; report: BotStoredWorkerReport };
        if (saved.fingerprint !== fingerprint) throw new Error('同一报告回执不能改写业务结果。');
        return saved.report;
      }
      const effect = sql.prepare("SELECT rowid AS position FROM bot_task_effects WHERE task_id=? AND call_id=? AND tool_name='worker_report' AND state='pending'").get(task.id, callId) as { position: number } | undefined;
      if (!effect) throw new Error('业务报告缺少对应的原生工具执行前回执。');
      const stored: BotStoredWorkerReport = { ...report, callId, nativeSessionId, nativeCallId, receivedAt: new Date().toISOString(), effectRow: effect.position };
      const current = this.store.getTask(task.id);
      if (!current || current.extra.cancelRequested || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(current.status)) throw new Error('任务当前不可提交新的业务报告。');
      this.store.setMetadata(key, JSON.stringify({ fingerprint, report: stored }));
      this.store.updateTask(task.id, { extra: { ...current.extra, workerReport: stored } });
      return stored;
    });
  }
  current(task: BotTask): BotStoredWorkerReport | undefined {
    const report = task.extra.workerReport as BotStoredWorkerReport | undefined;
    if (!report) return;
    const receipt = this.store.getMetadata(`task-report:${task.id}:${report.callId}`); if (!receipt) return;
    const saved = JSON.parse(receipt) as { fingerprint: string; report: BotStoredWorkerReport };
    const body = botWorkerReportSchema.parse({ state: saved.report.state, summary: saved.report.summary, verification: saved.report.verification });
    if (saved.fingerprint !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) throw new Error('任务业务报告的耐久回执校验失败。');
    if (task.extra.reportBaseline === report.callId) return;
    return saved.report;
  }
  /** Any later native tool step invalidates this report. Verification belongs
   * before the final ready report so the host need not guess a tool's effects. */
  readyIsCurrent(task: BotTask, report: BotStoredWorkerReport): boolean {
    return this.store.taskTransaction(sql => {
      const anchor = sql.prepare("SELECT rowid AS position FROM bot_task_effects WHERE task_id=? AND call_id=? AND tool_name='worker_report'").get(task.id, report.callId) as { position: number } | undefined;
      return !!anchor && !sql.prepare('SELECT 1 FROM bot_task_effects WHERE task_id=? AND rowid>? AND tool_name<>? LIMIT 1').get(task.id, anchor.position, 'worker_report');
    });
  }
}
