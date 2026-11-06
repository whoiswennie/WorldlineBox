import type { BotStore } from './store';
import type { BotEvent } from './types';

/** Current control facts, deliberately without old goals or results. */
export interface BotTaskContextPolicy {
  endedTaskIds: string[]; pausedTaskIds: string[]; endedCount: number; pausedCount: number;
  reminders: 'only-on-request'; authority: 'current-host-state';
}
export function taskContextPolicy(store: BotStore, event: BotEvent): BotTaskContextPolicy | undefined {
  return store.taskTransaction(sql => {
    const scope = [event.companionId, event.conversationId];
    const counts = sql.prepare(`SELECT COALESCE(SUM(status IN ('succeeded','failed','cancelled')),0) AS ended,
      COALESCE(SUM(status='paused'),0) AS paused FROM bot_tasks WHERE companion_id=? AND conversation_id=?`).get(...scope) as { ended: number; paused: number };
    if (!counts.ended && !counts.paused) return;
    const tasks = sql.prepare(`SELECT id,status FROM bot_tasks WHERE companion_id=? AND conversation_id=?
      AND status IN ('succeeded','failed','cancelled','paused') ORDER BY updated_at DESC,id LIMIT 128`).all(...scope) as Array<{ id: string; status: string }>;
    return { authority: 'current-host-state', reminders: 'only-on-request', endedCount: counts.ended, pausedCount: counts.paused,
      endedTaskIds: tasks.filter(task => task.status !== 'paused').map(task => task.id), pausedTaskIds: tasks.filter(task => task.status === 'paused').map(task => task.id) };
  });
}
