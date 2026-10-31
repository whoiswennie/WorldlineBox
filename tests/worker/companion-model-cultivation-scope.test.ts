import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionModelCultivationScope } from '../../src/main/companions/model-cultivation-scope';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

it('uses only a real member relationship or the exact authorized live origin for cultivation, never a standalone learning port', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-cultivation-scope-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-cultivation-scope-')) throw new Error('Unsafe scope fixture path.');
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '按实际来源。', model: '', avatar: 'sister', active: true, proactive: false })));
  try {
    const room = store.openPrivate('alice').id, other = store.openPrivate('bob').id;
    const request = async (command: CompanionStorageCommand) => store.request(command);
    const resolve = (data: Record<string, unknown>) => companionModelCultivationScope('alice', data, request);
    expect(await resolve({ identity: { currentReply: { conversationId: room } } })).toBe(room);
    const standalone = { identity: { currentReply: { conversationId: 'learning_isolated_goal' } },
      invocation: { conversationId: 'learning_isolated_goal', authorization: { sourceMessageIds: [] } } };
    expect(await resolve(standalone)).toBeUndefined();
    const source = store.appendMessage({ conversationId: room, authorId: 'user', content: '请逐步练习更简洁的表达。', replyDirective: 'none' });
    const origin = { ...standalone, source: { id: source.id, conversationId: room, content: source.content, revision: source.revision } };
    expect(await resolve(origin)).toBeUndefined();
    const authorized = { ...origin, invocation: { ...standalone.invocation, authorization: { sourceMessageIds: [source.id] } } };
    expect(await resolve(authorized)).toBe(room);
    expect(await resolve({ ...authorized, identity: { currentReply: { conversationId: other } } })).toBeUndefined();
    expect(await resolve({ ...authorized, source: { ...origin.source, content: '被外部冒换的任务来源。' } })).toBeUndefined();
    store.request({ type: 'memory.forget', companionId: 'alice', conversationId: room, sourceMessageIds: [source.id] });
    expect(await resolve(authorized)).toBeUndefined();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
