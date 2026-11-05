import { BotStore } from '../../src/main/companion-bot/store';
import { BotTaskRuntime } from '../../src/main/companion-bot/task-runtime';
import { BotTaskReports } from '../../src/main/companion-bot/task-report';
import type { BotToolCall } from '../../src/main/companion-bot/tool-server';

/** The actual App effect journal/admission implementation, in a fresh DB.
 * This never executes a tool or fabricates its result. Native DSH still owns it. */
export function createOwnedNativeEffectHost(filename: string) {
  const store = new BotStore(filename), runtime = new BotTaskRuntime(store), reports = new BotTaskReports(store);
  const companion = store.createCompanion({ name: '原生工具验收来源', persona: '仅用于新隔离验收来源与工具回执。' });
  const tasks = new Map<string, string>();
  return {
    register(taskId: string, goal: string) {
      const conversation = store.openDirect(companion.id);
      const source = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: goal, recipientIds: [companion.id] }).events[0];
      if (!source) throw new Error('Owned effect task source was not created.');
      const task = store.createTask({ id: taskId, conversationId: conversation.id, companionId: companion.id, sourceEventId: source.id, goal });
      store.updateTask(task.id, { status: 'running', extra: { ...task.extra, nativeAttempted: true } });
      const laneId = `worker-${task.id}`, eventId = `work-${task.id}`; tasks.set(laneId, task.id);
      return { laneId, eventId };
    },
    owns(laneId: string) { return tasks.has(laneId); },
    handle(call: BotToolCall) {
      const id = tasks.get(call.laneId), task = id && store.getTask(id);
      if (!task || call.eventId !== `work-${task.id}` || call.name !== 'worker_report' && call.callId !== call.args.callId) throw new Error('Owned worker effect callback identity mismatch.');
      if (call.name === 'worker_effect_start') return runtime.startEffect(task, call.args);
      if (call.name === 'worker_effect_commit') return runtime.commitEffect(task, call.args);
      if (call.name === 'worker_report') { runtime.assertAdmittedHostTool(task.id, call.callId, call.name, call.args); return reports.record(task, call.callId, call.args); }
      throw new Error('This fixture only admits native effect start/commit callbacks.');
    },
    rows() { return store.taskTransaction(sql => sql.prepare('SELECT * FROM bot_task_effects ORDER BY created_at,call_id').all()); },
    report(taskId: string) { const task = store.getTask(taskId); return task && reports.current(task); },
    close() { store.close(); },
  };
}
