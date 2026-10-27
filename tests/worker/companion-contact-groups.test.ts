import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';

const roots: string[] = [], stores: CompanionsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-groups-')) throw new Error('Invalid fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});
it('persists separate contact and group-chat organization and removes groups without deleting their members or history', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-groups-')); roots.push(root);
  const file = path.join(root, 'contacts.sqlite'), store = new CompanionsStore(file); stores.push(store);
  const alice = store.restoreBuiltin('deepseek-flash'), bob = store.restoreBuiltin('deepseek-sister');
  const room = store.request({ type: 'conversation.create-group', title: '周末', memberIds: [alice.id, bob.id] }).conversation!;
  const message = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '周末一起去海边。' });
  let state = store.request({ type: 'contact.groups.read' }).contactGroups!;
  expect(state.groups.map(group => group.kind)).toEqual(['contacts', 'conversations']);
  state = store.request({ type: 'contact.groups.create', kind: 'contacts', name: '朋友', expectedRevision: state.revision }).contactGroups!;
  const contactsId = state.groups.at(-1)!.id;
  state = store.request({ type: 'contact.groups.create', kind: 'conversations', name: '朋友', expectedRevision: state.revision }).contactGroups!;
  const roomsId = state.groups.at(-1)!.id;
  expect(() => store.request({ type: 'contact.groups.assign', kind: 'conversations', groupId: contactsId, itemIds: [room.id], expectedRevision: state.revision })).toThrow('类型');
  expect(() => store.request({ type: 'contact.groups.assign', kind: 'contacts', groupId: contactsId, itemIds: [room.id], expectedRevision: state.revision })).toThrow('当前存在');
  state = store.request({ type: 'contact.groups.assign', kind: 'contacts', groupId: contactsId, itemIds: [alice.id, bob.id], expectedRevision: state.revision }).contactGroups!;
  state = store.request({ type: 'contact.groups.assign', kind: 'conversations', groupId: roomsId, itemIds: [room.id], expectedRevision: state.revision }).contactGroups!;
  state = store.request({ type: 'contact.groups.rename', id: contactsId, name: '特别关心', expectedRevision: state.revision }).contactGroups!;
  expect(() => store.request({ type: 'contact.groups.rename', id: contactsId, name: '旧页面覆盖', expectedRevision: state.revision - 1 })).toThrow('已更新');
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new CompanionsStore(file); stores.push(reopened);
  expect(reopened.request({ type: 'contact.groups.read' }).contactGroups).toEqual(state);
  state = reopened.request({ type: 'contact.groups.remove', id: contactsId, expectedRevision: state.revision }).contactGroups!;
  expect(state.assignments[alice.id]).toBeUndefined(); expect(state.assignments[bob.id]).toBeUndefined();
  expect(state.assignments[room.id]).toBe(roomsId);
  expect(reopened.state().companions).toHaveLength(2);
  expect(reopened.messages({ conversationId: room.id }).messages.map(item => item.id)).toContain(message.id);
  expect(() => reopened.request({ type: 'contact.groups.remove', id: 'contacts_default', expectedRevision: state.revision })).toThrow('默认');
});
