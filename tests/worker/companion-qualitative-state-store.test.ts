import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionStateStore } from '../../src/companions/state-store';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionRoutineRuntime } from '../../src/shared/companion-routine';
import type { CompanionStateProposal } from '../../src/shared/companion-state';

const databases: CompanionConnection[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const at = '2026-10-28T00:00:00Z', now = Date.parse(at) + 60000;
function fixture() {
  const Database = BetterSqlite3 as { new(name: string): CompanionConnection }, db = new Database(':memory:'); databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT,data TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,kind TEXT,dissolved_at TEXT); CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);
    CREATE TABLE companion_topics(id TEXT PRIMARY KEY,conversation_id TEXT,data TEXT); CREATE TABLE companion_message_topics(message_id TEXT,topic_id TEXT);
    CREATE TABLE messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE,conversation_id TEXT,author_id TEXT,content TEXT,created_at TEXT,kind TEXT,status TEXT,revision INTEGER);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE actions(id TEXT PRIMARY KEY,companion_id TEXT,status TEXT,data TEXT);
    CREATE TABLE companion_work_queue(companion_id TEXT,status TEXT); CREATE TABLE companion_reset_jobs(companion_id TEXT,status TEXT);
    CREATE TABLE vcp_memory_notes(id TEXT PRIMARY KEY,companion_id TEXT,data TEXT); CREATE TABLE vcp_note_sources(note_id TEXT,message_id TEXT,revision INTEGER,checksum TEXT);`);
  for (const id of ['alice', 'bob']) db.prepare('INSERT INTO companions VALUES(?,NULL,?)').run(id, '{"active":true}');
  db.exec("INSERT INTO conversations VALUES('private','private',NULL),('group','group',NULL); INSERT INTO conversation_members VALUES('private','alice'),('group','alice'),('group','bob')");
  const sources = new Map<string, CompanionMessage>();
  const source = (id: string, content: string, room = 'private', author = 'alice') => {
    db.prepare('INSERT INTO messages(id,conversation_id,author_id,content,created_at,kind,status,revision) VALUES(?,?,?,?,?,?,?,1)').run(id, room, author, content, at, 'text', 'sent');
    const sequence = (db.prepare('SELECT sequence FROM messages WHERE id=?').get(id) as { sequence: number }).sequence;
    const value: CompanionMessage = { id, sequence, conversationId: room, authorId: author, content, createdAt: at, kind: 'text', status: 'sent', attachments: [] };
    sources.set(id, value); return value;
  };
  const scope = { companionId: 'alice', conversationId: 'private' };
  const store = new CompanionStateStore(db, (scope, ids) => ids.flatMap(id => { const source = sources.get(id); return source && (!scope.beforeSequence || source.sequence <= scope.beforeSequence) && (scope.conversationId === 'private' || source.conversationId === scope.conversationId) ? [source] : []; }),
    (_id, _from, _to, energy) => energy, () => ({ phase: 'awake', nextTransitionAt: new Date(now + 3600000).toISOString(), canRespond: true, simulation: true } satisfies CompanionRoutineRuntime), () => now);
  store.initialize();
  const proposal = (message: CompanionMessage, statement = '我想先核实，再答应。'): CompanionStateProposal => ({ reason: '这次交流后的本人表达。',
    sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }],
    experience: { situation: '正在确认一次合作安排。', statement, reassessWhen: ['该安排的结果得到核验后。'] } });
  return { db, store, scope, source, sources, proposal };
}
it('starts without relationship stages and records source-backed current experience idempotently', () => {
  const f = fixture(), first = f.store.get(f.scope); expect(first).not.toHaveProperty('affect'); expect(first).not.toHaveProperty('familiarity');
  const source = f.source('self', '我想先核实，再答应。'), proposal = f.proposal(source);
  const saved = f.store.update(f.scope, proposal); expect(saved.experience).toMatchObject({ statement: source.content, sourceMessageIds: ['self'], revision: 1 });
  expect(saved.experience!.sourceVersions).toHaveLength(1); expect(f.store.update(f.scope, proposal).revision).toBe(saved.revision);
  f.store.interaction('alice', source.id); expect(f.store.get(f.scope)).not.toHaveProperty('familiarity');
});
it('keeps specific relationship events without generalizing an overall trust score or leaking them into a group', () => {
  const f = fixture(), source = f.source('self', '这次合作中，我期待先确认文件已经保存。');
  const saved = f.store.update(f.scope, { ...f.proposal(source), relationshipUpdates: [{ targetId: 'bob', topic: '保存结果', context: '本次文件交付', kind: 'expectation', statement: source.content,
    currentExpectation: '先核对本次文件。', reassessWhen: ['本次交付核验后。'] }] });
  expect(saved.relationshipRecords).toHaveLength(1); expect(saved).not.toHaveProperty('relationship');
  const repeated = f.store.update(f.scope, { ...f.proposal(source), reason: '同一证据再次整理。', relationshipUpdates: [{ targetId: 'bob', topic: '保存结果', context: '本次文件交付', kind: 'expectation', statement: source.content,
    currentExpectation: '先核对本次文件。', reassessWhen: ['本次交付核验后。'] }] });
  expect(repeated.relationshipRecords).toHaveLength(1); expect(repeated.relationshipRecords[0]!.id).toBe(saved.relationshipRecords[0]!.id);
  const group = f.store.get({ companionId: 'alice', conversationId: 'group' }); expect(group.experience).toBeUndefined(); expect(group.relationshipRecords).toEqual([]);
  expect(f.store.worldState('alice')).not.toHaveProperty('experience');
});
it('withdraws a current experience without resurrecting an earlier one and rejects late evidence overwrites', () => {
  const f = fixture(), early = f.source('earlier', '我先继续考虑。'); f.store.update(f.scope, f.proposal(early));
  const latest = f.source('latest', '我现在需要先核查。'); const saved = f.store.update(f.scope, f.proposal(latest, latest.content));
  expect(() => f.store.update(f.scope, { ...f.proposal(early), reason: '迟到旧提议。' })).toThrow('迟到');
  f.store.invalidateEvidence('alice', [latest.id]); expect(f.store.get(f.scope).experience).toBeUndefined();
  expect(saved.experience!.id).not.toBeUndefined();
});
it('rejects false quotations, stale state revisions, changed source bytes and old numeric runtime data', () => {
  const f = fixture(), source = f.source('self', '我先核实。');
  expect(() => f.store.update(f.scope, { ...f.proposal(source), evidence: [{ sourceMessageId: source.id, quote: '我完全信任所有人。' }] })).toThrow('证据');
  expect(() => f.store.update(f.scope, f.proposal(source), 999)).toThrow('状态已更新');
  f.store.update(f.scope, { ...f.proposal(source), focus: '原文支持的当前关注。', expression: 'direct' }); f.sources.set(source.id, { ...source, content: '原文已修订。' });
  const changed = f.store.get(f.scope); expect(changed.experience).toBeUndefined(); expect(changed.focus).toBeUndefined(); expect(changed.expression).toBe('gentle'); expect(changed.recentChanges).toEqual([]);
  f.db.prepare('UPDATE companion_runtime_states SET data=? WHERE companion_id=?').run(JSON.stringify({ companionId: 'alice', affect: { pleasure: 1 } }), 'alice');
  expect(() => f.store.get(f.scope)).toThrow('不是当前定性协议');
});
it('rolls the whole state proposal back if one relationship mutation fails after preparing experience', () => {
  const f = fixture(), first = f.source('first', '先保留这次判断。'), initial = f.store.update(f.scope, f.proposal(first));
  const next = f.source('next', '新的安排尚未核实。');
  expect(() => f.store.update(f.scope, { ...f.proposal(next), relationshipUpdates: [{ targetId: 'missing', topic: '安排', context: '当前讨论', kind: 'expectation', statement: '需要核实。', reassessWhen: ['核实后。'] }] })).toThrow('对象无效');
  const after = f.store.get(f.scope); expect(after.experience).toEqual(initial.experience); expect(after.revision).toBe(initial.revision);
  expect(f.store.update(f.scope, f.proposal(next)).experience?.sourceMessageIds).toEqual([next.id]);
});
it('does not let a source-bounded older task overwrite a newer focus that is outside its visible window', () => {
  const f = fixture(), older = f.source('older', '旧问题。'), newer = f.source('newer', '新问题。');
  f.store.update(f.scope, { ...f.proposal(newer), focus: '新问题' });
  const earlierScope = { ...f.scope, beforeSequence: older.sequence };
  expect(f.store.get(earlierScope).focus).toBeUndefined();
  expect(() => f.store.update(earlierScope, { ...f.proposal(older), experience: undefined, focus: '迟到旧关注' })).toThrow('迟到');
  expect(f.store.get(f.scope).focus).toBe('新问题');
});
it('rejects game or story utterances as global experience even when the message is formally visible', () => {
  const f = fixture(), source = f.source('fiction', '我在故事里永远不会相信你。');
  f.db.prepare('INSERT INTO companion_topics VALUES(?,?,?)').run('story', 'private', JSON.stringify({ kind: 'story' }));
  f.db.prepare('INSERT INTO companion_message_topics VALUES(?,?)').run(source.id, 'story');
  expect(() => f.store.update(f.scope, f.proposal(source))).toThrow('不能写成全局本人体验');
  expect(f.store.get(f.scope).experience).toBeUndefined(); expect(f.store.get(f.scope).relationshipRecords).toEqual([]);
});
it('preserves formal game communication while skipping its automatic global experience receipt', () => {
  const f = fixture();
  f.db.transaction(() => {
    const source = f.source('game-reply', '我的角色选择向港口出发。');
    f.db.prepare('INSERT INTO companion_topics VALUES(?,?,?)').run('game', 'private', JSON.stringify({ kind: 'game' }));
    f.db.prepare('INSERT INTO companion_message_topics VALUES(?,?)').run(source.id, 'game');
    f.store.worldEvent({ id: 'world-game-speech', sequence: 1, kind: 'social_phone', at, realAt: at, simulation: true,
      actorId: 'alice', sourceMessageId: source.id, conversationId: 'private', text: source.content });
  }).immediate();
  expect(f.db.prepare('SELECT content FROM messages WHERE id=?').get('game-reply')).toEqual({ content: '我的角色选择向港口出发。' });
  expect(f.db.prepare('SELECT COUNT(*) n FROM companion_state_events').get()).toEqual({ n: 0 });
  expect(f.store.get(f.scope).experience).toBeUndefined();
  expect(() => f.store.update(f.scope, f.proposal(f.sources.get('game-reply')!))).toThrow('不能写成全局本人体验');
});
