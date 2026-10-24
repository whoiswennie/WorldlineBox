import { afterEach, expect, it, vi } from 'vitest';
import { AI_API_FORMATS, type AiApiFormat } from '../../src/shared/ai-endpoints';
import { generateCompanionStructured } from '../../src/main/companions/model';
import { observeCompanionProviderRequest, observeCompanionProviderResponse } from '../fixtures/companion-provider-observation';

afterEach(() => vi.restoreAllMocks());
const secret = 'HIDDEN_REASONING_MUST_NOT_BE_RECORDED';
const visible = '实际可见结果';
const payload = { purpose: 'topic_reply_quantity_actual_claims', identity: { self: { id: 'actual-owner' } }, data: { actual: '原文' } };
const user = JSON.stringify(payload);
function request(format: AiApiFormat) {
  switch (format) {
    case 'openai_chat': return { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: user }] };
    case 'openai_responses': return { instructions: 'system', input: [{ role: 'user', content: [{ type: 'input_text', text: user }] }] };
    case 'anthropic': return { system: 'system', messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] };
    case 'gemini_native': return { system_instruction: { parts: [{ text: 'system' }] }, contents: [{ role: 'user', parts: [{ text: user }] }] };
    case 'dashscope_native': return { input: { messages: [{ role: 'system', content: [{ text: 'system' }] }, { role: 'user', content: [{ text: user }] }] } };
  }
}
function envelope(format: AiApiFormat, text = `<thinking>${secret}</thinking><analysis>${secret}</analysis>${visible}`) {
  switch (format) {
    case 'openai_chat': return { usage: { prompt_tokens: 11, completion_tokens: 7, unknown: secret },
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', reasoning_content: secret,
        content: [{ type: 'analysis', text: secret }, { type: 'text', text }] } }] };
    case 'openai_responses': return { status: 'completed', usage: { input_tokens: 11, output_tokens: 7, unknown: secret },
      output: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: secret }] },
        { type: 'message', content: [{ type: 'output_text', text }, { type: 'reasoning_text', text: secret }] }] };
    case 'anthropic': return { stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7, unknown: secret },
      content: [{ type: 'thinking', thinking: secret }, { type: 'text', text }] };
    case 'gemini_native': return { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, unknown: secret },
      candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: secret }, { text }] } }] };
    case 'dashscope_native': return { usage: { input_tokens: 11, output_tokens: 7, unknown: secret },
      output: { choices: [{ finish_reason: 'stop', message: { reasoning_content: secret,
        content: [{ type: 'reasoning', text: secret }, { text }] } }] } };
  }
}
function frame(data: unknown, event?: string) { return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`; }
function stream(format: AiApiFormat) {
  switch (format) {
    case 'openai_chat': return frame({ choices: [{ index: 0, delta: { reasoning_content: secret } }] })
      + frame({ choices: [{ index: 0, delta: { content: `<thought>${secret}</thought>${visible}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, hidden: secret } });
    case 'openai_responses': return frame({ type: 'response.reasoning_text.delta', delta: secret })
      + frame({ type: 'response.output_text.delta', delta: visible })
      + frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 7 },
        output: [{ type: 'reasoning', text: secret }, { type: 'message', content: [{ type: 'output_text', text: visible }] }] } });
    case 'anthropic': return frame({ type: 'message_start', message: { usage: { input_tokens: 11 } } }, 'message_start')
      + frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'content_block_start')
      + frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: secret } }, 'content_block_delta')
      + frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
      + frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, 'content_block_start')
      + frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: visible } }, 'content_block_delta')
      + frame({ type: 'content_block_stop', index: 1 }, 'content_block_stop')
      + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }, 'message_delta')
      + frame({ type: 'message_stop' }, 'message_stop');
    case 'gemini_native': return frame({ candidates: [{ index: 0, content: { parts: [{ thought: true, text: secret }] } }] })
      + frame({ candidates: [{ index: 0, content: { parts: [{ text: visible }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 } });
    case 'dashscope_native': return frame({ output: { choices: [{ index: 0, message: { reasoning_content: secret, content: [{ text: visible }] }, finish_reason: 'stop' }] }, usage: { input_tokens: 11, output_tokens: 7 } });
  }
}
const endings: Record<AiApiFormat, string> = { openai_chat: 'stop', openai_responses: 'completed', anthropic: 'end_turn', gemini_native: 'STOP', dashscope_native: 'stop' };

it.each(AI_API_FORMATS)('observes the actual %s request user payload without rewriting bytes or making requests', format => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected observer request'));
  const body = JSON.stringify(request(format)), original = body;
  expect(observeCompanionProviderRequest(format, body)).toEqual({ userText: user, payload });
  expect(body).toBe(original); expect(fetch).not.toHaveBeenCalled();
});
it.each(AI_API_FORMATS)('records visible-only %s JSON and whitelisted numeric usage without consuming the original response', async format => {
  const raw = JSON.stringify(envelope(format)), response = new Response(raw, { headers: { 'content-type': 'application/json' } });
  const observed = await observeCompanionProviderResponse(response, format);
  expect(observed.status).toBe('observed'); expect(observed.visibleText).toBe(visible); expect(observed.finishReason).toBe(endings[format]);
  expect(Object.values(observed.usage!)).toEqual([11, 7]); expect(JSON.stringify(observed)).not.toContain(secret);
  expect(response.bodyUsed).toBe(false); expect(await response.text()).toBe(raw);
});
it.each(AI_API_FORMATS)('uses the production %s SSE parser and keeps hidden fields out of observations', async format => {
  const raw = stream(format), response = new Response(raw, { headers: { 'content-type': 'text/event-stream' } });
  const observed = await observeCompanionProviderResponse(response, format);
  expect(observed.status).toBe('observed'); expect(observed.visibleText).toBe(visible); expect(observed.finishReason).toBe(endings[format]);
  expect(Object.values(observed.usage!)).toEqual([11, 7]); expect(JSON.stringify(observed)).not.toContain(secret);
  expect(response.bodyUsed).toBe(false); expect(await response.text()).toBe(raw);
});
it.each(AI_API_FORMATS)('observes the real %s structured provider request without altering its business response', async apiFormat => {
  const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected external request'));
  const expected = { ok: true }, raw = JSON.stringify(envelope(apiFormat, JSON.stringify(expected)));
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const before = String(init?.body), response = new Response(raw, { headers: { 'content-type': 'application/json' } });
    expect(observeCompanionProviderRequest(apiFormat, before)).toEqual({ userText: user, payload });
    expect(await observeCompanionProviderResponse(response, apiFormat)).toMatchObject({ status: 'observed', visibleText: JSON.stringify(expected) });
    expect(init?.body).toBe(before); expect(response.bodyUsed).toBe(false);
    return response;
  });
  await expect(generateCompanionStructured({ system: '输出 JSON', user }, { apiFormat, model: 'fixture-any-model',
    baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only-key' }, undefined, { fetchFn })).resolves.toEqual(expected);
  expect(fetchFn).toHaveBeenCalledOnce(); expect(globalFetch).not.toHaveBeenCalled();
});
it.each(AI_API_FORMATS)('preserves %s SSE finish and usage across bare CR and split CRLF chunks', async format => {
  for (const separator of ['\r', '\r\n']) {
    const raw = stream(format).replace(/\n/gu, separator), bytes = new TextEncoder().encode(raw);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      // Single-byte chunks also split each CRLF and multi-byte character.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } });
    const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const observed = await observeCompanionProviderResponse(response, format);
    expect(observed).toMatchObject({ status: 'observed', visibleText: visible, finishReason: endings[format] });
    expect(Object.values(observed.usage!)).toEqual([11, 7]); expect(JSON.stringify(observed)).not.toContain(secret);
    expect(await response.text()).toBe(raw);
  }
});
it.each([
  `${visible}<analysis><think>${secret}</think></analysis>尾文`,
  `${visible}<analysis><think>${secret}</analysis>${secret}</think>尾文`,
  `${visible}<thought><reasoning>${secret}</thought>${secret}</reasoning>尾文`,
])('keeps nested and crossed hidden tags out of visible evidence: %s', async text => {
  const response = new Response(JSON.stringify(envelope('openai_chat', text)));
  const observed = await observeCompanionProviderResponse(response, 'openai_chat');
  expect(observed.status).toBe('observed'); expect(observed.visibleText.startsWith(visible)).toBe(true);
  expect(JSON.stringify(observed)).not.toContain(secret);
  expect(observed.visibleText).toBe(text.includes('</think></analysis>') ? `${visible}尾文` : visible);
});
it('also redacts crossed hidden SSE text and truncated opening tags without retaining hidden tails', async () => {
  const text = `${visible}<analysis><think>${secret}</analysis>${secret}</think>尾文`;
  const raw = frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] });
  expect(await observeCompanionProviderResponse(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }), 'openai_chat'))
    .toMatchObject({ status: 'observed', visibleText: visible });
  for (const suffix of ['<think', '<analysis', '<thinking', '<reasoning', '<thought']) {
    expect(await observeCompanionProviderResponse(new Response(JSON.stringify(envelope('openai_chat', visible + suffix))), 'openai_chat'))
      .toMatchObject({ status: 'observed', visibleText: visible });
  }
});
it('does not save arbitrary provider usage or terminal strings, and does not use stop as a general success requirement', async () => {
  const observed = await observeCompanionProviderResponse(new Response(JSON.stringify({ stop_reason: secret,
    usage: { input_tokens: 3, output_tokens: '3', total_tokens: -1, prompt_tokens: null, [secret]: 9, completion_tokens_details: { reasoning_tokens: 2, raw: secret } },
    content: [{ type: 'text', text: `${visible}<reasoning>${secret}` }] })), 'anthropic');
  expect(observed).toEqual({ status: 'observed', visibleText: visible, usage: { input_tokens: 3, 'completion_tokens_details.reasoning_tokens': 2 }, diagnostic: 'unrecognized_finish_reason' });
  expect(JSON.stringify(observed)).not.toContain(secret);
});
it('reports bounded observation failure separately while preserving the actual oversized response', async () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'x'.repeat(256 * 1024) } }] }), response = new Response(raw);
  expect(await observeCompanionProviderResponse(response, 'openai_chat')).toEqual({ status: 'unavailable', visibleText: '', diagnostic: 'response_bytes_limit' });
  expect(await response.text()).toBe(raw);
});
it('records fixed missing-evidence codes rather than malformed provider text or request material', async () => {
  const response = new Response(secret), original = await observeCompanionProviderResponse(response, 'openai_chat');
  expect(original).toEqual({ status: 'unavailable', visibleText: '', diagnostic: 'response_json_invalid' });
  expect(await response.text()).toBe(secret);
  expect(observeCompanionProviderRequest('openai_chat', secret)).toEqual({ payload: {}, evidenceMissing: 'request_json_invalid' });
  expect(observeCompanionProviderRequest('gemini_native', '{}')).toEqual({ payload: {}, evidenceMissing: 'request_user_text_missing' });
});
it('keeps ordinary non-JSON user prompts observable and cancels only its own response clone', async () => {
  expect(observeCompanionProviderRequest('openai_responses', JSON.stringify({ input: '普通上游提示' }))).toEqual({ userText: '普通上游提示', payload: {} });
  const controller = new AbortController(); controller.abort(new Error(secret));
  const raw = JSON.stringify(envelope('openai_chat')), response = new Response(raw);
  expect(await observeCompanionProviderResponse(response, 'openai_chat', { signal: controller.signal })).toEqual({ status: 'unavailable', visibleText: '', diagnostic: 'response_cancelled' });
  expect(await response.text()).toBe(raw);
});
