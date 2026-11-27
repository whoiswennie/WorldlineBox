// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotCallWindow } from '../../src/renderer/companion-bot/BotCallWindow';
import { BotCallDialogue } from '../../src/renderer/companion-bot/BotCallDialogue';
import { BotDesktopCapture } from '../../src/renderer/companion-bot/BotDesktopCapture';
import type { BotMediaResponse, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { botCallClock, botCallProfile } from '../../src/renderer/companion-bot/call-presentation';
import type { BotMessage, BotRequest, BotSnapshot, BotEvent, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotLive2DControls } from '../../src/renderer/companion-bot/BotLive2DStage';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import type { BotPushToTalkTarget } from '../../src/renderer/companion-bot/useBotPushToTalk';

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
  vi.clearAllMocks();
  vi.stubGlobal('Audio', class { loop = false; muted = false; volume = 0; play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn(); constructor(readonly src: string) { sounds.push(this); } });
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function mount(initialDraft = '会面草稿', actor = companion, options: { model?: boolean; send?: () => Promise<BotResponse>; speech?: Pick<WorldlineBoxBotApi, 'speech' | 'onSpeech'> } = {}) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const hangup = vi.fn();
  let listener: ((event: BotEvent) => void) | undefined;
  const snapshot: BotSnapshot = { companions: [actor], messages: [], conversations: [], tasks: [], hasMore: false,
    runtime: { engine: 'dsh-native', memory: 'vcp-memory', embedding: '', activeLanes: 0, ready: true, dataRoot: '' } };
  const request = vi.fn(async (input: BotRequest): Promise<BotResponse> => {
    if (input.type === 'call.open') return { ok: true, conversationId: 'direct', snapshot: { ...snapshot },
      callModel: options.model ? { model: 'test.model3.json', catalog: 'test.json', assets: { expressions: [], motions: [], credits: '', license: '' } } : undefined };
    if (input.type === 'state') return { ok: true, snapshot: { ...snapshot } };
    if (input.type === 'call.interrupt') return { ok: true, interruptedReplyIds: input.replies.map(reply => reply.messageId) };
    if (input.type === 'message.send' && options.send) return options.send();
    return { ok: true };
  });
  const api = { request, ...options.speech, onEvent: (callback: (event: BotEvent) => void) => { listener = callback; return () => { listener = undefined; }; } };
  const target: { current: (() => BotPushToTalkTarget | undefined) | undefined } = { current: undefined };
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    const [speechMuted, setSpeechMuted] = useState(false);
    return <BotCallWindow conversationId="direct" companion={actor} api={api} draft={draft} setDraft={setDraft} speechMuted={speechMuted} onSpeechMute={setSpeechMuted} locale="zh-CN" onHangup={hangup} onOpenUrl={() => undefined} pushToTalkTargetRef={target} />;
  }
  await act(() => root!.render(<Harness />));
  return { hangup, request, target, refresh: async (messages: BotMessage[]) => {
    snapshot.messages = messages; await act(async () => { listener?.({ type: 'changed', conversationId: 'direct' }); await vi.advanceTimersByTimeAsync(40); });
  } };
}
const button = (text: string, surface = document) => [...surface.querySelectorAll<HTMLButtonElement>('.bot-call-window button')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!;
it('waits for the user to connect, loops the ringtone and ends after exactly 60 seconds', async () => {
  const fixture = await mount(); expect(sounds[0]?.loop).toBe(true); expect(sounds[0]?.play).toHaveBeenCalledOnce(); expect(document.querySelector('.bot-call-ringing')).not.toBeNull();
  expect(sounds[0]?.src).toMatch(/\/companion-call\/ringtones\/phoebe\.wav$/);
  await act(() => vi.advanceTimersByTime(59000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-ringing')?.textContent).toContain('1 秒');
  await act(() => vi.advanceTimersByTime(1000)); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('uses 大肥鱼’s theme by companion ID and mutes without restarting it', async () => {
  await mount('', { ...companion, id: DEFAULT_BOT_COMPANION_ID, name: '自定义昵称' });
  const sound = sounds[0]!;
  expect(sound.src).toMatch(/\/ringtones\/dafeiyu\.wav$/);
  await act(() => button('静音铃声').click()); expect(sound.muted).toBe(true);
  await act(() => button('开启铃声').click()); expect(sound.muted).toBe(false);
  expect(sound.play).toHaveBeenCalledOnce();
});
it('uses the same default ringtone for 菲比 after renaming her', async () => {
  await mount('', { ...companion, id: 'phoebe', name: '自定义昵称' });
  expect(sounds[0]?.src).toMatch(/\/companion-call\/ringtones\/phoebe\.wav$/);
});
it('stops ringing on connect, cancels the ringing deadline and shows an avatar for an ordinary companion', async () => {
  const fixture = await mount(); await act(() => button('接通').click()); expect(sounds[0]?.pause).toHaveBeenCalled(); expect(sounds[0]?.removeAttribute).toHaveBeenCalledWith('src');
  expect(document.querySelector('.bot-call-portrait h2')?.textContent).toBe('GPT'); expect(document.querySelector('[data-live2d-fixture]')).toBeNull();
  await act(() => vi.advanceTimersByTime(61000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-duration')?.textContent).toBe('01:01');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="挂断"]')!.click()); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('routes the bubble composer to the shared private chat and keeps native topic controls available', async () => {
  const f = await mount(); expect(document.querySelector('.bot-composer')).toBeNull();
  await act(() => button('接通').click());
  expect(f.request).toHaveBeenCalledWith({ type: 'call.open', conversationId: 'direct' });
  const field = document.querySelector<HTMLTextAreaElement>('.bot-call-composer-host textarea')!;
  expect(field.value).toBe('会面草稿');
  expect(button('新话题')).toBeDefined(); expect(button('压缩').disabled).toBe(true);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="收起会面输入"]')!.click());
  expect(document.querySelector('.bot-call-dock')?.children).toHaveLength(1);
  expect(document.querySelector('.bot-call-input-entry img')?.getAttribute('src')).toContain('startup-logo');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="展开会面输入"]')!.click());
  expect(document.querySelector<HTMLTextAreaElement>('.bot-call-composer-host textarea')?.value).toBe('会面草稿');
  await act(() => document.querySelector<HTMLButtonElement>('.bot-send')!.click());
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send', conversationId: 'direct', content: '会面草稿', surface: 'call' }));
});
it('offers one-click dictation without the continuous listening controls', async () => {
  vi.stubGlobal('worldlinebox', { localSpeech: { request: async () => ({ ok: true, status: { phase: 'ready' } }) } });
  await mount(); await act(() => button('接通').click());
  expect(document.querySelector('[aria-label="连续语音对话"]')).toBeNull();
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="语音转文字"]')!.click());
  expect(document.querySelector('.bot-voice-panel')?.textContent).toBe('00:00');
  expect(document.querySelector('[aria-label="语音转文字"]')?.getAttribute('aria-pressed')).toBe('true');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭语音"]')!.click());
  expect(document.querySelector('.bot-voice-panel')).toBeNull();
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
it('displays a complete published utterance while the native turn is still running', async () => {
  const actor = { ...companion, id: 'claude', name: 'Claude' };
  const f = await mount('', actor); await act(() => button('接通').click());
  const text = '我把这份很长的内容拆成几个小段，方便在舞台上阅读。'.repeat(8);
  const reply: BotMessage = { id: 'reply', eventId: 'event', conversationId: 'meeting', createdAt: new Date().toISOString(), senderId: actor.id,
    senderName: actor.name, sequence: 1, status: 'running', content: '后台正文不进入舞台', parts: [{ id: 'first', sequence: 1, kind: 'text', text, presentation: {} }] };
  await f.refresh([reply]);
  expect(document.querySelector('.bot-call-bubble .bot-avatar')).toBeNull();
  const page = () => document.querySelector('.bot-call-bubble-text')?.textContent ?? '';
  expect(page()).toBe(text);
  expect(document.querySelector('.bot-call-window')?.textContent).not.toContain(reply.content);
  const next = document.querySelector<HTMLButtonElement>('[aria-label="下一段"]')!;
  expect(next.disabled).toBe(true);
  expect(document.querySelector('[aria-label="完整对话"], [aria-label="会面聊天记录"], .bot-call-transcript')).toBeNull();
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
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt', conversationId: 'direct', replies: [{ messageId: 'live', throughSegmentId: 'visible' }] }));
  expect(document.querySelector('.bot-call-bubble-status')?.textContent).toBe('已打断 · 可以继续');
  await f.refresh([reply]);
  await act(() => vi.advanceTimersByTime(10000));
  expect(document.querySelector('.bot-call-bubble-text')).toBeNull();
});

const caption = (surface = document) => surface.querySelector('.bot-call-bubble-text')?.textContent;
const namedButton = (label: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const stageReply = (id: string, sequence: number, parts: BotMessage['parts'], status: BotMessage['status'] = 'sent'): BotMessage => ({
  id, eventId: id, conversationId: 'meeting', senderId: companion.id, senderName: companion.name,
  createdAt: new Date().toISOString(), sequence, status, content: '', parts,
});

it('skips synthesis for incoming captions and replay when companion speech is muted', async () => {
  const audio = vi.fn(), speech = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('AudioContext', audio);
  const f = await mount('草稿', companion, { speech: { speech, onSpeech: () => () => undefined } });
  await act(() => button('接通').click());
  const mute = button('伙伴语音静音');
  expect(mute.getAttribute('aria-pressed')).toBe('false');
  await act(() => mute.click());
  await f.refresh([stageReply('reply', 1, [{ id: 'cue', kind: 'text', sequence: 1, text: '一起看。', presentation: {} }])]);
  expect(caption()).toBe('一起看。');
  await act(() => button('从头播放').click());
  expect(audio).not.toHaveBeenCalled();
  expect(speech).not.toHaveBeenCalled();
});

it.each(['桌宠菜单', '场景面板', '话题列表'] as const)('continues speech while %s is open and stops it for Ctrl recording', async panel => {
  const outputs: Array<{ onended?: () => void }> = [], disconnect = vi.fn();
  vi.stubGlobal('AudioContext', class {
    destination = {};
    currentTime = 0;
    createAnalyser() { return { fftSize: 512, connect() {}, disconnect }; }
    createBuffer() { return { duration: 1, getChannelData: () => new Float32Array(1) }; }
    createBufferSource() { const source = { connect() {}, start() {}, onended: undefined }; outputs.push(source); return source; }
    async resume() {}
    async close() {}
  });
  const speech = vi.fn<NonNullable<WorldlineBoxBotApi['speech']>>().mockResolvedValue({ ok: true });
  let emit: Parameters<NonNullable<WorldlineBoxBotApi['onSpeech']>>[0] | undefined;
  const pet = panel === '桌宠菜单';
  if (pet) vi.stubGlobal('worldlinebox', { companionCallPet: {
    supported: true, command: vi.fn(), onClosed: () => () => undefined, onAnchorChanged: () => () => undefined,
  } });
  const f = await mount('草稿', companion, { speech: { speech, onSpeech: listener => { emit = listener; return () => { emit = undefined; }; } } });
  await act(() => button('接通').click());
  let surface = document;
  if (pet) {
    const child = document.createElement('iframe');
    host.append(child);
    const open = vi.spyOn(window, 'open').mockReturnValue(child.contentWindow);
    try { await act(() => button('切换为桌宠').click()); }
    finally { open.mockRestore(); }
    surface = child.contentDocument!;
  }
  const first = '不过这个真不是一般的烂事，看完别光刷弹幕，那种人当年能被放出来就是流程出问题了。';
  const second = '这件事说完了。';
  await f.refresh([stageReply('reply', 1, [
    { id: 'cue', kind: 'text', sequence: 1, text: first, presentation: {} },
    { id: 'next-cue', kind: 'text', sequence: 2, text: second, presentation: {} },
  ], 'running')]);
  expect(caption(surface)).toBe(first);
  const playing = speech.mock.calls[0]![0];
  expect(playing).toMatchObject({ type: 'play', partId: 'cue', pageIndex: 0 });
  await act(() => {
    emit?.({ id: playing.id, audio: new Uint8Array([0, 1]) });
    emit?.({ id: playing.id, done: true });
  });
  if (panel === '场景面板') await act(() => button('会面菜单', surface).click());
  const panelButton = { 桌宠菜单: '更多会面功能', 场景面板: '场景与互动', 话题列表: '选择话题' }[panel];
  await act(() => button(panelButton, surface).click());
  expect(caption(surface)).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(9000));
  expect(speech.mock.calls.filter(([request]) => request.type === 'play')).toHaveLength(1);
  expect(speech).not.toHaveBeenCalledWith({ type: 'stop', id: playing.id });
  await act(async () => { outputs[0]!.onended!(); await vi.advanceTimersByTimeAsync(20); });
  await act(() => vi.advanceTimersByTimeAsync(20));
  const next = speech.mock.calls.at(-1)![0];
  expect(next).toMatchObject({ type: 'play', partId: 'next-cue', pageIndex: 0 });
  expect(caption(surface)).toBeUndefined();
  const close = { 桌宠菜单: '更多会面功能', 场景面板: '收起会面面板', 话题列表: '关闭话题列表' }[panel];
  await act(() => surface.querySelector<HTMLButtonElement>(`[aria-label="${close}"]`)!.click());
  expect(caption(surface)).toBe(second);
  expect(speech.mock.calls.filter(([request]) => request.type === 'play')).toHaveLength(2);
  expect(speech).not.toHaveBeenCalledWith({ type: 'stop', id: next.id });
  disconnect.mockClear();
  await act(() => {
    f.target.current!()!.start();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  expect(speech).toHaveBeenLastCalledWith({ type: 'stop', id: next.id });
  expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt' }));
  expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'message.send' }));
});

it('presents consecutive no-tool replies with the same local segment ID exactly once per message', async () => {
  const f = await mount();
  await act(() => button('接通').click());
  const makeReply = (id: string, sequence: number, text: string) =>
    stageReply(id, sequence, [{ id: 'committed-answer', kind: 'text', sequence: 1, text, presentation: {} }]);
  const first = makeReply('first-reply', 1, '第一轮直接给出正文。');
  const second = makeReply('second-reply', 2, '第二轮仍然没有调用工具。');
  await f.refresh([first]);
  expect(caption()).toBe('第一轮直接给出正文。');
  await act(() => vi.advanceTimersByTimeAsync(5000));
  await f.refresh([first, second]);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(caption()).toBe('第二轮仍然没有调用工具。');
  await f.refresh([first, second]);
  expect(namedButton('下一段').disabled).toBe(true);
});

it('replays each recorded expression and motion when stepping and replaying from the beginning', async () => {
  const f = await mount('', companion, { model: true }); await act(() => button('接通').click());
  const first = { expression: 'smile', motion: 'wave', gesture: 'nod' as const, durationMs: 1600 };
  const second = { expression: 'surprised', gesture: 'blink' as const };
  await f.refresh([stageReply('reply', 1, [
    { id: 'one', kind: 'text', sequence: 1, text: '第一段', presentation: first },
    { id: 'two', kind: 'text', sequence: 2, text: '第二段', presentation: second },
  ])]);
  expect(live2d.present).toHaveBeenLastCalledWith(first, '第一段');
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(second, '第二段');
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(undefined, undefined);
  await act(() => vi.advanceTimersByTime(1799));
  expect(caption()).toBe('第二段');
  await act(() => vi.advanceTimersByTime(1));
  expect(caption()).toBeUndefined();
  await act(() => namedButton('展开对白').click());
  expect(caption()).toBe('第二段');
  expect(live2d.present).toHaveBeenLastCalledWith(undefined, undefined);
  await act(() => vi.advanceTimersByTime(2000)); expect(caption()).toBe('第二段');
  await act(() => namedButton('收起对白').click());
  expect(caption()).toBeUndefined();
  await act(() => namedButton('展开对白').click());
  expect(caption()).toBe('第二段');
  await act(() => namedButton('上一段').click()); expect(live2d.present).toHaveBeenLastCalledWith(first, '第一段');
  await act(() => namedButton('下一段').click()); expect(live2d.present).toHaveBeenLastCalledWith(second, '第二段');
  await act(() => namedButton('从头播放').click()); expect(live2d.present).toHaveBeenLastCalledWith(first, '第一段');
  expect(caption()).toBe('第一段');
  await act(() => namedButton('收起对白').click());
  await act(() => vi.advanceTimersByTime(1900)); expect(live2d.present).toHaveBeenLastCalledWith(second, '第二段');
  expect(caption()).toBeUndefined();
  await act(() => namedButton('展开对白').click());
  expect(caption()).toBe('第二段');
  await act(() => button('打断').click());
  expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt' }));
});

it('shows the submitted prompt while waiting and presents reports from a different topic', async () => {
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
  expect(document.querySelector('.bot-call-bubble .bot-reply-progress-label')?.textContent).toBe('正在回应…');
  await act(() => resolve({ ok: true, replyMessageIds: ['new'] }));
  const reply = stageReply('new', 2, [], 'running');
  await f.refresh([old, { ...reply, progress: { phase: 'using-tool', toolName: 'shell', activity: { step: 4, summary: '正在核对文件' } } }]);
  const progress = document.querySelector('.bot-call-progress')!;
  expect(progress.querySelector('.bot-reply-progress-label')?.textContent).toBe('运行命令');
  expect(progress.querySelector('.bot-reply-progress-label')?.getAttribute('title')).toBe('正在核对文件');
  expect(progress.querySelector('.bot-call-progress-meta')?.textContent).toContain('第 4 步');
  expect(progress.parentElement?.className).toBe('bot-call-bubble');
  await act(() => vi.advanceTimersByTime(2000));
  expect(progress.querySelector('.bot-reply-progress-elapsed')?.textContent).toBe('2 秒');
  await f.refresh([old, stageReply('new', 2, [{ id: 'new-segment', sequence: 1, kind: 'text', text: '新的回应', presentation: {} }])]);
  expect(caption()).toBe('新的回应');
  expect(document.querySelector('.bot-call-progress')).toBeNull();
  const scheduled = { ...stageReply('scheduled', 3, []), content: '一分钟提醒已完成。', topic: { id: 'schedule', title: '日程提醒' } };
  await f.refresh([old, stageReply('new', 2, [{ id: 'new-segment', sequence: 1, kind: 'text', text: '新的回应', presentation: {} }]), scheduled]);
  await act(() => vi.advanceTimersByTime(1500));
  expect(caption()).toBe(scheduled.content);
  expect(document.querySelector('.bot-call-transcript')).toBeNull();
});

it('keeps desktop pet progress and interruption outside the caption as the reply streams', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const onInterrupt = vi.fn(), ignored = new Set<string>(), baseline = new Set<string>();
  const render = async (message: BotMessage) => {
    const turn = { id: 'turn', content: '问题', receipt: { replyIds: ['reply'], pending: message.status === 'running' ? ['reply'] : [] } };
    await act(() => root!.render(<BotCallDialogue messages={[message]} baseline={baseline} ignored={ignored} connectedAt={0}
      turn={turn} companionId={companion.id} activeAtConnect={baseline} desktopPet zh hideDialogue={false} modelLoading interrupted={false}
      onInterrupt={onInterrupt} onPresent={() => undefined} onPlayback={() => undefined} onNotice={() => undefined} />));
  };
  const waiting = { ...stageReply('reply', 1, [], 'running'), progress: { phase: 'waiting-model' as const } };
  await render(waiting);
  expect(document.querySelector('.bot-call-bubble')).toBeNull();
  const pill = () => document.querySelector('.bot-call-pet-progress');
  expect(pill()?.textContent).toContain('等待模型响应');
  const text = { id: 'segment', sequence: 1, kind: 'text' as const, text: '这行正文应该完整显示。', presentation: {} };
  await render({ ...waiting, parts: [text], progress: { phase: 'recalling-memory' } });
  expect(caption()).toBe(text.text);
  expect(document.querySelector('.bot-call-bubble .bot-call-progress')).toBeNull();
  expect(pill()?.textContent).toContain('正在检索记忆');
  await act(() => pill()!.querySelector<HTMLButtonElement>('button[aria-label="打断"]')!.click());
  expect(onInterrupt).toHaveBeenCalledOnce();
  await render(stageReply('reply', 1, [text]));
  expect(pill()).toBeNull();
  expect(caption()).toBe(text.text);
});

it.each(['sent', 'failed', 'cancelled'] as const)('does not wait for or interrupt an aged-out %s reply', async status => {
  vi.stubGlobal('worldlinebox', { companionCallPet: {
    supported: true, command: vi.fn(), onClosed: () => () => undefined, onAnchorChanged: () => () => undefined,
  } });
  const f = await mount('下一条消息', companion, { send: async () => ({ ok: true, replyMessageIds: ['own'] }) });
  await act(() => button('接通').click());
  const child = document.createElement('iframe');
  host.append(child);
  const open = vi.spyOn(window, 'open').mockReturnValue(child.contentWindow);
  try { await act(() => button('切换为桌宠').click()); }
  finally { open.mockRestore(); }
  const pet = child.contentDocument!;
  await act(async () => { await f.target.current!()!.send('上一个问题', 'voice-turn'); });
  expect(pet.querySelector('.bot-call-pet-progress')).not.toBeNull();
  await f.refresh([stageReply('own', 1, [], 'running')]);
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'state', callReplyIds: ['own'] }));
  await f.refresh([stageReply('own', 1, [], status)]);
  const later = Array.from({ length: 80 }, (_, index) => ({ ...stageReply('later-' + index, index + 2, []), senderId: 'user' }));
  await f.refresh(later);
  expect(pet.querySelector('.bot-call-pet-progress')).toBeNull();
  expect(f.request.mock.calls.filter(([input]) => input.type === 'state').at(-1)?.[0]).not.toHaveProperty('callReplyIds');
  await act(() => button('发送 ↑', pet).click());
  expect(f.request).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'call.interrupt' }));
});

it('keeps replay and page navigation inside the retained window when older captions roll off', async () => {
  const f = await mount('');
  await act(() => button('接通').click());
  const replies = [0, 1].map(batch => stageReply('batch-' + batch, batch + 1, Array.from({ length: 80 }, (_, i) => ({
    id: 'part-' + i, kind: 'text' as const, sequence: i + 1, text: '对白 ' + (batch * 80 + i), presentation: {},
  }))));
  await f.refresh(replies);
  const counter = () => document.querySelector('.bot-call-bubble-controls > span')?.textContent;
  expect(counter()).toBe('1/128');
  expect(caption()).toBe('对白 32');
  await act(() => namedButton('下一段').click());
  expect(caption()).toBe('对白 33');
  await f.refresh([...replies]);
  expect(counter()).toBe('2/128');
  const newest = { ...stageReply('newest', 3, []), content: '新一轮' };
  await f.refresh([...replies, newest]);
  expect(caption()).toBe('新一轮');
  expect(counter()).toBe('128/128');
  await act(() => namedButton('从头播放').click());
  expect(caption()).toBe('对白 33');
  expect(counter()).toBe('1/128');
});

it('shows active desktop capture and DSH progress in the same dock row without an overlay', async () => {
  host = document.createElement('div');
  const surface = document.createElement('div'), statusRow = document.createElement('div');
  host.append(surface, statusRow); document.body.append(host); root = createRoot(surface);
  let finish!: (result: BotMediaResponse) => void;
  const work = new Promise<BotMediaResponse>(resolve => { finish = resolve; });
  const api: WorldlineBoxBotMediaApi = { request: vi.fn(input => input.type === 'desktop.transcribe' ? work : Promise.resolve({ ok: true })), getDroppedFilePaths: () => [] };
  const waiting = { ...stageReply('reply', 1, [], 'running'), progress: { phase: 'recalling-memory' as const } };
  const baseline = new Set<string>();
  const noop = () => undefined;
  const render = (fileRequest: number) => root!.render(<>
    <BotCallDialogue messages={[waiting]} baseline={baseline} ignored={baseline} connectedAt={0}
      companionId={companion.id} activeAtConnect={baseline} desktopPet zh hideDialogue={false} interrupted={false} progressTarget={statusRow}
      onInterrupt={() => undefined} onPresent={() => undefined} onPlayback={() => undefined} onNotice={() => undefined} />
    <BotDesktopCapture api={api} conversationId="direct" surface="pet" locale="zh-CN" statusTarget={statusRow}
      onAttachment={noop} onBusy={noop} fileRequest={fileRequest} />
  </>);
  await act(() => render(0));
  await act(() => render(1));
  expect(statusRow.querySelector('.bot-call-pet-progress')?.textContent).toContain('正在检索记忆');
  expect(statusRow.querySelector('.bot-desktop-capture-status')?.textContent).toContain('正在分段转写音轨');
  expect(host.querySelector('.bot-desktop-capture-panel')).toBeNull();
  await act(() => finish({ ok: true, cancelled: true }));
  expect(statusRow.querySelector('.bot-desktop-capture-status')).toBeNull();
  expect(statusRow.querySelector('.bot-call-pet-progress')).not.toBeNull();
});
