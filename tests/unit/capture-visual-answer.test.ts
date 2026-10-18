import sharp from 'sharp';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { answerCaptureImage, getCaptureAiState } from '../../src/main/capture-tools/visual-answer';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';

let png: string;
const config = (format: AiApiFormat = 'openai_chat'): CompanionModelConfig => ({ apiFormat: format, apiKey: 'secret-capture-key-never-expose', model: 'custom-vision', baseUrl: 'https://example.test' });
const messages = [{ role: 'user' as const, content: '这张截图是什么？' }];
beforeAll(async () => { png = `data:image/png;base64,${(await sharp({ create: { width: 24, height: 12, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64')}`; });
afterEach(() => vi.useRealTimers());
const bodies: Record<AiApiFormat, unknown> = {
  openai_chat: { choices: [{ message: { content: '图中是红色区域。' } }] },
  openai_responses: { output: [{ type: 'message', content: [{ type: 'output_text', text: '图中是红色区域。' }] }] },
  anthropic: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '图中是红色区域。' }] },
  gemini_native: { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: '图中是红色区域。' }] } }] },
  dashscope_native: { output: { choices: [{ message: { content: [{ text: '图中是红色区域。' }] } }] } },
};

describe('capture visual model requests', () => {
  it.each<AiApiFormat>(['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'])('sends actual sanitized image pixels using %s and extracts visible text', async format => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(bodies[format]), { headers: { 'Content-Type': 'application/json' } }));
    expect(await answerCaptureImage({ config: config(format), dataUrl: png, messages, fetchFn })).toBe('图中是红色区域。');
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!; const wire = JSON.parse(String(init?.body));
    expect(String(url)).not.toContain('secret-capture'); expect(init?.redirect).toBe('error');
    if (format === 'openai_responses') { expect(wire.store).toBe(false); expect(wire.previous_response_id).toBeUndefined(); expect(wire.conversation).toBeUndefined(); }
    const image = format === 'openai_chat' ? wire.messages.at(-1).content.find((item: { type: string }) => item.type === 'image_url').image_url.url
      : format === 'openai_responses' ? wire.input.at(-1).content.find((item: { type: string }) => item.type === 'input_image').image_url
      : format === 'anthropic' ? 'data:image/jpeg;base64,' + wire.messages.at(-1).content.find((item: { type: string }) => item.type === 'image').source.data
      : format === 'gemini_native' ? 'data:image/jpeg;base64,' + wire.contents.at(-1).parts.find((item: { inlineData?: unknown }) => item.inlineData).inlineData.data
      : wire.input.messages.at(-1).content.find((item: { image?: unknown }) => item.image).image;
    expect(image).toMatch(/^data:image\/jpeg;base64,/);
    const decoded = await sharp(Buffer.from(image.split(',')[1], 'base64')).metadata();
    expect([decoded.width, decoded.height]).toEqual([24, 12]);
    expect(JSON.stringify(wire)).toContain('这张截图是什么'); expect(JSON.stringify(wire)).not.toContain('hidden');
    const headers = new Headers(init?.headers);
    expect(format === 'anthropic' ? headers.get('x-api-key') : format === 'gemini_native' ? headers.get('x-goog-api-key') : headers.get('Authorization')).toContain('secret-capture-key');
  });

  it('keeps text history and attaches only the current edited image to the latest question', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(bodies.openai_chat));
    await answerCaptureImage({ config: config(), dataUrl: png, messages: [{ role: 'user', content: '之前的问题' }, { role: 'assistant', content: '之前的回答' }, ...messages], fetchFn });
    const wire = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(wire.messages[1].content).toBe('之前的问题'); expect(wire.messages[2].content).toBe('之前的回答');
    expect(JSON.stringify(wire).match(/image_url/g)).toHaveLength(2);
  });

  it('rejects known text-only models before making any provider request', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(answerCaptureImage({ config: { ...config(), baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' }, dataUrl: png, messages, fetchFn })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports image rejection explicitly without retrying as text-only', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'unsupported_image', message: 'Model does not support image input, secret-capture-key-never-expose' } }, { status: 400 }));
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn })).rejects.toMatchObject({ code: 'UNSUPPORTED', message: expect.not.stringContaining('secret-capture-key') });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0]?.[1]?.body)).toContain('image_url');
  });

  it('does not leak auth keys or provider bodies through HTTP and fetch errors', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'secret-capture-key-never-expose private response' } }, { status: 401 }));
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn })).rejects.toMatchObject({ code: 'AUTH', message: expect.not.stringContaining('secret-capture') });
    const failed = vi.fn<typeof fetch>(async () => { throw new Error('https://secret-capture-key-never-expose@example.test'); });
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn: failed })).rejects.toMatchObject({ code: 'NETWORK', message: expect.not.stringContaining('secret-capture') });
  });

  it('redacts credentials even if a misbehaving provider echoes them in a successful answer', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: 'echo secret-capture-key-never-expose' } }] }));
    expect(await answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn })).toBe('echo [redacted]');
  });

  it('supports cancellation even when a custom fetch implementation ignores AbortSignal', async () => {
    const controller = new AbortController(); let entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
    const fetchFn = vi.fn<typeof fetch>(() => { entered(); return new Promise<Response>(() => undefined); });
    const pending = answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn, signal: controller.signal });
    await ready; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects a pre-cancelled request without sending any pixels', async () => {
    const controller = new AbortController(); controller.abort(); const fetchFn = vi.fn<typeof fetch>();
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('ends an unresponsive provider at the request timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let entered!: () => void; const ready = new Promise<void>(done => { entered = done; });
    const fetchFn = vi.fn<typeof fetch>(() => { entered(); return new Promise<Response>(() => undefined); });
    const pending = answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await ready; await vi.advanceTimersByTimeAsync(90_000); await assertion;
  });

  it('enforces the 256 KiB response bound and 16 KiB visible-answer bound', async () => {
    const huge = vi.fn<typeof fetch>(async () => new Response('x'.repeat(270_000)));
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn: huge })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const text = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: '图'.repeat(10000) } }] }));
    const answer = await answerCaptureImage({ config: config(), dataUrl: png, messages, fetchFn: text });
    expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(16 * 1024); expect(answer).not.toContain('\uFFFD');
  });

  it('checks decoded image format and refuses external image URLs', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const dataUrl of ['https://example.test/image.png', 'data:image/png;base64,YmFk', png.replace('image/png', 'image/jpeg')]) {
      await expect(answerCaptureImage({ config: config(), dataUrl, messages, fetchFn })).rejects.toMatchObject({ code: 'IMAGE' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resizes large screenshots within a 2048 px longest side before sending them', async () => {
    const large = `data:image/png;base64,${(await sharp({ create: { width: 4096, height: 2048, channels: 3, background: '#008800' } }).png().toBuffer()).toString('base64')}`;
    const fetchFn = vi.fn<typeof fetch>(async () => Response.json(bodies.openai_chat));
    await answerCaptureImage({ config: config(), dataUrl: large, messages, fetchFn });
    const wire = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const metadata = await sharp(Buffer.from(wire.messages.at(-1).content[1].image_url.url.split(',')[1], 'base64')).metadata();
    expect([metadata.width, metadata.height]).toEqual([2048, 1024]);
  });

  it('validates credential-free endpoint prefixes and bounded alternating conversation history', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(answerCaptureImage({ config: { ...config(), baseUrl: 'https://example.test?key=secret' }, dataUrl: png, messages, fetchFn })).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages: [{ role: 'assistant', content: 'not a question' }], fetchFn })).rejects.toMatchObject({ code: 'CONFIG' });
    await expect(answerCaptureImage({ config: config(), dataUrl: png, messages: [{ role: 'user', content: 'x'.repeat(20_000) }], fetchFn })).rejects.toMatchObject({ code: 'CONFIG' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('reports capabilities without exposing API credentials and allows unknown services to attempt real images', () => {
    expect(getCaptureAiState(undefined)).toMatchObject({ configured: false, visionSupported: null });
    expect(getCaptureAiState(config())).toEqual({ configured: true, model: 'custom-vision', visionSupported: null });
    expect(getCaptureAiState({ ...config(), model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })).toEqual({ configured: true, model: 'deepseek-flash', visionSupported: true });
    expect(JSON.stringify(getCaptureAiState(config()))).not.toContain('secret-capture');
  });
});
