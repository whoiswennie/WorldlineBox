// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { LocalSpeechRequest, LocalSpeechResponse } from '../../src/shared/local-speech';
import { useBotCallVoice, type BotCallSendReceipt } from '../../src/renderer/companion-bot/useBotCallVoice';
import type { VoiceRecording } from '../../src/renderer/companion-bot/voice-recorder';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const microphones = vi.hoisted(() => ({ captures: [] as Array<{ stop: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; resolve(value: VoiceRecording | undefined): void }> }));
vi.mock('../../src/renderer/companion-bot/BotVoiceInput', () => ({ localSpeechApi: () => undefined }));
vi.mock('../../src/renderer/companion-bot/call-voice-capture', () => ({ CallVoiceCapture: class {
  readonly finished: Promise<VoiceRecording | undefined>;
  resolve!: (value: VoiceRecording | undefined) => void;
  stop = vi.fn(() => this.resolve({ wave: new Uint8Array([82, 73, 70, 70, 1, 2]), seconds: 1 }));
  cancel = vi.fn(() => this.resolve(undefined));
  constructor() { this.finished = new Promise(resolve => { this.resolve = resolve; }); microphones.captures.push(this); }
  async start() { return { finished: this.finished }; }
} }));

type Options = Parameters<typeof useBotCallVoice>[0];
let root: Root | undefined, host: HTMLDivElement, voice: ReturnType<typeof useBotCallVoice>;
function Harness(options: Options) { const current = useBotCallVoice(options); useLayoutEffect(() => { voice = current; }); return <output data-phase={current.state.phase}>{current.state.transcript}</output>; }
const flush = async () => { for (let index = 0; index < 35; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; }
const reply = (id: string, overrides: Partial<BotMessage> = {}): BotMessage => ({ id, conversationId: 'room', eventId: id, senderId: 'companion', senderName: '伙伴', content: '你好，我们继续聊。', sequence: 1, status: 'sent', createdAt: '2026-11-05T00:00:00Z', ...overrides });
beforeEach(() => { microphones.captures.length = 0; host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host.remove(); });
async function fixture(asr?: (input: LocalSpeechRequest) => Promise<LocalSpeechResponse>) {
  const request = vi.fn<(input: LocalSpeechRequest) => Promise<LocalSpeechResponse>>(asr ?? (async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : input.type === 'speech.transcribe' ? { ok: true, transcript: { text: '识别出来的这句话。', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } } : { ok: true }));
  const send = vi.fn<(text: string, requestId: string) => Promise<BotCallSendReceipt>>(async () => ({ ok: true, replyMessageIds: ['exact-reply'] }));
  let options: Options = { api: { request }, connected: true, conversationId: 'room', companionId: 'companion', messages: [], send };
  const render = async (patch: Partial<Options> = {}) => { options = { ...options, ...patch }; await act(async () => { root!.render(<Harness {...options} />); await flush(); }); };
  const begin = async () => { await act(async () => { voice.start(); await flush(); }); expect(voice.state.phase).toBe('listening'); };
  const finish = async () => { await act(async () => { voice.finish(); await flush(); }); };
  await render(); return { request, send, render, begin, finish };
}

it('resumes only for a settled reply from the exact companion and meeting', async () => {
  const f = await fixture(); await f.begin(); await f.finish();
  for (const messages of [
    [reply('notice')], [reply('exact-reply', { conversationId: 'other-room' })],
    [reply('exact-reply', { senderId: 'other-companion' })], [reply('exact-reply', { status: 'running' })],
  ]) {
    await f.render({ messages }); expect(microphones.captures).toHaveLength(1); expect(voice.state.phase).toBe('waiting');
  }
  await f.render({ messages: [reply('exact-reply')] });
  expect(microphones.captures).toHaveLength(2); expect(voice.state.phase).toBe('listening');
});
it('handles a reply that settles before its send receipt', async () => {
  const receipt = deferred<BotCallSendReceipt>(), f = await fixture(); f.send.mockReturnValueOnce(receipt.promise);
  await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply')] });
  expect(microphones.captures).toHaveLength(1);
  await act(async () => { receipt.resolve({ ok: true, replyMessageIds: ['exact-reply'] }); await flush(); });
  expect(microphones.captures).toHaveLength(2); expect(voice.state.phase).toBe('listening');
});
it('preserves the exact rich composer action and handles its failure without resending', async () => {
  const f = await fixture(); await f.begin();
  const perform = vi.fn().mockResolvedValue({ ok: true, replyMessageIds: ['file-reply'] });
  await act(async () => { expect(await voice.sendAction('', 'attachment-send-id', perform)).toBe(true); await flush(); });
  expect(perform).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  await f.render({ messages: [reply('file-reply', { status: 'failed', error: '回复失败' })] });
  expect(voice.state).toMatchObject({ phase: 'error', canRetrySend: false, error: '回复失败' });
  expect(microphones.captures).toHaveLength(1);
});
it('cancels local recognition on dispose and never sends its delayed transcript into another conversation', async () => {
  const transcript = deferred<LocalSpeechResponse>(); const f = await fixture(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : input.type === 'speech.transcribe' ? transcript.promise : { ok: true });
  await f.begin(); await f.finish(); expect(voice.state.phase).toBe('recognizing');
  const asr = f.request.mock.calls.find(([input]) => input.type === 'speech.transcribe')![0] as { requestId: string };
  await act(() => root!.unmount()); root = undefined; expect(f.request).toHaveBeenLastCalledWith({ type: 'speech.cancel', requestId: asr.requestId });
  await act(async () => { transcript.resolve({ ok: true, transcript: { text: '不得晚发的旧录音', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } }); await flush(); }); expect(f.send).not.toHaveBeenCalled();
});
