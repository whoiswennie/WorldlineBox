// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotCallWindow } from '../../src/renderer/companion-bot/BotCallWindow';
import { botCallClock, botCallProfile } from '../../src/renderer/companion-bot/call-presentation';
import type { BotMessage, BotRequest, BotSnapshot, BotEvent, BotResponse } from '../../src/shared/companion-bot';
import type { BotLive2DControls } from '../../src/renderer/companion-bot/BotLive2DStage';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const live2d = vi.hoisted(() => ({
  present: vi.fn(), fullBody: vi.fn(), scale: vi.fn(), position: vi.fn(), gaze: vi.fn(), idle: vi.fn(),
}));
vi.mock('../../src/renderer/companion-bot/BotLive2DStage', async () => {
  const { useEffect } = await import('react');
  return { BotLive2DStage: ({ onReady }: { onReady(controls: BotLive2DControls): void }) => {
    useEffect(() => { onReady({ ...live2d, catalog: { expressions: [], motions: [] } } as unknown as BotLive2DControls); }, [onReady]);
    return <div data-live2d-fixture />;
  } };
});
const voice = vi.hoisted(() => ({ available: false, stop: vi.fn(), start: vi.fn(), interrupt: vi.fn(), waitForPlayback: vi.fn(), finish: vi.fn(), retry: vi.fn(), sendAction: vi.fn(async (_text: string, _id: string, perform: () => Promise<{ ok: boolean }>) => (await perform()).ok) }));
vi.mock('../../src/renderer/companion-bot/useBotCallVoice', () => ({ useBotCallVoice: () => ({ ...voice, state: { phase: voice.available ? 'listening' : 'off', enabled: voice.available, turn: 0 }, level: 0 }) }));
vi.mock('../../src/renderer/companion-bot/voice-recorder', () => ({
  speechBase64: () => '',
  VoiceRecorder: class {
    private resolve?: (value: undefined) => void;
    async start() { return { startedAt: performance.now(), finished: new Promise(resolve => { this.resolve = resolve; }) }; }
    cancel() { this.resolve?.(undefined); }
  },
}));
const sounds: Array<{ src: string; loop: boolean; muted: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> }> = [];
let root: Root | undefined, host: HTMLDivElement;
const companion = { id: 'gpt', name: 'GPT', persona: '', createdAt: '2026-11-05' };
beforeEach(() => {
  vi.useFakeTimers(); sounds.length = 0;
  voice.available = false; vi.clearAllMocks();
  vi.stubGlobal('Audio', class { loop = false; muted = false; volume = 0; play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn(); constructor(readonly src: string) { sounds.push(this); } });
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function mount(initialDraft = '会面草稿', actor = companion, options: { model?: boolean; send?: () => Promise<BotResponse> } = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const hangup = vi.fn();
  let listener: ((event: BotEvent) => void) | undefined;
  const snapshot: BotSnapshot = { companions: [actor], messages: [], conversations: [], tasks: [], hasMore: false,
    runtime: { engine: 'dsh-native', memory: 'vcp-memory', embedding: '', activeLanes: 0, ready: true, dataRoot: '' } };
  const request = vi.fn(async (input: BotRequest): Promise<BotResponse> => {
    if (input.type === 'call.open') return { ok: true, conversationId: 'meeting', snapshot: { ...snapshot },
      callModel: options.model ? { model: 'test.model3.json', catalog: 'test.json', assets: { expressions: [], motions: [], credits: '', license: '' } } : undefined };
    if (input.type === 'state') return { ok: true, snapshot: { ...snapshot } };
    if (input.type === 'call.interrupt') return { ok: true, interruptedReplyIds: input.replies.map(reply => reply.messageId) };
    if (input.type === 'message.send' && options.send) return options.send();
    return { ok: true };
  });
  const api = { request, onEvent: (callback: (event: BotEvent) => void) => { listener = callback; return () => { listener = undefined; }; } };
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    return <BotCallWindow conversationId="direct" companion={actor} api={api} draft={draft} setDraft={setDraft} locale="zh-CN" onHangup={hangup} onOpenUrl={() => undefined} />;
  }
  await act(() => root!.render(<Harness />));
  return { hangup, request, refresh: async (messages: BotMessage[]) => {
    snapshot.messages = messages; await act(async () => { listener?.({ type: 'changed', conversationId: 'meeting' }); await vi.advanceTimersByTimeAsync(40); });
  } };
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.bot-call-window button')].find(item => item.textContent?.trim() === text)!;
it('waits for the user to connect, loops the ringtone and ends after exactly 60 seconds', async () => {
  const fixture = await mount(); expect(sounds[0]?.loop).toBe(true); expect(sounds[0]?.play).toHaveBeenCalledOnce(); expect(document.querySelector('.bot-call-ringing')).not.toBeNull();
  expect(sounds[0]?.src).toMatch(/\/companion-call\/ringtone\.wav$/);
  await act(() => vi.advanceTimersByTime(59000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-ringing')?.textContent).toContain('1 秒');
  await act(() => vi.advanceTimersByTime(1000)); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('uses 大肥鱼’s theme by companion ID and mutes without restarting it', async () => {
  await mount('', { ...companion, id: DEFAULT_BOT_COMPANION_ID, name: '自定义昵称' });
  const sound = sounds[0]!;
  expect(sound.src).toMatch(/\/ringtones\/dafeiyu-let-me-go\.ogg$/);
  await act(() => button('静音铃声').click()); expect(sound.muted).toBe(true);
  await act(() => button('开启铃声').click()); expect(sound.muted).toBe(false);
  expect(sound.play).toHaveBeenCalledOnce();
});
it('stops ringing on connect, cancels the ringing deadline and shows an avatar for an ordinary companion', async () => {
  const fixture = await mount(); await act(() => button('接通').click()); expect(sounds[0]?.pause).toHaveBeenCalled(); expect(sounds[0]?.removeAttribute).toHaveBeenCalledWith('src');
  expect(document.querySelector('.bot-call-portrait h2')?.textContent).toBe('GPT'); expect(document.querySelector('[data-live2d-fixture]')).toBeNull();
  await act(() => vi.advanceTimersByTime(61000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-duration')?.textContent).toBe('01:01');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="挂断"]')!.click()); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('routes the bubble composer to the dedicated meeting and keeps native topic controls available', async () => {
  const f = await mount(); expect(document.querySelector('.bot-composer')).toBeNull();
  await act(() => button('接通').click());
  expect(f.request).toHaveBeenCalledWith({ type: 'call.open', conversationId: 'direct' });
  const field = document.querySelector<HTMLTextAreaElement>('.bot-call-composer-host textarea')!;
  expect(field.value).toBe('会面草稿');
  expect(button('新话题')).toBeDefined(); expect(button('压缩').disabled).toBe(true);
  await act(() => document.querySelector<HTMLButtonElement>('.bot-send')!.click());
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', conversationId: 'meeting', content: '会面草稿' }));
});
it('stops continuous listening when one-click dictation starts, until it closes', async () => {
  voice.available = true;
  vi.stubGlobal('worldlinebox', { localSpeech: { request: async () => ({ ok: true, status: { phase: 'ready' } }) } });
  await mount(); await act(() => button('接通').click());
  const toggle = document.querySelector<HTMLButtonElement>('[aria-label="连续语音对话"]')!;
  expect(toggle.disabled).toBe(false);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="语音转文字"]')!.click());
  expect(voice.stop).toHaveBeenCalledOnce(); expect(toggle.disabled).toBe(true);
  expect(document.querySelector('.bot-voice-panel')?.textContent).toBe('00:00');
  expect(document.querySelector('[aria-label="语音转文字"]')?.getAttribute('aria-pressed')).toBe('true');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭语音"]')!.click()); expect(toggle.disabled).toBe(false);
});
it('closes emoji then the standard composer before Escape hangs up, and leaves IME composition alone', async () => {
  const f = await mount(); await act(() => button('接通').click());
  const field = document.querySelector<HTMLTextAreaElement>('.bot-call-composer-host textarea')!;
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="表情"]')!.click());
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.bot-expression-picker')).toBeNull(); expect(f.hangup).not.toHaveBeenCalled();
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(f.hangup).not.toHaveBeenCalled();
  await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.bot-call-composer-host')).toBeNull(); expect(document.querySelector('.bot-call-input-entry')).not.toBeNull(); expect(f.hangup).not.toHaveBeenCalled();
  await act(async () => document.querySelector('.bot-call-window')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(f.hangup).toHaveBeenCalledOnce();
});
it('displays only published segments while the native turn is still running, and pages long text losslessly', async () => {
  const actor = { ...companion, id: 'claude', name: 'Claude' };
  const f = await mount('', actor); await act(() => button('接通').click());
  const text = '我把这份很长的内容拆成几个小段，方便在舞台上阅读。'.repeat(8);
  const reply: BotMessage = { id: 'reply', eventId: 'event', conversationId: 'meeting', createdAt: new Date().toISOString(), senderId: actor.id,
    senderName: actor.name, sequence: 1, status: 'running', content: '后台正文不进入舞台', parts: [{ id: 'first', sequence: 1, kind: 'text', text, presentation: {} }] };
  await f.refresh([reply]);
  const avatar = document.querySelector<HTMLImageElement>('.bot-call-visual-novel header .bot-avatar img');
  expect(avatar?.src).toBe(document.querySelector<HTMLImageElement>('.bot-call-portrait img')?.src);
  expect(avatar).not.toBeNull();
  const page = () => document.querySelector('.bot-call-bubble-text')?.textContent ?? '';
  expect(page()).not.toBe(''); expect(page().length).toBeLessThan(text.length);
  expect(document.querySelector('.bot-call-window')?.textContent).not.toContain(reply.content);
  const next = document.querySelector<HTMLButtonElement>('[aria-label="下一段"]')!;
  let joined = page();
  while (!next.disabled) { await act(() => next.click()); joined += page(); }
  expect(joined).toBe(text);
  await act(() => button('完整对话').click());
  expect(document.querySelector('.bot-call-transcript')?.textContent).toContain(text);
  expect(document.querySelector('.bot-call-transcript')?.textContent).not.toContain(reply.content);
});

it('keeps the call clock and model parameter profile', () => {
  expect(botCallClock(125_000)).toBe('02:05');
  expect(botCallProfile({ ParamAngleX: { min: -30, max: 30, default: 0 } }, 'model.json').capabilities?.headControl).toBe(true);
});

it('keeps the first tool segment on stage for its requested duration while later calls queue', async () => {
  const f = await mount(''); await act(() => button('接通').click());
  const first = { id: 'first', sequence: 1, kind: 'text' as const, text: '第一段。', presentation: { durationMs: 5000 } };
  const reply: BotMessage = { id: 'reply', eventId: 'event', conversationId: 'meeting', createdAt: new Date().toISOString(), senderId: companion.id,
    senderName: companion.name, sequence: 1, status: 'running', content: '', parts: [first] };
  await f.refresh([reply]);
  const text = () => document.querySelector('.bot-call-bubble-text')?.textContent;
  expect(text()).toBe(first.text);
  await f.refresh([{ ...reply, status: 'sent', parts: [first, { id: 'second', sequence: 2, kind: 'text', text: '第二段。', presentation: { durationMs: 2000 } },
    { id: 'third', sequence: 3, kind: 'text', text: '第三段。', presentation: {} }] }]);
  await act(() => vi.advanceTimersByTime(4800)); expect(text()).toBe(first.text);
  await act(() => vi.advanceTimersByTime(250)); expect(text()).toBe('第二段。');
  await act(() => vi.advanceTimersByTime(1900)); expect(text()).toBe('第二段。');
  await act(() => vi.advanceTimersByTime(150)); expect(text()).toBe('第三段。');
  await act(() => vi.advanceTimersByTime(1400)); expect(document.querySelector('.bot-call-bubble-status')?.textContent).toBe('回应结束 · 可以继续');
});

it('interrupts the live queue at its visible segment and drops late old snapshots', async () => {
  const f = await mount(''); await act(() => button('接通').click());
  const reply: BotMessage = { id: 'live', eventId: 'event', conversationId: 'meeting', createdAt: new Date().toISOString(), senderId: companion.id,
    senderName: companion.name, sequence: 1, status: 'running', content: '', parts: [
      { id: 'visible', sequence: 1, kind: 'text', text: '已经展示', presentation: { durationMs: 7000 } },
      { id: 'queued', sequence: 2, kind: 'text', text: '应被丢弃', presentation: { gesture: 'nod' } },
    ] };
  await f.refresh([reply]);
  await act(() => button('打断').click());
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt', conversationId: 'meeting', replies: [{ messageId: 'live', throughSegmentId: 'visible' }] }));
  expect(document.querySelector('.bot-call-bubble-status')?.textContent).toBe('已打断 · 可以继续');
  await f.refresh([reply]);
  await act(() => vi.advanceTimersByTime(10000));
  expect(document.querySelector('.bot-call-bubble-text')).toBeNull();
});

const caption = () => document.querySelector('.bot-call-bubble-text')?.textContent;
const namedButton = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const stageReply = (id: string, sequence: number, parts: BotMessage['parts'], status: BotMessage['status'] = 'sent'): BotMessage => ({
  id, eventId: id, conversationId: 'meeting', senderId: companion.id, senderName: companion.name,
  createdAt: new Date().toISOString(), sequence, status, content: '', parts,
});

it('replays each recorded expression and motion when stepping and replaying from the beginning', async () => {
  const f = await mount('', companion, { model: true }); await act(() => button('接通').click());
  const first = { expression: 'smile', motion: 'wave', gesture: 'nod' as const, durationMs: 1600 };
  const second = { expression: 'surprised', gesture: 'blink' as const };
  await f.refresh([stageReply('reply', 1, [
    { id: 'one', kind: 'text', sequence: 1, text: '第一段', presentation: first },
    { id: 'two', kind: 'text', sequence: 2, text: '第二段', presentation: second },
  ])]);
  expect(live2d.present).toHaveBeenLastCalledWith(first);
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(second);
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(undefined);
  await act(() => namedButton('上一段').click()); expect(live2d.present).toHaveBeenLastCalledWith(first);
  await act(() => namedButton('下一段').click()); expect(live2d.present).toHaveBeenLastCalledWith(second);
  await act(() => namedButton('从头播放').click()); expect(live2d.present).toHaveBeenLastCalledWith(first);
  expect(caption()).toBe('第一段');
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(second);
  await act(() => button('打断').click());
  expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt' }));
});

it('shows the submitted prompt while waiting and accepts only its associated reply', async () => {
  let resolve!: (response: BotResponse) => void;
  const sent = new Promise<BotResponse>(done => { resolve = done; });
  const f = await mount('新一轮问题', companion, { send: () => sent });
  await act(() => button('接通').click());
  const old = stageReply('old', 1, [{ id: 'old-segment', sequence: 1, kind: 'text', text: '旧台词', presentation: {} }]);
  await f.refresh([old]); expect(caption()).toBe('旧台词');
  await act(() => vi.advanceTimersByTime(1400));
  await act(() => namedButton('发送 ↑').click());
  expect(caption()).toBeUndefined();
  expect(document.querySelector('.bot-call-user-line')?.textContent).toContain('新一轮问题');
  expect(document.querySelector('.bot-call-bubble-status')?.textContent).toBe('正在回应…');
  await act(() => resolve({ ok: true, replyMessageIds: ['new'] }));
  await f.refresh([old, stageReply('unrelated', 3, [{ id: 'other', sequence: 1, kind: 'text', text: '无关台词', presentation: {} }])]);
  expect(caption()).toBeUndefined();
  const reply = stageReply('new', 2, [], 'running');
  await f.refresh([old, { ...reply, progress: { phase: 'using-tool', toolName: 'shell', activity: { step: 4, summary: '正在核对文件' } } }]);
  const progress = document.querySelector('.bot-call-progress')!;
  expect(progress.textContent).toContain('第 4 步 · 运行命令');
  expect(progress.textContent).toContain('正在核对文件');
  expect(progress.nextElementSibling?.className).toBe('bot-call-bubble');
  await f.refresh([old, stageReply('new', 2, [{ id: 'new-segment', sequence: 1, kind: 'text', text: '新的回应', presentation: {} }])]);
  expect(caption()).toBe('新的回应');
  expect(document.querySelector('.bot-call-progress')).toBeNull();
});
