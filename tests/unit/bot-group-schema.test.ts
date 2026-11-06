import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BotStore } from '../../src/main/companion-bot/store';

const owned: Array<{ root: string; store?: BotStore }> = [];
afterEach(() => {
  for (const item of owned.splice(0).reverse()) {
    item.store?.close();
    if (path.dirname(path.resolve(item.root)) !== path.resolve(tmpdir()) || !path.basename(item.root).startsWith('wlb-group-schema-')) throw new Error('Invalid schema fixture cleanup.');
    rmSync(item.root, { recursive: true, force: true });
  }
});
const LegacyDatabase = Database as new (filename: string) => { exec(sql: string): void; close(): void };
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'wlb-group-schema-')), filename = path.join(root, 'bot.sqlite');
  const item = { root, store: new BotStore(filename) }; owned.push(item);
  item.store.createCompanion({ id: 'alice', name: 'Alice', persona: '公开角色 A' });
  item.store.createCompanion({ id: 'bob', name: 'Bob', persona: '公开角色 B' });
  return { item, filename };
}

it('upgrades v15 peer groups to include their user owner while preserving history, source identities and dissolved revocation', () => {
  const { item, filename } = fixture(), original = item.store;
  const visible = original.createGroup({ title: '旧伙伴群', memberIds: ['alice', 'bob'] });
  const dissolved = original.createGroup({ title: '已解散旧群', memberIds: ['alice'] });
  const direct = original.openDirect('alice');
  const source = original.enqueue({ conversationId: visible.id, senderId: 'user', recipientIds: ['bob'], sourceMessageId: 'preserved-v15-source', content: '这个公开群的原始历史保持不变。' });
  const privateSource = original.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: [], sourceMessageId: 'private-v15-source', content: 'PRIVATE_V15_SENTINEL' });
  const dissolvedSource = original.enqueue({ conversationId: dissolved.id, senderId: 'user', recipientIds: [], sourceMessageId: 'dissolved-v15-source', content: '已解散群的历史保留，但不重新授权。' });
  const stamp = '2026-11-03T01:02:03.000Z';
  original.setMetadata(`conversation-dissolved:${dissolved.id}`, stamp);
  original.taskTransaction(sql => { sql.prepare("DELETE FROM bot_members WHERE member_id='user' AND conversation_id IN (?,?)").run(visible.id, dissolved.id); });
  original.close();
  const legacy = new LegacyDatabase(filename); legacy.exec('PRAGMA user_version=15'); legacy.close();
  item.store = new BotStore(filename); const migrated = item.store;
  expect(migrated.taskTransaction(sql => sql.prepare('PRAGMA user_version').get())).toEqual({ user_version: 19 });
  expect(migrated.getConversation(visible.id)).toMatchObject({ ownerId: 'user', revision: visible.revision, securityDomainId: visible.securityDomainId });
  expect(migrated.getConversation(visible.id)!.memberIds.sort()).toEqual(['alice', 'bob', 'user']);
  expect(migrated.getEvent(source.events[0]!.id)).toEqual(source.events[0]);
  expect(migrated.getMessage(source.message.id)).toEqual(source.message);
  expect(migrated.getMessage(privateSource.message.id)).toEqual(privateSource.message);
  expect(migrated.messagesPage(visible.id).items.map(message => message.content).join('\n')).not.toContain('PRIVATE_V15_SENTINEL');
  expect(migrated.getConversation(dissolved.id)).toMatchObject({ ownerId: 'user', dissolvedAt: stamp, securityDomainId: dissolved.securityDomainId });
  expect(migrated.getConversation(dissolved.id)!.memberIds).not.toContain('user');
  expect(migrated.conversations().map(room => room.id)).not.toContain(dissolved.id);
  expect(migrated.getMessage(dissolvedSource.message.id)).toEqual(dissolvedSource.message);
  expect(() => migrated.enqueue({ conversationId: dissolved.id, senderId: 'user', content: '不能重新发言', sourceMessageId: 'not-resurrected' })).toThrow();
});

it('treats an empty old dissolution marker as visible, then keeps a real dissolution revoked across v16 reopen', () => {
  const { item, filename } = fixture();
  const visible = item.store.createGroup({ title: '空标记旧群', memberIds: ['alice', 'bob'] });
  item.store.setMetadata(`conversation-dissolved:${visible.id}`, '');
  item.store.taskTransaction(sql => { sql.prepare("DELETE FROM bot_members WHERE conversation_id=? AND member_id='user'").run(visible.id); });
  item.store.close();
  const legacy = new LegacyDatabase(filename); legacy.exec('PRAGMA user_version=15'); legacy.close();
  item.store = new BotStore(filename);
  expect(item.store.getConversation(visible.id)!.memberIds).toContain('user');
  expect(item.store.getConversation(visible.id)!.dissolvedAt).toBeUndefined();
  item.store.dissolveConversation(visible.id);
  const revoked = item.store.getConversation(visible.id)!;
  item.store.close(); item.store = new BotStore(filename);
  expect(item.store.getConversation(visible.id)).toEqual(revoked);
  expect(item.store.getConversation(visible.id)!.memberIds).not.toContain('user');
  expect(item.store.conversations().some(room => room.id === visible.id)).toBe(false);
});
