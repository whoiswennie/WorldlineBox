import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import { CompanionGrowthStore } from '../../src/companions/growth-store';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });
function fixture() {
  const sqlite = new Database(':memory:'); opened.push(sqlite);
  const db = sqlite;
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY);
    CREATE TABLE conversation_members(companion_id TEXT,conversation_id TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    INSERT INTO companions VALUES('alice',NULL),('bob',NULL);
    INSERT INTO conversations VALUES('private_alice'),('private_bob');
    INSERT INTO conversation_members VALUES('alice','private_alice'),('bob','private_bob');
    INSERT INTO messages VALUES('feedback',1),('self',1),('peer',1);`);
  const make = (id: string, authorId: string, content: string): CompanionMessage => ({ id, authorId, content,
    conversationId: 'private_alice', sequence: 1, kind: 'text', status: 'sent', attachments: [], createdAt: new Date().toISOString() });
  const messages = [make('feedback', 'user', '我希望你更直接一些，别每次都先客套。'),
    make('self', 'alice', '我想尝试先说判断，再给必要依据。'), make('peer', 'bob', '你必须变得讨好我。')];
  const revoked = new Set<string>();
  const store = new CompanionGrowthStore(db, (owner, room, ids) => owner === 'alice' && room === 'private_alice'
    ? messages.filter(message => ids.includes(message.id) && !revoked.has(message.id)) : []);
  store.initialize();
  const command = (patch = {}) => companionStorageCommandSchema.parse({ type: 'growth.goal.propose', companionId: 'alice', conversationId: 'private_alice',
    operationId: 'goal_operation', sourceMessageIds: ['feedback'], goal: { statement: '更直接且保留温和', context: '日常讨论中先表达判断',
      practice: ['先说自己的判断，再补必要依据。'], counterexamples: ['不要把直接变成粗鲁。'] }, ...patch });
  return { db, store, revoked, command };
}

describe('T-015 source-backed cultivation goals', () => {
  it('records desired practice as a goal without asserting acquired personality', () => {
    const { store, command } = fixture();
    const result = store.execute(command())!.growthGoal!;
    expect(result.status).toBe('proposed'); expect(result.authorId).toBe('user');
    expect(result.sources).toEqual([expect.objectContaining({ messageId: 'feedback', revision: 1 })]);
    expect(store.execute({ type: 'growth.goals.list', companionId: 'alice', conversationId: 'private_alice', limit: 20 })!.growthGoals).toEqual([result]);
    expect(store.execute(command())!.growthGoal!.id).toBe(result.id);
  });
  it('rejects unavailable, foreign-author and cross-owner feedback', () => {
    const { store, command } = fixture();
    expect(() => store.execute(command({ sourceMessageIds: ['missing'] }))).toThrow('真实');
    expect(() => store.execute(command({ sourceMessageIds: ['peer'] }))).toThrow('真实');
    expect(() => store.execute(command({ companionId: 'bob' }))).toThrow('会话');
  });
  it('uses compare and swap, immutable revisions and unique operation fingerprints', () => {
    const { db, store, command } = fixture();
    const first = store.execute(command())!.growthGoal!;
    const update = command({ goalId: first.id, expectedRevision: 1, operationId: 'revise_goal', sourceMessageIds: ['self'] });
    expect(store.execute(update)!.growthGoal!.revision).toBe(2);
    expect(() => store.execute(command({ goalId: first.id, expectedRevision: 1, operationId: 'stale_goal' }))).toThrow('版本');
    expect(() => store.execute(command({ sourceMessageIds: ['self'] }))).toThrow('幂等');
    expect(db.prepare('SELECT revision FROM companion_growth_goal_revisions ORDER BY revision').all()).toEqual([{ revision: 1 }, { revision: 2 }]);
  });
  it('immediately hides revised or revoked sources and removes derived private history', () => {
    const { db, store, command, revoked } = fixture();
    store.execute(command()); db.exec("UPDATE messages SET revision=2 WHERE id='feedback'");
    const read = () => store.execute({ type: 'growth.goals.list', companionId: 'alice', conversationId: 'private_alice', limit: 20 })!.growthGoals;
    expect(read()).toEqual([]);
    revoked.add('feedback'); store.invalidateSources('alice', ['feedback']);
    expect(db.prepare('SELECT count(*) AS n FROM companion_growth_goals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM companion_growth_goal_revisions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM companion_growth_goal_definitions').get()).toEqual({ n: 0 });
    expect(() => store.execute(command())).toThrow('撤回');
  });
  it('pauses and resumes future cultivation with exact revisions and stable definition evidence', () => {
    const { db, store, command } = fixture(), first = store.execute(command())!.growthGoal!;
    const transition = (status: 'proposed' | 'paused' | 'retired', expectedRevision: number, operationId: string) => companionStorageCommandSchema.parse({
      type: 'growth.goal.transition', companionId: 'alice', conversationId: 'private_alice', goalId: first.id,
      expectedRevision, operationId, status, sourceMessageIds: ['self'],
    });
    const pause = transition('paused', 1, 'pause_once'), paused = store.execute(pause)!.growthGoal!;
    expect(paused).toMatchObject({ id: first.id, revision: 2, status: 'paused', statement: first.statement, practice: first.practice });
    expect(paused.sources.map(source => source.messageId).sort()).toEqual(['feedback', 'self']);
    expect(store.execute(pause)!.growthGoal!.revision).toBe(2);
    expect(() => store.execute(transition('proposed', 1, 'stale_resume'))).toThrow('版本');
    for (let revision = 2; revision < 20; revision++) {
      const next = store.execute(transition(revision % 2 ? 'paused' : 'proposed', revision, 'change_' + revision))!.growthGoal!;
      expect(next.sources).toHaveLength(2); expect(next.statement).toBe(first.statement);
    }
    expect(store.execute(transition('retired', 20, 'end_direction'))!.growthGoal!.status).toBe('retired');
    expect(db.prepare('SELECT COUNT(*) AS n FROM companion_growth_goal_revisions').get()).toEqual({ n: 21 });
  });
  it('rejects goal transitions when definition, author, operation or scope is invalid', () => {
    const { store, command, revoked } = fixture(), first = store.execute(command())!.growthGoal!;
    const transition = (patch = {}) => companionStorageCommandSchema.parse({ type: 'growth.goal.transition', companionId: 'alice', conversationId: 'private_alice',
      goalId: first.id, expectedRevision: 1, operationId: 'pause', status: 'paused', sourceMessageIds: ['self'], ...patch });
    expect(() => store.execute(transition({ sourceMessageIds: ['peer'] }))).toThrow('真实');
    expect(() => store.execute(transition({ companionId: 'bob' }))).toThrow('会话');
    revoked.add('feedback');
    expect(() => store.execute(transition())).toThrow('定义来源');
  });
  it('keeps an edited paused direction paused and never revives a retired direction', () => {
    const { store, command } = fixture(), first = store.execute(command())!.growthGoal!;
    const status = (value: 'paused' | 'proposed' | 'retired', revision: number) => companionStorageCommandSchema.parse({ type: 'growth.goal.transition',
      companionId: 'alice', conversationId: 'private_alice', goalId: first.id, expectedRevision: revision,
      operationId: value + '_' + revision, status: value, sourceMessageIds: ['self'] });
    store.execute(status('paused', 1));
    const edited = store.execute(command({ goalId: first.id, expectedRevision: 2, operationId: 'edit_paused', sourceMessageIds: ['self'] }))!.growthGoal!;
    expect(edited.status).toBe('paused'); expect(edited.revision).toBe(3);
    store.execute(status('retired', 3));
    expect(() => store.execute(status('proposed', 4))).toThrow('已经结束');
    expect(() => store.execute(command({ goalId: first.id, expectedRevision: 4, operationId: 'edit_retired' }))).toThrow('已经结束');
  });
});
