import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionsRequestSchema } from '../../src/shared/companions';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';

const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of fixtures.splice(0)) { store.close(); rmSync(root, { recursive: true, force: true }); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-library-scope-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: '爱丽丝', persona: '平静友好。', description: '', avatar: 'sister', model: '', proactive: false, active: false }]);
  fixtures.push({ root, store }); return store;
}

it('creates a hidden manual evidence container without opening a chat or waking the companion', () => {
  const store = fixture();
  expect(store.state().conversations).toEqual([]);
  const first = store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation!;
  const saved = store.request({ type: 'memory.save', memory: { companionId: 'alice', conversationId: first.id, content: '阳台的薄荷需要明亮的散射光。', diaryName: '资料' } });
  expect(saved.ok).toBe(true);
  expect(saved.memories?.[0]?.sources).toMatchObject([{ sourceType: 'manual_input' }]);
  expect(store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation?.id).toBe(first.id);
  expect(store.state().conversations).toEqual([]);
  expect(store.state().companions[0]?.active).toBe(false);
});

it('preserves a chat the human has already opened while resolving the same evidence domain', () => {
  const store = fixture(), opened = store.openPrivate('alice');
  expect(store.request({ type: 'memory.library.scope', companionId: 'alice' }).conversation?.id).toBe(opened.id);
  expect(store.state().conversations.map(room => room.id)).toEqual([opened.id]);
});

it('keeps owner-wide document operations outside the companion request and agent tool channel', () => {
  const command = { type: 'memory.documents.list', companionId: 'alice', directory: '', limit: 64 };
  expect(companionWorkspaceRequestSchema.safeParse(command).success).toBe(true);
  expect(companionsRequestSchema.safeParse(command).success).toBe(false);
  expect(companionsRequestSchema.safeParse({ type: 'memory.library.scope', companionId: 'alice' }).success).toBe(false);
});
