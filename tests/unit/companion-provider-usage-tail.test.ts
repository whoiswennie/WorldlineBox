import { expect, it, vi } from 'vitest';
import { readCompanionProviderStream } from '../../src/main/companions/provider-stream';

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function fixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(), encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
  return { response, cancel, send: (text: string) => controller.enqueue(encoder.encode(text)), fail: () => controller.error(new Error('closed transport')) };
}
const stop = event({ choices: [{ delta: { content: '完整正文' }, finish_reason: 'stop' }] });

it('collects a prompt usage tail without closing the stream at finish_reason', async () => {
  vi.useFakeTimers();
  try {
    const source = fixture(), onUsage = vi.fn(); let settled = false;
    const reply = readCompanionProviderStream(source.response, 'openai_chat', { signal: new AbortController().signal, onUsage }).then(value => { settled = true; return value; });
    source.send(stop); await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    source.send(event({ choices: [], usage: { prompt_tokens: 90, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } } }) + 'data: [DONE]\n\n');
    expect(await reply).toMatchObject({ choices: [{ message: { content: '完整正文' } }] });
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 90, outputTokens: 7, cacheReadTokens: 60 });
    expect(source.cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it('does not hold a completed reply for a missing usage tail or endless SSE keepalives', async () => {
  vi.useFakeTimers();
  try {
    const source = fixture(), onUsage = vi.fn();
    const reply = readCompanionProviderStream(source.response, 'openai_chat', { signal: new AbortController().signal, onUsage });
    source.send(stop); await vi.advanceTimersByTimeAsync(600);
    source.send(': keepalive\n\n'); await vi.advanceTimersByTimeAsync(401);
    expect(await reply).toMatchObject({ choices: [{ message: { content: '完整正文' } }] });
    expect(onUsage).not.toHaveBeenCalled();
    expect(source.cancel).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
it('keeps a valid completed answer if the transport breaks while awaiting optional telemetry', async () => {
  const source = fixture(), onUsage = vi.fn();
  const reply = readCompanionProviderStream(source.response, 'openai_chat', { signal: new AbortController().signal, onUsage });
  source.send(stop); await vi.waitFor(() => expect(source.response.body?.locked).toBe(true));
  // Let the terminal frame dispatch before simulating the trailing connection failure.
  await Promise.resolve(); await Promise.resolve();
  source.fail();
  expect(await reply).toMatchObject({ choices: [{ message: { content: '完整正文' } }] });
  expect(onUsage).not.toHaveBeenCalled();
});
