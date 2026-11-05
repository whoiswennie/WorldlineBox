// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalSpeechRequest, LocalSpeechResponse, WorldlineBoxLocalSpeechApi } from '../../src/shared/local-speech';
import { BotVoiceInput } from '../../src/renderer/companion-bot/BotVoiceInput';
import { BotVoiceMessage } from '../../src/renderer/companion-bot/BotVoiceMessage';

const capture = vi.hoisted(() => ({ resolve: undefined as undefined | ((value: { wave: Uint8Array; seconds: number }) => void), cancel: vi.fn() }));
vi.mock('../../src/renderer/companion-bot/voice-recorder', () => ({
  speechBase64: () => 'wave-base64',
  VoiceRecorder: class {
    async start() { return { startedAt: 0, finished: new Promise(resolve => { capture.resolve = resolve; }) }; }
    stop() { capture.resolve?.({ wave: new Uint8Array(100), seconds: 3 }); }
    cancel() { capture.cancel(); }
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.clearAllMocks(); });
const voice = { id: 'v-test', name: '语音消息.wav', kind: 'file' as const, mimeType: 'audio/wav', size: 100, url: 'worldlinebox://bot-media/voice', voice: { durationSeconds: 3 }, transcript: { text: '今天的安排是什么？', audioSeconds: 3, engine: 'sensevoice-int8-cpu' as const } };
async function mount(override?: (request: LocalSpeechRequest) => Promise<LocalSpeechResponse>) {
  const onText = vi.fn(), onVoice = vi.fn(async () => undefined), requests: LocalSpeechRequest[] = [];
  const api: WorldlineBoxLocalSpeechApi = { request: async input => {
    requests.push(input);
    if (input.type === 'speech.status') return { ok: true, status: { phase: 'standby' } };
    if (override) return override(input);
    return { ok: true, transcript: voice.transcript, media: voice };
  } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotVoiceInput api={api} conversationId="room" locale="zh-CN" onText={onText} onVoice={onVoice} />));
  return { api, requests, onText, onVoice };
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, label).toBeDefined(); await act(() => button!.click());
}
async function recorded() { await click('语音转文字'); await click('开始录音'); await click('结束录音'); }

it('dictates into the existing composer only after confirmation and never sends a message', async () => {
  const fixture = await mount(); await recorded(); expect(fixture.onText).not.toHaveBeenCalled();
  await click('转成文字'); expect(fixture.onText).toHaveBeenCalledWith(voice.transcript.text); expect(fixture.onVoice).not.toHaveBeenCalled();
  expect(fixture.requests.some(request => request.type === 'speech.transcribe')).toBe(true);
});
it('sends a playable voice through its separate action and retains the recording on a failed send', async () => {
  const fixture = await mount(); fixture.onVoice.mockRejectedValueOnce(Error('发送失败，请重试。'));
  await recorded(); await click('录音发语音'); await click('发送语音');
  expect(host.textContent).toContain('发送失败'); expect(host.textContent).toContain('录音已就绪');
  await click('发送语音'); expect(fixture.onVoice).toHaveBeenCalledTimes(2); expect(fixture.onText).not.toHaveBeenCalled();
});
it('cancels pending recognition on chat change and prevents late results from reaching another composer', async () => {
  let resolve!: (value: LocalSpeechResponse) => void;
  const fixture = await mount(input => input.type === 'speech.cancel' ? Promise.resolve({ ok: true }) : new Promise(done => { resolve = done; }));
  await recorded();
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === '转成文字')!;
  await act(() => button.click()); await act(() => root!.unmount()); root = undefined;
  await act(() => resolve({ ok: true, transcript: voice.transcript }));
  expect(fixture.requests.some(input => input.type === 'speech.cancel')).toBe(true); expect(fixture.onText).not.toHaveBeenCalled();
});
it('renders the original recording without preloading audio and expands its persisted transcript on demand', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotVoiceMessage media={voice} conversationId="room" locale="zh-CN" />));
  expect(host.querySelector('audio')?.preload).toBe('none'); expect(host.textContent).not.toContain(voice.transcript.text);
  await click('转文字'); expect(host.textContent).toContain(voice.transcript.text);
});
it('holds Space to record and sends a compact voice message on release while keeping voice mode open', async () => {
  const fixture = await mount(); await click('录音发语音');
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })));
  await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })));
  expect(fixture.onVoice).toHaveBeenCalledWith(voice); expect(fixture.onText).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="本地语音"]')).not.toBeNull();
});
