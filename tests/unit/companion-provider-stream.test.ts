import { describe, expect, it, vi } from 'vitest';
import { generateCompanionReply, generateCompanionStructured, parseCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { visibleCompanionStreamText } from '../../src/main/companions/provider-stream';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

const input: CompanionReplyInput = {
  companion: { id: 'sister', name: '大肥鱼', description: '', persona: '沉稳温柔', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: '2026-10-14T00:00:00Z' },
  conversation: { id: 'private_sister', kind: 'private', title: '大肥鱼', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: '2026-10-14T00:00:00Z', lastMessage: '' },
  messages: [{ id: 'source', sequence: 1, conversationId: 'private_sister', authorId: 'user', kind: 'text', content: '看看之前的约定', status: 'sent', attachments: [], createdAt: '2026-10-14T00:00:00Z' }], memories: [],
};
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'selected-model', baseUrl: 'https://provider.invalid', apiKey: 'private-test-key' };
const argumentsText = '{"query":"约定"}', callId = 'native_1';
const event = (value: unknown, name?: string) => `${name ? `event: ${name}\r\n` : ''}data: ${JSON.stringify(value)}\r\n\r\n`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
  return { response, cancel, send: (text: string) => controller.enqueue(encoder.encode(text)), end: () => controller.close(), fail: (error: unknown) => controller.error(error) };
}
function fixtures(format: AiApiFormat): { initial: string; first: string; second: string; tools: string; finish: string } {
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const chunk = (delta: unknown, finish_reason: string | null = null) => event(format === 'openai_chat'
      ? { choices: [{ index: 0, delta, finish_reason }] } : { output: { choices: [{ index: 0, message: delta, finish_reason }] } });
    const content = (text: string) => format === 'openai_chat' ? text : [{ text }];
    return { initial: ': heartbeat\r\n\r\n' + chunk({ reasoning_content: 'PRIVATE_THINKING' }), first: chunk({ content: content('你好') }),
      second: chunk({ content: content('，伙伴') }), tools: chunk({ tool_calls: [{ index: 0, id: callId, function: { name: 'memory_search', arguments: '{"query":' } }] })
        + chunk({ tool_calls: [{ index: 0, function: { arguments: '"约定"}' } }] }), finish: chunk({}, 'tool_calls') + 'data: [DONE]\r\n\r\n' };
  }
  if (format === 'openai_responses') return {
    initial: event({ type: 'response.created', response: { status: 'in_progress' } }) + event({ type: 'response.reasoning_text.delta', delta: 'PRIVATE_THINKING' }),
    first: event({ type: 'response.output_text.delta', output_index: 0, delta: '你好' }), second: event({ type: 'response.output_text.delta', output_index: 0, delta: '，伙伴' }),
    tools: event({ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: callId, name: 'memory_search', arguments: '' } })
      + event({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"query":' }) + event({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '"约定"}' }),
    finish: event({ type: 'response.completed', response: { status: 'completed', output: [
      { type: 'message', content: [{ type: 'output_text', text: '你好，伙伴' }] }, { type: 'function_call', call_id: callId, name: 'memory_search', arguments: argumentsText }] } }),
  };
  if (format === 'anthropic') return {
    initial: event({ type: 'message_start', message: { content: [] } }) + event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      + event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } })
      + event({ type: 'content_block_stop', index: 0 }) + event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    first: event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } }),
    second: event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '，伙伴' } }),
    tools: event({ type: 'content_block_stop', index: 1 }) + event({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: callId, name: 'memory_search', input: {} } })
      + event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } })
      + event({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"约定"}' } }) + event({ type: 'content_block_stop', index: 2 }),
    finish: event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + event({ type: 'message_stop' }),
  };
  const chunk = (parts: unknown[], finishReason?: string) => event({ candidates: [{ index: 0, content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
  return { initial: chunk([{ thought: true, text: 'PRIVATE_THINKING' }]), first: chunk([{ text: '你好' }]), second: chunk([{ text: '，伙伴' }]),
    tools: chunk([{ functionCall: { id: callId, name: 'memory_search', args: JSON.parse(argumentsText) }, thoughtSignature: 'opaque-function-signature' }]), finish: chunk([], 'STOP') };
}

describe('real provider streaming', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])(
    'emits visible text while the actual %s response is unfinished and holds tool calls to the end', async format => {
      const source = controlled(), first = deferred<void>(), second = deferred<void>(), texts: string[] = [], wire = fixtures(format);
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(source.response); let completed = false;
      const pending = generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true,
        onTextDelta(text) { texts.push(text); if (text === '你好') first.resolve(); if (text === '你好，伙伴') second.resolve(); } }).then(value => { completed = true; return value; });
      source.send(wire.initial + wire.first); await first.promise;
      expect(texts).toEqual(['你好']); expect(completed).toBe(false);
      source.send(wire.second + wire.tools); await second.promise;
      expect(texts).toEqual(['你好', '你好，伙伴']); expect(completed).toBe(false);
      source.send(wire.finish); const reply = await pending;
      expect(source.cancel).toHaveBeenCalled();
      expect(reply.text).toBe('你好，伙伴'); expect(reply.turn?.calls[0]).toMatchObject({ id: callId, name: 'memory.search', arguments: argumentsText });
      expect(JSON.stringify(reply)).not.toContain('PRIVATE_THINKING'); expect(texts.join('')).not.toContain('约定');
      if (format === 'gemini_native') expect(reply.turn?.calls[0]?.thoughtSignature).toBe('opaque-function-signature');
      const [url, init] = fetchFn.mock.calls[0]!, request = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
      if (format === 'gemini_native') expect(String(url)).toContain(':streamGenerateContent?alt=sse');
      else if (format === 'dashscope_native') {
        expect(new Headers(init?.headers).get('X-DashScope-SSE')).toBe('enable'); expect(request.parameters.incremental_output).toBe(true);
      } else expect(request.stream).toBe(true);
    });
  it('decodes arbitrary UTF-8 network chunk boundaries and incrementally unwraps JSON text without thinking or tool fields', async () => {
    const raw = '<think>PRIVATE_THINKING</think>{"dsh":{"text":"PRIVATE_ARGS"},"text":"你好\\n\\uD83D\\uDE42伙伴","memories":[]}';
    const encoder = new TextEncoder(), text = [...raw].map(content => event({ choices: [{ delta: { content }, finish_reason: null }] })).join('')
      + event({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
    const bytes = encoder.encode(text), texts: string[] = [];
    const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const reply = await generateCompanionReply(input, config, undefined, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(response), onTextDelta: value => texts.push(value) });
    expect(reply.text).toBe('你好\n🙂伙伴'); expect(texts.length).toBeGreaterThan(2); expect(texts.at(-1)).toBe(reply.text);
    expect(reply.turn?.rawText).not.toContain('PRIVATE_THINKING');
    expect(texts.join('')).not.toContain('PRIVATE'); expect(texts.every(value => !value.includes('{') && !value.includes('\\u'))).toBe(true);
    expect(reply.turn?.calls).toEqual([]);
  });
  it('uses a JSON response as one complete response without simulating text deltas', async () => {
    const onTextDelta = vi.fn(), fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '你好' } }] }), { headers: { 'Content-Type': 'application/json' } }));
    expect((await generateCompanionReply(input, config, undefined, { fetchFn, loop: true, onTextDelta })).text).toBe('你好'); expect(onTextDelta).not.toHaveBeenCalled();
  });
  it('redacts thought tags after incremental JSON decoding, including escaped tag prefixes', async () => {
    const raw = String.raw`{"text":"\u003cthink\u003ePRIVATE_ENCODED_THOUGHT\u003c/think\u003e真实正文"}`;
    const source = controlled(), texts: string[] = [];
    const pending = generateCompanionReply(input, config, undefined, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta: value => texts.push(value) });
    for (const content of raw) source.send(event({ choices: [{ delta: { content } }] }));
    source.send(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    const reply = await pending; expect(reply.text).toBe('真实正文'); expect(texts).toEqual(['真', '真实', '真实正', '真实正文']);
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_ENCODED_THOUGHT'); expect(parseCompanionReply(raw).text).toBe('真实正文');
    expect(() => parseCompanionReply(String.raw`{"text":"\u003cthink\u003ePRIVATE_UNCLOSED"}`)).toThrow();
    expect(visibleCompanionStreamText(String.raw`{"text":"\u003c`)).toBe('');
  });
  it('buffers a tool-only argument across frames and publishes no argument fragments as text', async () => {
    const source = controlled(), onTextDelta = vi.fn(); let complete = false;
    const pending = generateCompanionReply(input, config, undefined, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta }).then(value => { complete = true; return value; });
    source.send(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name: 'memory_', arguments: '{"query":' } }] } }] }));
    await Promise.resolve(); await Promise.resolve(); expect(complete).toBe(false); expect(onTextDelta).not.toHaveBeenCalled();
    source.send(event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search', arguments: '"约定"}' } }] }, finish_reason: 'tool_calls' }] }));
    const reply = await pending; expect(reply.text).toBe(''); expect(reply.turn?.calls).toEqual([{ id: callId, name: 'memory.search', arguments: argumentsText }]);
    expect(onTextDelta).not.toHaveBeenCalled();
  });
  it('accepts standard SSE multi-line data and CR delimiters across network boundaries', async () => {
    const source = controlled(), text = deferred<void>(), onTextDelta = vi.fn(() => text.resolve());
    const pending = generateCompanionReply(input, config, undefined, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta });
    source.send('id: ignored\rdata: {"choices":\r');
    source.send('data: [{"delta":{"content":"你好"}}]}\r\r'); await text.promise;
    source.send('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\r');
    expect((await pending).text).toBe('你好'); expect(onTextDelta).toHaveBeenCalledWith('你好');
  });
  it('keeps background structured extraction non-streaming and tool-free', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"candidates":[]}' } }] })));
    expect(await generateCompanionStructured({ system: 'structured', user: '{}' }, config, undefined, { fetchFn })).toEqual({ candidates: [] });
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)); expect(body.stream).toBe(false); expect(body).not.toHaveProperty('tools');
  });
  it.each([
    event({ choices: [{ delta: { content: '部分正文' }, finish_reason: null }] }),
    'data: {"choices":BROKEN_SECRET}\n\n',
    event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'dsh', arguments: '{"tasks":' } }] }, finish_reason: 'tool_calls' }] }),
    event({ choices: [{ delta: {}, finish_reason: 'length' }] }),
  ])('rejects truncated or malformed streams without executing incomplete tools or leaking raw payload %#', async wire => {
    const source = controlled(), fetchFn = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    const pending = generateCompanionReply(input, config, undefined, { fetchFn, loop: true }); source.send(wire); source.end();
    const error = await pending.catch(value => value); expect(error).toMatchObject({ code: 'INVALID_RESPONSE' }); expect(String(error)).not.toContain('SECRET');
  });
  it('cancels a live reader on interruption and does not publish later chunks', async () => {
    const source = controlled(), abort = new AbortController(), seen = deferred<void>(), texts: string[] = [];
    const pending = generateCompanionReply(input, config, abort.signal, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta(value) { texts.push(value); seen.resolve(); } });
    source.send(fixtures('openai_chat').first); await seen.promise; abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' }); await vi.waitFor(() => expect(source.cancel).toHaveBeenCalled()); expect(texts).toEqual(['你好']);
  });
  it('classifies a broken transport reader as a retryable network failure without exposing the raw error', async () => {
    const source = controlled(), seen = deferred<void>();
    const pending = generateCompanionReply(input, config, undefined, { loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta() { seen.resolve(); } });
    source.send(fixtures('openai_chat').first); await seen.promise;
    source.fail(new TypeError('PRIVATE_NETWORK_URL?api_key=PRIVATE_KEY'));
    const error = await pending.catch(value => value); expect(error).toMatchObject({ code: 'NETWORK' }); expect(String(error)).not.toContain('PRIVATE');
  });
  it('times out and cancels a provider that stops sending bytes mid-answer', async () => {
    const source = controlled();
    await expect(generateCompanionReply(input, config, undefined, { timeoutMs: 5, loop: true, fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response) })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.waitFor(() => expect(source.cancel).toHaveBeenCalled());
  });
  it('allows a response longer than its idle budget while actual model events keep advancing', async () => {
    vi.useFakeTimers();
    try {
      const source = controlled(), first = deferred<void>(), second = deferred<void>(), wire = fixtures('openai_chat');
      const pending = generateCompanionReply(input, config, undefined, { timeoutMs: 50, loop: true,
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta(text) { if (text === '你好') first.resolve(); else second.resolve(); } });
      source.send(wire.first); await first.promise; await vi.advanceTimersByTimeAsync(40);
      source.send(wire.second); await second.promise; await vi.advanceTimersByTimeAsync(40);
      source.send(event({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
      expect((await pending).text).toBe('你好，伙伴');
    } finally { vi.useRealTimers(); }
  });
  it('does not extend a stalled response merely because SSE comments are still arriving', async () => {
    vi.useFakeTimers();
    try {
      const source = controlled(), seen = deferred<void>();
      const pending = generateCompanionReply(input, config, undefined, { timeoutMs: 50, loop: true,
        fetchFn: vi.fn<typeof fetch>().mockResolvedValue(source.response), onTextDelta() { seen.resolve(); } });
      const result = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      source.send(fixtures('openai_chat').first); await seen.promise; await vi.advanceTimersByTimeAsync(40);
      source.send(': keepalive\n\n'); await vi.advanceTimersByTimeAsync(11); await result;
      expect(source.cancel).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native'] as const)('rejects the native %s refusal without exposing its raw body', async format => {
    const source = controlled(), fetchFn = vi.fn<typeof fetch>().mockResolvedValue(source.response);
    const refusal = format === 'openai_chat' ? { choices: [{ delta: { refusal: 'PRIVATE_REFUSAL' }, finish_reason: 'content_filter' }] }
      : format === 'openai_responses' ? { type: 'response.refusal.delta', delta: 'PRIVATE_REFUSAL' }
        : format === 'anthropic' ? { type: 'message_delta', delta: { stop_reason: 'refusal' } } : { promptFeedback: { blockReason: 'SAFETY' } };
    const pending = generateCompanionReply(input, { ...config, apiFormat: format }, undefined, { fetchFn, loop: true }); source.send(event(refusal)); source.end();
    const error = await pending.catch(value => value); expect(error).toMatchObject({ code: 'REFUSED' }); expect(String(error)).not.toContain('PRIVATE_REFUSAL');
  });
});

describe('safe incremental visible text projection', () => {
  it.each(['<', '<thi', '<think>SECRET', '{', '{"dsh":{"text":"SECRET"},', '```json', '[P', '[PASS]'])('withholds protocol, thoughts and silence while incomplete: %s', text => expect(visibleCompanionStreamText(text)).toBe(''));
  it('exposes only the actual top-level text field and decodes complete escape sequences', () => {
    expect(visibleCompanionStreamText('{"dsh":{"text":"SECRET"},"text":"可见\\n正文\\u4f60')).toBe('可见\n正文你');
    expect(visibleCompanionStreamText('```json\n{"text":"可见正文"}')).toBe('可见正文');
    expect(visibleCompanionStreamText('自然正文<thi')).toBe('自然正文');
  });
  it('withholds a split emoji high surrogate in both natural text and a JSON text field', () => {
    expect(visibleCompanionStreamText('你好 \uD83D')).toBe('你好');
    expect(visibleCompanionStreamText('你好 \uD83D\uDE42')).toBe('你好 🙂');
    expect(visibleCompanionStreamText('{"text":"你好 \uD83D')).toBe('你好');
    expect(visibleCompanionStreamText('{"text":"你好 \uD83D\uDE42')).toBe('你好 🙂');
  });
});
