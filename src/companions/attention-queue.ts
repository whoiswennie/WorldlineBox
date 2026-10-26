import type { CompanionConnection } from './store';
import { companionTaskCanClaim } from './task-concurrency-store';
export const COMPANION_INBOX_LIMIT = 100;
/** Both user chats and peer conversations share one bounded FIFO inbox. SQL
 * admission runs inside the caller's IMMEDIATE transaction. */
export function assertCompanionInboxCapacity(db: CompanionConnection, owner: string) {
  const value = db.prepare(`SELECT
    (SELECT count(*) FROM companion_work_queue WHERE companion_id=? AND status IN('queued','interrupted')) +
    (SELECT count(*) FROM companion_social_jobs WHERE companion_id=? AND status IN('pending','failed') AND COALESCE(json_extract(data,'$.terminal'),0)=0) AS total`).get(owner, owner) as { total: number };
  if (value.total >= COMPANION_INBOX_LIMIT) throw new Error('这位伙伴的待处理消息已满100条，请等候处理完成后重试。消息未加入队列。');
}
export function companionAttentionCanClaim(db: CompanionConnection, owner: string, sourceMessageId: string) {
  if (!companionTaskCanClaim(db, owner)) return false;
  const earlier = db.prepare(`SELECT 1 FROM companion_work_queue q JOIN messages m ON m.id=json_extract(q.data,'$.sourceMessageId')
    WHERE q.companion_id=? AND q.status='queued' AND COALESCE(json_extract(q.data,'$.proactive'),0)=0 AND m.sequence<(SELECT sequence FROM messages WHERE id=?)
    UNION ALL SELECT 1 FROM companion_social_jobs q JOIN messages m ON m.id=json_extract(q.data,'$.sourceMessageId')
    WHERE q.companion_id=? AND q.status IN('pending','failed') AND COALESCE(json_extract(q.data,'$.terminal'),0)=0
      AND json_extract(q.data,'$.attempts')<8 AND m.sequence<(SELECT sequence FROM messages WHERE id=?) LIMIT 1`)
    .get(owner, sourceMessageId, owner, sourceMessageId);
  return !earlier;
}
