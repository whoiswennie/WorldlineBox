import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';
const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-visible-actions-')), filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, [{ id: 'alice', name: 'Alice', persona: '独立角色。', description: '', model: '', avatar: 'sister', proactive: false }]);
  const room = store.openPrivate('alice'), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '处理这项真实任务。' });
  const action = store.createAction({ conversationId: room.id, companionId: 'alice', sourceMessageId: source.id, title: '本页卡片', status: 'succeeded' });
  const db = new Database(filename);
  return { root, store, room, action, db, close() {
    db.close(); store.close();
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-visible-actions-')) throw new Error('Unexpected test cleanup path.');
    rmSync(root, { recursive: true, force: true });
  } };
}

it('loads exact old visible cards plus only 32 extra live cards, before decoding or validating offscreen history', () => {
  const f = fixture();
  try {
    const insert = f.db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)');
    for (let index = 0; index < 240; index++) {
      const status = index < 200 ? 'succeeded' : 'queued', id = 'window_card_' + index;
      insert.run(id, f.room.id, 'alice', status, JSON.stringify({ ...f.action, id, status }));
    }
    // A malformed unrelated recent row must not be parsed merely to open a
    // different visible card. Requested corrupt rows still fail normally.
    insert.run('unrelated_corrupt', f.room.id, 'alice', 'succeeded', 'null');
    const response = f.store.request({ type: 'actions', conversationId: f.room.id, ids: ['window_card_0', 'window_card_200', 'window_card_0'], includeOngoing: true });
    expect(response.ok).toBe(true);
    const ids = response.actions!.map(action => action.id);
    expect(ids).toHaveLength(34); expect(new Set(ids).size).toBe(34);
    expect(ids).toContain('window_card_0'); expect(ids).toContain('window_card_200');
    expect(ids).not.toContain('unrelated_corrupt'); expect(ids).not.toContain('window_card_199');
    expect(f.store.request({ type: 'actions', conversationId: f.room.id, ids: [], includeOngoing: false }).actions).toEqual([]);
    expect(() => f.store.request({ type: 'actions', conversationId: f.room.id, ids: ['unrelated_corrupt'], includeOngoing: false })).toThrow();
  } finally { f.close(); }
});

it('binds the selected IDs to the actual room and keeps legacy task-list behavior separate', () => {
  const f = fixture();
  try {
    const other = f.store.createConversation('另一入口', ['alice']);
    const source = f.store.appendMessage({ conversationId: other.id, authorId: 'user', content: '另一项任务。' });
    const foreign = f.store.createAction({ conversationId: other.id, companionId: 'alice', sourceMessageId: source.id, title: '别处卡片', status: 'succeeded' });
    expect(f.store.request({ type: 'actions', conversationId: f.room.id, ids: [foreign.id], includeOngoing: false }).actions).toEqual([]);
    expect(f.store.request({ type: 'actions', conversationId: f.room.id, ids: [f.action.id], includeOngoing: false }).actions?.map(action => action.id)).toEqual([f.action.id]);
    expect(f.store.request({ type: 'actions', conversationId: f.room.id }).actions?.map(action => action.id)).toEqual([f.action.id]);
    expect(() => f.store.request({ type: 'actions', ids: [f.action.id] })).toThrow(/当前聊天/u);
  } finally { f.close(); }
});

it('bounds the public visible-card request without accepting arbitrary fields or an unbounded ID list', () => {
  expect(companionsRequestSchema.safeParse({ type: 'actions', conversationId: 'room', ids: [], includeOngoing: false }).success).toBe(true);
  expect(companionsRequestSchema.safeParse({ type: 'actions', conversationId: 'room', ids: Array.from({ length: 201 }, (_, index) => 'card_' + index) }).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'actions', conversationId: 'room', ids: [], arbitrary: true }).success).toBe(false);
});
