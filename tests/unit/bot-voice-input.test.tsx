// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LocalSpeechRequest, LocalSpeechResponse, WorldlineBoxLocalSpeechApi } from '../../src/shared/local-speech';
import { BotVoiceInput } from '../../src/renderer/companion-bot/BotVoiceInput';
import { BotVoiceMessage } from '../../src/renderer/companion-bot/BotVoiceMessage';

const capture = vi.hoisted(() => ({ resolve: undefined as undefined | ((value: { wave: Uint8Array; seconds: number } | undefined) => void), cancel: vi.fn(), start: vi.fn(), onLevel: undefined as undefined | ((level: number) => void), onLimit: undefined as undefined | (() => void) }));
vi.mock('../../src/renderer/companion-bot/voice-recorder', () => ({
  speechBase64: () => 'wave-base64',
  VoiceRecorder: class {
    async start(onLimit: () => void, options: { onLevel?(level: number): void }) { capture.start(); capture.onLevel = options.onLevel; capture.onLimit = onLimit; return { startedAt: performance.now(), finished: new Promise(resolve => { capture.resolve = resolve; }) }; }
    stop() { capture.resolve?.({ wave: new Uint8Array(100), seconds: 3 }); }
    cancel() { capture.cancel(); capture.resolve?.(undefined); }
  },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
beforeEach(() => { capture.resolve = undefined; capture.onLevel = undefined; capture.onLimit = undefined; });
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.clearAllMocks(); vi.useRealTimers(); });
const voice = { id: 'v-test', name: '语音消息.wav', kind: 'file' as const, mimeType: 'audio/wav', size: 100, url: 'worldlinebox://bot-media/voice', voice: { durationSeconds: 3 }, transcript: { text: '今天的安排是什么？', audioSeconds: 3, engine: 'sensevoice-int8-cpu' as const } };
async function mount(override?: (request: LocalSpeechRequest) => Promise<LocalSpeechResponse>) {
  const onText = vi.fn(), onVoice = vi.fn(async () => undefined), onStart = vi.fn(), onActivityChange = vi.fn(), requests: LocalSpeechRequest[] = [];
  const api: WorldlineBoxLocalSpeechApi = { request: async input => {
    requests.push(input);
    if (input.type === 'speech.status') return { ok: true, status: { phase: 'standby' } };
    if (override) return override(input);
    return { ok: true, transcript: voice.transcript, media: voice };
  } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotVoiceInput api={api} conversationId="room" locale="zh-CN" onText={onText} onVoice={onVoice} onStart={onStart} onActivityChange={onActivityChange} />));
  return { api, requests, onText, onVoice, onStart, onActivityChange };
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, label).toBeDefined(); await act(() => button!.click());
}
async function recorded(mode = '语音转文字') { await click(mode); await click('结束录音'); }

it('starts immediately and fills the existing composer on the second click without setup or confirmation', async () => {
  const fixture = await mount(); expect(capture.start).not.toHaveBeenCalled();
  await click('语音转文字'); expect(capture.start).toHaveBeenCalledOnce(); expect(fixture.onStart).toHaveBeenCalledOnce();
  expect(host.querySelector('[aria-label="语音转文字"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(host.querySelector('.bot-voice-panel')?.textContent).toBe('00:00');
  expect(host.textContent).not.toMatch(/准备|开始录音|最长|按住空格/);
  await click('语音转文字'); expect(fixture.onText).toHaveBeenCalledWith(voice.transcript.text); expect(fixture.onVoice).not.toHaveBeenCalled();
  expect(fixture.requests.some(request => request.type === 'speech.transcribe')).toBe(true);
  expect(fixture.requests.some(request => request.type === 'speech.prepare' || request.type === 'speech.status')).toBe(false);
  expect(host.querySelector('.bot-voice-panel')).toBeNull(); expect(fixture.onActivityChange).toHaveBeenLastCalledWith(false);
});
it('sends a playable voice through its separate action and retains the recording on a failed send', async () => {
  const fixture = await mount(); fixture.onVoice.mockRejectedValueOnce(Error('发送失败，请重试。'));
  await recorded('录音发语音'); expect(fixture.onVoice).not.toHaveBeenCalled(); await click('发送语音');
  expect(host.textContent).toContain('发送失败'); expect(host.querySelector('[aria-label="发送语音"]')).not.toBeNull();
  await click('发送语音'); expect(fixture.onVoice).toHaveBeenCalledTimes(2); expect(fixture.onText).not.toHaveBeenCalled();
  expect(fixture.requests.filter(request => request.type === 'speech.voice')).toHaveLength(1);
});
it('cancels pending recognition on chat change and prevents late results from reaching another composer', async () => {
  let resolve!: (value: LocalSpeechResponse) => void;
  const fixture = await mount(input => input.type === 'speech.cancel' ? Promise.resolve({ ok: true }) : new Promise(done => { resolve = done; }));
  await recorded();
  await act(() => root!.unmount()); root = undefined;
  await act(() => resolve({ ok: true, transcript: voice.transcript }));
  expect(fixture.requests.some(input => input.type === 'speech.cancel')).toBe(true); expect(fixture.onText).not.toHaveBeenCalled();
});
it('renders the original recording without preloading audio and expands its persisted transcript on demand', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotVoiceMessage media={voice} conversationId="room" locale="zh-CN" />));
  expect(host.querySelector('audio')?.preload).toBe('none'); expect(host.textContent).not.toContain(voice.transcript.text);
  await click('转文字'); expect(host.textContent).toContain(voice.transcript.text);
});
it('ends a recording with Space without sending a voice before its send action', async () => {
  const fixture = await mount(); await click('录音发语音');
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true })));
  await act(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true })));
  expect(fixture.onVoice).not.toHaveBeenCalled(); expect(fixture.onText).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="本地语音"]')).not.toBeNull();
  await click('发送语音'); expect(fixture.onVoice).toHaveBeenCalledWith(voice);
});

it('shows actual microphone levels and elapsed time, keeping silent input flat', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  await mount(); await click('语音转文字');
  const bars = () => [...host.querySelectorAll<HTMLElement>('.bot-voice-live-wave i')].map(item => item.style.height);
  expect(bars()).toEqual(Array(24).fill('3px'));
  await act(() => capture.onLevel?.(.75)); expect(bars().at(-1)).toBe('20.25px');
  await act(() => capture.onLevel?.(0)); expect(bars().at(-1)).toBe('3px');
  await act(() => vi.advanceTimersByTime(3100)); expect(host.querySelector('time')?.textContent).toBe('00:03');
  await click('关闭语音'); expect(capture.cancel).toHaveBeenCalled(); expect(host.querySelector('.bot-voice-panel')).toBeNull();
});
it('processes automatically at the recorder limit and can retry failed recognition without another recording', async () => {
  let attempt = 0;
  const fixture = await mount(async () => ++attempt === 1 ? { ok: false, error: '识别暂时失败' } : { ok: true, transcript: voice.transcript });
  await click('语音转文字');
  await act(() => { capture.onLimit?.(); capture.resolve?.({ wave: new Uint8Array(100), seconds: 60 }); });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('识别暂时失败');
  await click('重试识别'); expect(fixture.onText).toHaveBeenCalledOnce(); expect(capture.start).toHaveBeenCalledOnce();
});
it('cancels on Escape and fences a late transcript even if a new recording has started', async () => {
  let resolve!: (value: LocalSpeechResponse) => void;
  const fixture = await mount(input => input.type === 'speech.cancel' ? Promise.resolve({ ok: true }) : new Promise(done => { resolve = done; }));
  await recorded(); const previous = resolve;
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await click('语音转文字'); await act(() => previous({ ok: true, transcript: voice.transcript }));
  expect(fixture.onText).not.toHaveBeenCalled(); expect(host.querySelector('.is-recording')).not.toBeNull();
  await click('关闭语音'); expect(fixture.requests.some(input => input.type === 'speech.cancel')).toBe(true);
});
