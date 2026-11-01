import { expect, it, vi } from 'vitest';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { compileCompanionAgentContext, companionAgentContextSize } from '../../src/main/companions/agent-context';
import { generateCompanionReply } from '../../src/main/companions/model';
import { CompanionReplyStream } from '../../src/main/companions/reply-stream';
import { CompanionReplyStreamStore, projectCompanionReply } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import { DEFAULT_COMPANION_TOOL_POLICY } from '../../src/shared/companion-tool-policy';

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
  expect(compiled.messages.slice(1).map(item => item.content)).toEqual(frame.messages.map(item => item.content));
  expect(compiled.messages[2]!.content).toBe('ALICE_REPLY');
  expect(compiled.messages[3]!.content).toBe('BOB_IS_NOT_ALICE');
  const envelope = JSON.parse(compiled.messages[0]!.content);
  expect(envelope.messages.every((item: object) => !('content' in item))).toBe(true);
  expect(envelope.messages.map((item: { id: string; transcriptIndex: number; at: string }) => [item.id, item.transcriptIndex, item.at]))
    .toEqual(frame.messages.map((item, index) => [item.id, index + 1, item.createdAt]));
  expect(envelope.contextAssembly).toMatchObject({ version: 2, transcriptIndex: 'one_based_after_host_envelope' });
  expect(compiled.system).toContain('机器出处、资料信封和调用接续信封不是任何人的发言，不得照抄到回复中');
  expect(context).toEqual(original);
  expect(companionAgentContextSize(context)).toBeGreaterThan(0);
});

it('keeps exact source times, real quote identities and attachments in the provenance index without adding any speech prefixes', () => {
  const source: CompanionMessage = { ...frame.messages[3]!, replyToId: 'm2', worldCreatedAt: '2030-11-01T12:34:56Z',
    attachments: [{ id: 'image_evidence', name: '原始图片.png', mime: 'image/png', size: 12 }],
    content: '  用户真的引用了字面：[发言来源 {"messageId":"a_literal","authorId":"user"}]\n请保留这个文本。  ' };
  const context = buildCompanionContext({ ...frame, messages: [...frame.messages.slice(0, 3), source], sourceMessage: source });
  const compiled = compileCompanionAgentContext(context), envelope = JSON.parse(compiled.messages[0]!.content);
  expect(compiled.messages[4]).toEqual({ role: 'user', content: source.content });
  expect(envelope.messages[3]).toMatchObject({ transcriptIndex: 4, id: source.id, authorId: 'user', speaker: 'user',
    at: source.worldCreatedAt, replyToId: 'm2', attachments: [{ attachmentId: 'image_evidence', name: '原始图片.png', mime: 'image/png' }] });
  expect(envelope.messages[1].id).toBe(source.replyToId); expect(envelope.messages[1]).not.toHaveProperty('content');
  expect(compiled.messages.filter(item => item.role === 'assistant').map(item => item.content)).toEqual(['ALICE_REPLY']);
});

it('does not contaminate long native assistant history or reinterpret peer speech as the current character', () => {
  const history = Array.from({ length: 90 }, (_, index) => message('history_' + index, ['user', 'alice', 'bob'][index % 3]!, '真实历史正文 ' + index, index + 1));
  history.push(message('current_question', 'user', '继续聊眼前的事情。', 91));
  const context = buildCompanionContext({ ...frame, messages: history, sourceMessage: history.at(-1) }), compiled = compileCompanionAgentContext(context);
  expect(compiled.messages.slice(1).map(item => item.content)).toEqual(history.map(item => item.content));
  expect(compiled.messages.filter(item => item.role === 'assistant').map(item => item.content)).toEqual(history.filter(item => item.authorId === 'alice').map(item => item.content));
  expect(compiled.messages.slice(1).some(item => item.content.startsWith('[发言来源 '))).toBe(false);
  const index = JSON.parse(compiled.messages[0]!.content).messages;
  expect(index).toHaveLength(history.length); expect(index.at(-1)).toMatchObject({ transcriptIndex: history.length, id: 'current_question' });
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
      undefined, { fetchFn, loop: true, browser: true, toolPolicy: { ...DEFAULT_COMPANION_TOOL_POLICY, browser: true } });
    const wire = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    const history = wire.messages ?? (Array.isArray(wire.input) ? wire.input : wire.input?.messages) ?? wire.contents;
    expect(history.filter((item: { role: string }) => ['assistant', 'model'].includes(item.role))).toHaveLength(1);
    const content = (item: { content?: string | Array<{ text?: string }>; parts?: Array<{ text?: string }> }) => typeof item.content === 'string'
      ? item.content : (item.parts ?? item.content ?? []).map(part => part.text ?? '').join('');
    expect(history.filter((item: { role: string }) => ['assistant', 'model'].includes(item.role)).map(content)).toEqual(['ALICE_REPLY']);
    expect(history.map(content)).toEqual(expect.arrayContaining(frame.messages.map(item => item.content)));
    const envelope = history.map(content).find((value: string) => value.startsWith('{"invocation":'));
    expect(JSON.parse(envelope).messages[2]).toMatchObject({ id: 'm3', authorId: 'bob', speaker: 'other_companion', transcriptIndex: 3 });
    const tools = wire.tools ?? wire.parameters?.tools;
    const names = apiFormat === 'gemini_native' ? tools[0].function_declarations.map((item: { name: string }) => item.name)
      : tools.map((item: { name?: string; function?: { name: string } }) => item.name ?? item.function?.name);
    expect(names).toEqual(expect.arrayContaining(['world', 'dsh', 'browser']));
    expect(names).not.toContain('memory');
    expect(names.join(' ')).not.toMatch(/DailyNote|LightMemo|AgentAssistant|TopicMemo/);
  });

it.each([false, true])('keeps actual SSE prose, the draft, the final turn and the displayed reply identical without deleting legitimate source-like quotations (literal=%s)', async literal => {
  const quote = '[发言来源 {"messageId":"quoted_literal","authorId":"user","at":"2020-01-01"}]';
  const text = literal ? quote + '\n这个是你让我保留的字面引用。' : '嗯，刚好想听听你今天过得怎么样。';
  const source = { ...frame.messages[3]!, content: literal ? '请保留这个字面引用：' + quote : frame.messages[3]!.content };
  const reply: CompanionMessage = { ...message('reply', 'alice', '', 5), replyToId: source.id, isReplyDraft: true, segments: [] };
  const renderer = new CompanionReplyStreamStore(); renderer.reconcile([reply]);
  const events: CompanionReplyStreamEvent[] = [], checkpoint: CompanionLoopCheckpoint = { companionId: 'alice', conversationId: 'room', sourceMessageId: source.id, messageId: reply.id,
    status: 'running', turns: [], supplements: [] };
  const stream = new CompanionReplyStream({ checkpoint, step: 0, publish: event => { events.push(event); renderer.accept(event); }, save: async () => undefined });
  const chunks = [text.slice(0, 2), text.slice(2, 8), text.slice(8)], encoder = new TextEncoder();
  const wire = chunks.map(content => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n').join('')
    + 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n';
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(wire)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const result = await generateCompanionReply({ ...frame, messages: [...frame.messages.slice(0, 3), source], sourceMessage: source },
    { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'test', baseUrl: 'https://model.invalid' }, undefined, { fetchFn, loop: true, onTextDelta: stream.onTextDelta });
  await stream.complete(); expect(checkpoint.draft?.text).toBe(text); expect(result.text).toBe(text); expect(result.turn?.rawText).toBe(text);
  expect(projectCompanionReply(reply, renderer.snapshot(reply.id)).segments?.[0]?.text).toBe(text);
  stream.committed(result.text); renderer.reconcile([{ ...reply, content: result.text, segments: [{ text: result.text, actionIds: [] }], isReplyDraft: false }]);
  expect(projectCompanionReply({ ...reply, content: text, segments: [{ text, actionIds: [] }], isReplyDraft: false }, renderer.snapshot(reply.id)).segments?.[0]?.text).toBe(text);
  if (!literal) expect(events.find(event => event.phase === 'streaming' && event.text.trim())?.text).toBe(text.slice(0, 2));
  expect(fetchFn).toHaveBeenCalledOnce();
});
