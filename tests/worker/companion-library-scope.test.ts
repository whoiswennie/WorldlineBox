import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';

const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-library-scope-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: '爱丽丝', persona: '平静友好。', description: '', avatar: 'sister', model: '', proactive: false, active: false }]);
  fixtures.push({ root, store }); return store;
}

it('resolves a hidden audit scope without opening a chat, waking the companion or admitting retired manual writes', () => {
  const store = fixture();
  expect(store.state().conversations).toEqual([]);
  const first = store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation!;
  expect(() => store.request({ type: 'memory.save', memory: { companionId: 'alice', conversationId: first.id, content: '阳台的薄荷需要明亮的散射光。', diaryName: '资料' } })).toThrow('人工保存接口已经退出');
  expect(store.listMemory('alice')).toEqual([]); expect(store.messages({ conversationId: first.id }).messages).toEqual([]);
  expect(store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation?.id).toBe(first.id);
  expect(store.state().conversations).toEqual([]);
  expect(store.state().companions[0]?.active).toBe(false);
});

it('preserves a chat the human has already opened while resolving the same evidence domain', () => {
  const store = fixture(), opened = store.openPrivate('alice');
  expect(store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation?.id).toBe(opened.id);
  expect(store.state().conversations.map(room => room.id)).toEqual([opened.id]);
});

it('reads only an existing evidence entrance without creating a private chat or membership', () => {
  const store = fixture(), sql = new (Database as { new(file: string): CompanionConnection })(path.join(fixtures.at(-1)!.root, 'messages.sqlite'));
  try {
    const rows = () => ({ conversations: sql.prepare('SELECT id,hidden_at FROM conversations ORDER BY id').all(),
      members: sql.prepare('SELECT conversation_id,companion_id FROM conversation_members ORDER BY conversation_id,companion_id').all() });
    const before = rows();
    expect(() => store.request({ type: 'memory.library.scope.read', companionId: 'alice' })).toThrow('伙伴不是聊天成员');
    expect(rows()).toEqual(before); expect(store.state().conversations).toEqual([]);
    const opened = store.openPrivate('alice'), withPrivate = rows();
    expect(store.request({ type: 'memory.library.scope.read', companionId: 'alice' }).conversation?.id).toBe(opened.id);
    expect(rows()).toEqual(withPrivate);
    sql.prepare('DELETE FROM conversation_members WHERE companion_id=?').run('alice');
    const revoked = rows();
    expect(() => store.request({ type: 'memory.library.scope.read', companionId: 'alice' })).toThrow('伙伴不是聊天成员');
    expect(rows()).toEqual(revoked);
    expect(() => store.request({ type: 'memory.library.scope.read', companionId: 'unknown' })).toThrow();
    expect(rows()).toEqual(revoked);
  } finally { sql.close(); }
});

it('keeps owner-wide document operations outside the companion request and agent tool channel', () => {
  const command = { type: 'memory.documents.list', companionId: 'alice', directory: '', limit: 64 };
  expect(companionWorkspaceRequestSchema.safeParse(command).success).toBe(true);
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'memory.library.scope', companionId: 'alice' }).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'memory.library.scope.read', companionId: 'alice' }).success).toBe(false);
});
