import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { buildCompanionContext } from '../../src/main/companions/context';
import { companionInstanceSchema } from '../../src/shared/companion-instance';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const roots: string[] = [], stores: CompanionsStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-instance-')) throw new Error('Invalid fixture root');
    await rm(root, { recursive: true, force: true });
  }
});
it('creates no default contacts, then instantiates only selected owners and persists their explicit primary-topic history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-instance-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), store = new CompanionsStore(file); stores.push(store);
  expect(store.state().companions).toEqual([]); expect(store.state().conversations).toEqual([]);
  const role = store.restoreBuiltin('deepseek-flash'), files = new CompanionAssetProfileStore(path.join(root, '伙伴记忆'), {
    registryStorage: { request: async (command: CompanionStorageCommand) => store.request(command) },
    initialized: async companionId => !!store.request({ type: 'companion.assets.initialized', companionId }).assetProfileInitialized,
    markInitialized: async companionId => { store.request({ type: 'companion.assets.mark-initialized', companionId }); },
  });
  const snapshot = await files.bootstrap(role);
  const manifest = companionInstanceSchema.parse(JSON.parse(await readFile(path.join(snapshot.root, 'instance.json'), 'utf8')));
  expect(manifest.companionId).toBe(role.id); expect(manifest.files.knowledge).toBe('记忆/知识');
  await expect((await files.artifacts(role.id)).get('origin:creation')).resolves.toMatchObject({ kind: 'origin_snapshot', ownerId: role.id });
  expect(await readdir(path.join(root, '伙伴记忆'))).toEqual([role.id]);
  const room = store.openPrivate(role.id), topics = store.request({ type: 'topic.list', conversationId: room.id, readerId: 'user' }).topics!;
  expect(topics).toHaveLength(1); expect(topics[0]).toMatchObject({ id: room.defaultTopicId, title: '主要对话', isPrimary: true, participantIds: ['user', role.id] });
  expect(room.activeTopicId).toBe(room.defaultTopicId);
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '主要对话的真实内容' });
  expect(source.topicId).toBe(room.defaultTopicId);
  const next = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '新的独立讨论', kind: 'discussion' }).topic!;
  expect(next.participantIds).toContain(role.id);
  const other = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '另一话题的内容' });
  expect(other.topicId).toBe(next.id);
  const reply = store.appendMessage({ conversationId: room.id, authorId: role.id, content: '我只回复原话题', replyToId: source.id });
  expect(reply.topicId).toBe(source.topicId);
  const current = buildCompanionContext({ companion: role, conversation: room, topic: next, sourceMessage: other,
    messages: store.messages({ conversationId: room.id }).messages, memories: [] });
  expect(current.user).not.toContain(source.content); expect(current.user).toContain(other.content);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new CompanionsStore(file); stores.push(reopened);
  expect(reopened.state().companions.map(item => item.id)).toEqual([role.id]);
  expect(reopened.request({ type: 'topic.list', conversationId: room.id, readerId: 'user' }).topics).toHaveLength(2);
  expect(reopened.messages({ conversationId: room.id, topicId: room.defaultTopicId }).messages.map(item => item.id)).toEqual([source.id, reply.id]);
});
