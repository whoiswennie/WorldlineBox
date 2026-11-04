import { createHash } from 'node:crypto';
import path from 'node:path';
import { botLaneRetentionKey, type BotStore } from './store';
import type { BotHistoryProjector } from './history-projection';
import type { BotCompanion, BotLane } from './types';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nativeLaneId = (lane: BotLane) => lane.epoch === 1 ? lane.id : `${lane.id}-epoch-${lane.epoch}`;
export const botNativeHostBindingKey = (id: string) => `native-host:${id}`;
export const botHostHistoryRebuildKey = (laneId: string) => `host-history-rebuild:${laneId}`;
/** A companion is a human-readable group; each audience retains its own files. */
export function botConversationWorkdir(root: string, companion: BotCompanion, conversationId: string, store: BotStore): string {
  const group = botCompanionWorkdir(root, companion, store);
  return path.join(group, `${path.basename(group)}--${digest(conversationId).slice(0, 12)}`);
}
export const botHostMigrationKey = (fromHostId: string, toHostId: string) => `host-migration:${digest(JSON.stringify([fromHostId, toHostId]))}`;
const laneMarker = (key: string, laneId: string) => `${key}:lane:${laneId}`;
type Row = Record<string, string | number | null>;
export type BotHostMigrationBlockReason = 'pending-events' | 'native-uncertain' | 'active-tasks' | 'unknown-effects' | 'history-archive-failed' | 'history-unconfirmed' | 'lane-changed' | 'host-binding-conflict';
export interface BotHostMigrationBlock { laneId: string; eventIds: string[]; taskIds: string[]; nativeLaneIds: string[]; reasons: BotHostMigrationBlockReason[] }
export interface BotHostMigrationResult { complete: boolean; migratedLaneIds: string[]; alreadyMigratedLaneIds: string[]; removedLaneIds: string[]; blocked: BotHostMigrationBlock[] }
interface Plan { version: 1; fromHostId: string; toHostId: string; laneIds: string[]; complete: boolean }
interface Inspection { lane?: BotLane; domainId?: string; block: BotHostMigrationBlock }
const hostId = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || value.includes('\0')) throw new Error('主脑 Host 标识无效。');
  return value;
};

function inspect(store: BotStore, laneId: string): Inspection {
  const lane = store.getLane(laneId), conversation = lane && store.getConversation(lane.conversationId);
  const block: BotHostMigrationBlock = { laneId, eventIds: [], taskIds: [], nativeLaneIds: lane ? [nativeLaneId(lane)] : [], reasons: [] };
  if (!lane || !conversation) return { block };
  store.taskTransaction(sql => {
    const pending = sql.prepare("SELECT id FROM bot_inbox WHERE lane_id=? AND status IN ('queued','running')").all(laneId) as Row[];
    if (pending.length) { block.reasons.push('pending-events'); block.eventIds.push(...pending.map(row => String(row.id))); }
    const uncertain = sql.prepare(`SELECT i.id,m.value FROM bot_inbox i LEFT JOIN bot_metadata m ON m.key='native-admission:'||i.id
      WHERE i.lane_id=? AND ((COALESCE(m.value,'')<>'' OR i.dsh_event_id IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM bot_metadata terminal WHERE terminal.key='native-terminal-counted:'||i.id AND terminal.value<>''))`).all(laneId) as Row[];
    const retirements = store.pendingCancelledNativeAdmissions(laneId);
    if (uncertain.length || retirements.length) block.reasons.push('native-uncertain');
    block.eventIds.push(...uncertain.map(row => String(row.id)), ...retirements.map(item => item.eventId));
    block.nativeLaneIds.push(...retirements.map(item => item.nativeLaneId));
    for (const row of uncertain) {
      if (!row.value) continue;
      try { const admission = JSON.parse(String(row.value)) as { nativeLaneId?: unknown }; if (typeof admission.nativeLaneId === 'string') block.nativeLaneIds.push(admission.nativeLaneId); }
      catch { /* A malformed unresolved admission remains blocked. */ }
    }
    const active = store.activeDomainTasks(lane.companionId, conversation.securityDomainId);
    if (active.length) { block.reasons.push('active-tasks'); block.taskIds.push(...active.map(task => task.id)); }
    const effects = sql.prepare(`SELECT DISTINCT t.id FROM bot_tasks t JOIN bot_inbox source ON source.id=t.source_event_id
      WHERE t.companion_id=? AND source.domain_id=? AND EXISTS(SELECT 1 FROM bot_task_effects e WHERE e.task_id=t.id AND e.state IN ('pending','unknown'))`)
      .all(lane.companionId, conversation.securityDomainId) as Row[];
    if (effects.length) { block.reasons.push('unknown-effects'); block.taskIds.push(...effects.map(row => String(row.id))); }
  });
  block.eventIds = [...new Set(block.eventIds)]; block.taskIds = [...new Set(block.taskIds)]; block.nativeLaneIds = [...new Set(block.nativeLaneIds)];
  return { lane, domainId: conversation.securityDomainId, block };
}
function bind(store: BotStore, id: string, instanceId: string): boolean {
  const key = botNativeHostBindingKey(id), saved = store.getMetadata(key);
  if (saved && saved !== instanceId) return false;
  store.setMetadata(key, instanceId); return true;
}
function preserveOldBindings(store: BotStore, block: BotHostMigrationBlock, fromHostId: string): void {
  for (const id of [...block.nativeLaneIds, ...block.taskIds.map(id => `worker-${id}`)]) {
    if (!bind(store, id, fromHostId) && !block.reasons.includes('host-binding-conflict')) block.reasons.push('host-binding-conflict');
  }
}

/** Call once during startup before admitting/scheduling work. The persisted
 * plan freezes only old native lanes; future lanes already belong to shared
 * Host. No old native Session is opened, copied, replayed or deleted here. */
export async function migrateBotHost(input: {
  store: BotStore; projector: Pick<BotHistoryProjector, 'project'>; fromHostId: string; toHostId: string; signal?: AbortSignal;
}): Promise<BotHostMigrationResult> {
  const { store, projector, signal } = input, fromHostId = hostId(input.fromHostId), toHostId = hostId(input.toHostId);
  const result: BotHostMigrationResult = { complete: true, migratedLaneIds: [], alreadyMigratedLaneIds: [], removedLaneIds: [], blocked: [] };
  if (fromHostId === toHostId) return result;
  signal?.throwIfAborted(); const key = botHostMigrationKey(fromHostId, toHostId);
  const plan = store.taskTransaction(sql => {
    const saved = store.getMetadata(key);
    if (saved) {
      const parsed = JSON.parse(saved) as Plan;
      if (parsed.version !== 1 || parsed.fromHostId !== fromHostId || parsed.toHostId !== toHostId || !Array.isArray(parsed.laneIds) || !parsed.laneIds.every(id => typeof id === 'string')) throw new Error('主脑 Host 切换计划无效。');
      return parsed;
    }
    const ids = (sql.prepare(`SELECT l.id FROM bot_lanes l WHERE l.session_id IS NOT NULL
      OR EXISTS(SELECT 1 FROM bot_metadata m WHERE (m.key='delivered:'||l.id OR m.key='lane-retention:'||l.id) AND m.value<>'')
      OR EXISTS(SELECT 1 FROM bot_inbox i WHERE i.lane_id=l.id AND (i.dsh_event_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM bot_metadata m WHERE m.key='native-admission:'||i.id AND m.value<>''))) ORDER BY l.id`).all() as Row[])
      .map(row => String(row.id)).filter(id => {
        const lane = store.getLane(id)!; const binding = store.getMetadata(botNativeHostBindingKey(nativeLaneId(lane)));
        return !binding || binding === fromHostId;
      });
    const created: Plan = { version: 1, fromHostId, toHostId, laneIds: ids, complete: false }; store.setMetadata(key, JSON.stringify(created)); return created;
  });
  for (const laneId of plan.laneIds) {
    signal?.throwIfAborted();
    const done = store.getMetadata(laneMarker(key, laneId));
    if (done) {
      if ((JSON.parse(done) as { removed?: boolean }).removed) result.removedLaneIds.push(laneId); else result.alreadyMigratedLaneIds.push(laneId);
      continue;
    }
    const before = inspect(store, laneId);
    if (!before.lane) { store.setMetadata(laneMarker(key, laneId), JSON.stringify({ removed: true })); result.removedLaneIds.push(laneId); continue; }
    store.taskTransaction(() => preserveOldBindings(store, before.block, fromHostId));
    if (before.block.reasons.length) { result.blocked.push(before.block); continue; }
    let archived: { through: number };
    try { archived = await projector.project({ companionId: before.lane.companionId, conversationId: before.lane.conversationId, securityDomainId: before.domainId! }, signal); }
    catch { signal?.throwIfAborted(); before.block.reasons.push('history-archive-failed'); result.blocked.push(before.block); continue; }
    signal?.throwIfAborted();
    const accepted = store.taskTransaction(sql => {
      const current = inspect(store, laneId);
      if (!current.lane || current.lane.epoch !== before.lane!.epoch || current.lane.sessionId !== before.lane!.sessionId) current.block.reasons.push('lane-changed');
      const head = current.lane ? store.historyProjectionHead(current.lane.conversationId) : -1;
      if (!Number.isSafeInteger(archived.through) || archived.through !== head) current.block.reasons.push('history-unconfirmed');
      if (!current.block.reasons.includes('lane-changed')) preserveOldBindings(store, current.block, fromHostId);
      if (current.block.reasons.length) { result.blocked.push(current.block); return false; }
      const epoch = current.lane!.epoch + 1;
      if (!Number.isSafeInteger(epoch) || epoch < 2) throw new Error('主脑代际无法安全递增。');
      const nextNativeId = nativeLaneId({ ...current.lane!, epoch });
      if (!bind(store, nextNativeId, toHostId)) { current.block.reasons.push('host-binding-conflict'); result.blocked.push(current.block); return false; }
      if (!sql.prepare('UPDATE bot_lanes SET epoch=?,session_id=NULL WHERE id=? AND epoch=?').run(epoch, laneId, current.lane!.epoch).changes) throw new Error('主脑通道在 Host 切换提交时变化。');
      for (const metadataKey of [botLaneRetentionKey(laneId), `delivered:${laneId}`]) sql.prepare('DELETE FROM bot_metadata WHERE key=?').run(metadataKey);
      store.setMetadata(botHostHistoryRebuildKey(laneId), JSON.stringify({ epoch, hostId: toHostId, historyThrough: archived.through }));
      store.setMetadata(laneMarker(key, laneId), JSON.stringify({ epoch, hostId: toHostId })); return true;
    });
    if (accepted) result.migratedLaneIds.push(laneId);
  }
  result.complete = result.blocked.length === 0;
  store.setMetadata(key, JSON.stringify({ ...plan, complete: result.complete })); return result;
}

const workspacePrefix = 'companion-workspace:';
function safeComponent(value: string, fallback: string, maximum: number): string {
  const safe = Array.from(value.normalize('NFC')).filter(character => character.charCodeAt(0) >= 32).join('')
    .replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  const bounded = Array.from(safe).slice(0, maximum).join('') || fallback;
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(bounded) ? `_${bounded}` : bounded;
}
/** Allocation only: caller creates/physically validates the directory before
 * starting tools. Rename never moves an already allocated workspace; every
 * logical lane of this companion receives the same cwd, tasks remain separate. */
export function botCompanionWorkdir(root: string, companion: Pick<BotCompanion, 'id' | 'name'>, store: BotStore): string {
  if (!path.isAbsolute(root) || root.includes('\0') || !store.getCompanion(companion.id)) throw new Error('伙伴工作目录的根或身份无效。');
  const base = path.resolve(root, 'companions'), key = workspacePrefix + digest(companion.id);
  return store.taskTransaction(sql => {
    const saved = store.getMetadata(key);
    let name: string;
    if (saved) {
      const value = JSON.parse(saved) as { directoryName: string; companionId: string };
      if (value.companionId !== companion.id || typeof value.directoryName !== 'string' || value.directoryName !== safeComponent(value.directoryName, '伙伴', 180)) throw new Error('伙伴已分配工作目录记录无效。');
      name = value.directoryName;
    } else {
      name = `${safeComponent(companion.name, '伙伴', 40)}--${safeComponent(companion.id, digest(companion.id).slice(0, 16), 48)}`;
      const assigned = (sql.prepare('SELECT value FROM bot_metadata WHERE key LIKE ?').all(workspacePrefix + '%') as Row[])
        .map(row => (JSON.parse(String(row.value)) as { directoryName?: string }).directoryName?.toLocaleLowerCase());
      if (assigned.includes(name.toLocaleLowerCase())) name += `-${digest(companion.id).slice(0, 16)}`;
      store.setMetadata(key, JSON.stringify({ companionId: companion.id, directoryName: name }));
    }
    const directory = path.resolve(base, name), relative = path.relative(base, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('伙伴工作目录超出了指定根目录。');
    return directory;
  });
}
