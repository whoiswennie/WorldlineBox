import { describe, expect, it, vi } from 'vitest';
import { buildCompanionContext, companionRuntimeBehavior, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { generateCompanionJournal } from '../../src/main/companions/memory-model';
import { companionStateArgumentsSchema } from '../../src/shared/companion-state-tool';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionCharacterDevelopment } from '../../src/shared/companion-character-development';
import { companionStateToolTurns } from '../../src/main/companions/state-context';

const runtimeState: CompanionRuntimeState = { schema: 'companion-runtime-qualitative-v1', companionId: 'sister', energy: 20, expression: 'gentle', relationshipRecords: [],
  focus: 'WorldlineBox 聊天开发', reason: '真实工作后需要休息', sourceConversationId: 'private_sister', sourceMessageIds: ['user_message'],
  evidence: [{ sourceMessageId: 'user_message', quote: '谢谢你一直陪我做 WorldlineBox' }],
  updatedAt: '2026-10-14T00:00:00Z', revision: 2 };
const input: CompanionReplyInput = {
  companion: { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳，喜欢海洋。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' },
  conversation: { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' },
  messages: [{ id: 'user_message', sequence: 1, conversationId: 'private_sister', authorId: 'user', kind: 'text', content: '谢谢你一直陪我做 WorldlineBox。', status: 'sent', attachments: [], createdAt: '2026-10-14T00:00:00Z' }], memories: [], runtimeState,
};
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' };
const proposal = { reason: '用户实际表达陪伴支持', experience: { situation: '正在一起处理项目。', statement: '我愿意先核实当前进展。', reassessWhen: ['当前检查结束后。'] }, relationshipUpdates: [],
  sourceMessageIds: ['user_message'], evidence: [{ sourceMessageId: 'user_message', quote: '谢谢你一直陪我做 WorldlineBox' }] };
function response(format: AiApiFormat): Response {
  const name = 'world', args = { action: 'state', parameters: { action: 'inspect' } };
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
      expect(reply.turn?.calls[0]).toEqual({ id: 'state_1', name: 'world', arguments: '{"action":"state","parameters":{"action":"inspect"}}' });
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
      const receipt = format === 'openai_chat' || format === 'dashscope_native' ? (format === 'openai_chat' ? next.messages : next.input.messages).at(-1).content
        : format === 'openai_responses' ? next.input.at(-1).output : format === 'anthropic' ? next.messages.at(-1).content[0].content
          : next.contents.at(-1).parts[0].functionResponse.response.result;
      expect(JSON.parse(receipt)).toMatchObject({ ok: true, stateObservation: { status: 'historical', revision: 2, asOf: runtimeState.updatedAt } });
      expect(receipt).not.toContain('WorldlineBox 聊天开发');
      expect(JSON.parse(receipt)).not.toHaveProperty('runtimeState');
    });
  it('bases delivery on actual resources and specific authored expectations without numeric psychology', () => {
    const behavior = companionRuntimeBehavior(runtimeState);
    expect(behavior).toMatchObject({ responseLength: 'brief', topicExpansion: 'limited',
      boundaryStyle: 'consider_specific_current_agreements_and_boundaries', normalRequestsRemainAvailable: true, currentExperienceIsSelfReport: true });
    expect(companionRuntimeBehavior({ ...runtimeState, energy: 80 }).initiative).toBe('consider_current_goals_availability_and_actual_relationship_events');
    expect(companionRuntimeBehavior({ ...runtimeState, energy: 80 }).currentFocus).toBe(runtimeState.focus);
  });
  it.each(['gentle', 'playful', 'direct', 'reserved'] as const)('keeps %s expression constrained by the stable persona', expression => {
    const context = buildCompanionContext({ ...input, runtimeState: { ...runtimeState, expression } });
    expect(JSON.parse(context.user).runtimeBehavior.expression).toBe(expression);
    expect(context.system).toContain(input.companion.persona);
    expect(context.system).toContain('本人认识经独立反思、反例检查与发布后才影响后续人格上下文');
  });
  it('refreshes the latest state during a frozen loop rather than reusing its old revision', async () => {
    const context = buildCompanionContext({ ...input, runtimeState: { ...runtimeState, energy: 80, revision: 1 } });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat'));
    await generateCompanionReply(input, config, undefined, { fetchFn, context, loop: true });
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(data.runtimeState.revision).toBe(2);
    expect(data.runtimeBehavior.responseLength).toBe('brief');
  });
  it('drops checkpoint state and character data when current host reads are absent', async () => {
    const characterDevelopment: CompanionCharacterDevelopment = { companionId: 'sister', conversationId: 'private_sister', observedAt: '2026-10-22T00:00:00Z', truncated: false,
      items: [{ memoryId: 'old_note', memoryVersion: 1, kind: 'preference', topic: 'drink', statement: 'OLD_ONLY_SECRET_TEA', basis: 'self_expression', updatedAt: '2026-10-22T00:00:00Z', sourceMessageIds: ['self_expression'] }] };
    const context = buildCompanionContext({ ...input, characterDevelopment });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat'));
    await generateCompanionReply({ ...input, runtimeState: undefined }, config, undefined, { fetchFn, context, loop: true });
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(data).not.toHaveProperty('runtimeState'); expect(data).not.toHaveProperty('runtimeBehavior');
    expect(data).not.toHaveProperty('characterDevelopment'); expect(JSON.stringify(data)).not.toContain('OLD_ONLY_SECRET_TEA');
  });
  it('uses the current source-backed character version, scoped to this owner and room', async () => {
    const characterDevelopment: CompanionCharacterDevelopment = { companionId: 'sister', conversationId: 'private_sister', observedAt: '2026-10-22T00:00:00Z', truncated: false,
      items: [{ memoryId: 'new_note', memoryVersion: 2, kind: 'preference', topic: 'drink', statement: '现在更喜欢不甜的茶', basis: 'self_expression', updatedAt: '2026-10-22T00:00:00Z', sourceMessageIds: ['new_self_expression'] }] };
    const context = buildCompanionContext({ ...input, characterDevelopment: { ...characterDevelopment, items: [{ ...characterDevelopment.items[0]!, statement: 'OLD_PREFERENCE' }] } });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat'));
    await generateCompanionReply({ ...input, characterDevelopment }, config, undefined, { fetchFn, context, loop: true });
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(data.characterDevelopment.items).toEqual(characterDevelopment.items); expect(JSON.stringify(data)).not.toContain('OLD_PREFERENCE');
    expect(JSON.parse(buildCompanionContext({ ...input, characterDevelopment: { ...characterDevelopment, companionId: 'other' } }).user)).not.toHaveProperty('characterDevelopment');
    expect(JSON.parse(buildCompanionContext({ ...input, characterDevelopment: { ...characterDevelopment, conversationId: 'other_room' } }).user)).not.toHaveProperty('characterDevelopment');
  });
  it('keeps change receipts out of inference and never forwards old private state tool fields', () => {
    const data = JSON.parse(buildCompanionContext({ ...input, runtimeState: { ...runtimeState, recentChanges: [{ reason: 'PRIVATE_CHANGE_REASON' }] as CompanionRuntimeState['recentChanges'] } }).user);
    expect(data.runtimeState).not.toHaveProperty('recentChanges');
    const turns = [{ text: '', rawText: '', calls: [{ id: 'old_state', name: 'world', arguments: '{"action":"state","parameters":{"action":"inspect"}}' }], results: [{ callId: 'old_state', content: JSON.stringify({ ok: true, runtimeState: { ...runtimeState, focus: 'REVOKED_FOCUS' } }) }] }];
    const projected = companionStateToolTurns(turns);
    expect(JSON.stringify(projected)).not.toContain('REVOKED_FOCUS'); expect(turns[0]!.results[0]!.content).toContain('REVOKED_FOCUS');
    expect(companionStateToolTurns([{ ...turns[0]!, results: [{ callId: 'old_state', content: '{broken' }] }])[0]!.results![0]!.content).toContain('请重新读取当前状态');
  });
  it('shows only high-level state in a group and never another companion owner', () => {
    const context = buildCompanionContext({ ...input, conversation: { ...input.conversation, id: 'group', kind: 'group' },
      runtimeState: { ...runtimeState, focus: 'PRIVATE_PROJECT_884', reason: 'PRIVATE_REASON_885' } });
    const data = JSON.parse(context.user);
    expect(data.runtimeState.energy).toBe(20);
    expect(data.runtimeState.relationshipRecords).toEqual([]); expect(data.runtimeState).not.toHaveProperty('relationship');
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
  it('accepts a supported qualitative experience beside an empty VCP journal batch', async () => {
    expect(companionStateArgumentsSchema.parse({ action: 'update', expectedRevision: 2, proposal }).action).toBe('update');
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(structured({ notes: [], stateProposal: proposal }));
    const result = await generateCompanionJournal(input, config, undefined, { fetchFn });
    expect(result.stateProposal).toMatchObject(proposal);
    const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(result.notes).toEqual([]);
    expect(request.messages[0].content).toContain('stateProposal');
    expect(JSON.parse(request.messages[1].content).runtimeState).not.toHaveProperty('affect');
  });
  it('verifies quote text for qualitative state instead of accepting fabricated evidence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(structured({ notes: [], stateProposal: proposal }));
    fetchFn.mockResolvedValue(structured({ notes: [], stateProposal: { ...proposal, evidence: [{ sourceMessageId: 'user_message', quote: '捏造原文' }] } }));
    await expect(generateCompanionJournal(input, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
