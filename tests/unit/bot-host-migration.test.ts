import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BotStore, botLaneRetentionKey } from '../../src/main/companion-bot/store';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import { botCompanionWorkdir, botConversationWorkdir, botHostHistoryRebuildKey, botNativeHostBindingKey, migrateBotHost } from '../../src/main/companion-bot/host-migration';
import type { BotMemoryMessage } from '../../src/main/companion-bot/memory-service';

let root: string, store: BotStore;
const fromHostId = 'legacy-private-host', toHostId = 'shared-default-host';
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wlb-host-migration-')); store = new BotStore(path.join(root, 'bot.sqlite'));
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id === 'alice' ? '大肥鱼' : 'Bob', persona: '长期伙伴' });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
function oldLane(companionId = 'alice') {
  const conversation = store.openDirect(companionId);
  const input = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '以前说过的约定' });
  const claim = store.claim({ workerId: 'old-host' })!;
  store.bindEventNativeEpoch(claim.event.id, 1); store.markDispatched(claim.event.id, claim.leaseToken, claim.event.id);
  store.trackNativeAdmission({ eventId: claim.event.id, epoch: 1, nativeLaneId: claim.event.laneId, system: 'old-system', cwd: root, inputBytes: 10 });
  store.saveSession(claim.event.laneId, 'old-session-' + companionId);
  store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '记住这个约定', metadata: [
    { key: `native-terminal-counted:${claim.event.id}`, value: '1' }, { key: `native-admission:${claim.event.id}`, value: '' },
    { key: botLaneRetentionKey(claim.event.laneId), value: JSON.stringify({ epoch: 1, turns: 1, bytes: 20, last: { eventId: claim.event.id, nativeLaneId: claim.event.laneId, cwd: root, system: 'old-system' } }) },
    { key: `delivered:${claim.event.laneId}`, value: JSON.stringify({ nativeLaneId: claim.event.laneId, ids: [input.message.id, claim.event.replyMessageId] }) },
  ] });
  return { conversation, event: claim.event, laneId: claim.event.laneId, input };
}
function sourceProjector(append?: (messages: BotMemoryMessage[]) => void) {
  const saved = new Map<string, BotMemoryMessage>();
  const projector = new BotHistoryProjector({ store, memory: { appendHistory: vi.fn(async (_scope, messages) => {
    append?.(messages);
    for (const message of messages) { const previous = saved.get(message.id); if (previous) expect(message).toEqual(previous); saved.set(message.id, message); }
    return { archived: true };
  }) } });
  return { projector, saved };
}
it('archives original user and own-assistant history before a single durable epoch rotation without reading native files', async () => {
  const old = oldLane(), nativeLog = path.join(root, 'old-session.jsonl'); writeFileSync(nativeLog, 'retain native bytes');
  const f = sourceProjector(() => { expect(store.getLane(old.laneId)?.epoch).toBe(1); });
  const result = await migrateBotHost({ store, projector: f.projector, fromHostId, toHostId });
  expect(result).toMatchObject({ complete: true, migratedLaneIds: [old.laneId], blocked: [] });
  expect([...f.saved.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ content: '以前说过的约定', role: 'user' }), expect.objectContaining({ content: '记住这个约定', role: 'assistant' })]));
  expect(store.getLane(old.laneId)).toMatchObject({ epoch: 2, sessionId: undefined });
  expect(store.getMetadata(`delivered:${old.laneId}`)).toBeUndefined(); expect(store.getLaneRetention(old.laneId)).toEqual({ epoch: 2, turns: 0, bytes: 0 });
  expect(JSON.parse(store.getMetadata(botHostHistoryRebuildKey(old.laneId))!)).toMatchObject({ epoch: 2, hostId: toHostId, historyThrough: store.historyProjectionHead(old.conversation.id) });
  expect(store.getMetadata(botNativeHostBindingKey(old.laneId))).toBe(fromHostId);
  expect(store.getMetadata(botNativeHostBindingKey(old.laneId + '-epoch-2'))).toBe(toHostId);
  expect(readFileSync(nativeLog, 'utf8')).toBe('retain native bytes');
  const next = await migrateBotHost({ store, projector: f.projector, fromHostId, toHostId });
  expect(next.alreadyMigratedLaneIds).toEqual([old.laneId]); expect(store.getLane(old.laneId)?.epoch).toBe(2);
  expect(store.searchMessages(old.conversation.id).items.filter(item => item.content === '以前说过的约定')).toHaveLength(1);
});
it('does not rotate or bind a pure new lane before any native admission', async () => {
  const conversation = store.openDirect('alice'), queued = store.enqueue({ conversationId: conversation.id, senderId: 'user', content: '新伙伴第一次消息' });
  const projector = { project: vi.fn() };
  expect(await migrateBotHost({ store, projector, fromHostId, toHostId })).toMatchObject({ complete: true, migratedLaneIds: [], blocked: [] });
  expect(projector.project).not.toHaveBeenCalled(); expect(store.getLane(queued.events[0]!.laneId)?.epoch).toBe(1);
  expect(store.getMetadata(botNativeHostBindingKey(queued.events[0]!.laneId))).toBeUndefined();
});
it('keeps pending and cancelled-unknown native inputs on the old Host until actual absence proof', async () => {
  const old = oldLane(), pending = store.enqueue({ conversationId: old.conversation.id, senderId: 'user', content: '尚未确认的新输入' });
  const claim = store.claim({ workerId: 'unknown-host' })!;
  store.bindEventNativeEpoch(claim.event.id, 1); store.trackNativeAdmission({ eventId: claim.event.id, epoch: 1, nativeLaneId: old.laneId, system: 'old-system', cwd: root, inputBytes: 12 });
  store.requeue(claim.event.id, claim.leaseToken);
  const projector = { project: vi.fn() };
  const first = await migrateBotHost({ store, projector, fromHostId, toHostId });
  expect(first.blocked).toEqual([expect.objectContaining({ laneId: old.laneId, eventIds: [pending.events[0]!.id], reasons: expect.arrayContaining(['pending-events', 'native-uncertain']) })]);
  expect(projector.project).not.toHaveBeenCalled(); expect(store.getLane(old.laneId)?.sessionId).toBe('old-session-alice');
  store.cancelEvent(claim.event.id);
  const cancelled = await migrateBotHost({ store, projector, fromHostId, toHostId });
  expect(cancelled.blocked[0]?.reasons).toContain('native-uncertain'); expect(store.getLane(old.laneId)?.epoch).toBe(1);
  expect(store.resolveCancelledNativeAdmission({ eventId: claim.event.id, epoch: 1, absent: true })).toBe(true);
  const moved = await migrateBotHost({ store, projector: sourceProjector().projector, fromHostId, toHostId });
  expect(moved.complete).toBe(true); expect(store.getLane(old.laneId)?.epoch).toBe(2);
});
it('preserves worker Host bindings for active/unknown tasks, including unresolved effects after a terminal status', async () => {
  const old = oldLane(), task = store.createTask({ conversationId: old.conversation.id, companionId: 'alice', sourceEventId: old.event.id, goal: '旧任务' });
  store.updateTask(task.id, { status: 'unknown', extra: { nativeAttempted: true } });
  const projector = { project: vi.fn() };
  const blocked = await migrateBotHost({ store, projector, fromHostId, toHostId });
  expect(blocked.blocked[0]).toMatchObject({ taskIds: [task.id], reasons: ['active-tasks'] });
  expect(store.getMetadata(botNativeHostBindingKey('worker-' + task.id))).toBe(fromHostId);
  store.updateTask(task.id, { status: 'cancelled' });
  store.taskTransaction(sql => sql.prepare(`INSERT INTO bot_task_effects(task_id,call_id,tool_name,args_hash,preview,state,provenance,created_at,updated_at)
    VALUES(?,?,?,?,?,'unknown','unknown',?,?)`).run(task.id, 'write-1', 'write', 'digest', 'write file', new Date().toISOString(), new Date().toISOString()));
  expect((await migrateBotHost({ store, projector, fromHostId, toHostId })).blocked[0]?.reasons).toContain('unknown-effects');
  expect(store.getLane(old.laneId)?.epoch).toBe(1); expect(projector.project).not.toHaveBeenCalled();
});
it('rechecks new activity and history after asynchronous archival, leaving the original lane intact', async () => {
  const old = oldLane(), beforeDelivered = store.getMetadata(`delivered:${old.laneId}`);
  const projector = { project: vi.fn(async () => {
    const through = store.historyProjectionHead(old.conversation.id);
    store.enqueue({ conversationId: old.conversation.id, senderId: 'user', content: '归档时新到达' });
    return { through, projected: 2 };
  }) };
  const result = await migrateBotHost({ store, projector, fromHostId, toHostId });
  expect(result.blocked[0]?.reasons).toEqual(expect.arrayContaining(['pending-events', 'history-unconfirmed']));
  expect(store.getLane(old.laneId)?.epoch).toBe(1); expect(store.getMetadata(`delivered:${old.laneId}`)).toBe(beforeDelivered);
  expect(store.getMetadata(botHostHistoryRebuildKey(old.laneId))).toBeUndefined();
});
it('does not bind or rotate a changed epoch and can retry a source-only archive failure without native replay', async () => {
  const old = oldLane();
  const unavailable = { project: vi.fn(async () => { throw new Error('source archive unavailable'); }) };
  expect((await migrateBotHost({ store, projector: unavailable, fromHostId, toHostId })).blocked[0]?.reasons).toEqual(['history-archive-failed']);
  const raced = { project: vi.fn(async () => { store.rotateDomain('alice', old.conversation.securityDomainId); return { through: store.historyProjectionHead(old.conversation.id), projected: 2 }; }) };
  expect((await migrateBotHost({ store, projector: raced, fromHostId, toHostId })).blocked[0]?.reasons).toContain('lane-changed');
  expect(store.getLane(old.laneId)?.epoch).toBe(2);
  expect(store.getMetadata(botNativeHostBindingKey(old.laneId + '-epoch-2'))).toBeUndefined();
});
it('commits epoch, rebuild marker and binding together or rolls all three back', async () => {
  const old = oldLane(), original = store.setMetadata.bind(store);
  const failure = vi.spyOn(store, 'setMetadata').mockImplementation((key, value) => { if (key.includes(':lane:')) throw new Error('simulated commit failure'); original(key, value); });
  await expect(migrateBotHost({ store, projector: sourceProjector().projector, fromHostId, toHostId })).rejects.toThrow('simulated commit failure');
  expect(store.getLane(old.laneId)?.epoch).toBe(1); expect(store.getMetadata(botHostHistoryRebuildKey(old.laneId))).toBeUndefined();
  expect(store.getMetadata(botNativeHostBindingKey(old.laneId + '-epoch-2'))).toBeUndefined(); failure.mockRestore();
  expect((await migrateBotHost({ store, projector: sourceProjector().projector, fromHostId, toHostId })).complete).toBe(true);
});
it('allocates readable Windows-safe companion paths once, preserves rename/cold restart and avoids case/truncation collisions', () => {
  const alice = store.getCompanion('alice')!, first = botCompanionWorkdir(root, alice, store);
  expect(path.basename(first)).toBe('大肥鱼--alice'); expect(path.dirname(first)).toBe(path.join(root, 'companions')); expect(existsSync(first)).toBe(false);
  const privateFiles = botConversationWorkdir(root, alice, 'private', store), groupFiles = botConversationWorkdir(root, alice, 'group', store);
  expect(privateFiles).not.toBe(groupFiles); expect(path.dirname(privateFiles)).toBe(first); expect(path.basename(privateFiles)).toContain('大肥鱼');
  store.updateCompanion('alice', { name: '改名以后', persona: '长期伙伴' }); expect(botCompanionWorkdir(root, store.getCompanion('alice')!, store)).toBe(first);
  const filename = store.filename; store.close(); store = new BotStore(filename); expect(botCompanionWorkdir(root, store.getCompanion('alice')!, store)).toBe(first);
  const unsafe = store.createCompanion({ id: 'NUL:/../*?id', name: 'CON.\u0001 / :\\?*|. ', persona: '路径测试' });
  const sanitized = botCompanionWorkdir(root, unsafe, store); expect(path.basename(sanitized)).not.toMatch(/[<>:"/\\|?*]/); expect(path.relative(path.join(root, 'companions'), sanitized)).not.toContain(path.sep);
  const upper = store.createCompanion({ id: 'ALICE', name: '大肥鱼', persona: '路径冲突' });
  expect(botCompanionWorkdir(root, upper, store).toLowerCase()).not.toBe(first.toLowerCase());
  expect(() => botCompanionWorkdir('relative-root', alice, store)).toThrow('根或身份');
});
