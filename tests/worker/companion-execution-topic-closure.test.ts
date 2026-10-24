import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const stores: CompanionsStore[] = [], roots: string[] = [];
const seeds: CompanionSeed[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '本人身份', model: '', avatar: 'sister', proactive: false, active: true }));
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-topic-readset-')) throw new Error('Unexpected temporary research fixture path.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-topic-readset-')); roots.push(root);
  const file = path.join(root, 'companions.sqlite'), store = new CompanionsStore(file, seeds); stores.push(store);
  const room = store.request({ type: 'conversation.create-group', title: '合成来源闭环', memberIds: ['alice', 'bob'] }).conversation!;
  const topic = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'alice', title: '合成长故事', kind: 'story' }).topic!;
  store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId: 'user' });
  const scope = { companionId: 'alice', conversationId: room.id };
  const read = (id = topic.id) => store.request({ type: 'topic.read', conversationId: room.id, topicId: id, readerId: 'alice' });
  const update = (patch: Extract<CompanionStorageCommand, { type: 'topic.update' }>['patch']) => store.request({ type: 'topic.update',
    conversationId: room.id, topicId: topic.id, readerId: 'alice', expectedRevision: read().topic!.revision, patch });
  const message = (content: string) => store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content, replyDirective: 'none' });
  const capture = (id = topic.id) => { const view = read(id); return captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ topic: view.topic, topicState: view.topicState }) } }); };
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
  return { file, store, room, topic, scope, read, update, message, capture, request };
}

it('invalidates execution evidence when an earlier retained checkpoint source is forgotten even though the latest direct sources remain visible', async () => {
  const f = fixture(), earlier = f.message('SYNTHETIC_EARLY_CANON');
  f.update({ workingState: { summary: 'First exact canonical fact', sourceMessageIds: [earlier.id] } });
  const latest = f.message('SYNTHETIC_LATEST_PROGRESS');
  f.update({ workingState: { state: { phase: 'later' }, sourceMessageIds: [latest.id] } });
  const captured = f.capture();
  expect(captured.sources).toEqual([]); expect(captured.topics[0]!.sourceMessageIds).toEqual([latest.id]);
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(true);
  const reopened = new CompanionsStore(f.file, seeds); stores.push(reopened);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [earlier.id] });
  expect(reopened.request({ type: 'memory.sources.filter', ...f.scope, ids: [latest.id] }).memorySources?.map(source => source.id)).toEqual([latest.id]);
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: async command => reopened.request(command) })).toBe(false);
});

it('keeps an immutable captured checkpoint valid across unrelated replacements but rejects a different reader private event', async () => {
  const f = fixture(), earlier = f.message('SYNTHETIC_PAST_FACT');
  f.update({ workingState: { summary: 'Actually consumed old checkpoint', sourceMessageIds: [earlier.id] } });
  const captured = f.capture();
  f.update({ workingState: { summary: 'Independent replacement', sourceMessageIds: [] } });
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(true);
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: f.topic.id, readerId: 'bob' });
  const bob = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'bob', expectedRevision: f.read().topic!.revision,
    patch: { workingState: { summary: 'BOB_PRIVATE_SYNTHETIC', sourceMessageIds: [] } } }).topicState!.workingState!;
  expect(f.store.request({ type: 'topic.sources.valid', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice',
    sourceMessageIds: [], checkpointEventIds: [bob.sourceEventId] }).topicSourcesValid).toBe(false);
});

it('checks the original checkpoint ancestry of a fork and fails closed after deleting its parent archive', async () => {
  const f = fixture(), original = f.message('SYNTHETIC_ORIGINAL_BRANCH');
  f.update({ workingState: { summary: 'Origin inherited by a continuation', sourceMessageIds: [original.id] } });
  const forked = f.store.request({ type: 'topic.fork', conversationId: f.room.id, topicId: f.topic.id, readerId: 'alice', title: '合成续写' }).topic!;
  const captured = f.capture(forked.id);
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(true);
  f.store.request({ type: 'topic.delete', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: f.read().topic!.revision });
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(false);
});

it('does not resurrect a source-free checkpoint after its own immutable event has been removed', async () => {
  const f = fixture();
  f.update({ workingState: { summary: 'SYNTHETIC_SOURCE_FREE_SETTING', sourceMessageIds: [] } });
  const captured = f.capture(), eventId = f.read().topicState!.workingState!.sourceEventId;
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.file);
  try { db.prepare('DELETE FROM companion_topic_events WHERE id=?').run(eventId); } finally { db.close(); }
  expect(f.read().topicState?.workingState).toBeUndefined();
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(false);
});

it('retains a valid recipient checkpoint when the real user updates only its private structured setting', () => {
  const f = fixture(), source = f.message('SYNTHETIC_RETAINED_SOURCE');
  f.update({ workingState: { summary: 'Retain the recipient private summary', sourceMessageIds: [source.id] } });
  const old = f.read().topicState!.workingState!;
  f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: f.topic.id, readerId: 'user', expectedRevision: f.read().topic!.revision,
    patch: { privateRecipientId: 'alice', workingState: { state: { fixtureSetting: 'changed' }, sourceMessageIds: [] } } });
  expect(f.read().topicState?.workingState).toMatchObject({ summary: old.summary, derivedFromEventIds: [old.sourceEventId], state: { fixtureSetting: 'changed' } });
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] });
  expect(f.read().topicState?.workingState).toBeUndefined();
});

it('permits a late invitee to derive from an authorized shared checkpoint while its original raw message remains unreadable', async () => {
  const f = fixture();
  const isolated = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: 'user', title: '合成晚加入', kind: 'story', participantIds: ['user', 'alice'] }).topic!;
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: isolated.id, readerId: 'alice' });
  const source = f.store.appendMessage({ conversationId: f.room.id, topicId: isolated.id, authorId: 'user', content: 'SYNTHETIC_PAST_NOT_WITNESSED_BY_BOB', replyDirective: 'none' });
  const shared = f.store.request({ type: 'topic.update', conversationId: f.room.id, topicId: isolated.id, readerId: 'user', expectedRevision: isolated.revision + 1,
    patch: { shared: { summary: 'An authorized shared recap', sourceMessageIds: [source.id] }, invitedIds: ['bob'] } }).topic!;
  f.store.request({ type: 'topic.join', conversationId: f.room.id, topicId: shared.id, readerId: 'bob' });
  const scope = { companionId: 'bob', conversationId: f.room.id };
  expect(f.store.request({ type: 'memory.sources.filter', ...scope, ids: [source.id] }).memorySources).toEqual([]);
  const view = f.store.request({ type: 'topic.read', conversationId: f.room.id, topicId: shared.id, readerId: 'bob' });
  expect(view.topicState?.shared?.summary).toBe('An authorized shared recap');
  const captured = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ topic: view.topic, topicState: view.topicState }) } });
  expect(captured.sources).toEqual([]); expect(captured.topics).toHaveLength(1);
  expect(await verifyCompanionExecutionReadset(captured, scope, { request: f.request })).toBe(true);
});

it('withdraws a past topic-index observation through its typed immutable event references when an older ancestor source is forgotten', async () => {
  const f = fixture(), earlier = f.message('SYNTHETIC_EARLIER_INDEX_CANON');
  f.update({ workingState: { summary: 'Retained history from an early phase', sourceMessageIds: [earlier.id] } });
  const latest = f.message('SYNTHETIC_LATEST_INDEX_CANON');
  f.update({ workingState: { state: { phase: 'later' }, sourceMessageIds: [latest.id] } });
  const observation = f.store.request({ type: 'memory.world_query', ...f.scope, category: 'topics', topicId: f.topic.id });
  const receipt = observation.memorySources![0]!;
  expect(JSON.stringify(observation.worldKnowledge?.items)).toContain('Retained history from an early phase');
  const captured = captureCompanionExecutionReadset(f.scope, { turns: [{ text: '', rawText: '', calls: [{ id: 'actual_index_read', name: 'memory',
    arguments: JSON.stringify({ action: 'world_query', category: 'topics', topicId: f.topic.id }) }],
  results: [{ callId: 'actual_index_read', content: JSON.stringify(observation) }] }] });
  expect(captured.sources.map(source => source.id)).toEqual([receipt.id]);
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(true);
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [earlier.id] });
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [latest.id] }).memorySources?.map(source => source.id)).toEqual([latest.id]);
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [receipt.id] }).memorySources).toEqual([]);
  expect(await verifyCompanionExecutionReadset(captured, f.scope, { request: f.request })).toBe(false);
});

it('does not reclassify a legacy topic-index observation without its checkpoint proof as a new independent fact', () => {
  const f = fixture();
  f.update({ workingState: { summary: 'SYNTHETIC_LEGACY_INDEX_SUMMARY', sourceMessageIds: [] } });
  const receipt = f.store.request({ type: 'memory.world_query', ...f.scope, category: 'topics', topicId: f.topic.id }).memorySources![0]!;
  const db = new (BetterSqlite3 as { new(file: string): CompanionConnection })(f.file);
  try { db.prepare("UPDATE metadata SET value=json_remove(value,'$.topicCheckpoints') WHERE key=?").run('memory-world-observation/' + receipt.id); }
  finally { db.close(); }
  expect(f.store.request({ type: 'memory.sources.filter', ...f.scope, ids: [receipt.id] }).memorySources).toEqual([]);
});
