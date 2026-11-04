import { expect, it, vi } from 'vitest';
import { readProviderStream, ProviderStreamError } from '../../src/main/llm/provider-stream';
import { parseBrowserAgentReply } from '../../src/main/browser/agent-model';
import { unsupportedImageError } from '../../src/shared/model-vision-errors';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

function response(frames: unknown[]) {
  const wire = frames.map(frame => typeof frame === 'string' ? frame : `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(wire);
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const fixtures: Array<{ format: AiApiFormat; frames: unknown[] }> = [
  { format: 'openai_chat', frames: [
    { choices: [{ index: 0, delta: { reasoning_content: 'PRIVATE', content: '你好' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'browser_tabs', arguments: '{' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
  ] },
  { format: 'openai_responses', frames: [
    { type: 'response.output_text.delta', delta: '你好' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call', name: 'browser_tabs', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{}' },
    { type: 'response.completed', response: { status: 'completed' } },
  ] },
  { format: 'anthropic', frames: [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }, { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'browser_tabs', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }, { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' },
  ] },
  { format: 'gemini_native', frames: [
    { candidates: [{ index: 0, content: { parts: [{ text: 'PRIVATE', thought: true }, { text: '你好' }, { functionCall: { id: 'call', name: 'browser_tabs', args: {} }, thoughtSignature: 'signature' }] }, finishReason: 'STOP' }] },
  ] },
  { format: 'dashscope_native', frames: [
    { output: { choices: [{ index: 0, message: { role: 'assistant', content: [{ text: '你好' }], tool_calls: [{ index: 0, id: 'call', function: { name: 'browser_tabs', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } },
  ] },
];
it.each(fixtures)('keeps native tools and public text through split UTF8 SSE frames for $format', async ({ format, frames }) => {
  const onText = vi.fn(), body = await readProviderStream(response(frames), format, { signal: new AbortController().signal, onText });
  const parsed = parseBrowserAgentReply(format, body);
  expect(parsed.text).toBe('你好'); expect(parsed.calls).toMatchObject([{ id: 'call', name: 'browser_tabs', arguments: '{}' }]);
  expect(onText).toHaveBeenLastCalledWith('你好'); expect(JSON.stringify(onText.mock.calls)).not.toContain('PRIVATE');
  if (format === 'gemini_native') expect(parsed.calls[0]?.thoughtSignature).toBe('signature');
});
it('rejects a disconnected partial reply instead of manufacturing a terminal success', async () => {
  await expect(readProviderStream(response([{ choices: [{ delta: { content: '未完成' } }] }]), 'openai_chat', { signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE', diagnostic: 'uncompleted_stream' });
});
it('preserves explicit context-capacity errors for the calling runtime', async () => {
  await expect(readProviderStream(response([{ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }]), 'openai_chat', { signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
});
it('cancels before consuming a response and does not emit stale content', async () => {
  const controller = new AbortController(); controller.abort(); const onText = vi.fn();
  await expect(readProviderStream(response([{ choices: [{ delta: { content: '迟到' }, finish_reason: 'stop' }] }]), 'openai_chat', { signal: controller.signal, onText }))
    .rejects.toBeInstanceOf(ProviderStreamError);
  expect(onText).not.toHaveBeenCalled();
});
it('does not confuse malformed image content with a model lacking vision', () => {
  expect(unsupportedImageError({ error: { message: 'image_url has invalid base64' } })).toBe(false);
  expect(unsupportedImageError({ error: { message: 'This model does not support image inputs' } })).toBe(true);
});
