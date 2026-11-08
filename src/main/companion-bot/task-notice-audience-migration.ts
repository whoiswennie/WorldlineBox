import { createHash } from 'node:crypto';
import { botHostHistoryRebuildKey } from './host-migration';
import type { BotStore } from './store';
import type { BotEvent } from './types';

const revision = 1;
type Row = Record<string, string | number | null>;
interface Marker { revision: number; state: 'clean' | 'isolated'; epoch: number }
export interface TaskNoticeAudienceIsolation {
  state: 'current' | 'clean' | 'isolated' | 'deferred'; sourceIds: string[]; epoch: number; reason?: string;
}
export const botTaskNoticeAudienceKey = (companionId: string, securityDomainId: string) =>
  'task-notice-audience:' + createHash('sha256').update(JSON.stringify([companionId, securityDomainId])).digest('hex');

function marker(store: BotStore, event: BotEvent): Marker | undefined {
  const value = store.getMetadata(botTaskNoticeAudienceKey(event.companionId, event.securityDomainId));
  if (!value) return;
  const saved = JSON.parse(value) as Marker;
  if (saved.revision !== revision || !['clean', 'isolated'].includes(saved.state) || !Number.isSafeInteger(saved.epoch) || saved.epoch < 1) {
    throw new Error('主脑受众上下文隔离记录无效。');
  }
  return saved;
}

/** VCP withdrawal acknowledgement may advance the epoch again. Rebuild only
 * from the audience-filtered published transcript at that final watermark;
 * never import the old App summary or retention handoff into the new lane. */
export function refreshTaskNoticeAudienceRebuild(store: BotStore, event: BotEvent): void {
  if (marker(store, event)?.state !== 'isolated') return;
  store.taskTransaction(sql => {
    const lanes = sql.prepare(`SELECT l.id,l.epoch,l.conversation_id FROM bot_lanes l JOIN bot_conversations c ON c.id=l.conversation_id
      WHERE l.companion_id=? AND c.domain_id=?`).all(event.companionId, event.securityDomainId) as Row[];
    for (const lane of lanes) {
      sql.prepare('DELETE FROM bot_metadata WHERE key=?').run(`delivered:${lane.id}`);
      store.setMetadata(botHostHistoryRebuildKey(String(lane.id)), JSON.stringify({ epoch: Number(lane.epoch),
        historyThrough: store.historyProjectionHead(String(lane.conversation_id)), reason: 'task-notice-audience-v1' }));
    }
    const current = store.getLane(event.laneId);
    if (current) store.setMetadata(botTaskNoticeAudienceKey(event.companionId, event.securityDomainId),
      JSON.stringify({ revision, state: 'isolated', epoch: current.epoch } satisfies Marker));
  });
}

/** One-time, actor/domain-scoped compatibility fence for older releases which
 * copied another participant's private Worker notices into Router history or
 * VCP. The UI journal, public posts, tasks, Worker Sessions and tool receipts
 * remain intact. A frozen/admitted turn must retire on its original input.
 * Quarantined effects with no live admission can stay cold: AppBrain retains
 * its cross-epoch per-tool effect fence and reconciles without replaying them. */
export function isolateLegacyTaskNoticeContext(input: { store: BotStore; event: BotEvent }): TaskNoticeAudienceIsolation {
  const { store, event } = input;
  return store.taskTransaction(sql => {
    const lane = store.getLane(event.laneId), room = store.getConversation(event.conversationId);
    if (!lane || !room || lane.companionId !== event.companionId || lane.conversationId !== room.id || room.securityDomainId !== event.securityDomainId) {
      throw new Error('主脑受众上下文与当前通道不一致。');
    }
    if (!['peer', 'group'].includes(room.kind) && !room.peerConversation) return { state: 'current', sourceIds: [], epoch: lane.epoch };
    if (marker(store, event)) return { state: 'current', sourceIds: [], epoch: lane.epoch };

    // Scan IDs in indexed pages, without loading a potentially long transcript
    // or any attachment bytes. The visibility rule is shared with future input
    // assembly and memory projection; the migration does not infer recipients.
    const sourceIds: string[] = [];
    let after = 0;
    while (true) {
      const page = sql.prepare(`SELECT m.id,m.sequence FROM bot_messages m JOIN bot_conversations c ON c.id=m.conversation_id
        WHERE c.domain_id=? AND m.sequence>? AND (m.sender_id='task-service' OR m.kind IN ('task_done','task_progress')
          OR EXISTS(SELECT 1 FROM bot_inbox source WHERE source.source_record_id=m.id AND source.source='task'))
        ORDER BY m.sequence LIMIT 200`).all(event.securityDomainId, after) as Row[];
      for (const message of page) if (!store.isMessageVisibleToCompanion(String(message.id), event.companionId)) sourceIds.push(String(message.id));
      if (page.length < 200) break;
      after = Number(page.at(-1)!.sequence);
    }
    const key = botTaskNoticeAudienceKey(event.companionId, event.securityDomainId);
    if (!sourceIds.length) {
      store.setMetadata(key, JSON.stringify({ revision, state: 'clean', epoch: lane.epoch } satisfies Marker));
      return { state: 'clean', sourceIds, epoch: lane.epoch };
    }

    // Binding an event to an epoch is already a durable reservation even when
    // the model has not yet received it. Moving it would invalidate its saved
    // dispatch. Queued new inputs with no binding remain safe to move together.
    const reserved = sql.prepare(`SELECT i.id FROM bot_inbox i WHERE i.companion_id=? AND i.domain_id=?
      AND (i.status='running' AND i.id<>? OR i.status IN ('queued','running') AND (
        EXISTS(SELECT 1 FROM bot_metadata m WHERE m.key IN ('native-input:'||i.id,'event-native-epoch:'||i.id) AND m.value<>'')
        OR i.dsh_event_id IS NOT NULL)) LIMIT 1`).get(event.companionId, event.securityDomainId, event.id);
    if (reserved) return { state: 'deferred', sourceIds, epoch: lane.epoch, reason: 'reserved-router-turn' };
    const unsettled = sql.prepare(`SELECT i.id FROM bot_inbox i WHERE i.companion_id=? AND i.domain_id=? AND (
      EXISTS(SELECT 1 FROM bot_metadata m WHERE m.key='native-admission:'||i.id AND m.value<>'')
      OR i.dsh_event_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bot_metadata terminal WHERE terminal.key='native-terminal-counted:'||i.id AND terminal.value<>'')) LIMIT 1`)
      .get(event.companionId, event.securityDomainId);
    const retiring = sql.prepare(`SELECT r.event_id FROM bot_native_retirements r JOIN bot_lanes l ON l.id=r.lane_id
      JOIN bot_conversations c ON c.id=l.conversation_id WHERE l.companion_id=? AND c.domain_id=? LIMIT 1`)
      .get(event.companionId, event.securityDomainId);
    if (unsettled || retiring) return { state: 'deferred', sourceIds, epoch: lane.epoch, reason: 'native-receipt-unsettled' };

    // Exact notice withdrawal performs a single rotation and enqueues durable,
    // targeted VCP tombstones. An existing tombstone without this policy marker
    // still requires a fresh epoch to fence previously compacted summaries.
    if (!store.withdrawPrivateNoticeSources(event.companionId, event.securityDomainId, sourceIds)) store.rotateDomain(event.companionId, event.securityDomainId);
    const epoch = store.getLane(event.laneId)!.epoch;
    store.setMetadata(key, JSON.stringify({ revision, state: 'isolated', epoch } satisfies Marker));
    refreshTaskNoticeAudienceRebuild(store, event);
    return { state: 'isolated', sourceIds, epoch };
  });
}
