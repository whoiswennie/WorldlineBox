import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';

const roots: string[] = [], stores: CompanionsStore[] = [];
const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean }): CompanionConnection };
afterEach(() => { stores.splice(0).forEach(store => store.close()); for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-deletion-')) throw new Error('Invalid fixture path');
  rmSync(root, { recursive: true, force: true });
} });
it('uses one durable retirement pipeline for deletion, erases owned history and creates a template only as a new published identity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-deletion-')); roots.push(root);
  const file = path.join(root, 'messages.sqlite'), store = new CompanionsStore(file, BUILTIN_COMPANIONS.slice(0, 2)); stores.push(store);
  const role = store.state().companions.find(owner => owner.id === 'deepseek-flash')!, other = store.state().companions.find(owner => owner.id === 'deepseek-sister')!;
  const profiles = new CompanionAssetProfileStore(path.join(root, 'owner-files'), { registryStorage: { request: async command => store.request(command) } });
  await profiles.bootstrap(role);
  const room = store.openPrivate(role.id), group = store.request({ type: 'conversation.create-group', title: '共同聊天', memberIds: [role.id, other.id] }).conversation!;
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '需要随身份删除的私聊。' });
  store.appendMessage({ conversationId: room.id, authorId: role.id, content: '自己的私聊发言。', replyToId: source.id });
  const memory = store.request({ type: 'memory.record', companionId: role.id, conversationId: room.id,
    candidate: { artifactKind: 'episode_memory', content: source.content, sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
  const own = store.appendMessage({ conversationId: group.id, authorId: role.id, content: '需要删除的群聊发言。' });
  const retained = store.appendMessage({ conversationId: group.id, authorId: other.id, content: '其他作者的原文保留。' });
  const topic = store.request({ type: 'topic.create', conversationId: group.id, readerId: role.id, title: '主持的讨论', kind: 'discussion',
    participantIds: ['user', role.id, other.id], moderatorId: role.id }).topic!;
  const groups = store.request({ type: 'contact.groups.read' }).contactGroups!;
  store.request({ type: 'contact.groups.assign', kind: 'contacts', groupId: groups.groups[0]!.id, itemIds: [role.id], expectedRevision: groups.revision });
  const fixtureDb = new Database(file);
  try {
    for (const owner of [role.id, other.id]) fixtureDb.prepare('INSERT INTO companion_growth_input_scopes(owner_id,conversation_id,generation,processed_generation) VALUES(?,?,2,0)').run(owner, group.id);
    for (const owner of [role.id, other.id]) {
      fixtureDb.prepare('INSERT INTO companion_growth_goals(id,companion_id,conversation_id,revision,data) VALUES(?,?,?,?,?)').run('goal-' + owner, owner, group.id, 1, '{}');
      fixtureDb.prepare('INSERT INTO companion_growth_goal_definitions(goal_id,revision,sources) VALUES(?,?,?)').run('goal-' + owner, 1, JSON.stringify([{ messageId: owner === role.id ? source.id : retained.id, revision: 1 }]));
    }
    expect(fixtureDb.prepare('SELECT COUNT(*) n FROM companion_artifact_publication_producers WHERE owner_id=?').get(role.id)).not.toEqual({ n: 0 });
  } finally { fixtureDb.close(); }
  const result = store.request({ type: 'companion.delete', id: role.id }), job = result.reset!;
  expect(job.operation).toBe('retire_identity'); expect(job.phase).toBe('stopping');
  expect(store.request({ type: 'companion.retire', id: role.id, scope: 'all' }).reset?.id).toBe(job.id);
  store.request({ type: 'companion.retire.cleanup', id: role.id, jobId: job.id });
  for (let batch = 0; store.request({ type: 'companion.retire.status', id: role.id }).reset?.status !== 'completed'; batch++) {
    if (batch > 200) throw new Error('Retirement failed to finish.'); await store.advanceReset();
  }
  expect(store.state().companions.map(item => item.id)).toEqual([other.id]);
  expect(store.messages({ conversationId: room.id }).messages).toEqual([]);
  expect(store.messages({ conversationId: group.id }).messages.map(item => item.id)).toEqual([retained.id]);
  expect(() => store.getMessage(own.id)).toThrow();
  expect(() => store.request({ type: 'memory.read', companionId: role.id, conversationId: room.id, id: memory.id })).toThrow();
  expect(store.state().conversations.find(item => item.id === group.id)?.memberIds).toEqual([other.id]);
  expect(store.request({ type: 'contact.groups.read' }).contactGroups?.assignments[role.id]).toBeUndefined();
  const remainingTopic = store.request({ type: 'topic.read', conversationId: group.id, topicId: topic.id, readerId: 'user' }).topic!;
  expect(remainingTopic.moderatorId).toBe('user'); expect(remainingTopic.participantIds).not.toContain(role.id);
  expect(remainingTopic.invitedIds).not.toContain(role.id); expect(remainingTopic.revision).toBeGreaterThan(topic.revision);
  expect(() => store.openPrivate(role.id)).toThrow();
  const create = { type: 'companion.creation.prepare' as const, operationId: randomUUID(), companionId: randomUUID(), request: { kind: 'builtin' as const, templateId: 'flash' as const } };
  const prepared = store.request(create);
  await profiles.bootstrap(prepared.companion!);
  const next = store.request({ type: 'companion.creation.commit', operationId: create.operationId }).companion!;
  expect(next.id).not.toBe(role.id); expect(next.templateId).toBe('flash'); expect(store.openPrivate(next.id).id).not.toBe(room.id);
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new CompanionsStore(file); stores.push(reopened);
  expect(reopened.state().companions.map(item => item.id)).toEqual([other.id, next.id]);
  expect(reopened.request({ type: 'companion.delete', id: role.id }).reset?.id).toBe(job.id);
  expect(reopened.request({ type: 'companion.creation.status', operationId: create.operationId }).creation?.state).toBe('committed');
  const read = new Database(file, { readonly: true });
  try {
    for (const table of ['companion_artifacts', 'companion_artifact_versions', 'companion_artifact_publication_producers', 'companion_growth_input_scopes'])
      expect(read.prepare('SELECT COUNT(*) n FROM ' + table + ' WHERE owner_id=?').get(role.id)).toEqual({ n: 0 });
    expect(read.prepare('SELECT generation FROM companion_growth_input_scopes WHERE owner_id=?').get(other.id)).toEqual({ generation: 2 });
    expect(read.prepare('SELECT COUNT(*) n FROM companion_growth_goal_definitions WHERE goal_id=?').get('goal-' + role.id)).toEqual({ n: 0 });
    expect(read.prepare('SELECT revision FROM companion_growth_goal_definitions WHERE goal_id=?').get('goal-' + other.id)).toEqual({ revision: 1 });
  } finally { read.close(); }
});
