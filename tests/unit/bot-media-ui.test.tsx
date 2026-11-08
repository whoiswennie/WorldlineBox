// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { botUiSharedLauncher } from '../fixtures/bot-ui-shared-launcher';
import { BotWorkspace } from '../../src/renderer/companion-bot/BotWorkspace';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotRequest, BotResponse, BotSnapshot } from '../../src/shared/companion-bot';
import type { BotMediaRef, BotMediaRequest, BotMediaResponse, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
const at = '2026-11-02T14:00:00Z';
const file: BotMediaRef = { id: 'owned-file', name: '任务说明.txt', mimeType: 'text/plain', size: 42, sha256: 'f'.repeat(64), url: 'worldlinebox://bot-media/private/file', kind: 'file' };
const sticker: BotMediaRef = { id: 'builtin-sticker', name: '辉夜 你真棒', mimeType: 'image/webp', size: 1024, sha256: 'e'.repeat(64), url: 'worldlinebox://bot-media/public/animated', kind: 'sticker', packId: 'kaguya', animated: true };
const base: BotSnapshot = { companions: [{ id: 'alice', name: 'Alice', persona: '认真', createdAt: at }, { id: 'bob', name: 'Bob', persona: '活泼', createdAt: at }],
  conversations: [{ id: 'a', title: '私聊甲', kind: 'direct', memberIds: ['user', 'alice'], createdAt: at }, { id: 'b', title: '私聊乙', kind: 'direct', memberIds: ['user', 'bob'], createdAt: at }],
  messages: [], tasks: [], hasMore: false, runtime: { engine: 'worldlinebox', memory: 'vcp-memory', embedding: 'bundled', activeLanes: 0, ready: true, dataRoot: 'fixture' } };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function mount(mediaHandler: (request: BotMediaRequest) => Promise<BotMediaResponse>, sendHandler: (request: BotRequest) => Promise<BotResponse> = async () => ({ ok: true }), snapshot = base, mediaOptions:Partial<WorldlineBoxBotMediaApi>={}) {
  const requests: BotRequest[] = [], mediaRequests: BotMediaRequest[] = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<LocaleProvider initialPreference="zh-CN"><BotWorkspace launcherApi={botUiSharedLauncher()} onOpenSettings={() => undefined}
    api={{ onEvent: () => () => undefined, request: async request => { requests.push(request); return request.type === 'state' ? { ok: true, snapshot: { ...snapshot, messages: snapshot.messages.filter(message => message.conversationId === request.conversationId) } } : sendHandler(request); } }}
    mediaApi={{ getDroppedFilePaths: () => [], request: async request => { mediaRequests.push(request); return mediaHandler(request); },...mediaOptions }} /></LocaleProvider>));
  return { requests, mediaRequests };
}
async function click(label: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)!; expect(button).toBeDefined(); await act(async () => { button.click(); await Promise.resolve(); }); }
async function select(title: string) { const button = [...host.querySelectorAll<HTMLButtonElement>('.bot-contact')].find(item => item.querySelector('strong')?.textContent === title)!; await act(async () => button.click()); }
async function input(value: string) { const field = host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!; await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('keeps a delayed file import in its originating chat and retries the same attachment send intent', async () => {
  const pending = deferred<BotMediaResponse>(); let sends = 0;
  const f = await mount(request => request.type === 'files.pick' ? pending.promise : Promise.resolve({ ok: true }), async request => request.type === 'message.send' && ++sends === 1 ? { ok: false, error: 'response lost' } : { ok: true });
  await click('添加文件'); await select('私聊乙');
  await act(() => pending.resolve({ ok: true, media: [file] }));
  expect(host.querySelector('.bot-draft-attachments')).toBeNull();
  await select('私聊甲'); expect(host.querySelector('.bot-draft-attachments')?.textContent).toContain(file.name);
  await click('发送 ↑'); await click('发送 ↑');
  const sent = f.requests.filter(request => request.type === 'message.send');
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
  expect(sent[0]).toMatchObject({ type: 'message.send', conversationId: 'a', content: '', attachmentIds: [file.id] });
  expect(host.querySelector('.bot-draft-attachments')).toBeNull();
});

it('sends a real sticker independently while preserving the current text and file draft', async () => {
  const f = await mount(async request => request.type === 'packs.list' ? { ok: true, packs: [{ id: 'kaguya', name: '辉夜', builtin: true, count: 1 }] }
    : request.type === 'stickers.list' ? { ok: true, media: [sticker] } : { ok: true, media: [file] });
  await input('还没写完的话'); await click('添加文件'); await click('表情'); await click('表情包'); await click(sticker.name);
  expect(f.requests.find(request => request.type === 'message.send')).toMatchObject({ conversationId: 'a', content: '', attachmentIds: [sticker.id] });
  expect(host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')?.value).toBe('还没写完的话');
  expect(host.querySelector('.bot-draft-attachments')?.textContent).toContain(file.name);
});

it('renders actual animated media without empty reply bubbles and saves files only within their chat', async () => {
  const snapshot: BotSnapshot = { ...base, messages: [
    { id: 'media', eventId: 'event', conversationId: 'a', senderId: 'alice', senderName: 'Alice', content: '', sequence: 1, status: 'sent', createdAt: at, attachments: [sticker, file] },
    { id: 'empty-final', eventId: 'event', conversationId: 'a', senderId: 'alice', senderName: 'Alice', content: '', sequence: 2, status: 'sent', createdAt: at },
  ] };
  const f = await mount(async () => ({ ok: true }), undefined, snapshot);
  expect(host.querySelectorAll('.bot-message')).toHaveLength(1); expect(host.querySelector('.bot-message-text')).toBeNull();
  expect(host.querySelector<HTMLImageElement>('.is-sticker img')?.getAttribute('src')).toBe(sticker.url);
  expect(host.querySelector('.bot-message-file-toggle')).toBeNull();
  await click('保存'); expect(f.mediaRequests).toContainEqual({ type: 'attachment.save', conversationId: 'a', id: file.id });
});

it('offers inline players without preloading, moves the current source into the viewer, and keeps files over 200MB external', async () => {
  const mib = 1024 * 1024;
  const refs: BotMediaRef[] = [
    { ...file, id: 'video-limit', name: '片段.mp4', mimeType: 'application/mp4', size: 200 * mib },
    { ...file, id: 'audio-limit', name: '声音.mp3', mimeType: 'audio/mpeg', size: 200 * mib },
    { ...file, id: 'large-video', name: '电影.mp4', mimeType: 'video/mp4', size: 200 * mib + 1, storage: 'external', analysisBlocked: true },
    { ...file, id: 'large-audio', name: '大音频.mp3', mimeType: 'audio/mpeg', size: 200 * mib + 1, storage: 'external', analysisBlocked: true },
    { ...file, id: 'large-image', name: '大图.png', mimeType: 'image/png', size: 200 * mib + 1, storage: 'external', analysisBlocked: true },
  ];
  const snapshot: BotSnapshot = { ...base, messages: refs.map((ref, index) => ({ id: ref.id, eventId: `e-${index}`, conversationId: 'a', senderId: 'alice', senderName: 'Alice', content: '', sequence: index + 1, status: 'sent', createdAt: at, attachments: [ref] })) };
  const f = await mount(async () => ({ ok: true }), undefined, snapshot);
  expect(document.querySelectorAll('video,audio')).toHaveLength(2);
  for(const player of document.querySelectorAll('video,audio'))expect(player.getAttribute('preload')).toBe('none');
  await click('打开预览 片段.mp4');
  expect(document.querySelectorAll('video')).toHaveLength(1); expect(document.querySelector('video')?.getAttribute('preload')).toBe('metadata');
  expect(document.querySelector('[data-bot-message="video-limit"] video')).toBeNull();
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click());
  await click('打开预览 声音.mp3'); expect(document.querySelectorAll('audio')).toHaveLength(1); expect(document.querySelector('audio')?.hasAttribute('controls')).toBe(true);
  await act(() => document.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click());
  for (const id of ['large-video', 'large-audio', 'large-image']) expect(host.querySelector(`[data-bot-message="${id}"]`)?.querySelector('img,video,audio')).toBeNull();
  const target = host.querySelector<HTMLButtonElement>('[data-bot-message="large-video"] .bot-file-open')!;
  await act(async () => target.click());
  expect(f.mediaRequests).toContainEqual({ type: 'attachment.open', conversationId: 'a', id: 'large-video' });
});

it('pastes Explorer files without File items, preserves ordinary text, and imports real dropped File paths in the original composer',async()=>{
  let nativeFiles=false;
  const f=await mount(async()=>({ok:true,media:[file]}),undefined,base,{hasClipboardFiles:()=>nativeFiles,getDroppedFilePaths:files=>files.length?['C:/selected.txt']:[]});
  const input=host.querySelector<HTMLTextAreaElement>('.bot-composer textarea')!;
  const paste=(text:string,types=['text/plain'])=>{
    const event=new Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{files:[],items:[],types,getData:(type:string)=>type==='text/plain'?text:''}});return event;
  };
  const plain=paste('普通文字');await act(()=>input.dispatchEvent(plain));
  expect(plain.defaultPrevented).toBe(false);expect(f.mediaRequests).toHaveLength(0);
  nativeFiles=true;const native=paste('C:\\selected.txt');await act(async()=>input.dispatchEvent(native));
  expect(native.defaultPrevented).toBe(true);expect(f.mediaRequests).toContainEqual({type:'files.paste',conversationId:'a'});
  nativeFiles=false;const screenshot=paste('',['image/png']);await act(async()=>input.dispatchEvent(screenshot));
  expect(screenshot.defaultPrevented).toBe(true);expect(f.mediaRequests.filter(request=>request.type==='files.paste')).toHaveLength(2);
  const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{files:[new File(['x'],'selected.txt')],types:['Files']}});
  await act(async()=>input.dispatchEvent(drop));expect(drop.defaultPrevented).toBe(true);
  expect(f.mediaRequests).toContainEqual({type:'files.import',conversationId:'a',paths:['C:/selected.txt']});
});
