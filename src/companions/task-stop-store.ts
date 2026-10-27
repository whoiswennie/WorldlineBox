import type { CompanionConnection } from './store';
import { advanceCompanionReplyTiming } from '../shared/companion-reply-progress';
import { companionTaskStopReceiptSchema, type CompanionTaskStopReceipt } from '../shared/companion-task-stop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

const tables = { reply: 'companion_work_queue', action: 'actions', activity: 'companion_activity_tasks', 'work-order': 'companion_work_orders', schedule: 'companion_schedules',
  schedule_occurrence: 'companion_schedule_occurrences', world: 'companion_world_jobs', social: 'companion_social_jobs', social_notification: 'companion_social_notifications',
  learning: 'companion_learning_grants', learning_goal: 'companion_learning_goals', memory_tags: 'companion_memory_tag_jobs' } as const;
type StopKind = CompanionTaskStopReceipt['kind'];
type StoredRow = { data?: string; companion_id?: string; status?: string; autonomous?: number; enabled?: number; state?: string; conversation_id?: string };
const stopped = (kind: StopKind, row: StoredRow, value: Record<string, unknown>) => kind === 'world'
  ? row.status === 'done' && (value.stop as { actor?: string } | undefined)?.actor === 'user'
  : kind === 'learning' ? row.enabled === 1 && row.autonomous === 0
    : kind === 'learning_goal' ? row.state === 'stopped' : row.status === 'cancelled';
/** Bounded host-decision ledger. It cannot authorize work or fabricate a reply. */
export class CompanionTaskStopStore {
  constructor(private readonly db: CompanionConnection) {}
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type !== 'task-stop.record' && command.type !== 'task-stop.list') return;
    if (!this.db.prepare('SELECT 1 FROM conversation_members WHERE companion_id=? AND conversation_id=?').get(command.companionId, command.conversationId)) throw new Error('停止记录不属于当前伙伴或聊天。');
    const key = 'user-task-stops/' + command.companionId;
    const read = (): CompanionTaskStopReceipt[] => {
      const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
      if (!found) return [];
      return (JSON.parse(found.value) as unknown[]).flatMap(value => { const parsed = companionTaskStopReceiptSchema.safeParse(value); return parsed.success ? [parsed.data] : []; });
    };
    if (command.type === 'task-stop.list') return { ok: true, userTaskStops: read().filter(item => {
      const primary = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('primary-chat-topic/' + command.conversationId) as { value: string } | undefined;
      if (item.conversationId !== command.conversationId || (item.topicId ?? null) !== (command.topicId ?? primary?.value ?? null)) return false;
      const found = this.db.prepare(`SELECT * FROM ${tables[item.kind]} WHERE id=?`).get(item.taskId) as StoredRow | undefined;
      return !!found && stopped(item.kind, found, found.data ? JSON.parse(found.data) : {});
    }).slice(-(command.limit ?? 12)).reverse() };
    return this.db.transaction(() => {
      const table = tables[command.kind];
      const found = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(command.taskId) as StoredRow | undefined;
      if (!found) throw new Error('任务不存在，不能登记手动停止。');
      const value = found.data ? JSON.parse(found.data) : {};
      const owner = value.companionId ?? found.companion_id;
      const room = value.conversationId ?? found.conversation_id ?? 'world_' + owner;
      if (owner !== command.companionId || room !== command.conversationId || !stopped(command.kind, found, value)) throw new Error('只可登记当前伙伴已停止的任务。');
      const topic = value.sourceMessageId ? this.db.prepare('SELECT topic_id FROM companion_message_topics WHERE message_id=?').get(value.sourceMessageId) as { topic_id?: string } | undefined : undefined;
      const receipt = companionTaskStopReceiptSchema.parse({ companionId: command.companionId, conversationId: command.conversationId,
        taskId: command.taskId, kind: command.kind, title: command.title, stop: command.stop, ...(topic?.topic_id ? { topicId: topic.topic_id } : {}) });
      const entries = read().filter(item => item.kind !== command.kind || item.taskId !== command.taskId);
      entries.push(receipt);
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(entries.slice(-100)));
      value.stop = command.stop;
      if (command.kind === 'action') { value.stage = '用户已停止，已完成的步骤保留'; delete value.error; }
      if (command.kind === 'activity') value.stage = '用户手动停止了这项任务，停止后续步骤；已经发生的实际行为保留。';
      if (found.data) this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(value), command.taskId);
      if (command.kind === 'reply' && value.messageId) {
        const metadataKey = 'message-loop/' + value.messageId;
        const stored = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(metadataKey) as { value: string } | undefined;
        if (stored) {
          const loop = JSON.parse(stored.value);
          loop.progress = advanceCompanionReplyTiming(loop.progress, { ...loop.progress, revision: (loop.progress?.revision ?? 0) + 1, phase: 'cancelled', detail: '用户已停止这次回复',
            stop: command.stop, finishedAt: command.stop.requestedAt, updatedAt: command.stop.requestedAt });
          for (const loopKey of [metadataKey, `loop/${value.sourceMessageId}/${value.companionId}` + (value.proactive ? '/invocation/' + value.id : '')])
            this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(loopKey, JSON.stringify(loop));
        }
      }
      return { ok: true, userTaskStops: [receipt] };
    }).immediate();
  }
}
