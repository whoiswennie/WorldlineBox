import { afterEach, expect, it, vi } from 'vitest';
import { BOT_SPEECH_DEFAULT_VOICE, BOT_SPEECH_MAX_AUDIO_BYTES, botSpeechParts, botSpeechRequestSchema, botSpeechText } from '../../src/shared/companion-bot-speech';
import { BotSpeechService } from '../../src/main/companion-bot/speech-service';
import type { BotSpeechSynthesize } from '../../src/main/companion-bot/edge-speech-transport';
import type { BotConversation, BotMessage } from '../../src/shared/companion-bot';

const input = { type: 'speech.synthesize' as const, conversationId: 'direct', messageId: 'reply', requestId: 'request' };
const audio = Buffer.from('ID3neutral-mp3-fixture');
const services: BotSpeechService[] = [];
function setup() {
  let room: BotConversation | undefined = { id: 'direct', title: '伙伴', kind: 'direct', memberIds: ['user', 'companion'], createdAt: '2026-11-05T00:00:00Z' };
  let message: BotMessage | undefined = { id: 'reply', eventId: 'event', conversationId: 'direct', senderId: 'companion', senderName: '伙伴', content: '你好，很高兴见到你。', sequence: 2, status: 'sent', createdAt: '2026-11-05T00:00:00Z' };
  const synthesize = vi.fn<BotSpeechSynthesize>(async () => audio);
  const service = new BotSpeechService({ getConversation: id => id === room?.id ? room : undefined, getMessage: id => id === message?.id ? message : undefined, synthesize }); services.push(service);
  return { service, synthesize, get room() { return room; }, set room(next) { room = next; }, get message() { return message; }, set message(next) { message = next; } };
}
afterEach(() => { for (const service of services) service.dispose(); services.length = 0; vi.useRealTimers(); });

it('accepts only message references and fixed voice settings, never arbitrary text/SSML/endpoints', () => {
  expect(botSpeechRequestSchema.safeParse(input).success).toBe(true);
  for (const addition of [{ text: 'arbitrary' }, { voice: 'unknown' }, { endpoint: 'https://example.com' }, { partIndex: -1 }, { partIndex: 16 }]) expect(botSpeechRequestSchema.safeParse({ ...input, ...addition }).success).toBe(false);
});
it('removes code and raw addresses, keeps readable link titles, and splits without losing Chinese or supplementary characters', () => {
  const rich = '# 你好\n\n**这是说明**，[资料](https://example.com?q=1)。\n\n```js\nsecretCode();\n```\n\n`inlineCode` ![picture](https://example.com/image) https://example.com/a\n\n<script>doNotRead()</script>';
  const spoken = botSpeechText(rich); expect(spoken).toBe('你好 这是说明，资料。');
  const source = ('🌈你好世界。'.repeat(150)), parts = botSpeechParts(source);
  expect(parts.length).toBeGreaterThan(1); expect(parts.every(part => Array.from(part).length <= 320)).toBe(true); expect(parts.join('')).toBe(source);
  expect(() => botSpeechParts('长'.repeat(5121))).toThrow('回复过长');
});
it('synthesizes the actual final companion message, returns only one bounded MP3 part and reuses it from an in-memory cache', async () => {
  const fixture = setup(); fixture.message!.content = '第一段。'.repeat(100);
  const first = await fixture.service.request(input); expect(first.ok).toBe(true); expect(first.audio).toMatchObject({ mimeType: 'audio/mpeg', voice: BOT_SPEECH_DEFAULT_VOICE, partIndex: 0, partCount: 2, base64: audio.toString('base64') });
  expect(fixture.synthesize).toHaveBeenCalledWith(first.audio!.text, { voice: BOT_SPEECH_DEFAULT_VOICE, signal: expect.any(AbortSignal) });
  const cached = await fixture.service.request({ ...input, requestId: 'retry' }); expect(cached).toEqual(first); expect(fixture.synthesize).toHaveBeenCalledOnce();
  const second = await fixture.service.request({ ...input, requestId: 'part-two', partIndex: 1 }); expect(second.audio?.partIndex).toBe(1); expect(second.audio?.text).not.toBe(first.audio?.text);
});
it('denies user messages, unfinished replies, other chats, peer rooms, and removed membership before any network request', async () => {
  for (const mutation of ['user', 'pending', 'wrong-room', 'peer', 'member'] as const) {
    const fixture = setup();
    if (mutation === 'user') fixture.message!.senderId = 'user';
    if (mutation === 'pending') fixture.message!.status = 'running';
    if (mutation === 'wrong-room') fixture.message!.conversationId = 'other';
    if (mutation === 'peer') fixture.room!.kind = 'peer';
    if (mutation === 'member') fixture.room!.memberIds = ['companion', 'other'];
    expect((await fixture.service.request(input)).ok).toBe(false); expect(fixture.synthesize).not.toHaveBeenCalled();
  }
});
it('rechecks permissions after synthesis and on cache hits so changed/withdrawn content cannot leak audio', async () => {
  const fixture = setup();
  fixture.synthesize.mockImplementationOnce(async () => { fixture.message!.content = '原消息已经更新。'; return audio; });
  const changed = await fixture.service.request(input); expect(changed.ok).toBe(false); expect(changed.audio).toBeUndefined();
  expect((await fixture.service.request({ ...input, requestId: 'valid' })).ok).toBe(true);
  fixture.room!.memberIds = ['companion', 'other'];
  expect((await fixture.service.request({ ...input, requestId: 'revoked' })).audio).toBeUndefined(); expect(fixture.synthesize).toHaveBeenCalledTimes(2);
});
it('coalesces a retried request, caps parallel work, and aborts both current and just-cancelled intents', async () => {
  const fixture = setup(); const pending = new Map<string, (value: Buffer) => void>();
  fixture.synthesize.mockImplementation((text, options) => new Promise<Buffer>((resolve, reject) => { pending.set(text, resolve); options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); }));
  const first = fixture.service.request(input), duplicate = fixture.service.request(input); expect(duplicate).toBe(first);
  fixture.message!.content += '第二次。'; const second = fixture.service.request({ ...input, requestId: 'two' }); await Promise.resolve();
  expect((await fixture.service.request({ ...input, requestId: 'three' })).error).toContain('其他片段');
  await fixture.service.request({ type: 'speech.cancel', requestId: input.requestId }); expect(await first).toMatchObject({ ok: false, cancelled: true });
  fixture.service.dispose(); expect(await second).toMatchObject({ ok: false, cancelled: true });
  const fresh = setup(); fresh.service.cancel('future'); expect(await fresh.service.request({ ...input, requestId: 'future' })).toMatchObject({ cancelled: true }); expect(fresh.synthesize).not.toHaveBeenCalled();
});
it('bounds oversized audio and expires cached speech without persisting an audio history', async () => {
  const fixture = setup(); fixture.synthesize.mockResolvedValueOnce(Buffer.alloc(BOT_SPEECH_MAX_AUDIO_BYTES + 1));
  expect((await fixture.service.request(input)).error).toContain('大小');
  vi.useFakeTimers(); await fixture.service.request({ ...input, requestId: 'valid' }); await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
  await fixture.service.request({ ...input, requestId: 'expired' }); expect(fixture.synthesize).toHaveBeenCalledTimes(3);
});
it('returns a visible retryable timeout rather than misreporting a slow provider as a user cancellation', async () => {
  vi.useFakeTimers(); const fixture = setup();
  fixture.synthesize.mockImplementation((_text, { signal }) => new Promise<Buffer>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })));
  const pending = fixture.service.request(input); await Promise.resolve(); await vi.advanceTimersByTimeAsync(35_000);
  const result = await pending; expect(result.ok).toBe(false); expect(result.error).toContain('超时'); expect(result.cancelled).not.toBe(true);
});
