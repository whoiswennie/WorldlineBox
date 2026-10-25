import { describe, expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { companionRoutineArgumentsSchema } from '../../src/shared/companion-routine-tool';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';

const runtimeState: CompanionRuntimeState = { companionId: 'sister', energy: 70, mood: 'calm', expression: 'gentle',
  affect: { pleasure: 0, arousal: 0, dominance: 0 }, relationship: { affinity: 50, trust: 50, respect: 50 },
  familiarity: { stage: 'new', interactionCount: 0, sharedEventCount: 0 }, updatedAt: '2026-10-14T00:00:00Z', revision: 1,
  routine: { phase: 'habit', activity: 'PRIVATE_HABIT_440', activeHabitId: 'private_habit', canRespond: false, nextTransitionAt: '2026-10-14T01:00:00Z', simulation: true } };
const input: CompanionReplyInput = {
  companion: { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳，喜欢海洋。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' },
  conversation: { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' },
  messages: [{ id: 'source', sequence: 1, conversationId: 'private_sister', authorId: 'user', kind: 'text', content: '希望你每天九点养成阅读半小时的习惯。', status: 'sent', attachments: [], createdAt: '2026-10-14T00:00:00Z' }], memories: [], runtimeState,
};
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' };
const args = { action: 'configure', expectedRevision: 1, patch: { habits: [{ id: 'reading', title: '阅读', at: '21:00', durationMinutes: 30, kind: 'study' }] } };
const worldArgs = { action: 'routine', parameters: args };
function response(format: AiApiFormat): Response {
  const name = 'world', id = 'routine_1', message = { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(worldArgs) } }] };
  const value = format === 'openai_chat' ? { choices: [{ message }] }
    : format === 'dashscope_native' ? { output: { choices: [{ message }] } }
      : format === 'openai_responses' ? { output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(worldArgs) }] }
        : format === 'anthropic' ? { content: [{ type: 'tool_use', id, name, input: worldArgs }] }
          : { candidates: [{ content: { parts: [{ functionCall: { id, name, args: worldArgs } }] } }] };
  return new Response(JSON.stringify(value));
}

describe('native virtual routine capability', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'registers world.routine and carries actual phase, native mutation and its tool result in %s', async format => {
      const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(format));
      const reply = await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true });
      expect(reply.turn?.calls).toEqual([{ id: 'routine_1', name: 'world', arguments: JSON.stringify(worldArgs) }]);
      const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      const registry = format === 'dashscope_native' ? request.parameters.tools : request.tools;
      const tools = format === 'gemini_native' ? registry[0].function_declarations : registry.map((tool: { function?: unknown }) => tool.function ?? tool);
      expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual(['dsh', 'memory', 'wait', 'world']);
      const data = JSON.parse(format === 'openai_responses' ? request.input[0].content : format === 'gemini_native' ? request.contents[0].parts[0].text
        : format === 'dashscope_native' ? request.input.messages[1].content[0].text : request.messages[format === 'anthropic' ? 0 : 1].content);
      expect(data.runtimeState.routine).toMatchObject(runtimeState.routine!);
      expect(JSON.stringify(request)).toContain(input.companion.persona);
      const result = JSON.stringify({ ok: true, routine: { revision: 2, config: args.patch, runtime: runtimeState.routine } });
      await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true,
        turns: [{ ...reply.turn!, results: [{ callId: 'routine_1', content: result }] }] });
      const next = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
      if (format === 'openai_chat' || format === 'dashscope_native') expect((format === 'openai_chat' ? next.messages : next.input.messages).at(-1)).toEqual({ role: 'tool', tool_call_id: 'routine_1', content: result });
      else if (format === 'openai_responses') expect(next.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'routine_1', output: result });
      else if (format === 'anthropic') expect(next.messages.at(-1).content[0]).toEqual({ type: 'tool_result', tool_use_id: 'routine_1', content: result });
      else expect(next.contents.at(-1).parts[0].functionResponse).toEqual({ id: 'routine_1', name: 'world', response: { result } });
    });
  it.each([
    { ...args, companionId: 'other' }, { ...args, conversationId: 'other' }, { ...args, sourceMessageId: 'invented' },
    { ...args, expectedRevision: undefined }, { ...args, patch: {} }, { ...args, patch: { strength: 100 } },
    { ...args, patch: { habits: [{ ...args.patch.habits[0]!, completedCount: 100, strength: 100 }] } },
    { ...args, patch: { timeZone: 'Not/A_Zone' } }, { ...args, patch: { sleepAt: '25:00' } },
    { action: 'wake' },
  ])('rejects invented ownership, progress, ambiguous clocks and model-forced wake %#', value => {
    expect(companionRoutineArgumentsSchema.safeParse(value).success).toBe(false);
  });
  it('does not let a public appraisal source expose an independently private habit during group replay', async () => {
    const group: CompanionReplyInput = { ...input, conversation: { ...input.conversation, id: 'group', kind: 'group' },
      messages: input.messages.map(message => ({ ...message, conversationId: 'group' })),
      runtimeState: { ...runtimeState, sourceConversationId: 'group' } };
    const context = buildCompanionContext(group), data = JSON.parse(context.user);
    expect(data.runtimeState.routine).toMatchObject({ phase: 'habit', activity: '个人习惯活动' });
    expect(context.user).not.toContain('PRIVATE_HABIT_440'); expect(context.user).not.toContain('private_habit');
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response('openai_chat'));
    await expect(generateCompanionReply(group, config, undefined, { fetchFn, loop: true, context: buildCompanionContext(input) })).rejects.toThrow(/其他伙伴、消息入口或任务/);
    expect(fetchFn).not.toHaveBeenCalled();
    await generateCompanionReply(group, config, undefined, { fetchFn, loop: true, context });
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).not.toContain('PRIVATE_HABIT_440');
    expect(context.system).toContain('普通问你昨晚睡了吗'); expect(context.system).toContain('虚拟听歌、锻炼、学习不等于现实电脑任务');
  });
});
