import { expect, it, vi } from 'vitest';
import { companionSocialCapabilities } from '../../src/main/companions/social-capabilities';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import type { CompanionLoopCall } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

const call = (args: unknown, id = 'tool_call'): CompanionLoopCall => ({ id, name: 'world', arguments: JSON.stringify(args) });
function fixture(allowed = true) {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async command => command.type === 'social.conversation.ensure'
    ? { ok: true, socialConversation: { id: 'actual_pair', kind: 'private', memberIds: ['alice', 'bob'], title: '', updatedAt: '2026-10-23T10:00:00Z', messageCount: 0 } } : { ok: true });
  const scope = { companionId: 'alice', conversationId: 'peer_room', sourceMessageId: 'peer_source', beforeSequence: 10 };
  const authorize = vi.fn(async () => allowed);
  const capabilities = companionSocialCapabilities(request, scope, companionTopicCapabilities(request, scope), authorize);
  return { request, scope, authorize, capabilities };
}
it('binds discovery, self-introduction and group creation to the real speaker and exact invocation, with stable delivery retries', async () => {
  const f = fixture(), actions = [{ action: 'query', category: 'people', query: 'bob' },
    { action: 'introduce', targetCompanionId: 'bob', text: '我是alice，你好！' },
    { action: 'create_group', recipientIds: ['bob', 'carol'], title: '游戏群', text: '想一起玩狼人杀吗？', includePlayer: true }];
  for (const action of actions) await f.capabilities.execute(call(action));
  expect(f.request.mock.calls.map(([command]) => command)).toEqual(actions.map(arguments_ => expect.objectContaining({ type: 'world.tool', ...f.scope, arguments: arguments_ })));
  await f.capabilities.execute(call(actions[2]));
  expect(f.request.mock.calls[2]![0]).toEqual(f.request.mock.calls[3]![0]);
  expect(f.authorize).toHaveBeenCalledTimes(3);
  expect(f.capabilities.tools.map(tool => tool.name)).toEqual(['world']);
});
it('rejects private forwarding before any mutation, foreign identities and non-social execution', async () => {
  const f = fixture(false);
  await expect(f.capabilities.execute(call({ action: 'message', recipientIds: ['bob'], text: 'PRIVATE_PLAYER_DATA' }))).rejects.toThrow('不能转发私聊');
  expect(f.request).not.toHaveBeenCalled();
  await expect(f.capabilities.execute(call({ action: 'introduce', targetCompanionId: 'bob', text: '你好', companionId: 'carol' }))).rejects.toThrow();
  await expect(f.capabilities.execute(call({ action: 'move', destinationId: 'computer' }))).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
});
it('retains per-reader topic actions alongside social agency without letting callers replace the message port', async () => {
  const f = fixture();
  await f.capabilities.execute(call({ action: 'topic', parameters: { action: 'join', topicId: 'werewolf_topic' } }));
  expect(f.request).toHaveBeenCalledWith({ type: 'topic.join', conversationId: 'peer_room', readerId: 'alice', topicId: 'werewolf_topic', operationId: 'brain_tool_call' });
});
it('reports peer social delivery without implying a collaboration or computer execution grant', async () => {
  const f = fixture();
  const result = await f.capabilities.execute(call({ action: 'message', recipientIds: ['bob'], text: '现在方便聊聊吗？' }));
  expect(result).toMatchObject({ ok: true, socialDelivery: { socialOnly: true, executionGrantCreated: false,
    collaborationCreated: false, continuationKind: 'none' } });
  expect(f.request.mock.calls.map(([command]) => command.type)).toEqual(['social.contact.check', 'social.conversation.ensure', 'social.send']);
  const first = f.request.mock.calls[2]![0];
  expect(first).toMatchObject({ type: 'social.send', companionId: 'alice', conversationId: 'actual_pair',
    clientId: expect.stringMatching(/^peer_/), agentSource: { conversationId: 'peer_room', messageId: 'peer_source' } });
  expect(first).not.toHaveProperty('authorizationMessageId');
  await f.capabilities.execute(call({ action: 'message', recipientIds: ['bob'], text: '现在方便聊聊吗？' }));
  expect(f.request.mock.calls[5]![0]).toEqual(first);
});
it('returns the actual game port with a truthful private-message versus topic-state handoff contract', async () => {
  const f = fixture(), capabilities = companionSocialCapabilities(f.request, f.scope, companionTopicCapabilities(f.request, f.scope), f.authorize,
    { gamePort: { conversationId: 'original_game_group', topicId: 'original_game_topic' } });
  expect(await capabilities.execute(call({ action: 'message', recipientIds: ['bob'], text: '这条真实单独消息只负责送达。' }))).toMatchObject({ gameStateHandoff: {
    automaticTopicStateTransfer: false, gamePort: { conversationId: 'original_game_group', topicId: 'original_game_topic' },
    notice: expect.stringContaining('不会自动把私信正文写入其他入口') } });
  expect(f.request.mock.calls.map(([command]) => command.type)).toEqual(['social.contact.check', 'social.conversation.ensure', 'social.send']);
});

it('binds actual outgoing private communication to the sender readset while keeping each original dependency room intact', async () => {
  const f = fixture();
  const readset = captureCompanionExecutionReadset({ companionId: 'alice', conversationId: f.scope.conversationId }, {
    topics: [{ conversationId: 'actual_game_room', topicId: 'actual_game', checkpointEventIds: ['own_private_checkpoint'], sourceMessageIds: ['private_card_source'] }],
    sources: [{ conversationId: f.scope.conversationId, id: f.scope.sourceMessageId, checksum: 'a'.repeat(64) }],
  });
  const capabilities = companionSocialCapabilities(f.request, f.scope, companionTopicCapabilities(f.request, f.scope), f.authorize,
    { executionReadset: () => readset });
  await capabilities.execute(call({ action: 'message', recipientIds: ['bob'], text: '本局本人已选择行动。' }));
  expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ type: 'social.send', conversationId: 'actual_pair',
    executionReadset: { ...readset, conversationId: 'actual_pair' } });
  expect(readset.conversationId).toBe(f.scope.conversationId);
  expect(JSON.stringify(f.request.mock.calls.at(-1)![0])).not.toContain('private state body');
});
