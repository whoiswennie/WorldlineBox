// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { botUiSharedLauncher } from '../fixtures/bot-ui-shared-launcher';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotRequest, BotResponse, BotSnapshot } from '../../src/shared/companion-bot';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const call = vi.hoisted(() => ({
  send: undefined as undefined | ((text: string, id: string) => Promise<boolean | { ok: boolean; replyMessageIds?: readonly string[] }>),
  bridge: vi.fn(async (_text: string, _id: string, perform: () => Promise<{ ok: boolean }>) => (await perform()).ok),
  noop: () => undefined,
}));
vi.mock('../../src/renderer/companion-bot/useBotCallVoice', () => ({ useBotCallVoice: (options: { send: typeof call.send }) => {
  call.send = options.send;
  return { available: false, state: { phase: 'off', enabled: false, turn: 0 }, level: 0, sendAction: call.bridge,
    stop: call.noop, start: call.noop, interrupt: call.noop, waitForPlayback: call.noop, finish: call.noop, retry: call.noop };
} }));
vi.mock('../../src/renderer/companion-bot/BotLive2DStage', () => ({ BotLive2DStage: () => null }));
const at = '2026-11-05T00:00:00Z';
const file: BotMediaRef = { id: 'pending-file', name: '待发送文档.txt', kind: 'file', mimeType: 'text/plain', size: 12, url: 'worldlinebox://bot-media/public/pending-file' };
const sticker: BotMediaRef = { id: 'selected-sticker', name: '鲸鱼表情包', kind: 'sticker', mimeType: 'image/webp', size: 12, url: 'worldlinebox://bot-media/public/selected-sticker' };
let root: Root | undefined, host: HTMLDivElement, requests: BotRequest[], snapshot: BotSnapshot;
let respond: (request: BotRequest) => BotResponse | Promise<BotResponse> | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] }); vi.clearAllMocks(); localStorage.clear(); requests = []; respond = () => undefined;
  snapshot = { companions: [{ id: 'alice', name: 'Alice', persona: '', createdAt: at }], conversations: [{ id: 'room', kind: 'direct', title: 'Alice', memberIds: ['user', 'alice'], createdAt: at }], messages: [], tasks: [], hasMore: false,
    runtime: { engine: 'dsh-native', memory: 'vcp-memory', embedding: 'bundled', activeLanes: 1, ready: true, dataRoot: 'isolated-test' } };
  vi.stubGlobal('Audio', class { loop = false; volume = 0; muted = false; play = async () => undefined; pause() {} removeAttribute() {} load() {} });
});
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const api = { async request(input: BotRequest): Promise<BotResponse> {
    requests.push(input); const custom = respond(input); if (custom) return custom;
    if (input.type === 'state') return { ok: true, snapshot };
    return { ok: true, replyMessageIds: ['original-reply'] };
  }, onEvent: () => () => undefined };
  const mediaApi = { getDroppedFilePaths: (files: File[]) => files.map(item => item.name), async request(input: { type: string }) {
    if (input.type === 'files.pick' || input.type === 'files.import') return { ok: true, media: [file] };
    if (input.type === 'packs.list') return { ok: true, packs: [{ id: 'whale', name: '鲸鱼', builtin: true, count: 1 }] };
    return { ok: true, media: [sticker] };
  } };
  await act(async () => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace launcherApi={botUiSharedLauncher()} api={api} mediaApi={mediaApi} onOpenSettings={call.noop} /></LocaleProvider>));
}
const input = () => document.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!;
async function type(value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); }); }
async function click(label: string, scope: ParentNode = document) {
  const target = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!;
  expect(target, label).toBeDefined(); await act(async () => target.click());
}
async function connect() { await act(async () => host.querySelector<HTMLButtonElement>('.bot-call-entry')!.click()); await click('接通'); }
const sends = () => requests.filter((request): request is Extract<BotRequest, { type: 'message.send' }> => request.type === 'message.send');

it('moves the full standard composer into the meeting, preserves failed attachment sends and retries the same original IPC intent', async () => {
  let fail = true; respond = input => input.type === 'message.send' && fail ? { ok: false, error: '原消息暂未受理' } : undefined;
  await mount(); await type('原私聊完整草稿。'); await click('添加文件'); await connect();
  expect(document.querySelectorAll('.bot-composer')).toHaveLength(1); expect(host.querySelector('.bot-composer')).toBeNull();
  const dock = document.querySelector('.bot-call-composer-host')!;
  expect(dock.contains(input())).toBe(true); expect(input().value).toBe('原私聊完整草稿。'); expect(dock.textContent).toContain(file.name);
  await click('发送 ↑', dock); const original = sends()[0]!;
  expect(original).toMatchObject({ conversationId: 'room', content: '原私聊完整草稿。', attachmentIds: [file.id] });
  expect(dock.querySelector('[role="alert"]')?.textContent).toContain('原消息暂未受理'); expect(input().value).toBe('原私聊完整草稿。'); expect(dock.textContent).toContain(file.name);
  fail = false; await click('发送 ↑', dock);
  expect(sends()).toHaveLength(2); expect(sends()[1]).toEqual(original); expect(call.bridge).toHaveBeenCalledTimes(2);
  expect(input().value).toBe(''); expect(dock.textContent).not.toContain(file.name);
  await type('会面后继续编辑。'); await click('挂断'); expect(host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.value).toBe('会面后继续编辑。'); expect(document.querySelectorAll('.bot-composer')).toHaveLength(1);
});

it('keeps stickers as media-only original sends and does not consume the shared draft or pending files', async () => {
  await mount(); await type('还没准备发送的文字'); await click('添加文件'); await connect();
  await click('表情'); await click('表情包'); await click(sticker.name);
  expect(sends()).toHaveLength(1); expect(sends()[0]).toMatchObject({ content: '', conversationId: 'room', attachmentIds: [sticker.id] });
  expect(call.bridge).toHaveBeenCalledExactlyOnceWith('', sends()[0]!.requestId, expect.any(Function));
  expect(input().value).toBe('还没准备发送的文字'); expect(document.querySelector('.bot-call-composer-host')?.textContent).toContain(file.name);
});

it('shows a late normal-send failure after collapsing input and restores the same unsent draft for editing', async () => {
  let finish!: (response: BotResponse) => void;
  const pending = new Promise<BotResponse>(resolve => { finish = resolve; });
  respond = input => input.type === 'message.send' ? pending : undefined;
  await mount(); await type('发送确认前仍应保留这份草稿。'); await connect();
  await click('发送 ↑', document.querySelector('.bot-call-composer-host')!); await click('收起会面输入');
  expect(document.querySelector('.bot-composer')).toBeNull();
  await act(async () => { finish({ ok: false, error: '原消息尚未受理，请重试。' }); });
  expect(document.querySelector('.bot-call-live-status [role="alert"]')?.textContent).toContain('原消息尚未受理');
  await click('继续编辑'); expect(input().value).toBe('发送确认前仍应保留这份草稿。'); expect(sends()).toHaveLength(1);
  expect(document.querySelector('.bot-call-live-status')).toBeNull(); expect(document.querySelectorAll('.bot-call-send-error')).toHaveLength(1);
});
