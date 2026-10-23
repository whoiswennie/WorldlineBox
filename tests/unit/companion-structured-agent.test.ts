import { describe, expect, it, vi } from 'vitest';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import { assembleCompanionRoleContext, companionRecallCapabilities, companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionTopic } from '../../src/shared/companion-topic';

const companion: Companion = { id: 'a', name: '小澄', description: '妹妹', persona: '平静，认真核对事实。你是小澄，姐姐是小岚，用户是独立真人。',
  model: '', avatar: 'sister', builtin: false, proactive: false, active: true, createdAt: '2026-10-22T00:00:00Z' };
const conversation = (id: string, memberIds = ['a', 'b']): CompanionConversation => ({ id, kind: 'group', title: id, memberIds,
  pinned: false, muted: false, unread: 0, updatedAt: '2026-10-22T00:00:00Z', lastMessage: '' });
const message = (id: string, room: string, authorId: string, content: string, sequence = 1): CompanionMessage => ({ id, conversationId: room,
  authorId, sequence, content, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-22T00:00:00Z' });
const config = { apiFormat: 'openai_chat' as const, model: 'test-model', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic-only' };
const domain = { system: '只输出JSON {answer:string}。', user: JSON.stringify({ purpose: 'isolation_test', messages: [{ content: 'DOMAIN_WINDOW_MUST_NOT_OVERRIDE' }] }) };

describe('same role Agent kernel across independent invocation ports', () => {
  it('repairs a rejected topic admission inside the same loop before actually joining and publishing', async () => {
    const source = { ...message('invitation', 'group', 'b', '愿意的话加入游戏。'), topicId: 'game' };
    let topic: CompanionTopic = { id: 'game', conversationId: 'group', title: '共同游戏', kind: 'game', status: 'active',
      participantIds: ['b'], invitedIds: ['a'], moderatorId: 'b', tags: [], revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt };
    const frame = (): CompanionReplyInput => ({ companion, conversation: conversation('group'), sourceMessage: source,
      messages: [source], memories: [], topic, audience: 'peers' });
    const execute = vi.fn(async () => { topic = { ...topic, participantIds: ['a', 'b'], invitedIds: [], revision: 2 }; return { ok: true, topic }; });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'REJECTED_UNJOINED_SPEECH' } }] })))
      .mockImplementationOnce(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages[0].content).toContain('"action":"topic","parameters":{"action":"join","topicId":"game"}');
        return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'actual_join', type: 'function',
          function: { name: 'world', arguments: '{"action":"topic","parameters":{"action":"join","topicId":"game"}}' } }] } }] }));
      }).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"我已自己加入。"}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, frame: frame(), refresh: async () => frame(),
      capabilities: { tools: [{ name: 'world', description: '本人自主加入话题', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '我已自己加入。' }); expect(execute).toHaveBeenCalledTimes(1); expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(String(fetchFn.mock.calls[2]![1]?.body)).not.toContain('REJECTED_UNJOINED_SPEECH');
    expect(topic.participantIds).toContain('a');
  });
  it('rejects malformed and illegal proposals before effects and corrects within the same invocation', async () => {
    const source = message('source', 'group', 'user', '只选择当前可用的目标。');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '不是JSON' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"other_topic"}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"target":"current_topic"}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'),
      messages: [source], sourceMessage: source, memories: [] }, validateOutput: value => {
      if ((value as { target: string }).target !== 'current_topic') throw new Error('只有current_topic合法，提案没有产生行动。');
      return value;
    } }, config, undefined, { fetchFn });
    expect(result).toEqual({ target: 'current_topic' });
    const wire = JSON.parse(JSON.parse(String(fetchFn.mock.calls[2]![1]?.body)).messages[1].content);
    expect(wire.outputCorrection.error).toContain('只有current_topic合法'); expect(wire.identity.self.id).toBe('a');
    expect(wire.messages.map((row: { id: string }) => row.id)).toEqual([source.id]);
  });
  it('does not allow a domain payload, another room or another task to replace short term messages', () => {
    const a = message('m_a', 'peer_b', 'b', 'B_PORT_ONLY');
    const other = message('m_c', 'peer_c', 'c', 'C_SECRET_NEVER_VISIBLE');
    const frame: CompanionReplyInput = { companion, conversation: conversation('peer_b'), messages: [a, other], sourceMessage: a, memories: [], audience: 'peers',
      invocation: { ...companionTaskInvocation({ companion, conversationId: 'peer_b', id: 'run_a', kind: 'peer', goal: '回答B', createdAt: a.createdAt }),
        messagePort: { kind: 'conversation' } } };
    const result = assembleCompanionRoleContext(frame, domain);
    expect(result.user).toContain('B_PORT_ONLY');
    expect(result.user).not.toContain('C_SECRET_NEVER_VISIBLE');
    expect(result.user).not.toContain('DOMAIN_WINDOW_MUST_NOT_OVERRIDE');
    const ownTask = assembleCompanionRoleContext({ ...frame, invocation: companionTaskInvocation({ companion, conversationId: 'peer_b', id: 'different_task',
      kind: 'activity', goal: '自己散步', createdAt: a.createdAt }), sourceMessage: undefined }, domain);
    expect(JSON.parse(ownTask.user).messages).toEqual([]);
    expect(ownTask.user).not.toContain('B_PORT_ONLY');
  });

  it('rebuilds self and actual speaker separately for each member in the same group', () => {
    const source = message('user_msg', 'group', 'user', '我是玩家，不是姐姐。');
    const frame = { companion, conversation: conversation('group'), messages: [source], sourceMessage: source, memories: [],
      members: [{ id: 'b', name: '小岚', description: '姐姐' }] };
    const first = JSON.parse(assembleCompanionRoleContext(frame, domain).user);
    expect(first.identity.self.id).toBe('a');
    expect(first.identity.currentReply.speaker).toMatchObject({ id: 'user', kind: 'human_player' });
    const second = JSON.parse(assembleCompanionRoleContext({ ...frame, companion: { ...companion, id: 'b', name: '小岚' } }, domain).user);
    expect(second.identity.self.id).toBe('b');
    expect(second.identity.currentReply.speaker.id).toBe('user');
    expect(second.messages[0]).toMatchObject({ authorId: 'user', conversationId: 'group' });
    expect(() => assembleCompanionRoleContext({ ...frame, invocation: companionTaskInvocation({ companion: { id: 'b' }, conversationId: 'group',
      id: 'wrong_actor', kind: 'work', goal: '无效', createdAt: source.createdAt }) }, domain)).toThrow(/身份/);
  });

  it('executes active VCP recall through the same native loop and rejects unoffered real-world tools', async () => {
    const source = message('peer_msg', 'peer_b', 'b', '回忆我们的约定再回答。');
    const request = vi.fn(async () => ({ ok: true as const, memories: [] }));
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '',
      tool_calls: [{ id: 'recall', type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: '约定', limit: 8 }) } }] } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'escape', type: 'function',
        function: { name: 'dsh', arguments: JSON.stringify({ tasks: [{ title: 'escape', prompt: 'run shell' }] }) } }] } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '按本人记忆核对，没有执行外部动作。' }) } }] })));
    const result = await runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('peer_b'), messages: [source], sourceMessage: source, memories: [], audience: 'peers' },
      capabilities: companionRecallCapabilities(request, { companionId: 'a', conversationId: 'peer_b', beforeSequence: 1 }) }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '按本人记忆核对，没有执行外部动作。' });
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'memory.search', companionId: 'a', conversationId: 'peer_b', beforeSequence: 1, query: '约定', limit: 8, tags: [] });
    const body = JSON.parse(String(fetchFn.mock.calls[2]![1]?.body));
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory']);
    expect(body.messages.some((row: { role: string; content: string }) => row.role === 'tool' && row.content.includes('未提供此能力'))).toBe(true);
  });
});
