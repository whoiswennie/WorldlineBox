import { randomUUID } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionCreationStore } from '../../src/companions/creation-store';
import type { CompanionConnection } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';

const Database = BetterSqlite3 as { new(file: string): CompanionConnection };
const databases: CompanionConnection[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const draft = { name: '小蓝', description: '起点', persona: '会从实践形成自己的认识。', model: '', avatar: 'custom' as const, proactive: false };
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT NOT NULL,deleted_at TEXT);');
  const store = new CompanionCreationStore(db); store.initialize();
  const input = { operationId: randomUUID(), companionId: randomUUID(), request: { kind: 'custom' as const, companion: draft } };
  const persist = () => db.prepare('INSERT INTO companions(id,data) VALUES(?,?)').run(input.companionId, JSON.stringify(draft));
  return { db, store, input, persist };
}
it('binds one operation and one identity to the normalized immutable request', () => {
  const f = fixture(), receipt = f.store.prepare(f.input);
  expect(f.store.prepare(f.input)).toEqual(receipt);
  expect(f.store.prepare({ ...f.input, request: { kind: 'custom', companion: { ...draft, name: ' 小蓝 ' } } })).toEqual(receipt);
  expect(() => f.store.prepare({ ...f.input, request: { kind: 'custom', companion: { ...draft, persona: '改写起点' } } })).toThrow('不能修改');
  expect(() => f.store.prepare({ ...f.input, companionId: randomUUID() })).toThrow('绑定');
  expect(() => f.store.prepare({ ...f.input, operationId: randomUUID() })).toThrow('已经使用');
  expect(f.db.prepare('SELECT COUNT(*) n FROM companion_creation_operations').get()).toEqual({ n: 1 });
});
it('resumes failure under the same receipt, commits only an existing identity and never rolls a committed receipt back', () => {
  const f = fixture(); f.store.prepare(f.input);
  expect(() => f.store.commit(f.input.operationId)).toThrow('尚未持久化');
  expect(f.store.fail(f.input.operationId, '发布中断').state).toBe('failed');
  f.persist(); expect(() => f.store.commit(f.input.operationId)).toThrow('重新准备');
  const resumed = f.store.prepare(f.input); expect(resumed.state).toBe('prepared'); expect(resumed.error).toBeUndefined();
  f.store.fail(f.input.operationId, '重启前发布中断'); expect(f.store.resume(f.input.operationId).state).toBe('prepared');
  const committed = f.store.commit(f.input.operationId);
  expect(f.store.commit(f.input.operationId)).toEqual(committed);
  expect(f.store.fail(f.input.operationId, '迟到的错误')).toEqual(committed);
  expect(f.store.resume(f.input.operationId)).toEqual(committed);
  expect(f.store.prepare(f.input)).toEqual(committed);
});
it('rejects existing and retired identities and keeps the receipt after retirement', () => {
  const f = fixture(); f.persist();
  expect(() => f.store.prepare(f.input)).toThrow('已经使用');
  f.db.prepare('UPDATE companions SET deleted_at=?').run(new Date().toISOString());
  expect(() => f.store.prepare(f.input)).toThrow('已经使用');
  const fresh = { ...f.input, operationId: randomUUID(), companionId: randomUUID() };
  f.store.prepare(fresh); f.db.prepare('INSERT INTO companions VALUES(?,?,NULL)').run(fresh.companionId, '{}');
  const committed = f.store.commit(fresh.operationId); f.db.prepare('UPDATE companions SET deleted_at=? WHERE id=?').run(new Date().toISOString(), fresh.companionId);
  expect(f.store.prepare(fresh)).toEqual(committed);
  expect(f.db.prepare('SELECT COUNT(*) n FROM companions WHERE deleted_at IS NULL').get()).toEqual({ n: 0 });
});
it('persists receipt metadata without role text or credentials and rejects an API key inside a payload', () => {
  const f = fixture(); f.store.prepare(f.input);
  const data = JSON.stringify(f.db.prepare('SELECT * FROM companion_creation_operations').all());
  expect(data).not.toContain(draft.persona); expect(data).not.toContain('apiKey');
  const malformed = { ...f.input, request: { ...f.input.request, apiKey: 'PRIVATE_KEY' } };
  expect(() => f.store.prepare(malformed)).toThrow();
});
it('requires creation identity on every public creation route, including templates', () => {
  expect(companionsRequestSchema.safeParse({ type: 'companion.create', companion: draft }).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'companion.add-builtin', templateId: 'phoebe' }).success).toBe(false);
  const identity = { operationId: randomUUID(), companionId: randomUUID() };
  expect(companionsRequestSchema.safeParse({ type: 'companion.create', companion: draft, ...identity }).success).toBe(true);
  expect(companionsRequestSchema.safeParse({ type: 'companion.creation.status', operationId: identity.operationId }).success).toBe(true);
});
