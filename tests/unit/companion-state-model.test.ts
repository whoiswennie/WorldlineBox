import { describe, expect, it, vi } from 'vitest';
import { buildCompanionContext, companionRuntimeBehavior, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { generateCompanionJournal } from '../../src/main/companions/memory-model';
import { companionStateArgumentsSchema } from '../../src/shared/companion-state-tool';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

const runtimeState: CompanionRuntimeState = { companionId: 'sister', energy: 20, mood: 'tired', expression: 'gentle',
  affect: { pleasure: -0.25, arousal: 0.4, dominance: -0.1 }, relationship: { affinity: 60, trust: 60, respect: 60 },
  focus: 'WorldlineBox 聊天开发', reason: '真实工作后需要休息', sourceConversationId: 'private_sister', sourceMessageIds: ['user_message'],
  evidence: [{ sourceMessageId: 'user_message', quote: '谢谢你一直陪我做 WorldlineBox' }],
  familiarity: { stage: 'acquainted', interactionCount: 12, sharedEventCount: 2 }, updatedAt: '2026-10-14T00:00:00Z', revision: 2 };
const input: CompanionReplyInput = {
  companion: { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳，喜欢海洋。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' },
  conversation: { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' },
  messages: [{ id: 'user_message', sequence: 1, conversationId: 'private_sister', authorId: 'user', kind: 'text', content: '谢谢你一直陪我做 WorldlineBox。', status: 'sent', attachments: [], createdAt: '2026-10-14T00:00:00Z' }], memories: [], runtimeState,
};
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' };
const proposal = { reason: '用户实际表达陪伴支持', appraisals: [{ type: 'support', target: 'user', intensity: 0.6, confidence: 0.9 }],
  sourceMessageIds: ['user_message'], evidence: [{ sourceMessageId: 'user_message', quote: '谢谢你一直陪我做 WorldlineBox' }] };
function response(format: AiApiFormat): Response {
  const name = 'state', args = { action: 'inspect' };
  const message = { content: null, tool_calls: [{ id: 'state_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  const value = format === 'openai_chat' ? { choices: [{ message }] }
    : format === 'dashscope_native' ? { output: { choices: [{ message }] } }
      : format === 'openai_responses' ? { output: [{ type: 'function_call', call_id: 'state_1', name, arguments: JSON.stringify(args) }] }
        : format === 'anthropic' ? { content: [{ type: 'tool_use', id: 'state_1', name, input: args }] }
          : { candidates: [{ content: { parts: [{ functionCall: { id: 'state_1', name, args } }] } }] };
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
}
function structured(value: unknown): Response { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] })); }

describe('continuous companion state affects behavior without replacing persona or authority', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'injects the current host state and exposes a real native state inspection in %s', async format => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(format));
      const reply = await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true });
      expect(reply.turn?.calls[0]).toEqual({ id: 'state_1', name: 'state', arguments: '{"action":"inspect"}' });
      const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      const data = JSON.parse(format === 'openai_responses' ? request.input[0].content : format === 'gemini_native' ? request.contents[0].parts[0].text
        : format === 'dashscope_native' ? request.input.messages[1].content[0].text : request.messages[format === 'anthropic' ? 0 : 1].content);
      expect(data.runtimeState).toMatchObject(runtimeState);
      expect(data.runtimeBehavior).toMatchObject({ responseLength: 'brief', topicExpansion: 'limited', normalRequestsRemainAvailable: true });
      expect(JSON.stringify(request)).toContain(input.companion.persona);
      expect(JSON.stringify(request)).toContain('state');
      const result = JSON.stringify({ ok: true, runtimeState });
      await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true,
        turns: [{ ...reply.turn!, results: [{ callId: 'state_1', content: result }] }] });
      const next = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
      if (format === 'openai_chat' || format === 'dashscope_native') expect((format === 'openai_chat' ? next.messages : next.input.messages).at(-1)).toEqual({ role: 'tool', tool_call_id: 'state_1', content: result });
      else if (format === 'openai_responses') expect(next.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'state_1', output: result });
      else if (format === 'anthropic') expect(next.messages.at(-1).content[0]).toEqual({ type: 'tool_result', tool_use_id: 'state_1', content: result });
      else expect(next.contents.at(-1).parts[0].functionResponse).toEqual({ id: 'state_1', name: 'state', response: { result } });
    });
  it('maps PAD and separate affinity/trust/respect to calm expression, initiative and boundaries', () => {
    const behavior = companionRuntimeBehavior({ ...runtimeState, energy: 80, mood: 'low', relationship: { affinity: 70, trust: 20, respect: 20 } });
    expect(behavior).toMatchObject({ responseLength: 'brief', topicExpansion: 'limited', emotionalDelivery: 'calm_and_clear',
      boundaryStyle: 'explicit_calm_boundaries', normalRequestsRemainAvailable: true, stablePersonaRemainsAuthoritative: true });
    expect(companionRuntimeBehavior({ ...runtimeState, energy: 80, mood: 'bright', affect: { pleasure: 0.5, arousal: 0.1, dominance: 0.2 },
      relationship: { affinity: 70, trust: 70, respect: 70 } }).initiative).toBe('familiar');
    expect(companionRuntimeBehavior({ ...runtimeState, energy: 80, mood: 'focused' }).currentFocus).toBe(runtimeState.focus);
  });
  it.each(['gentle', 'playful', 'direct', 'reserved'] as const)('keeps %s expression constrained by the stable persona', expression => {
    const context = buildCompanionContext({ ...input, runtimeState: { ...runtimeState, expression } });
    expect(JSON.parse(context.user).runtimeBehavior.expression).toBe(expression);
    expect(context.system).toContain(input.companion.persona);
    expect(context.system).toContain('都必须符合完整稳定人格和用户要求');
  });
  it('refreshes the latest state during a frozen loop rather than reusing its old revision', async () => {
    const context = buildCompanionContext({ ...input, runtimeState: { ...runtimeState, energy: 80, mood: 'focused', revision: 1 } });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat'));
    await generateCompanionReply(input, config, undefined, { fetchFn, context, loop: true });
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(data.runtimeState.revision).toBe(2);
    expect(data.runtimeBehavior.responseLength).toBe('brief');
  });
  it('shows only high-level state in a group and never another companion owner', () => {
    const context = buildCompanionContext({ ...input, conversation: { ...input.conversation, id: 'group', kind: 'group' },
      runtimeState: { ...runtimeState, mood: 'focused', focus: 'PRIVATE_PROJECT_884', reason: 'PRIVATE_REASON_885' } });
    const data = JSON.parse(context.user);
    expect(data.runtimeState.energy).toBe(20);
    expect(data.runtimeState.relationship.trust).toBe(60);
    expect(data.runtimeState).not.toHaveProperty('sourceMessageIds');
    expect(data.runtimeState).not.toHaveProperty('evidence');
    expect(data.runtimeBehavior).not.toHaveProperty('currentFocus');
    expect(context.user).not.toContain('PRIVATE_PROJECT_884');
    expect(context.user).not.toContain('PRIVATE_REASON_885');
    expect(JSON.parse(buildCompanionContext({ ...input, runtimeState: { ...runtimeState, companionId: 'other' } }).user)).not.toHaveProperty('runtimeState');
  });
  it.each([
    { ...proposal, mood: 'bright' }, { ...proposal, energy: 100 }, { ...proposal, affect: { pleasure: 1 } },
    { ...proposal, relationship: { affinity: 100 } }, { ...proposal, familiarity: { stage: 'close' } },
    { ...proposal, persona: 'new identity' }, { ...proposal, companionId: 'other' }, { ...proposal, sourceMessageIds: ['user_message', 'missing'] },
    { ...proposal, appraisals: [{ type: 'hostility', target: 'user', intensity: 2, confidence: 1 }] },
  ])('rejects model-written mood, numeric relationships, identities or unsupported evidence %#', value => {
    expect(companionStateArgumentsSchema.safeParse({ action: 'update', expectedRevision: 2, proposal: value }).success).toBe(false);
  });
  it('accepts a supported appraisal beside an empty VCP journal batch', async () => {
    expect(companionStateArgumentsSchema.parse({ action: 'update', expectedRevision: 2, proposal }).action).toBe('update');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(structured({ notes: [], stateProposal: proposal }));
    const result = await generateCompanionJournal(input, config, undefined, { fetchFn });
    expect(result.stateProposal).toMatchObject(proposal);
    const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(result.notes).toEqual([]);
    expect(request.messages[0].content).toContain('对真实失败的批评不当敌意');
    expect(request.messages[0].content).toContain('普通委托、礼貌与消息数量不自动增加关系');
    expect(JSON.parse(request.messages[1].content).runtimeState.affect).toEqual(runtimeState.affect);
  });
  it('requires a real user author for user relationship appraisal and verifies quote text', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(structured({ notes: [], stateProposal: proposal }));
    await expect(generateCompanionJournal({ ...input, messages: [{ ...input.messages[0]!, authorId: 'sister' }] }, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    fetchFn.mockResolvedValue(structured({ notes: [], stateProposal: { ...proposal, evidence: [{ sourceMessageId: 'user_message', quote: '捏造原文' }] } }));
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
