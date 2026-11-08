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
    runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: 'bundled', activeLanes: 1, ready: true, dataRoot: 'isolated-test' } };
  vi.stubGlobal('Audio', class { loop = false; volume = 0; muted = false; play = async () => undefined; pause() {} removeAttribute() {} load() {} });
});
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const api = { async request(input: BotRequest): Promise<BotResponse> {
    requests.push(input); const custom = respond(input); if (custom) return custom;
    if (input.type === 'state') return { ok: true, snapshot };
    if (input.type === 'task.list') return { ok: true, taskPage: { items: snapshot.tasks, total: snapshot.tasks.length, activeCount: snapshot.tasks.length, queuedCount: 0, page: 0, limit: 6 } };
    if (input.type === 'task.get') return { ok: true, task: snapshot.tasks[0] };
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

it.each(['attachments', 'followup'] as const)('finalizes a frozen %s action when voice retries it after the original composer send has returned', async kind => {
  if (kind === 'followup') snapshot.tasks = [{ id: 'frozen-task', conversationId: 'room', companionId: 'alice', goal: '继续整理', title: '继续整理', status: 'running' }];
  let finish!: (response: BotResponse) => void, attempts = 0;
  const pending = new Promise<BotResponse>(resolve => { finish = resolve; });
  respond = input => input.type === 'message.send' ? ++attempts === 1 ? { ok: false, error: '第一次尚未送达' } : pending : undefined;
  let frozen!: () => Promise<{ ok: boolean }>;
  call.bridge.mockImplementationOnce(async (_text, _id, perform) => { frozen = perform; return (await perform()).ok; });
  await mount(); await type('这份完整原生发送动作需要重试。');
  if (kind === 'attachments') await click('添加文件');
  else { await click('任务', document.querySelector('.bot-composer')!); await click('跟进这个任务'); }
  await connect(); await click('发送 ↑', document.querySelector('.bot-call-composer-host')!);
  expect(sends()).toHaveLength(1); expect(input().value).toBe('这份完整原生发送动作需要重试。');
  expect(document.querySelector('.bot-call-send-error')?.textContent).toContain('第一次尚未送达');
  let retry!: Promise<{ ok: boolean }>, duplicate!: Promise<{ ok: boolean }>;
  await act(() => { retry = frozen(); duplicate = frozen(); });
  expect(duplicate).toBe(retry); expect(sends()).toHaveLength(2); expect(document.querySelector<HTMLButtonElement>('.bot-send')?.disabled).toBe(true);
  expect(document.querySelector('.bot-call-send-error')).toBeNull();
  snapshot.messages = [{ id: 'after-retry', eventId: 'r', sequence: 1, conversationId: 'room', senderId: 'alice', senderName: 'Alice', status: 'sent', content: '重试后已刷新原聊天。', createdAt: at }];
  await act(async () => { finish({ ok: true, replyMessageIds: ['after-retry'] }); await retry; });
  expect(sends()).toHaveLength(2); expect(sends()[1]).toEqual(sends()[0]); expect(call.bridge).toHaveBeenCalledOnce();
  expect(input().value).toBe(''); expect(document.querySelector('.bot-task-followup')).toBeNull(); expect(document.querySelector('.bot-draft-attachments')).toBeNull();
  expect(document.querySelector('.bot-call-dialogue')?.textContent).toContain('重试后已刷新原聊天');
  expect(sends()[0]).toMatchObject(kind === 'attachments' ? { attachmentIds: [file.id] } : { replyToTaskId: 'frozen-task' });
});

it('uses the same task follow-up send kernel for recognized speech while leaving unsubmitted draft files local', async () => {
  await mount(); await type('保留正在编辑的文字'); await click('添加文件'); await connect();
  await act(async () => { expect((await call.send!('只发送本句识别文字。', 'recognized-intent') as { ok: boolean }).ok).toBe(true); });
  expect(sends()[0]).toMatchObject({ content: '只发送本句识别文字。', requestId: 'recognized-intent' }); expect(sends()[0]!.attachmentIds).toBeUndefined(); expect(call.bridge).not.toHaveBeenCalled();
  expect(input().value).toBe('保留正在编辑的文字'); expect(document.querySelector('.bot-call-composer-host')?.textContent).toContain(file.name);
  await click('移除 ' + file.name);
  snapshot.tasks = [{ id: 'original-task', conversationId: 'room', companionId: 'alice', goal: '整理资料', title: '整理资料', status: 'running' }];
  await click('任务', document.querySelector('.bot-call-composer-host')!);
  expect(document.querySelector('.bot-call-window')).toBeNull(); expect(document.querySelector('[aria-label="任务工作台"]')).not.toBeNull();
  await click('跟进这个任务'); await connect(); expect(document.querySelector('.bot-task-followup')?.textContent).toContain('整理资料');
  await click('发送 ↑', document.querySelector('.bot-call-composer-host')!);
  expect(sends().at(-1)).toMatchObject({ content: '保留正在编辑的文字', replyToTaskId: 'original-task' });
});
