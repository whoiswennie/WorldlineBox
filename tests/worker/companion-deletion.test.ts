import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';

const roots: string[] = [], stores: CompanionsStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-deletion-')) throw new Error('Invalid fixture path');
  rmSync(root, { recursive: true, force: true });
} });
it('erases a built-in instance and its state, preserves old chat, and re-adds the template as a different identity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-deletion-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), store = new CompanionsStore(file); stores.push(store);
  const role = store.restoreBuiltin('deepseek-flash'), other = store.restoreBuiltin('deepseek-sister');
  const room = store.openPrivate(role.id), group = store.request({ type: 'conversation.create-group', title: '共同聊天', memberIds: [role.id, other.id] }).conversation!;
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '保留原来的约定。' });
  store.appendMessage({ conversationId: room.id, authorId: role.id, content: '记住这次见面。', replyToId: source.id });
  store.request({ type: 'memory.save', memory: { companionId: role.id, conversationId: room.id, content: '应该清理的记忆', sourceMessageId: source.id } });
  store.deleteCompanion(role.id);
  expect(store.state().companions.map(item => item.id)).toEqual([other.id]);
  expect(store.messages({ conversationId: room.id }).messages.map(item => item.content)).toEqual(['保留原来的约定。', '记住这次见面。']);
  expect(store.state().conversations.find(item => item.id === group.id)?.memberIds).toEqual([other.id]);
  expect(store.request({ type: 'companion.deletion.pending' }).pendingCompanionDeletions).toEqual([role.id]);
  expect(() => store.openPrivate(role.id)).toThrow();
  const next = store.restoreBuiltin('deepseek-flash');
  expect(next.id).not.toBe(role.id); expect(next.templateId).toBe('deepseek-flash');
  expect(store.openPrivate(next.id).id).not.toBe(room.id);
  expect(store.request({ type: 'memory.list', companionId: next.id }).memories).toEqual([]);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new CompanionsStore(file); stores.push(reopened);
  expect(reopened.request({ type: 'companion.deletion.pending' }).pendingCompanionDeletions).toEqual([role.id]);
  reopened.request({ type: 'companion.deletion.complete', id: role.id });
  expect(reopened.request({ type: 'companion.deletion.pending' }).pendingCompanionDeletions).toEqual([]);
  expect(reopened.restoreBuiltin('deepseek-flash').id).toBe(next.id);
  expect(reopened.messages({ conversationId: room.id }).messages[1]!.authorId).toBe(role.id);
});
