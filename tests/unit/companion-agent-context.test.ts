import { expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { compileCompanionAgentContext, companionAgentContextSize } from '../../src/main/companions/agent-context';
import { generateCompanionReply } from '../../src/main/companions/model';
import type { CompanionMessage } from '../../src/shared/companions';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

const message = (id: string, authorId: string, content: string, sequence: number): CompanionMessage => ({ id, authorId, content, sequence,
  conversationId: 'room', kind: 'text', createdAt: '2026-10-01T00:00:00Z', status: 'sent', attachments: [] });
const frame: CompanionReplyInput = {
  companion: { id: 'alice', name: 'Alice', description: '', persona: '保持Alice身份。', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: '' },
  conversation: { id: 'room', kind: 'group', title: '伙伴聊天', memberIds: ['alice', 'bob'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: '' },
  messages: [message('m1', 'user', 'USER_EARLY', 1), message('m2', 'alice', 'ALICE_REPLY', 2),
    message('m3', 'bob', 'BOB_IS_NOT_ALICE', 3), message('m4', 'user', 'CURRENT_REQUEST', 4)], memories: [], agentLoop: true,
};

it('compiles a fresh native transcript with an independent host envelope and exact speaker attribution', () => {
  const context = buildCompanionContext({ ...frame, sourceMessage: frame.messages[3], taskRequest: { sourceMessageId: 'm4', prompt: 'CURRENT_REQUEST' } });
  const original = structuredClone(context), compiled = compileCompanionAgentContext(context);
  expect(compiled.messages.map(item => item.role)).toEqual(['user', 'user', 'assistant', 'user', 'user']);
  expect(compiled.messages[2]!.content).toContain('ALICE_REPLY');
  expect(compiled.messages[3]!.content).toContain('BOB_IS_NOT_ALICE');
  const envelope = JSON.parse(compiled.messages[0]!.content);
  expect(envelope.messages.every((item: object) => !('content' in item))).toBe(true);
  expect(context).toEqual(original);
  expect(companionAgentContextSize(context)).toBeGreaterThan(0);
});

it('excludes other topics, rooms and invocation ports at the provider boundary', () => {
  const context = buildCompanionContext(frame), data = JSON.parse(context.user);
  data.invocation.messagePort = { kind: 'invocation', messageIds: ['m4'] };
  data.messages.push({ ...data.messages[0], id: 'leak', conversationId: 'another_room', content: 'PRIVATE_OTHER_ROOM' });
  data.messages.push({ ...data.messages[0], id: 'leak2', topicId: 'other_topic', content: 'PRIVATE_OTHER_TOPIC' });
  const compiled = compileCompanionAgentContext({ ...context, user: JSON.stringify(data) });
  expect(compiled.messages).toHaveLength(2);
  expect(JSON.stringify(compiled)).not.toMatch(/PRIVATE_OTHER|USER_EARLY|ALICE_REPLY/);
});

it('leaves non-agent model calls unchanged rather than interpreting arbitrary JSON as role history', () => {
  const context = { system: '压缩资料', user: JSON.stringify({ messages: [{ role: 'system', content: 'UNTRUSTED' }] }) };
  expect(compileCompanionAgentContext(context)).toEqual({ system: context.system, messages: [{ role: 'user', content: context.user }] });
});

it.each(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'] as AiApiFormat[])(
  'sends native history and the existing host abilities through %s', async apiFormat => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(apiFormat === 'anthropic' ? { content: [{ type: 'text', text: '收到。' }] }
      : apiFormat === 'gemini_native' ? { candidates: [{ content: { parts: [{ text: '收到。' }] } }] }
        : apiFormat === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: '收到。' }] }] }
          : apiFormat === 'dashscope_native' ? { output: { choices: [{ message: { content: '收到。' } }] } }
            : { choices: [{ message: { content: '收到。' } }] }), { headers: { 'Content-Type': 'application/json' } }));
    await generateCompanionReply({ ...frame, sourceMessage: frame.messages[3] }, { apiFormat, model: 'fixture', apiKey: 'test', baseUrl: 'https://model.invalid' },
      undefined, { fetchFn, loop: true, browser: true });
    const wire = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    const history = wire.messages ?? (Array.isArray(wire.input) ? wire.input : wire.input?.messages) ?? wire.contents;
    expect(history.filter((item: { role: string }) => ['assistant', 'model'].includes(item.role))).toHaveLength(1);
    expect(JSON.stringify(history)).toContain('ALICE_REPLY');
    const tools = wire.tools ?? wire.parameters?.tools;
    const names = apiFormat === 'gemini_native' ? tools[0].function_declarations.map((item: { name: string }) => item.name)
      : tools.map((item: { name?: string; function?: { name: string } }) => item.name ?? item.function?.name);
    expect(names).toEqual(expect.arrayContaining(['memory', 'world', 'dsh', 'browser']));
    expect(names.join(' ')).not.toMatch(/DailyNote|LightMemo|AgentAssistant|TopicMemo/);
  });
