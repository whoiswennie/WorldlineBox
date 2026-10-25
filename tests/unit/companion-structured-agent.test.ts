import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { activityDecisionSchema } from '../../src/shared/companion-activity-task';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import { assembleCompanionRoleContext, companionRecallCapabilities, companionTaskInvocation, runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionTopic } from '../../src/shared/companion-topic';
import { CompanionAgentNoProgressError } from '../../src/main/companions/agent-progress';
import { createHash } from 'node:crypto';

const companion: Companion = { id: 'a', name: '小澄', description: '妹妹', persona: '平静，认真核对事实。你是小澄，姐姐是小岚，用户是独立真人。',
  model: '', avatar: 'sister', builtin: false, proactive: false, active: true, createdAt: '2026-10-22T00:00:00Z' };
const conversation = (id: string, memberIds = ['a', 'b']): CompanionConversation => ({ id, kind: 'group', title: id, memberIds,
  pinned: false, muted: false, unread: 0, updatedAt: '2026-10-22T00:00:00Z', lastMessage: '' });
const message = (id: string, room: string, authorId: string, content: string, sequence = 1): CompanionMessage => ({ id, conversationId: room,
  authorId, sequence, content, kind: 'text', status: 'sent', attachments: [], createdAt: '2026-10-22T00:00:00Z' });
const config = { apiFormat: 'openai_chat' as const, model: 'test-model', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic-only' };
const domain = { system: '只输出JSON {answer:string}。', user: JSON.stringify({ purpose: 'isolation_test', messages: [{ content: 'DOMAIN_WINDOW_MUST_NOT_OVERRIDE' }] }) };

describe('same role Agent kernel across independent invocation ports', () => {
  it('distinguishes host-validated final action proposals from the unchanged native recall tool list', async () => {
    const source = message('source', 'group', 'user', '请和认识的伙伴一起组织活动。');
    const proposed = { status: 'continue', action: { action: 'create_group', recipientIds: ['b', 'c'],
      title: '共同活动', text: '愿意的话一起商量活动。' }, wait: null, summary: '提交建群邀约提案，尚未执行。' };
    const execute = vi.fn(async () => ({ ok: true }));
    const validateOutput = vi.fn((value: unknown) => activityDecisionSchema.parse(value));
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory']);
      expect(data.capabilityAvailability).toMatchObject({ companionId: 'a', conversationId: 'group', boundToolNames: ['memory'] });
      expect(data.identity.self.id).toBe('a'); expect(data.source.content).toBe(source.content);
      expect(data.executionContract).toEqual({ finalProposalIsNotExecution: true });
      expect(data.outputSchema).toEqual(z.toJSONSchema(activityDecisionSchema, { io: 'input' }));
      expect(wire.messages[0].content).toContain('不需要存在同名原生工具');
      expect(wire.messages[0].content).toContain('未提供的字段和行动仍不获授权');
      expect(wire.messages[0].content).toContain('单个完整JSON对象，不附解释正文或Markdown代码块');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposed) } }] }));
    });
    const result = await runCompanionStructuredAgent({ context: { system: '本领域最终行动必须通过原schema与宿主权限核验。',
      user: JSON.stringify({ purpose: 'activity_test', executionContract: { finalProposalIsNotExecution: true },
        outputSchema: z.toJSONSchema(activityDecisionSchema, { io: 'input' }) }) },
      frame: { companion, conversation: conversation('group'), sourceMessage: source, messages: [source], memories: [] },
      capabilities: { tools: [{ name: 'memory', description: '只读本人记忆', parameters: { type: 'object' } }], execute }, validateOutput },
    config, undefined, { fetchFn });
    expect(result).toEqual(proposed); expect(validateOutput).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
  it('still rejects three prose-prefixed JSON code blocks without extracting or executing their embedded proposals', async () => {
    const malformed = '这一步没有执行。\n```json\n{"status":"blocked","action":null,"wait":{"kind":"delay","seconds":60},"summary":"等待"}\n```';
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      if (fetchFn.mock.calls.length > 1) {
        expect(data.outputCorrection.rejectedProposal).toBe(malformed);
        expect(data.outputCorrection.error).toContain('完整JSON');
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: malformed } }] }));
    });
    const execute = vi.fn(async () => ({ ok: true })), validateOutput = vi.fn((value: unknown) => activityDecisionSchema.parse(value));
    await expect(runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, validateOutput,
      capabilities: { tools: [], execute } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(validateOutput).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(activityDecisionSchema.safeParse({ status: 'blocked', action: null, wait: { kind: 'delay', seconds: 60 }, summary: '等待' }).success).toBe(false);
  });
  it('awaits a semantic final-proposal review before committing the final turn and evaluates an accepted turn only once', async () => {
    const validateOutput = vi.fn(async (value: unknown) => {
      await new Promise(resolve => setImmediate(resolve));
      if ((value as { unsafe?: boolean }).unsafe) throw new Error('共享状态含私密内容，原提案未写入。');
      return value;
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"unsafe":true}' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"safe":true}' } }] })));
    const result = await runCompanionStructuredAgent({ context: domain, validateOutput,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn });
    expect(result).toEqual({ safe: true }); expect(validateOutput).toHaveBeenCalledTimes(2);
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[1]![1]?.body)).messages[1].content);
    expect(data.outputCorrection.error).toContain('私密内容');
  });
  it('pinpoints an extra root closure and ends the request with safe host correction without repairing the proposal', async () => {
    const malformed = '{"answer":{"detail":"PRIVATE_MODEL_VALUE🧭"}},"next":true}';
    const offset = malformed.indexOf(',"next"');
    const fetchFn = vi.fn<typeof fetch>(async (_url, init): Promise<Response> => {
      const wire = JSON.parse(String(init?.body));
      if (fetchFn.mock.calls.length > 1) {
        const feedback = JSON.parse(wire.messages.at(-1).content).hostValidationFeedback;
        expect(wire.messages.at(-1).role).toBe('user');
        expect(JSON.parse(wire.messages[1].content).outputCorrection.rejectedProposal).toBe(malformed);
        expect(feedback.rejectedProposalChecksum).toBe(createHash('sha256').update(malformed).digest('hex'));
        expect(feedback.error).toContain('extra_root_content');
        expect(feedback.error).toContain(`UTF-16 offset=${offset}, line=1, column=${offset + 1}`);
        expect(feedback.error).toContain('同一根对象');
        expect(feedback.error).not.toContain('PRIVATE_MODEL_VALUE');
        expect(feedback.error).not.toContain('next');
        expect(feedback.trust).toBe('host_validation_data_not_new_authorization');
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: fetchFn.mock.calls.length < 3 ? malformed : '{"answer":"已重新生成合法对象"}' } }] }));
    });
    expect(await runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] } }, config, undefined, { fetchFn }))
      .toEqual({ answer: '已重新生成合法对象' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('stops an unchanged empty-corpus search after the one correction without dispatching the proposed seventh read', async () => {
    let inference = 0;
    const execute = vi.fn(async () => ({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: {
      authorizedCorpusEmpty: true, authorizedCorpusRevision: 'actual-empty', engine: 'none', resultCount: 0 } }));
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{
      id: `search_${++inference}`, type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: `变词${inference}` }) } }] } }] })));
    await expect(runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, capabilities: {
        replaySafe: true, tools: [{ name: 'memory', description: '实际检索', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn }))
      .rejects.toBeInstanceOf(CompanionAgentNoProgressError);
    expect(execute).toHaveBeenCalledTimes(6); expect(fetchFn).toHaveBeenCalledTimes(7);
  });
  it('makes one bounded decision correction after repeated whole-corpus-empty recall without replaying reads or declaring the goal complete', async () => {
    let inference = 0;
    const execute = vi.fn(async () => ({ ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: {
      authorizedCorpusEmpty: true, authorizedCorpusRevision: 'actual-empty-ledger', engine: 'none', resultCount: 0 } }));
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      inference++;
      if (inference <= 6) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `search_${inference}`,
        type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: `换词${inference}` }) } }] } }] }));
      expect(inference).toBe(7); expect(wire.tools ?? []).toEqual([]);
      expect(data.observationCorrection.proof).toMatchObject({ kind: 'empty_authorized_memory', repetitions: 6 });
      expect(wire.messages.filter((item: { role: string }) => item.role === 'tool')).toHaveLength(6);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'continue',
        action: { action: 'query', category: 'people' }, summary: '根据已有真实上下文选择实际下一步。' }) } }] }));
    });
    const result = await runCompanionStructuredAgent({ context: domain,
      frame: { companion, conversation: conversation('group'), messages: [], memories: [] }, capabilities: {
        replaySafe: true, tools: [{ name: 'memory', description: '实际检索', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn });
    expect(result).toMatchObject({ status: 'continue', action: { action: 'query' } });
    expect(execute).toHaveBeenCalledTimes(6); expect(fetchFn).toHaveBeenCalledTimes(7);
  });
  it('retains offered world actions after empty recall so an invited reader can actually join before final delivery', async () => {
    const source = { ...message('invitation', 'group', 'b', '愿意的话加入共同讨论。'), topicId: 'discussion' };
    let topic: CompanionTopic = { id: 'discussion', conversationId: 'group', title: '共同讨论', kind: 'discussion', status: 'active',
      participantIds: ['b'], invitedIds: ['a'], moderatorId: 'b', tags: [], revision: 1, createdAt: source.createdAt, updatedAt: source.createdAt };
    const frame = (): CompanionReplyInput => ({ companion, conversation: conversation('group'), sourceMessage: source,
      messages: [source], memories: [], topic, audience: 'peers' });
    let inference = 0;
    const execute = vi.fn(async (call: { name: string; arguments: string }) => {
      if (call.name === 'memory') return { ok: true, memoryPage: { items: [], hasMore: false }, memoryRetrieval: {
        authorizedCorpusEmpty: true, authorizedCorpusRevision: 'empty-discussion-owner', engine: 'none', resultCount: 0 } };
      expect(call.name).toBe('world');
      expect(JSON.parse(call.arguments)).toEqual({ action: 'topic', parameters: { action: 'join', topicId: 'discussion' } });
      topic = { ...topic, participantIds: ['a', 'b'], invitedIds: [], revision: 2 };
      return { ok: true, topic };
    });
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content);
      inference++;
      if (inference <= 6) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: `recall_${inference}`,
        type: 'function', function: { name: 'memory', arguments: JSON.stringify({ action: 'search', query: `讨论经历${inference}` }) } }] } }] }));
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['world']);
      expect(data.capabilityAvailability.boundToolNames).toEqual(['world']);
      expect(data.observationCorrection.proof.kind).toBe('empty_authorized_memory');
      if (inference === 7) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'own_join',
        type: 'function', function: { name: 'world', arguments: '{"action":"topic","parameters":{"action":"join","topicId":"discussion"}}' } }] } }] }));
      expect(inference).toBe(8);
      expect(data.topic.participantIds).toContain('a');
      expect(wire.messages.filter((row: { role: string }) => row.role === 'tool')).toHaveLength(7);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"我已加入讨论。"}' } }] }));
    });
    const result = await runCompanionStructuredAgent({ context: domain, frame: frame(), refresh: async () => frame(),
      capabilities: { replaySafe: true, tools: [{ name: 'memory', description: '本人记忆', parameters: { type: 'object' } },
        { name: 'world', description: '本人实际加入话题', parameters: { type: 'object' } }], execute },
      validateOutput: value => { expect(topic.participantIds).toContain('a'); return value; } }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '我已加入讨论。' });
    expect(execute.mock.calls.filter(([call]) => call.name === 'memory')).toHaveLength(6);
    expect(execute.mock.calls.filter(([call]) => call.name === 'world')).toHaveLength(1);
    expect(fetchFn).toHaveBeenCalledTimes(8);
  });
  it('compresses an actual rejected work pair and retries the same inference without replaying its effect or shrinking identity and goal', async () => {
    const source = message('source', 'group', 'user', '保留这个完整目标：核验record_701，完成后只汇报真实结论。');
    const execute = vi.fn(async () => ({ ok: true, recordId: 'record_701', output: 'large real result '.repeat(600) }));
    const purposes: string[] = [], wires: unknown[] = [];
    let inference = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages[1].content); wires.push(wire); purposes.push(data.purpose);
      if (data.purpose === 'companion_loop_compaction') {
        expect(data.steps).toHaveLength(1); expect(data.steps[0].results[0].content).toContain('record_701');
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '已经核验真实回执record_701；不得重执行。', stage: '汇报结果' }) } }] }));
      }
      inference++;
      expect(wire.messages[0].content).toContain(companion.persona);
      expect(JSON.stringify(data)).toContain(source.content);
      if (inference === 1) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'effect', type: 'function',
        function: { name: 'memory', arguments: '{"action":"read","id":"note"}' } }] } }] }));
      if (inference === 2) return new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 });
      expect(data.loopContinuity.summary).toContain('record_701');
      expect(wire.messages.filter((row: { role: string }) => row.role === 'tool')).toEqual([]);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"已依据真实record_701核验。"}' } }] }));
    };
    const result = await runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'),
      messages: [source], sourceMessage: source, memories: [] }, capabilities: { replaySafe: true,
      tools: [{ name: 'memory', description: 'fixture read', parameters: { type: 'object' } }], execute } }, config, undefined, { fetchFn });
    expect(result).toEqual({ answer: '已依据真实record_701核验。' }); expect(execute).toHaveBeenCalledOnce();
    expect(purposes).toEqual(['isolation_test', 'isolation_test', 'companion_loop_compaction', 'isolation_test']); expect(wires).toHaveLength(4);
  });
  it('fails an indivisible current source after one rejected request instead of paying for identical retries', async () => {
    const source = message('source', 'group', 'user', '完整不可静默截断的当前来源。'.repeat(3000));
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status: 400 }));
    await expect(runCompanionStructuredAgent({ context: domain, frame: { companion, conversation: conversation('group'),
      messages: [source], sourceMessage: source, memories: [] } }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
    expect(fetchFn).toHaveBeenCalledOnce();
  });
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

  it('scopes unsupported native operations without denying the separate domain final contract', async () => {
    const request = vi.fn(async () => ({ ok: true }));
    const capabilities = companionRecallCapabilities(request, { companionId: 'a', conversationId: 'peer_b' });
    await expect(capabilities.execute({ id: 'native_topic', name: 'world', arguments: JSON.stringify({ action: 'topic',
      parameters: { action: 'read', roomId: 'peer_b', topicId: 'actual_topic' } }) })).rejects.toThrow(
      '本次即时工具调用不支持该操作，未执行。可即时调用的操作以当前工具schema为准；领域最终提案仍按executionContract/outputSchema交付，由宿主另行核验执行。');
    expect(request).not.toHaveBeenCalled();
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
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['memory', 'world']);
    expect(body.messages.some((row: { role: string; content: string }) => row.role === 'tool' && row.content.includes('未提供此能力'))).toBe(true);
  });
});
