import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { companionScheduleArgumentsSchema } from '../../src/shared/companion-schedule-tool';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

const input: CompanionReplyInput = {
  companion: { id: 'sister', name: '大肥鱼', description: '姐姐', persona: '温柔沉稳，喜欢海洋。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' },
  conversation: { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' },
  messages: [{ id: 'user_message', sequence: 1, conversationId: 'private_sister', authorId: 'user', kind: 'text', content: '明天上午九点提醒我喝水，之后每周一三五都提醒。', status: 'sent', attachments: [], createdAt: '2026-10-14T00:00:00Z' }], memories: [],
};
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' };
const entry = { title: '喝水', prompt: '提醒用户喝水。', kind: 'reminder', runAt: '2026-10-15T09:00:00+08:00', timeZone: 'Asia/Shanghai', recurrence: 'weekly', weekDays: [1, 3, 5] };
function response(format: AiApiFormat, args: unknown, textOnly = false): Response {
  const name = 'schedule', text = '已按你的时间设置。';
  const message = textOnly ? { content: text } : { content: null, tool_calls: [{ id: 'schedule_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  const body = format === 'openai_chat' ? { choices: [{ message }] }
    : format === 'dashscope_native' ? { output: { choices: [{ message }] } }
      : format === 'openai_responses' ? { output: [textOnly ? { type: 'message', content: [{ type: 'output_text', text }] } : { type: 'function_call', call_id: 'schedule_1', name, arguments: JSON.stringify(args) }] }
        : format === 'anthropic' ? { content: [textOnly ? { type: 'text', text } : { type: 'tool_use', id: 'schedule_1', name, input: args }] }
          : { candidates: [{ content: { parts: [textOnly ? { text } : { functionCall: { id: 'schedule_1', name, args } }] } }] };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}
afterEach(() => vi.useRealTimers());

describe('native companion calendar capability', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'registers schedule, parses its native call and returns the execution result in %s', async format => {
      const args = { action: 'create', entries: [entry] };
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(format, args)).mockResolvedValueOnce(response(format, {}, true));
      const reply = await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true });
      expect(reply.turn?.calls).toEqual([{ id: 'schedule_1', name: 'schedule', arguments: JSON.stringify(args) }]);
      const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      const registry = format === 'dashscope_native' ? request.parameters.tools : request.tools;
      const tools = format === 'gemini_native' ? registry[0].function_declarations : registry.map((tool: { function?: unknown }) => tool.function ?? tool);
      expect(tools.some((tool: { name: string }) => tool.name === 'schedule')).toBe(true);
      const result = JSON.stringify({ ok: true, schedules: [{ id: 'saved_schedule', revision: 1, nextRunAt: '2026-10-15T01:00:00Z' }] });
      await generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true,
        turns: [{ ...reply.turn!, results: [{ callId: 'schedule_1', content: result }] }] });
      const second = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body));
      if (format === 'openai_chat' || format === 'dashscope_native') expect((format === 'openai_chat' ? second.messages : second.input.messages).at(-1)).toEqual({ role: 'tool', tool_call_id: 'schedule_1', content: result });
      else if (format === 'openai_responses') expect(second.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'schedule_1', output: result });
      else if (format === 'anthropic') expect(second.messages.at(-1).content[0]).toEqual({ type: 'tool_result', tool_use_id: 'schedule_1', content: result });
      else expect(second.contents.at(-1).parts[0].functionResponse).toEqual({ id: 'schedule_1', name: 'schedule', response: { result } });
    });
  it('accepts a requested series, preserves constraints and defaults fixed-time schedules', () => {
    const parsed = companionScheduleArgumentsSchema.parse({ action: 'create', entries: [entry, { ...entry, title: '只读检查', prompt: '只读检查项目文件；不要修改或删除。', kind: 'task', recurrence: 'once', weekDays: undefined }] });
    expect(parsed.action).toBe('create');
    if (parsed.action !== 'create') throw new Error('Unexpected schedule action.');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.flexible).toBe(false);
    expect(parsed.entries[1]?.prompt).toContain('不要修改或删除');
  });
  it.each([
    { action: 'create', companionId: 'other', entries: [entry] },
    { action: 'create', conversationId: 'other_room', entries: [entry] },
    { action: 'create', sourceMessageId: 'fake_request', entries: [entry] },
    { action: 'create', entries: [{ ...entry, companionId: 'other' }] },
    { action: 'create', entries: [] },
    { action: 'create', entries: [{ ...entry, runAt: '2026-10-15T09:00:00' }] },
    { action: 'create', entries: [{ ...entry, timeZone: 'Not/A_Zone' }] },
    { action: 'create', entries: [{ ...entry, recurrence: 'interval', intervalMinutes: 0, weekDays: undefined }] },
    { action: 'update', id: 'saved_schedule', expectedRevision: 1, patch: {} },
    { action: 'cancel', id: 'saved_schedule' },
  ])('rejects invented ownership, ambiguous time or unversioned changes %#', value => {
    expect(companionScheduleArgumentsSchema.safeParse(value).success).toBe(false);
  });
  it('refreshes the actual clock after a frozen loop resumes while keeping the current task intact', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T00:00:00Z'));
    const context = buildCompanionContext({ ...input, agentLoop: true, taskRequest: { sourceMessageId: 'user_message', prompt: input.messages[0]!.content } });
    vi.setSystemTime(new Date('2026-10-14T12:34:00Z'));
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('openai_chat', {}, true));
    await generateCompanionReply(input, config, undefined, { fetchFn, loop: true, context });
    const data = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(data.hostClock.now).toBe('2026-10-14T12:34:00.000Z');
    expect(data.hostClock.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(data.taskRequest.prompt).toBe(input.messages[0]!.content);
    expect(context.system).toContain('不能把提醒误当外部操作授权');
    expect(context.system).toContain('固定reminder/task仍按约定执行');
  });
});
