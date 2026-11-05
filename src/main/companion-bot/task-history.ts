import { createHash } from 'node:crypto';
import { setImmediate as yieldToRuntime } from 'node:timers/promises';
import type { BotStore, BotTaskSql } from './store';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const attachments = (value: unknown) => [...new Set(Array.isArray(value) ? value : [])].sort();
export function botTaskRemovalFingerprint(input: { sourceEventId: string; goal: string; attachmentIds?: unknown; title?: unknown }): string {
  return digest([input.sourceEventId, input.goal, attachments(input.attachmentIds), typeof input.title === 'string' ? input.title : null]);
}
export interface BotTaskHistoryClearResult { cleared: number; remaining: number; recordsOnly: true }
interface ClearReceipt { fingerprint: string; input: ClearInput; cleared: number; stamp: string; result?: BotTaskHistoryClearResult }
const running = new WeakMap<BotStore, Map<string, { fingerprint: string; promise: Promise<BotTaskHistoryClearResult> }>>();

/** Keep only an admission tombstone after the task's business text is cleared.
 * Older stores may not have initialized the companion runtime tables yet. */
function clearTaskMandateBody(sql: BotTaskSql, taskId: string): void {
  if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_task_mandates'").get()) return;
  const saved = sql.prepare('SELECT id,record_json,fingerprint FROM bot_task_mandates WHERE task_id=?').get(taskId) as { id: string; record_json: string; fingerprint: string } | undefined;
  if (!saved) return;
  const previous = JSON.parse(saved.record_json) as { sourceEventId?: string; authorizingEventId?: string; originalFingerprint?: string };
  const tombstone = { removed: true, taskId, id: saved.id, sourceEventId: previous.sourceEventId, authorizingEventId: previous.authorizingEventId,
    originalFingerprint: previous.originalFingerprint ?? saved.fingerprint };
  sql.prepare("UPDATE bot_task_mandates SET record_json=?,state='withdrawn' WHERE task_id=?").run(JSON.stringify(tombstone), taskId);
  if (sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_task_subscriptions'").get())
    sql.prepare("UPDATE bot_task_subscriptions SET state='stopped' WHERE task_id=?").run(taskId);
}
type ClearInput = { conversationId: string; requestId: string; taskId?: string; companionId?: string };

/** Removes ended-task bodies from the catalog while preserving the minimum
 * original admission identity. A replay cannot turn a removed record into a
 * fresh worker. Files, media grants and native execution logs are untouched. */
export function clearBotTaskHistory(store: BotStore, input: ClearInput): Promise<BotTaskHistoryClearResult> {
  const key = `task-history-clear:${digest([input.conversationId, input.requestId])}`, fingerprint = digest([input.conversationId, input.taskId ?? null, input.companionId ?? null]);
  let operations = running.get(store); if (!operations) { operations = new Map(); running.set(store, operations); }
  const previous = operations.get(key);
  if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.reject(new Error('同一清理操作标识对应不同范围。'));
  const ownedOperations = operations;
  const promise = clearHistory(store, input, key, fingerprint).finally(() => { if (ownedOperations.get(key)?.promise === promise) ownedOperations.delete(key); });
  ownedOperations.set(key, { fingerprint, promise }); return promise;
}
export async function resumeBotTaskHistoryClears(store: BotStore): Promise<void> {
  while (true) {
    const pending = store.taskTransaction(sql => sql.prepare("SELECT value FROM bot_metadata WHERE key LIKE 'task-history-clear:%' AND json_extract(value,'$.result') IS NULL LIMIT 8").all()) as Array<{ value: string }>;
    if (!pending.length) return;
    for (const item of pending) { const receipt = JSON.parse(item.value) as ClearReceipt; await clearBotTaskHistory(store, receipt.input); }
  }
}
async function clearHistory(store: BotStore, input: ClearInput, key: string, fingerprint: string): Promise<BotTaskHistoryClearResult> {
  if (![input.conversationId, input.requestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 300)) throw new Error('清理操作标识无效。');
  const receipt = store.taskTransaction(sql => {
    if (!store.getConversation(input.conversationId)) throw new Error('聊天不存在。');
    const saved = store.getMetadata(key);
    if (saved) {
      const receipt = JSON.parse(saved) as ClearReceipt;
      if (receipt.fingerprint !== fingerprint) throw new Error('同一清理操作标识对应不同范围。');
      return receipt;
    }
    const predicates = ['conversation_id=?'], args: string[] = [input.conversationId];
    if (input.companionId) { predicates.push('companion_id=?'); args.push(input.companionId); }
    if (input.taskId) {
      const target = sql.prepare('SELECT conversation_id,companion_id,status FROM bot_tasks WHERE id=?').get(input.taskId) as { conversation_id: string; companion_id: string; status: string } | undefined;
      if (!target || target.conversation_id !== input.conversationId || input.companionId && target.companion_id !== input.companionId) throw new Error('任务不属于当前聊天和伙伴。');
      if (!['succeeded', 'failed', 'cancelled'].includes(target.status)) throw new Error('任务尚未结束，请先停止并核实执行结果，再移除记录。');
      predicates.push('id=?'); args.push(input.taskId);
    }
    predicates.push("status IN ('succeeded','failed','cancelled')", "json_extract(extra_json,'$.removedAt') IS NULL");
    // Freeze membership before yielding. Later tasks never enter this request.
    // Both its remaining IDs and progress survive shutdown between batches.
    sql.prepare(`CREATE TABLE IF NOT EXISTS bot_task_history_clear_targets(request_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES bot_tasks(id) ON DELETE CASCADE,PRIMARY KEY(request_key,task_id))`).run();
    sql.prepare(`INSERT INTO bot_task_history_clear_targets(request_key,task_id) SELECT ?,id FROM bot_tasks WHERE ${predicates.join(' AND ')}`).run(key, ...args);
    const receipt: ClearReceipt = { fingerprint, input, cleared: 0, stamp: new Date().toISOString() };
    store.setMetadata(key, JSON.stringify(receipt)); return receipt;
  });
  if (receipt.result) return receipt.result;
  while (true) {
    const finished = store.taskTransaction(sql => {
      const current = JSON.parse(store.getMetadata(key)!) as ClearReceipt;
      if (current.fingerprint !== fingerprint) throw new Error('清理操作范围发生变化。');
      if (current.result) return current.result;
      const page = sql.prepare(`SELECT t.id,t.source_event_id,t.goal,t.extra_json FROM bot_task_history_clear_targets c JOIN bot_tasks t ON t.id=c.task_id WHERE c.request_key=? ORDER BY t.id LIMIT 16`)
        .all(key) as Array<{ id: string; source_event_id: string; goal: string; extra_json: string }>;
      for (const task of page) {
        const extra = JSON.parse(task.extra_json) as Record<string, unknown>;
        if (extra.removedAt) { sql.prepare('DELETE FROM bot_task_history_clear_targets WHERE request_key=? AND task_id=?').run(key, task.id); continue; }
        const minimal = { removedAt: current.stamp, removedFingerprint: botTaskRemovalFingerprint({ sourceEventId: task.source_event_id, goal: task.goal, attachmentIds: extra.attachmentIds, title: extra.title }),
          attachmentIds: attachments(extra.attachmentIds), ...(typeof extra.title === 'string' ? { title: extra.title.slice(0, 120) } : {}),
          ...(extra.nativeAttempted === true ? { nativeAttempted: true } : {}) };
        sql.prepare("UPDATE bot_tasks SET goal='',summary=NULL,error=NULL,extra_json=? WHERE id=?").run(JSON.stringify(minimal), task.id);
        sql.prepare('DELETE FROM bot_task_presence_events WHERE task_id=?').run(task.id);
        sql.prepare('DELETE FROM bot_task_controls WHERE task_id=?').run(task.id);
        sql.prepare('DELETE FROM bot_task_answer_receipts WHERE task_id=?').run(task.id);
        sql.prepare('DELETE FROM bot_task_questions WHERE task_id=?').run(task.id);
        clearTaskMandateBody(sql, task.id);
        const reportPrefix = `task-report:${task.id}:`;
        sql.prepare('DELETE FROM bot_metadata WHERE substr(key,1,length(?))=?').run(reportPrefix, reportPrefix);
        // Effects retain their identities and outcome, never their old inputs.
        sql.prepare("UPDATE bot_task_effects SET preview='' WHERE task_id=?").run(task.id);
        sql.prepare('DELETE FROM bot_task_history_clear_targets WHERE request_key=? AND task_id=?').run(key, task.id);
        current.cleared++;
      }
      if (page.length) { store.setMetadata(key, JSON.stringify(current)); return; }
      const remaining = Number((sql.prepare(`SELECT COUNT(*) AS n FROM bot_tasks WHERE conversation_id=?${input.companionId ? ' AND companion_id=?' : ''} AND json_extract(extra_json,'$.removedAt') IS NULL`).get(input.conversationId, ...(input.companionId ? [input.companionId] : [])) as { n: number }).n);
      current.result = { cleared: current.cleared, remaining, recordsOnly: true };
      store.setMetadata(key, JSON.stringify(current)); return current.result;
    });
    if (finished) return finished;
    // Main remains responsive to chat, stop and native callbacks even when a
    // history contains many thousands of large frozen prompts and reports.
    await yieldToRuntime();
  }
}
