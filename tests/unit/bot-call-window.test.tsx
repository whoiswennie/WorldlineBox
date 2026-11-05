// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotCallWindow } from '../../src/renderer/companion-bot/BotCallWindow';
import { botCallClock, botCallProfile } from '../../src/renderer/companion-bot/call-presentation';
import { BotComposer } from '../../src/renderer/companion-bot/BotComposer';
import type { BotCallComposerSendBridge } from '../../src/renderer/companion-bot/BotCallWindow';
import type { BotMessage } from '../../src/shared/companion-bot';
import type { BotCallSpeechState } from '../../src/renderer/companion-bot/BotCallSpeechSession';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('../../src/renderer/companion-bot/BotLive2DStage', () => ({ BotLive2DStage: () => <div data-live2d-fixture /> }));
const voice = vi.hoisted(() => ({ available: false, stop: vi.fn(), start: vi.fn(), interrupt: vi.fn(), waitForPlayback: vi.fn(), finish: vi.fn(), retry: vi.fn(), sendAction: vi.fn(async (_text: string, _id: string, perform: () => Promise<{ ok: boolean }>) => (await perform()).ok) }));
const speech = vi.hoisted(() => ({ available: false, enabled: true, state: { phase: 'idle' } as BotCallSpeechState, stop: vi.fn(), unlock: vi.fn(), toggle: vi.fn(), replay: vi.fn() }));
vi.mock('../../src/renderer/companion-bot/useBotCallVoice', () => ({ useBotCallVoice: () => ({ ...voice, state: { phase: voice.available ? 'listening' : 'off', enabled: voice.available, turn: 0 }, level: 0 }) }));
vi.mock('../../src/renderer/companion-bot/useBotCallSpeech', () => ({ useBotCallSpeech: () => ({ ...speech }) }));
const sounds: Array<{ loop: boolean; muted: boolean; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> }> = [];
let root: Root | undefined, host: HTMLDivElement;
const companion = { id: 'gpt', name: 'GPT', persona: '', createdAt: '2026-11-05' };
beforeEach(() => {
  vi.useFakeTimers(); sounds.length = 0;
  voice.available = false; speech.available = false; speech.enabled = true; speech.state = { phase: 'idle' }; vi.clearAllMocks();
  vi.stubGlobal('Audio', class { loop = false; muted = false; volume = 0; play = vi.fn().mockResolvedValue(undefined); pause = vi.fn(); removeAttribute = vi.fn(); load = vi.fn(); constructor(readonly src: string) { sounds.push(this); } });
});
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function mount(send = vi.fn().mockResolvedValue(true), register = vi.fn<(bridge?: BotCallComposerSendBridge) => void>(), messages: BotMessage[] = [], streams: Record<string, string> = {}, initialDraft = '原聊天的草稿', clipboard?: { paste(): void; probe(): boolean }) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); const hangup = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(initialDraft);
    return <BotCallWindow conversationId="room" companion={companion} messages={messages} streams={streams} locale="zh-CN" onHangup={hangup} send={send} onOpenUrl={() => undefined} registerComposerSend={register} onEditText={setDraft} hasPendingDraft={!!draft.trim()} onPasteFiles={clipboard?.paste} mediaApi={clipboard ? { request: async () => ({ ok: true }), getDroppedFilePaths: () => [], hasClipboardFiles: clipboard.probe } : undefined}
      composer={options => <BotComposer locale="zh-CN" conversationId="room" draft={draft} setDraft={setDraft} disabled={false} busy={false} group={false} world={false} panel={null} setPanel={() => undefined} send={async () => send(draft)} addFiles={async () => undefined} removeFile={() => undefined} sendSticker={async () => undefined} sendVoice={async () => undefined} extraTools={options.toolbar} cornerControl={options.corner} status={options.status} onVoiceInputStart={options.onVoiceInputStart} onVoiceInputActivity={options.onVoiceInputActivity} />} />;
  }
  await act(() => root!.render(<Harness />));
  return { hangup, send, register, refresh: async () => { await act(() => root!.render(<Harness />)); } };
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.bot-call-window button')].find(item => item.textContent?.trim() === text)!;
it('waits for the user to connect, loops the ringtone and ends after exactly 60 seconds', async () => {
  const fixture = await mount(); expect(sounds[0]?.loop).toBe(true); expect(sounds[0]?.play).toHaveBeenCalledOnce(); expect(document.querySelector('.bot-call-ringing')).not.toBeNull();
  await act(() => vi.advanceTimersByTime(59000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-ringing')?.textContent).toContain('1 秒');
  await act(() => vi.advanceTimersByTime(1000)); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('stops ringing on connect, cancels the ringing deadline and shows an avatar for an ordinary companion', async () => {
  const fixture = await mount(); await act(() => button('接通').click()); expect(sounds[0]?.pause).toHaveBeenCalled(); expect(sounds[0]?.removeAttribute).toHaveBeenCalledWith('src');
  expect(document.querySelector('.bot-call-portrait h2')?.textContent).toBe('GPT'); expect(document.querySelector('[data-live2d-fixture]')).toBeNull();
  await act(() => vi.advanceTimersByTime(61000)); expect(fixture.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-duration')?.textContent).toBe('01:01');
  await act(() => button('挂断').click()); expect(fixture.hangup).toHaveBeenCalledOnce();
});
it('hosts the original full composer at the bottom and registers its transport only after connecting', async () => {
  const f = await mount(); expect(f.register).not.toHaveBeenCalled(); expect(document.querySelector('.bot-composer')).toBeNull();
  await act(() => button('接通').click());
  expect(f.register).toHaveBeenLastCalledWith({ send: voice.sendAction });
  expect(document.querySelectorAll('.bot-composer')).toHaveLength(1); expect(document.querySelector('.bot-call-chat textarea')).toBeNull();
  const collapse = document.querySelector<HTMLButtonElement>('[aria-label="收起会面输入"]')!;
  expect(collapse.closest('.bot-composer')).not.toBeNull(); expect(collapse.querySelector('svg.bot-icon path')?.getAttribute('d')).toBe('M6 9l6 6 6-6'); expect(collapse.textContent).not.toContain('⌄');
  const field = document.querySelector<HTMLTextAreaElement>('.bot-call-composer-host .bot-composer textarea')!;
  expect(field.value).toBe('原聊天的草稿'); expect(field.getAttribute('aria-label')).toBe('发送消息…');
  await act(async () => document.querySelector<HTMLButtonElement>('.bot-call-composer-host [aria-label="表情"]')!.click());
  expect(document.querySelector('.bot-expression-picker')).not.toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('.bot-send')!.click()); expect(f.send).toHaveBeenCalledExactlyOnceWith('原聊天的草稿');
  await act(() => root!.unmount()); root = undefined; expect(f.register).toHaveBeenLastCalledWith();
});
it('stops continuous listening and playback before standard dictation, blocks its continuous toggle until the panel closes', async () => {
  voice.available = true;
  vi.stubGlobal('worldlinebox', { localSpeech: { request: async () => ({ ok: true, status: { phase: 'ready' } }) } });
  await mount(); await act(() => button('接通').click());
  const toggle = document.querySelector<HTMLButtonElement>('[aria-label="连续语音对话"]')!;
  expect(toggle.disabled).toBe(false);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="语音转文字"]')!.click());
  expect(voice.stop).toHaveBeenCalledOnce(); expect(speech.stop).toHaveBeenCalledOnce(); expect(toggle.disabled).toBe(true);
  await act(() => button('开始录音').click()); expect(voice.stop).toHaveBeenCalledTimes(2); expect(speech.stop).toHaveBeenCalledTimes(2);
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
it('shows one current streaming native reply with its attachment, keeping other messages in on-demand history', async () => {
  const base = { conversationId: 'room', createdAt: '2026-11-05T00:00:00Z', senderId: companion.id, senderName: companion.name };
  const messages: BotMessage[] = [
    { ...base, id: 'older', eventId: 'e1', sequence: 1, status: 'sent', content: '上一次完整回复。' },
    { ...base, id: 'own', eventId: 'e2', sequence: 2, status: 'sent', senderId: 'user', content: '刚刚发送并识别出来的话。' },
    { ...base, id: 'current', eventId: 'e3', sequence: 3, status: 'running', content: '', attachments: [{ id: 'file', name: '最新附件.html', kind: 'file', mimeType: 'text/html', size: 512, url: 'worldlinebox://bot-media/public/file' }] },
  ];
  const f = await mount(undefined, undefined, messages, { current: '这是正在生成的最新回应。' }); await act(() => button('接通').click());
  expect(document.querySelector<HTMLElement>('.bot-call-chat')?.hidden).toBe(true);
  expect(document.querySelector('.bot-call-dialogue')?.getAttribute('data-call-dialogue-message')).toBe('current');
  expect(document.querySelector('.bot-call-dialogue')?.textContent).toContain('这是正在生成的最新回应。'); expect(document.querySelector('.bot-call-dialogue')?.textContent).toContain('最新附件.html');
  expect(document.querySelector('.bot-call-user-echo')).toBeNull(); expect(document.querySelector('.bot-call-dialogue [data-call-message]')).toBeNull();
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="收起会面输入"]')!.click());
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="会面聊天记录"]')!.click());
  expect(document.querySelector<HTMLElement>('.bot-call-chat')?.hidden).toBe(false); expect(document.querySelectorAll('[data-call-message]')).toHaveLength(3); expect(document.querySelector('.bot-call-dialogue')).toBeNull();
  await act(() => document.querySelector('.bot-call-window')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector<HTMLElement>('.bot-call-chat')?.hidden).toBe(true); expect(f.hangup).not.toHaveBeenCalled(); expect(document.querySelector('.bot-call-dialogue')).not.toBeNull();
});
it('starts with a quiet input entry and expands only the original composer, retaining an unsent draft on collapse', async () => {
  voice.available = true; await mount(undefined, undefined, [], {}, ''); await act(() => button('接通').click());
  expect(document.querySelector('.bot-composer')).toBeNull(); expect(document.querySelector('.bot-call-input-entry')?.textContent).toContain('说点什么'); expect(document.querySelectorAll('[aria-label="连续语音对话"]')).toHaveLength(1);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="展开会面输入"]')!.click()); expect(document.querySelectorAll('.bot-composer')).toHaveLength(1); expect(document.querySelectorAll('[aria-label="连续语音对话"]')).toHaveLength(1);
  const field = document.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '不应丢失的文字'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="收起会面输入"]')!.click()); expect(document.querySelector('.bot-call-input-entry')?.textContent).toContain('未发送');
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="展开会面输入"]')!.click()); expect(document.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.value).toBe('不应丢失的文字');
});
it('pins the actual manually playing reply and its audio-revealed prefix even with automatic read-aloud off', async () => {
  speech.available = true; speech.enabled = false; speech.state = { phase: 'speaking', messageId: 'audio', displayText: '真正正在说', revealComplete: false };
  const base = { conversationId: 'room', createdAt: '2026-11-05T00:00:00Z', senderId: companion.id, senderName: companion.name, status: 'sent' as const };
  await mount(undefined, undefined, [{ ...base, id: 'audio', eventId: 'a', sequence: 1, content: '真正正在说的完整旧消息。' }, { ...base, id: 'queued', eventId: 'b', sequence: 2, content: '还没有开始朗读的新消息。' }], {}, ''); await act(() => button('接通').click());
  expect(document.querySelector('.bot-call-dialogue')?.getAttribute('data-call-dialogue-message')).toBe('audio');
  expect(document.querySelector('.bot-call-dialogue-content')?.textContent).toBe('真正正在说');
  const viewport = document.querySelector<HTMLElement>('.bot-call-dialogue-content')!;
  Object.defineProperty(viewport, 'scrollHeight', { value: 480, configurable: true });
  speech.state = { ...speech.state, displayText: '真正正在说的后半句话' };
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="会面菜单"]')!.click()); expect(viewport.scrollTop).toBe(0);
  speech.state = { phase: 'idle', messageId: 'audio', displayText: '真正正在说的完整旧消息。', revealComplete: true };
  viewport.scrollTop = 60;
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="会面菜单"]')!.click()); expect(viewport.scrollTop).toBe(60);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="会面聊天记录"]')!.click()); await act(() => document.querySelector<HTMLButtonElement>('[aria-label="会面聊天记录"]')!.click());
  expect(document.querySelector('.bot-call-dialogue')?.getAttribute('data-call-dialogue-message')).toBe('queued');
});
it('keeps read-aloud failure and manual retry visible while the full keyboard composer remains collapsed', async () => {
  speech.available = true; speech.state = { phase: 'error', messageId: 'failed-audio', displayText: '不完整', revealComplete: false, error: '伙伴声音连接中断', failures: [{ messageId: 'failed-audio', error: '伙伴声音连接中断' }] };
  const f = await mount(undefined, undefined, [{ id: 'failed-audio', eventId: 'a', sequence: 1, conversationId: 'room', createdAt: '2026-11-05T00:00:00Z', senderId: companion.id, senderName: companion.name, status: 'sent', content: '朗读失败后仍应看到这句完整消息。' }], {}, ''); await act(() => button('接通').click());
  expect(document.querySelector('.bot-composer')).toBeNull(); expect(document.querySelector('.bot-call-dialogue-content')?.textContent).toBe('朗读失败后仍应看到这句完整消息。');
  expect(document.querySelector('.bot-call-live-status [role="alert"]')?.textContent).toContain('伙伴声音连接中断');
  await act(() => button('重试朗读').click()); expect(speech.replay).toHaveBeenCalledExactlyOnceWith('failed-audio'); expect(f.send).not.toHaveBeenCalled(); expect(document.querySelector('.bot-composer')).toBeNull();
});
it('keeps audio captions on the frozen synthesis source through stale streams, new snapshots and completion', async () => {
  const sourceText = '已经开始朗读的稳定原文。', messages: BotMessage[] = [{ id: 'spoken', eventId: 'spoken', sequence: 1, conversationId: 'room', createdAt: '2026-11-05T00:00:00Z', senderId: companion.id, senderName: companion.name, status: 'sent', content: sourceText }];
  const streams = { spoken: '这是仍留在流缓存中的另一段文字。' };
  speech.available = true; speech.state = { phase: 'preparing', messageId: 'spoken', sourceText, displayText: '', pendingMessageIds: ['spoken'] };
  const fixture = await mount(undefined, undefined, messages, streams, ''); await act(() => button('接通').click());
  const caption = () => document.querySelector('.bot-call-caption-text')!.textContent!;
  expect(caption()).toBe('正在准备语音…');
  speech.state = { ...speech.state, phase: 'speaking', displayText: sourceText.slice(0, 5) }; await fixture.refresh(); expect(caption()).toBe(sourceText.slice(0, 5));
  messages[0] = { ...messages[0]!, content: '稍后到达的消息快照不能改写已经开始的字幕。' }; await fixture.refresh(); expect(caption()).toBe(sourceText.slice(0, 5));
  speech.state = { ...speech.state, phase: 'idle', displayText: sourceText, revealComplete: true, pendingMessageIds: [], textMessageIds: ['spoken'] }; await fixture.refresh();
  expect(caption()).toBe(sourceText); await act(() => vi.advanceTimersByTime(500)); expect(caption()).toBe(sourceText);
});
it('accepts native file paste without browser File items and leaves ordinary text paste to the original editor', async () => {
  const paste = vi.fn(), probe = vi.fn(() => true);
  await mount(undefined, undefined, [], {}, '', { paste, probe }); await act(() => button('接通').click());
  const native = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(native, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? 'C:\\example\\report.txt' : '' } });
  await act(() => document.querySelector('.bot-call-window')!.dispatchEvent(native));
  expect(paste).toHaveBeenCalledOnce(); expect(probe).toHaveBeenCalledWith('room'); expect(native.defaultPrevented).toBe(true); expect(document.querySelector('.bot-composer')).not.toBeNull();
  probe.mockReturnValue(false);
  const normal = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(normal, 'clipboardData', { value: { files: [], items: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? '普通文字' : '' } });
  await act(() => document.querySelector('textarea')!.dispatchEvent(normal));
  expect(paste).toHaveBeenCalledOnce(); expect(normal.defaultPrevented).toBe(false);
});
it('keeps local controls within real model capabilities and formats meeting duration across minutes', () => {
  const profile = botCallProfile({ ParamAngleX: { min: -30, max: 30, default: 0 }, ParamEyeLOpen: { min: 0, max: 1, default: 1 } }, 'local.model3.json');
  expect(profile.parameterMap.headX?.targets).toEqual(['ParamAngleX']); expect(profile.parameterMap.eyeOpen?.targets).toEqual(['ParamEyeLOpen']); expect(profile.parameterMap.blush).toBeUndefined();
  const face = botCallProfile({ key7: { min: 0, max: 1, default: 0 }, ParamMouthForm: { min: -1, max: 1, default: 0 } }, 'local.model3.json');
  expect(face.parameterMap.blush?.scale).toBeLessThanOrEqual(.2); expect(face.parameterMap.mouthSmile?.scale).toBeLessThanOrEqual(.4);
  expect(botCallClock(61000)).toBe('01:01'); expect(botCallClock(-1)).toBe('00:00');
});
