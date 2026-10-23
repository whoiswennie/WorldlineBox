import { expect, it, vi } from 'vitest';
import { companionSocialCapabilities } from '../../src/main/companions/social-capabilities';
import { companionTopicCapabilities } from '../../src/main/companions/topic-capabilities';
import type { CompanionLoopCall } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const call = (args: unknown, id = 'tool_call'): CompanionLoopCall => ({ id, name: 'world', arguments: JSON.stringify(args) });
function fixture(allowed = true) {
  const request = vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(async () => ({ ok: true }));
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
  expect(f.request).toHaveBeenCalledWith({ type: 'topic.join', conversationId: 'peer_room', readerId: 'alice', topicId: 'werewolf_topic' });
});
