import sharp from 'sharp';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CaptureAnswerUpdate } from '../../src/shared/capture-answer';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import { readCaptureProviderAnswer } from '../../src/main/capture-tools/provider-answer-stream';
import { answerSelectedText } from '../../src/main/capture-tools/text-answer';
import { answerCaptureImage } from '../../src/main/capture-tools/visual-answer';

const formats: AiApiFormat[] = ['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'];
const key = 'SECRET_API_TOKEN_NEVER_SHOW';
const config = (apiFormat: AiApiFormat = 'openai_chat', model = 'custom-model'): CompanionModelConfig => ({ apiFormat, model, apiKey: key, baseUrl: 'https://example.test' });
const textInput = { selection: '待解释的原文', messages: [{ role: 'user' as const, content: '请解释。' }] };
const event = (value: unknown, name = '') => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
const chat = (delta: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const encoded = new TextEncoder();
const byteResponse = (chunks: Uint8Array[]) => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
const sse = (source: string) => byteResponse([encoded.encode(source)]);
const read = (response: Response, format: AiApiFormat, onUpdate: (snapshot: CaptureAnswerUpdate) => void = vi.fn(), signal = new AbortController().signal) => readCaptureProviderAnswer(response, format, { signal, secret: key, onUpdate });

function source(format: AiApiFormat): string {
  switch (format) {
    case 'openai_chat': return event(chat({ reasoning_content: '公开思考。' })) + event(chat({ content: '**回答**。' })) + event(chat({}, 'stop')) + 'data: [DONE]\n\n';
    case 'openai_responses': return event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '公开思考。' })
      + event({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: '公开思考。' })
      + event({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '**回答**。' })
      + event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'NEVER_DECRYPT_THIS', summary: [{ type: 'summary_text', text: '公开思考。' }] }, { type: 'message', content: [{ type: 'output_text', text: '**回答**。' }] }] } });
    case 'anthropic': return event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'SECRET_SIGNATURE' } })
      + event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '公开思考。' } })
      + event({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SECRET_SIGNATURE' } })
      + event({ type: 'content_block_stop', index: 0 })
      + event({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
      + event({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '**回答**。' } })
      + event({ type: 'content_block_stop', index: 1 })
      + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + event({ type: 'message_stop' });
    case 'gemini_native': return event({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: '公开思考。', thoughtSignature: 'SECRET_SIGNATURE' }] } }] })
      + event({ candidates: [{ index: 0, content: { parts: [{ text: '**回答**。' }, { thoughtSignature: 'SECRET_SIGNATURE' }] }, finishReason: 'STOP' }] });
    case 'dashscope_native': return event({ output: { choices: [{ message: { reasoning_content: '公开思', content: '' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { reasoning_content: '公开思考。', content: '' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: '**回' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: '**回答**。' }, finish_reason: 'stop' }] } });
  }
}
const envelopes: Record<AiApiFormat, unknown> = {
  openai_chat: { choices: [{ message: { reasoning_content: '公开思考。', content: '**回答**。' } }] },
  openai_responses: { output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '公开思考。' }], encrypted_content: 'SECRET_SIGNATURE' }, { type: 'message', content: [{ type: 'output_text', text: '**回答**。' }] }] },
  anthropic: { content: [{ type: 'thinking', thinking: '公开思考。', signature: 'SECRET_SIGNATURE' }, { type: 'redacted_thinking', data: 'SECRET_SIGNATURE' }, { type: 'text', text: '**回答**。' }] },
  gemini_native: { candidates: [{ content: { parts: [{ thought: true, text: '公开思考。', thoughtSignature: 'SECRET_SIGNATURE' }, { text: '**回答**。' }] }, finishReason: 'STOP' }] },
  dashscope_native: { output: { choices: [{ message: { reasoning_content: '公开思考。', content: [{ text: '**回答**。' }] } }] } },
};

describe('temporary answer transport', () => {
  it('publishes genuine incremental reasoning and answer before the HTTP body ends', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>, settled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream' } });
    const updates: CaptureAnswerUpdate[] = [], pending = read(response, 'openai_chat', snapshot => updates.push(snapshot)).finally(() => { settled = true; });
    controller.enqueue(encoded.encode(event(chat({ reasoning_content: '先看原文。' }))));
    await vi.waitFor(() => expect(updates).toEqual([{ text: '', reasoning: '先看原文。' }]));
    expect(settled).toBe(false);
    controller.enqueue(encoded.encode(event(chat({ content: '第一部分' }))));
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ text: '第一部分', reasoning: '先看原文。' }));
    expect(settled).toBe(false);
    controller.enqueue(encoded.encode(event(chat({ content: '，完成。' }, 'stop'))));
    expect(await pending).toBe('第一部分，完成。');
  });

  it.each(formats)('separates public reasoning from the final answer using %s', async format => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    expect(await read(sse(source(format)), format, updates)).toBe('**回答**。');
    expect(updates.mock.calls.at(-1)?.[0]).toEqual({ text: '**回答**。', reasoning: '公开思考。' });
    expect(JSON.stringify(updates.mock.calls)).not.toMatch(/SECRET_SIGNATURE|NEVER_DECRYPT_THIS/u);
  });

  it.each(formats)('supports a service that ignores streaming and returns JSON using %s', async format => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    expect(await read(Response.json(envelopes[format]), format, updates)).toBe('**回答**。');
    expect(updates).toHaveBeenCalledExactlyOnceWith({ text: '**回答**。', reasoning: '公开思考。' });
    expect(JSON.stringify(updates.mock.calls)).not.toContain('SECRET_SIGNATURE');
  });

  it('handles split UTF-8, CRLF across chunks, comments and multiline SSE data fields', async () => {
    const frame = JSON.stringify(chat({ content: '中文😀 **文本**' }), null, 2).split('\n').map(line => `data: ${line}`).join('\r\n');
    const bytes = encoded.encode(`: ping\r\n\r\nevent: chunk\r\n${frame}\r\n\r\n${event(chat({}, 'stop')).replaceAll('\n', '\r\n')}`);
    const chunks = [...bytes].map(byte => Uint8Array.of(byte));
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    expect(await read(byteResponse(chunks), 'openai_chat', updates)).toBe('中文😀 **文本**');
    expect(JSON.stringify(updates.mock.calls)).not.toContain('\uFFFD');
  });

  it('holds unresolved credential prefixes across provider events in both public channels', async () => {
    const updates: CaptureAnswerUpdate[] = [];
    const input = event(chat({ content: 'safe SECRET_API_', reasoning_content: 'reason SECRET_' }))
      + event(chat({ content: 'TOKEN_NEVER_SHOW end', reasoning_content: 'API_TOKEN_NEVER_SHOW end' })) + event(chat({}, 'stop'));
    expect(await read(sse(input), 'openai_chat', update => updates.push(update))).toBe('safe [redacted] end');
    expect(updates[0]).toEqual({ text: 'safe ', reasoning: 'reason ' });
    for (const update of updates) expect(JSON.stringify(update)).not.toMatch(/SECRET_|TOKEN_NEVER_SHOW/u);
    expect(updates.at(-1)).toEqual({ text: 'safe [redacted] end', reasoning: 'reason [redacted] end' });
  });

  it('redacts overlapping and repeated credentials before publishing', async () => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    expect(await readCaptureProviderAnswer(sse(event(chat({ content: 'aaaaaa' })) + event(chat({}, 'stop'))), 'openai_chat', { signal: new AbortController().signal, secret: 'aaa', onUpdate: updates })).toBe('[redacted][redacted]');
    expect(updates.mock.calls.at(-1)?.[0].text).toBe('[redacted][redacted]');
  });

  it('bounds answer and public reasoning bytes without broken multibyte text', async () => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    const answer = await read(sse(event(chat({ content: '图'.repeat(10000), reasoning_content: '想'.repeat(15000) })) + event(chat({}, 'stop'))), 'openai_chat', updates);
    expect(Buffer.byteLength(answer)).toBe(16383);
    expect(Buffer.byteLength(updates.mock.calls.at(-1)![0].reasoning)).toBe(32766);
    expect(JSON.stringify(updates.mock.calls)).not.toContain('\uFFFD');
  });

  it('retains independent indexed Responses summary parts without duplicating done events', async () => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    const input = event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'one' })
      + event({ type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'one' })
      + event({ type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 1, delta: 'two' })
      + event({ type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'answer' }) + event({ type: 'response.completed', response: { status: 'completed' } });
    expect(await read(sse(input), 'openai_responses', updates)).toBe('answer');
    expect(updates.mock.calls.at(-1)?.[0]).toEqual({ text: 'answer', reasoning: 'onetwo' });
  });

  it('requires native completion instead of treating early EOF or an early DONE as success', async () => {
    for (const input of [event(chat({ content: 'partial' })), event(chat({ content: 'partial' })) + 'data: [DONE]\n\n']) {
      await expect(read(sse(input), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('rejects model length exhaustion and refusals without leaking upstream details', async () => {
    await expect(read(sse(event(chat({ content: 'partial' }, 'length'))), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(read(sse(event(chat({ refusal: key }, 'content_filter'))), 'openai_chat')).rejects.toMatchObject({ code: 'REFUSED', message: expect.not.stringContaining(key) });
    await expect(read(sse(event({ error: { message: key } })), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: expect.not.stringContaining(key) });
  });

  it('rejects cumulative DashScope responses that replace already published content', async () => {
    const input = event({ output: { choices: [{ message: { content: 'first' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: 'replacement' }, finish_reason: 'stop' }] } });
    await expect(read(sse(input), 'dashscope_native')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('preserves repeated tokens when DashScope uses the mandatory incremental thinking mode', async () => {
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
    const input = event({ output: { choices: [{ message: { reasoning_content: '想', content: '' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { reasoning_content: '想想', content: '' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: '哈' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: '哈哈' }, finish_reason: 'stop' }] } });
    expect(await readCaptureProviderAnswer(sse(input), 'dashscope_native', { signal: new AbortController().signal, secret: key, onUpdate: updates, dashscopeIncremental: true })).toBe('哈哈哈');
    expect(updates.mock.calls.at(-1)?.[0]).toEqual({ text: '哈哈哈', reasoning: '想想想' });
  });

  it('cancels a stalled stream promptly and cancels its reader', async () => {
    const cancelled = vi.fn(), controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { value.enqueue(encoded.encode(event(chat({ content: 'partial' })))); }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } });
    const updates = vi.fn<(snapshot: CaptureAnswerUpdate) => void>(), pending = read(response, 'openai_chat', updates, controller.signal);
    await vi.waitFor(() => expect(updates).toHaveBeenCalled()); controller.abort();
    await expect(pending).rejects.toBeDefined(); expect(cancelled).toHaveBeenCalledOnce();
  });

  it('does not include fetch read errors in the public network error', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(key)); } }), { headers: { 'content-type': 'text/event-stream' } });
    await expect(read(response, 'openai_chat')).rejects.toMatchObject({ code: 'NETWORK', message: expect.not.stringContaining(key) });
  });

  it('enforces per-event, total-stream, JSON and malformed UTF-8 limits', async () => {
    await expect(read(sse(event(chat({ content: 'a'.repeat(132000) }))), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(read(sse(Array.from({ length: 60 }, () => `: ${'a'.repeat(20000)}\n\n`).join('')), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(read(new Response('a'.repeat(270000)), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(read(byteResponse([Uint8Array.of(0xff)]), 'openai_chat')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

let png: string;
beforeAll(async () => { png = `data:image/png;base64,${(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64')}`; });
describe('capture answer request integration', () => {
  it.each(formats)('requests the actual streaming transport using %s for both selection and screenshot', async format => {
    for (const kind of ['text', 'image']) {
      const fetchFn = vi.fn<typeof fetch>(async () => sse(source(format))), onUpdate = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
      const answer = kind === 'text' ? await answerSelectedText({ config: config(format), ...textInput, fetchFn, onUpdate })
        : await answerCaptureImage({ config: config(format), dataUrl: png, messages: textInput.messages, fetchFn, onUpdate });
      expect(answer).toBe('**回答**。'); expect(onUpdate.mock.calls.at(-1)?.[0].reasoning).toBe('公开思考。');
      expect(fetchFn).toHaveBeenCalledOnce();
      const [url, init] = fetchFn.mock.calls[0]!, wire = JSON.parse(String(init?.body)), headers = new Headers(init?.headers);
      if (format === 'gemini_native') expect(String(url)).toMatch(/:streamGenerateContent\?alt=sse$/u);
      else if (format === 'dashscope_native') { expect(headers.get('X-DashScope-SSE')).toBe('enable'); expect(wire.parameters.incremental_output).toBe(false); }
      else expect(wire.stream).toBe(true);
      expect(JSON.stringify(wire)).not.toMatch(/"enable_thinking":false|"thinking":\{"type":"disabled"/u);
      if (kind === 'image') expect(JSON.stringify(wire)).toContain('image/jpeg');
    }
  });

  it('opts into public summaries for documented model families and leaves unknown models compatible', async () => {
    const cases: [AiApiFormat, string, string, unknown][] = [
      ['openai_responses', 'o3', 'reasoning', { summary: 'auto' }],
      ['openai_responses', 'gpt-5', 'reasoning', { summary: 'auto' }],
      ['anthropic', 'claude-sonnet-4-20250514', 'thinking', { type: 'enabled', budget_tokens: 1024 }],
      ['anthropic', 'claude-opus-4-6', 'thinking', { type: 'adaptive', display: 'summarized' }],
      ['gemini_native', 'gemini-2.5-flash', 'generationConfig', { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true } }],
      ['gemini_native', 'gemini-3.8-flash', 'generationConfig', { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true } }],
    ];
    for (const [format, model, field, expected] of cases) {
      const fetchFn = vi.fn<typeof fetch>(async () => Response.json(envelopes[format]));
      await answerSelectedText({ config: config(format, model), ...textInput, fetchFn, onUpdate: vi.fn() });
      const wire = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      expect(wire[field]).toEqual(expected);
      if (format === 'openai_responses') expect(wire.stream).toBe(true);
    }
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(envelopes.anthropic));
    await answerSelectedText({ config: config('anthropic', 'my-custom-model'), ...textInput, fetchFn, onUpdate: vi.fn() });
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).not.toHaveProperty('thinking');
  });

  it.each(['gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-6-chat-latest'])('keeps %s streaming without forcing unsupported reasoning options', async model => {
    for (const kind of ['text', 'image']) {
      const fetchFn = vi.fn<typeof fetch>(async () => sse(source('openai_responses'))), onUpdate = vi.fn<(snapshot: CaptureAnswerUpdate) => void>();
      if (kind === 'text') await answerSelectedText({ config: config('openai_responses', model), ...textInput, fetchFn, onUpdate });
      else await answerCaptureImage({ config: config('openai_responses', model), dataUrl: png, messages: textInput.messages, fetchFn, onUpdate });
      const wire = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
      expect(wire.stream).toBe(true); expect(wire).not.toHaveProperty('reasoning'); expect(fetchFn).toHaveBeenCalledOnce();
      expect(onUpdate.mock.calls.at(-1)?.[0].text).toBe('**回答**。');
    }
  });

  it('maps interrupted stream errors back to both original public error types', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => sse(event(chat({ content: 'partial' }))));
    await expect(answerSelectedText({ config: config(), ...textInput, fetchFn, onUpdate: vi.fn() })).rejects.toMatchObject({ name: 'SelectionAnswerError', code: 'INVALID_RESPONSE' });
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages: textInput.messages, fetchFn, onUpdate: vi.fn() })).rejects.toMatchObject({ name: 'CaptureVisualAnswerError', code: 'INVALID_RESPONSE' });
  });

  it('uses incremental thinking for known native Qwen models and their compatible multimodal endpoint', async () => {
    const input = event({ output: { choices: [{ message: { reasoning_content: '公开思考。', content: '' }, finish_reason: 'null' }] } })
      + event({ output: { choices: [{ message: { content: '**回答**。' }, finish_reason: 'stop' }] } });
    const fetchFn = vi.fn<typeof fetch>(async () => sse(input));
    await answerSelectedText({ config: config('dashscope_native', 'qwen3.5-plus'), ...textInput, fetchFn, onUpdate: vi.fn() });
    expect(String(fetchFn.mock.calls[0]?.[0])).toContain('/multimodal-generation/');
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).parameters).toMatchObject({ incremental_output: true, enable_thinking: true });
  });

  it('reports streamed image rejection without a second or text-only request', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => sse(event({ error: { code: 'unsupported_image', message: `Model does not support image input ${key}` } })));
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages: textInput.messages, fetchFn, onUpdate: vi.fn() })).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.not.stringContaining(key) });
    expect(fetchFn).toHaveBeenCalledOnce(); expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('image_url');
  });
});
