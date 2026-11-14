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
async function mount(imported: BotMediaRef[] = [file]) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const api = { async request(input: BotRequest): Promise<BotResponse> {
    requests.push(input); const custom = respond(input); if (custom) return custom;
    if (input.type === 'call.open') return { ok: true, conversationId: 'meeting', snapshot: { ...snapshot, messages: [] } };
    if (input.type === 'state') return { ok: true, snapshot };
    return { ok: true, replyMessageIds: ['original-reply'] };
  }, onEvent: () => () => undefined };
  const mediaApi = { getDroppedFilePaths: (files: File[]) => files.map(item => item.name), async request(input: { type: string }) {
    if (input.type === 'files.pick' || input.type === 'files.import') return { ok: true, media: imported };
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

it('keeps private-chat drafts separate and retries a failed meeting attachment send with the same intent', async () => {
  let fail = true; respond = input => input.type === 'message.send' && fail ? { ok: false, error: '会面暂未受理' } : undefined;
  await mount(); await type('普通私聊草稿'); await connect();
  expect(host.querySelector('.bot-composer')).toBeNull();
  await click('展开会面输入'); expect(input().value).toBe('');
  await type('会面消息'); await click('添加文件');
  await click('发送 ↑'); const original = sends()[0]!;
  expect(original).toMatchObject({ conversationId: 'meeting', content: '会面消息', attachmentIds: [file.id] });
  expect(document.querySelector('.bot-call-send-error')?.textContent).toBe('会面暂未受理');
  expect(input().value).toBe('会面消息');
  fail = false; await click('发送 ↑');
  expect(sends()).toHaveLength(2); expect(sends()[1]).toEqual(original);
  expect(input().value).toBe('');
  await type('下次会面草稿'); await click('挂断');
  expect(input().value).toBe('普通私聊草稿');
  await connect(); expect(input().value).toBe('下次会面草稿');
});

it('sends the local voice transcript to the meeting and leaves typed text and attachments intact', async () => {
  await mount(); await connect(); await click('展开会面输入');
  await type('稍后再发的草稿'); await click('添加文件');
  await act(async () => { await call.send!('语音识别内容', 'voice-receipt'); });
  expect(sends()[0]).toMatchObject({ type: 'message.send', conversationId: 'meeting', content: '语音识别内容', requestId: 'voice-receipt' });
  expect(sends()[0]?.attachmentIds).toBeUndefined(); expect(input().value).toBe('稍后再发的草稿');
  expect(document.querySelector('.bot-call-composer-host')?.textContent).toContain(file.name);
});

it('shows a bounded attachment list, previews images and removes individual files in ordinary chat and meetings', async () => {
  const image: BotMediaRef = { ...sticker, kind: 'file', name: '参考图.webp', previewUrl: 'data:image/webp;base64,AA==' };
  const imports = [image, file, { ...file, id: 'last', name: '最后的会议资料.txt' }];
  await mount(imports);
  for (const meeting of [false, true]) {
    if (meeting) { await connect(); await click('展开会面输入'); }
    await click('添加文件');
    const draft = document.querySelector<HTMLElement>('.bot-draft-attachments')!;
    expect(draft.querySelectorAll('li')).toHaveLength(2);
    await click('查看全部 3 个附件', draft);
    expect(draft.querySelectorAll('li')).toHaveLength(3);
    expect(draft.querySelector('ul')?.className).toBe('is-expanded');
    await click('预览 参考图.webp', draft);
    expect(document.querySelector('.bot-attachment-viewer[aria-label="参考图.webp"]')).not.toBeNull();
    await click('关闭预览');
    await click('移除 最后的会议资料.txt', draft);
    expect(draft.querySelectorAll('li')).toHaveLength(2);
    expect(draft.textContent).not.toContain('最后的会议资料.txt');
  }
});
