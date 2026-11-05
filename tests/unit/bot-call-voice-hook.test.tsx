// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { LocalSpeechRequest, LocalSpeechResponse } from '../../src/shared/local-speech';
import { useBotCallVoice, type BotCallSendReceipt } from '../../src/renderer/companion-bot/useBotCallVoice';
import type { BotCallSpeechState } from '../../src/renderer/companion-bot/BotCallSpeechSession';
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
  const stop = vi.fn(), unlock = vi.fn();
  let options: Options = { api: { request }, connected: true, conversationId: 'room', companionId: 'companion', messages: [], send, speech: { available: true, enabled: true, state: { phase: 'idle' }, stop, unlock } };
  const render = async (patch: Partial<Options> = {}) => { options = { ...options, ...patch }; await act(async () => { root!.render(<Harness {...options} />); await flush(); }); };
  const playback = async (state: BotCallSpeechState) => render({ speech: { ...options.speech, state } });
  const begin = async () => { await act(async () => { voice.start(); await flush(); }); expect(voice.state.phase).toBe('listening'); };
  const finish = async () => { await act(async () => { voice.finish(); await flush(); }); };
  await render(); return { request, send, stop, unlock, render, playback, begin, finish, options: () => options };
}

it('uses exact reply receipts and does not resume for other task notices, rooms, or senders', async () => {
  const f = await fixture(); await f.begin(); await f.finish(); expect(voice.state.phase).toBe('waiting');
  const notice = reply('task-notice', { taskNotice: { taskId: 'task', kind: 'task_progress' } });
  await f.render({ messages: [notice] }); await f.playback({ phase: 'preparing', messageId: notice.id }); await f.playback({ phase: 'idle', messageId: notice.id, completedMessageIds: [notice.id] });
  expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('exact-reply', { conversationId: 'another-room' })] }); expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('exact-reply', { senderId: 'another-companion' })] }); expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('exact-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] });
  expect(microphones.captures).toHaveLength(2); expect(voice.state.phase).toBe('listening');
});
it('does not open the microphone when unrelated TTS completes before the send receipt arrives', async () => {
  const receipt = deferred<BotCallSendReceipt>(), f = await fixture(); f.send.mockReturnValueOnce(receipt.promise);
  await f.begin(); await f.finish(); expect(voice.state.phase).toBe('waiting');
  await f.render({ messages: [reply('unrelated')] }); await f.playback({ phase: 'speaking', messageId: 'unrelated' }); await f.playback({ phase: 'idle', messageId: 'unrelated', completedMessageIds: ['unrelated'] }); expect(microphones.captures).toHaveLength(1);
  await act(async () => { receipt.resolve({ ok: true, replyMessageIds: ['exact-reply'] }); await flush(); }); expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('unrelated'), reply('exact-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['unrelated', 'exact-reply'] }); expect(microphones.captures).toHaveLength(2);
});
it('does not mark the current chat intent accepted or failed because an unrelated task-notice read-aloud fails', async () => {
  const receipt = deferred<BotCallSendReceipt>(), f = await fixture(); f.send.mockReturnValueOnce(receipt.promise);
  await f.begin(); await f.finish(); await f.render({ messages: [reply('task-notice', { taskNotice: { taskId: 'task', kind: 'task_progress' } })] });
  await f.playback({ phase: 'preparing', messageId: 'task-notice' }); await f.playback({ phase: 'error', messageId: 'task-notice', error: '任务通知的朗读失败' });
  expect(voice.state.phase).not.toBe('error'); expect(microphones.captures).toHaveLength(1);
  await act(async () => { receipt.resolve({ ok: true, replyMessageIds: ['exact-reply'] }); await flush(); });
  await f.render({ messages: [reply('exact-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] }); expect(voice.state.phase).toBe('listening');
});
it('waits after an exact sent reply commits while TTS is still idle, until that reply actually completes playback', async () => {
  const f = await fixture(); await f.begin(); await f.finish();
  await f.render({ messages: [reply('exact-reply')] }); expect(microphones.captures).toHaveLength(1); expect(voice.state.phase).toBe('waiting');
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); expect(voice.state.phase).toBe('speaking'); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'speaking', messageId: 'exact-reply' }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] }); expect(microphones.captures).toHaveLength(2);
});
it('keeps the accepted reply receipt while manually reading an older message', async () => {
  const f = await fixture(); await f.begin(); await f.finish();
  await f.render({ messages: [reply('history'), reply('exact-reply', { status: 'running', content: '' })] });
  await act(() => voice.waitForPlayback()); await f.playback({ phase: 'preparing', messageId: 'history' });
  await f.playback({ phase: 'idle', messageId: 'history', completedMessageIds: ['history'] });
  expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('history'), reply('exact-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] });
  expect(voice.state.phase).toBe('listening'); expect(microphones.captures).toHaveLength(2);
});
it('remembers successful playback across drains when a receipt arrives after a later task notice', async () => {
  const receipt = deferred<BotCallSendReceipt>(), f = await fixture(); f.send.mockReturnValueOnce(receipt.promise);
  await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply')] });
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] });
  await f.playback({ phase: 'preparing', messageId: 'notice' }); await f.playback({ phase: 'idle', messageId: 'notice', completedMessageIds: ['notice'] });
  expect(microphones.captures).toHaveLength(1);
  await act(async () => { receipt.resolve({ ok: true, replyMessageIds: ['exact-reply'] }); await flush(); });
  expect(voice.state.phase).toBe('listening'); expect(microphones.captures).toHaveLength(2);
});
it('routes a rich composer action once through its original transport and waits for the returned reply', async () => {
  const f = await fixture(); await f.begin(); const perform = vi.fn().mockResolvedValue({ ok: true, replyMessageIds: ['file-reply'] }); let accepted: unknown;
  await act(async () => { accepted = await voice.sendAction('', 'attachment-send-id', perform); await flush(); });
  expect(accepted).toBe(true); expect(perform).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(microphones.captures[0]!.cancel).toHaveBeenCalled();
  await f.render({ messages: [reply('file-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'file-reply' }); await f.playback({ phase: 'idle', messageId: 'file-reply', completedMessageIds: ['file-reply'] });
  expect(voice.state.phase).toBe('listening'); expect(microphones.captures).toHaveLength(2);
});
it('recognizes an exact reply failure retained while another message in the audio queue succeeds', async () => {
  const f = await fixture(); await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply'), reply('notice')] });
  await f.playback({ phase: 'idle', messageId: 'notice', completedMessageIds: ['notice'], failures: [{ messageId: 'exact-reply', error: '这一条音频未能获取' }] });
  expect(voice.state).toMatchObject({ phase: 'error', canRetrySend: false, transcript: '识别出来的这句话。', error: '这一条音频未能获取' }); expect(f.send).toHaveBeenCalledOnce(); expect(microphones.captures).toHaveLength(1);
});
it('retains recognized text after TTS failure and permits normal typing to enter a fresh exact reply turn', async () => {
  const f = await fixture(); await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply')] });
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'error', messageId: 'exact-reply', error: '朗读连接中断' });
  expect(voice.state).toMatchObject({ phase: 'error', transcript: '识别出来的这句话。', canRetrySend: false }); expect(microphones.captures).toHaveLength(1);
  f.send.mockResolvedValueOnce({ ok: true, replyMessageIds: ['typed-reply'] }); let typed: unknown;
  await act(async () => { typed = await voice.sendTyped('我可以继续打字。', 'typed-id'); await flush(); }); expect(typed).toBe(true); expect(f.send).toHaveBeenLastCalledWith('我可以继续打字。', 'typed-id');
  await f.render({ messages: [reply('exact-reply'), reply('typed-reply')] }); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'typed-reply' }); await f.playback({ phase: 'idle', messageId: 'typed-reply', completedMessageIds: ['typed-reply'] }); expect(microphones.captures).toHaveLength(2); expect(voice.state.phase).toBe('listening');
});
it('attributes a batched direct TTS error to the exact reply even when React never observed preparing', async () => {
  const f = await fixture(); await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply')] }); expect(voice.state.phase).toBe('waiting');
  await f.playback({ phase: 'error', messageId: 'exact-reply', error: '生成语音直接失败' });
  expect(voice.state).toMatchObject({ phase: 'error', transcript: '识别出来的这句话。', error: '生成语音直接失败', canRetrySend: false }); expect(f.send).toHaveBeenCalledOnce(); expect(microphones.captures).toHaveLength(1);
});
it('re-arms a deliberate TTS retry without resending accepted chat, then resumes the microphone when retry playback completes', async () => {
  const f = await fixture(); await f.begin(); await f.finish(); await f.render({ messages: [reply('exact-reply')] });
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'error', messageId: 'exact-reply', error: '朗读失败' });
  expect(voice.state.phase).toBe('error'); await act(() => voice.waitForPlayback()); expect(voice.state.phase).toBe('speaking'); expect(f.send).toHaveBeenCalledOnce(); expect(microphones.captures).toHaveLength(1);
  await f.playback({ phase: 'preparing', messageId: 'exact-reply' }); await f.playback({ phase: 'speaking', messageId: 'exact-reply' }); await f.playback({ phase: 'idle', messageId: 'exact-reply', completedMessageIds: ['exact-reply'] });
  expect(voice.state.phase).toBe('listening'); expect(microphones.captures).toHaveLength(2); expect(f.send).toHaveBeenCalledOnce();
});
it('resumes on the exact text reply when read-aloud is disabled, without waiting for unrelated playback metadata', async () => {
  const f = await fixture(); await f.render({ speech: { ...f.options().speech, enabled: false } }); await f.begin(); await f.finish();
  await f.render({ messages: [reply('notice')] }); expect(microphones.captures).toHaveLength(1);
  await f.render({ messages: [reply('notice'), reply('exact-reply')] }); expect(microphones.captures).toHaveLength(2); expect(voice.state.phase).toBe('listening');
});
it('cancels local recognition on dispose and never sends its delayed transcript into another conversation', async () => {
  const transcript = deferred<LocalSpeechResponse>(); const f = await fixture(async input => input.type === 'speech.status' ? { ok: true, status: { phase: 'ready' } } : input.type === 'speech.transcribe' ? transcript.promise : { ok: true });
  await f.begin(); await f.finish(); expect(voice.state.phase).toBe('recognizing');
  const asr = f.request.mock.calls.find(([input]) => input.type === 'speech.transcribe')![0] as { requestId: string };
  await act(() => root!.unmount()); root = undefined; expect(f.request).toHaveBeenLastCalledWith({ type: 'speech.cancel', requestId: asr.requestId });
  await act(async () => { transcript.resolve({ ok: true, transcript: { text: '不得晚发的旧录音', audioSeconds: 1, engine: 'sensevoice-int8-cpu' } }); await flush(); }); expect(f.send).not.toHaveBeenCalled();
});
