// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { BotSpeechRequest, BotSpeechResponse } from '../../src/shared/companion-bot-speech';
import type { BotLive2DControls } from '../../src/renderer/companion-bot/BotLive2DStage';
import type { BotSpeechFrame } from '../../src/renderer/companion-bot/BotSpeechPlayer';
import { useBotCallSpeech } from '../../src/renderer/companion-bot/useBotCallSpeech';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const playback = vi.hoisted(() => ({ players: [] as Array<{
  frame(frame: BotSpeechFrame): void; finish(): void; unlock: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn>;
}> }));
vi.mock('../../src/renderer/companion-bot/BotSpeechPlayer', () => ({ BotSpeechPlayer: class {
  private settle?: (result: 'ended' | 'cancelled') => void;
  constructor(readonly frame: (value: BotSpeechFrame) => void) { playback.players.push(this); }
  unlock = vi.fn();
  play = vi.fn(() => new Promise<'ended' | 'cancelled'>(resolve => { this.settle = resolve; }));
  finish() { const settle = this.settle; this.settle = undefined; this.frame({ playing: false, level: 0 }); settle?.('ended'); }
  stop = vi.fn(() => { const settle = this.settle; this.settle = undefined; this.frame({ playing: false, level: 0 }); settle?.('cancelled'); });
  destroy = vi.fn(() => this.stop());
} }));

type Options = Parameters<typeof useBotCallSpeech>[0];
let root: Root | undefined, host: HTMLDivElement, speech: ReturnType<typeof useBotCallSpeech>, clock = 0;
function Harness(options: Options) { const current = useBotCallSpeech(options); useLayoutEffect(() => { speech = current; }); return <output data-message={current.state.messageId}>{current.state.displayText}</output>; }
const flush = async () => { for (let step = 0; step < 30; step++) await Promise.resolve(); };
const text = '一二三四五六七八九十';
const message = (id: string): BotMessage => ({ id, conversationId: 'room', eventId: id, senderId: 'companion', senderName: '伙伴', content: text, sequence: 1, status: 'sent', createdAt: '2026-11-05T00:00:00Z' });
beforeEach(() => {
  vi.useFakeTimers(); clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  playback.players.length = 0; localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture() {
  const request = vi.fn<(input: BotSpeechRequest) => Promise<BotSpeechResponse>>(async input => input.type === 'speech.cancel' ? { ok: true, cancelled: true } : { ok: true, audio: { base64: 'AQID', mimeType: 'audio/mpeg', voice: 'zh-CN-XiaoyiNeural', text, partIndex: 0, partCount: 1 } });
  const wave = vi.fn(), control = { speech: wave } as unknown as BotLive2DControls;
  let options: Options = { api: { request }, conversationId: 'room', companionId: 'companion', connected: true, messages: [], control };
  const render = async (patch: Partial<Options> = {}) => { options = { ...options, ...patch }; await act(async () => { root!.render(<Harness {...options} />); await flush(); }); };
  const frame = async (positionSeconds: number, playing = true) => { await act(() => playback.players[0]!.frame({ playing, level: playing ? .6 : 0, positionSeconds, durationSeconds: 10 })); };
  const advance = async (ms: number) => { clock += ms; await act(async () => { vi.advanceTimersByTime(ms); await flush(); }); };
  await render(); return { render, request, wave, frame, advance };
}

it('prepares a newly committed reply during layout, pins its caption ahead of queued replies, and only reveals media-driven text', async () => {
  const f = await fixture(); await f.render({ messages: [message('A')] });
  expect(speech.state).toMatchObject({ phase: 'preparing', messageId: 'A', displayText: '', revealComplete: false }); expect(host.textContent).toBe('');
  await f.frame(2); expect(speech.state).toMatchObject({ phase: 'speaking', messageId: 'A', displayText: '一二', revealComplete: false });
  await f.render({ messages: [message('A'), message('B')] }); expect(speech.state).toMatchObject({ messageId: 'A', displayText: '一二' });
  await act(async () => { playback.players[0]!.finish(); await flush(); }); expect(speech.state).toMatchObject({ phase: 'preparing', messageId: 'B', displayText: '' });
  await act(async () => { playback.players[0]!.finish(); await flush(); }); expect(speech.state).toMatchObject({ phase: 'idle', messageId: 'B', displayText: text, revealComplete: true }); expect(host.textContent).toBe(text);
});

it('caps React subtitle updates while forwarding every waveform frame directly to Live2D', async () => {
  const f = await fixture(); await f.render({ messages: [message('A')] }); await f.frame(1); const baseline = f.wave.mock.calls.length;
  for (let index = 0; index < 60; index++) await f.frame(2 + index / 10);
  expect(f.wave.mock.calls.length - baseline).toBe(60); expect(speech.state.displayText).toBe('一');
  await f.advance(89); expect(speech.state.displayText).toBe('一'); await f.advance(1); expect(speech.state.displayText).toBe('一二三四五六七');
  await f.frame(9); await act(async () => { playback.players[0]!.finish(); await flush(); });
  expect(speech.state).toMatchObject({ phase: 'idle', displayText: text, revealComplete: true });
  await f.advance(200); expect(speech.state).toMatchObject({ phase: 'idle', displayText: text, revealComplete: true });
});

it('clears pending subtitle paints on stop or disconnect and still permits manual media-driven replay with automatic reading off', async () => {
  const f = await fixture(); await f.render({ messages: [message('A')] }); await f.frame(1); await f.frame(5);
  await act(() => speech.toggle()); expect(speech.enabled).toBe(false); expect(speech.state).toMatchObject({ phase: 'idle', messageId: 'A', displayText: text, revealComplete: true });
  await f.advance(100); expect(speech.state.displayText).toBe(text);
  await f.render({ messages: [message('A'), message('B')] }); expect(f.request.mock.calls.filter(([request]) => request.type === 'speech.synthesize')).toHaveLength(1);
  await act(async () => { speech.replay('B'); await flush(); }); expect(speech.state).toMatchObject({ phase: 'preparing', messageId: 'B', displayText: '', revealComplete: false });
  await f.frame(3); expect(speech.state).toMatchObject({ phase: 'speaking', messageId: 'B', displayText: '一二三' }); await f.frame(6);
  await f.render({ connected: false }); const last = speech.state;
  await f.advance(150); expect(speech.state).toEqual(last); expect(playback.players[0]!.destroy).toHaveBeenCalledOnce();
});
