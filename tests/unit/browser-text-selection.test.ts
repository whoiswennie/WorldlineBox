import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BrowserCaptureHost, type BrowserCaptureHooks, type BrowserCaptureSource } from '../../src/main/browser/capture-host';
import { BrowserService } from '../../src/main/browser/service';
import { BrowserTextDrafts, BROWSER_TEXT_DRAFT_LIMIT, BROWSER_TEXT_DRAFT_TTL, browserTextTitle, readBrowserTextSelection } from '../../src/main/browser/text-selection';
import { BROWSER_CAPTURE_TEXT_MAX_BYTES, browserCaptureContentRequestSchema, browserCaptureRequestSchema } from '../../src/shared/browser-capture';
import { newBrowserTab } from '../../src/main/browser/store';

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
vi.mock('../../src/main/application-network', () => ({ getApplicationNetwork: vi.fn() }));
const roots: string[] = []; const finalizers: Array<() => Promise<void>> = []; const windows: Array<{ window: Window }> = [];
afterEach(async () => {
  for (const finish of finalizers.splice(0)) await finish();
  for (const window of windows.splice(0)) window.window.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
type FakeFrame = { url: string; processId: number; routingId: number; isDestroyed(): boolean; send: Mock;
  executeJavaScript: Mock<(script: string) => Promise<unknown>>; framesInSubtree: FakeFrame[] };
function fakeFrame(url: string, text = '实际选中的段落\n第二行'): FakeFrame {
  return { url, processId: 1, routingId: Math.random(), isDestroyed: vi.fn(() => false), send: vi.fn(),
    executeJavaScript: vi.fn<(script: string) => Promise<unknown>>(async () => ({ text })), framesInSubtree: [] };
}
function fakeSource() {
  const frame = fakeFrame('https://page.example/article'); frame.framesInSubtree = [frame];
  const contents = { isDestroyed: vi.fn(() => false), getURL: () => 'https://page.example/article', getTitle: () => '网页标题不是摘录正文',
    mainFrame: frame, focusedFrame: frame as ReturnType<typeof fakeFrame> | null };
  return { frame, contents, source: { tabId: 'tab', contents, frame } as unknown as BrowserCaptureSource };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-text-selection-unit-')); roots.push(root);
  const { source, frame, contents } = fakeSource(); const child = fakeFrame('https://other.example/embedded', '跨域框架真实选区');
  frame.framesInSubtree.push(child);
  const target = { libraryId: 'library', folderId: null };
  const imported: Array<{ filename: string; bytes: string; sourcePageUrl?: string }> = [];
  const hooks: BrowserCaptureHooks = { listTargets: vi.fn(async () => ({ libraries: [{ libraryId: 'library', displayName: 'Library' }],
    activeLibraryId: 'library', defaultTarget: target, folders: [], recentBrowsedFolderIds: [] })), openAssets: vi.fn(),
    importStaged: vi.fn(async input => { imported.push({ filename: input.filename, bytes: await readFile(input.stagedFilePath, 'utf8'), sourcePageUrl: input.sourcePageUrl }); return { assetId: 'asset' }; }) };
  const host = new BrowserCaptureHost(root, hooks, { tempRoot: root, fetch: vi.fn(), changed: vi.fn(), chooseLocalImage: async () => undefined,
    source: () => source, sources: () => [source, { ...source, frame: child as unknown as Electron.WebFrameMain }] });
  const service = new BrowserService(() => undefined, root);
  Reflect.set(service, 'initialization', Promise.resolve()); Reflect.set(service, 'capture', host);
  const first = { ...newBrowserTab(contents.getURL()), id: 'tab' }; const second = { ...newBrowserTab('https://second.example/'), id: 'second' };
  service.store.data.tabs = [first, second]; service.store.data.activeTabId = first.id;
  const views = Reflect.get(service, 'views') as Map<string, unknown>;
  views.set(first.id, { view: { webContents: contents }, used: 0 }); views.set(second.id, { view: { webContents: { ...contents, focusedFrame: frame } }, used: 0 });
  finalizers.push(async () => { await service.shutdown(); await service.store.flush(); });
  return { root, service, host, hooks, source, contents, frame, child, imported, target };
}
async function saved(host: BrowserCaptureHost, result: Awaited<ReturnType<BrowserService['captureRequest']>>) {
  if (!result.ok || !result.jobId) throw Error(result.ok ? 'No text capture job' : result.error);
  return host.waitForJob(result.jobId);
}

describe('real DOM selection reading', () => {
  function domSource(markup = '<p id="passage"> 选中的内容 🎵\n下一行 </p><input id="input"><textarea id="area"></textarea><input id="password" type="password">') {
    const dom = { window: new Window({ url: 'https://page.example/article', settings: { enableJavaScriptEvaluation: true } }) };
    dom.window.document.body.innerHTML = markup; windows.push(dom);
    const { source, frame } = fakeSource(); frame.executeJavaScript.mockImplementation(async script => dom.window.eval(script) as unknown);
    return { dom, source, document: dom.window.document };
  }
  it('preserves the actual selected DOM range rather than the page title or full body', async () => {
    const { dom, source, document } = domSource(); const range = document.createRange(); range.selectNodeContents(document.querySelector('#passage')!);
    dom.window.getSelection()!.addRange(range);
    expect(await readBrowserTextSelection(source)).toBe(' 选中的内容 🎵\n下一行 ');
    dom.window.getSelection()!.removeAllRanges(); await expect(readBrowserTextSelection(source)).rejects.toThrow('选中');
  });
  it.each(['input', 'area'])('reads only the %s selection even after the document loses outer focus', async id => {
    const { dom, source, document } = domSource(); const input = document.getElementById(id) as unknown as HTMLInputElement | HTMLTextAreaElement;
    input.value = '前缀 selected line 后缀'; input.focus(); input.setSelectionRange(3, 16);
    Object.defineProperty(document, 'hasFocus', { value: () => false });
    expect(await readBrowserTextSelection(source)).toBe('selected line');
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#passage')!); dom.window.getSelection()!.addRange(range);
    input.setSelectionRange(0, 0); await expect(readBrowserTextSelection(source)).rejects.toThrow('选中');
  });
  it('rejects passwords even when a previous DOM selection still exists', async () => {
    const { dom, source, document } = domSource(); const range = document.createRange(); range.selectNodeContents(document.querySelector('#passage')!); dom.window.getSelection()!.addRange(range);
    const password = document.querySelector('#password') as unknown as HTMLInputElement;
    password.value = 'secret'; password.focus(); password.setSelectionRange(0, 6);
    await expect(readBrowserTextSelection(source)).rejects.toThrow('密码');
  });
  it('rejects oversized Unicode content rather than truncating the selected data', async () => {
    const { source, frame } = fakeSource(); frame.executeJavaScript.mockResolvedValue({ text: '🎵'.repeat(BROWSER_CAPTURE_TEXT_MAX_BYTES / 4 + 1) });
    await expect(readBrowserTextSelection(source)).rejects.toThrow('4 MiB');
  });
});

describe('selected text drafts and actual imports', () => {
  it('prepares an excerpt title, confirms edits as exact UTF-8 text and keeps the page URL only in asset metadata', async () => {
    const { service, host, imported, root } = await fixture();
    const prepared = await service.captureRequest({ type: 'text.prepare' });
    expect(prepared.ok && prepared.textDraft).toMatchObject({ text: '实际选中的段落\n第二行', title: '实际选中的段落', pageTitle: '网页标题不是摘录正文', sourcePageUrl: 'https://page.example/article' });
    if (!prepared.ok || !prepared.textDraft) throw Error('Missing real text draft');
    const body = '  用户确认的文字 🎵\n包括末尾空白  ';
    await saved(host, await service.captureRequest({ type: 'text.save', draftId: prepared.textDraft.id, text: body, title: '我的 / 摘录' }));
    expect(imported).toEqual([{ filename: '我的 _ 摘录.txt', bytes: body, sourcePageUrl: 'https://page.example/article' }]);
    expect((await service.captureRequest({ type: 'text.save', draftId: prepared.textDraft.id })).ok).toBe(false);
    await host.handle({ type: 'state' });
    const persisted = await readFile(path.join(root, 'capture.json'), 'utf8').catch(() => '');
    expect(persisted).not.toContain(body); expect(persisted).not.toContain('第二行');
  });
  it('keeps the old direct-save contract but derives names from the selection and saves literal code as plain text', async () => {
    const { service, host, frame, imported } = await fixture();
    const text = '<html><script>literal code only</script></html>\n'; frame.executeJavaScript.mockResolvedValue({ text });
    await saved(host, await service.captureRequest({ type: 'text.save' }));
    expect(imported[0]?.bytes).toBe(text); expect(imported[0]?.filename).not.toContain('网页标题'); expect(imported[0]?.filename).toMatch(/\.txt$/u);
    expect(browserTextTitle('\n\n 开始的一行 🎵\nnot in title')).toBe('开始的一行 🎵'); expect([...browserTextTitle('🎵'.repeat(90))]).toHaveLength(80);
    expect(browserTextTitle('A trailing period.')).toBe('A trailing period'); expect(browserTextTitle('CON')).toBe('capture-CON');
  });
  it('uses the actual focused cross-origin frame, and remembers that frame across toolbar focus without caching its text', async () => {
    const { service, frame, child, contents } = await fixture(); contents.focusedFrame = child;
    const focused = await service.captureRequest({ type: 'text.prepare' }); expect(focused.ok && focused.textDraft?.sourcePageUrl).toBe(child.url);
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
    const event = { sender: contents, senderFrame: child } as unknown as Electron.IpcMainEvent;
    service.captureSelectionState(event, { documentId: 'child-document', focused: true, hasSelection: true }); contents.focusedFrame = null;
    child.executeJavaScript.mockResolvedValue({ text: '点击侧栏前的同一选区' });
    const blurred = await service.captureRequest({ type: 'text.prepare' }); expect(blurred.ok && blurred.textDraft?.text).toBe('点击侧栏前的同一选区');
    child.executeJavaScript.mockResolvedValue({ text: '' });
    const cleared = await service.captureRequest({ type: 'text.prepare' }); expect(cleared.ok).toBe(false); expect(!cleared.ok && cleared.error).toContain('选中');
    expect(frame.executeJavaScript).not.toHaveBeenCalled();
  });
  it('ignores foreign frame hints and prioritizes the native focused frame over an old remembered one', async () => {
    const { service, source, contents, child } = await fixture();
    service.captureSelectionState({ sender: { isDestroyed: () => false }, senderFrame: child } as unknown as Electron.IpcMainEvent, { documentId: 'foreign', focused: true, hasSelection: true });
    service.captureSelectionState({ sender: contents, senderFrame: child } as unknown as Electron.IpcMainEvent, { documentId: 'owned', focused: true, hasSelection: true });
    contents.focusedFrame = source.frame as unknown as ReturnType<typeof fakeFrame>;
    const result = await service.captureRequest({ type: 'text.prepare' }); expect(result.ok && result.textDraft?.text).toContain('实际选中的段落');
  });
  it('invalidates drafts on a real tab-select request, navigation, detached frames, and confirmation after async source changes', async () => {
    const { service, contents, host, frame, imported, hooks } = await fixture();
    const prepare = async () => { const response = await service.captureRequest({ type: 'text.prepare' }); if (!response.ok || !response.textDraft) throw Error('Missing draft'); return response.textDraft; };
    const first = await prepare(); await service.handle({ type: 'tab.select', id: 'second' }); await service.handle({ type: 'tab.select', id: 'tab' });
    expect((await service.captureRequest({ type: 'text.save', draftId: first.id })).ok).toBe(false);
    const navigated = await prepare(); frame.url = 'https://page.example/next';
    expect((await service.captureRequest({ type: 'text.save', draftId: navigated.id })).ok).toBe(false); frame.url = contents.getURL();
    const detached = await prepare(); frame.framesInSubtree = [];
    expect((await service.captureRequest({ type: 'text.save', draftId: detached.id })).ok).toBe(false); frame.framesInSubtree = [frame];
    const racing = await prepare(); const original = hooks.listTargets;
    hooks.listTargets = async input => { const targets = await original(input); service.store.data.activeTabId = 'second'; return targets; };
    const cancelled = await service.captureRequest({ type: 'text.save', draftId: racing.id });
    if (cancelled.ok && cancelled.jobId) await expect(host.waitForJob(cancelled.jobId)).rejects.toThrow('切换'); else expect(cancelled.ok).toBe(false);
    expect(imported).toEqual([]);
  });
  it('does not revive an in-flight selection read or context-menu source after switching A to B and back to A', async () => {
    const { service, frame, source } = await fixture(); let release: ((value: unknown) => void) | undefined;
    frame.executeJavaScript.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const bind = Reflect.get(service, 'bindTextSource') as (source: BrowserCaptureSource, version: number) => BrowserCaptureSource;
    const bound = bind.call(service, source, 0); const preparing = service.captureRequest({ type: 'text.prepare' });
    await vi.waitFor(() => expect(release).toBeDefined());
    await service.handle({ type: 'tab.select', id: 'second' }); await service.handle({ type: 'tab.select', id: 'tab' });
    expect(bound.isCurrent?.()).toBe(false); release!({ text: 'old selection read' });
    const result = await preparing; expect(result.ok).toBe(false); expect(!result.ok && result.error).toContain('切换');
  });
  it('keeps draft memory bounded and automatically expires drafts, including a same-URL document version change', () => {
    const { source } = fakeSource(); let now = Date.now(); const drafts = new BrowserTextDrafts(() => now);
    try {
      const first = drafts.create(source, 'first', 'Page title', 1);
      for (let i = 0; i < BROWSER_TEXT_DRAFT_LIMIT; i++) drafts.create(source, String(i), 'Page title', 1);
      expect(() => drafts.get(first.id, 'tab', 1)).toThrow('过期');
      const reloaded = drafts.create(source, 'reload', 'Page title', 1); expect(() => drafts.get(reloaded.id, 'tab', 2)).toThrow('跳转');
      const expired = drafts.create(source, 'expire', 'Page title', 2); now += BROWSER_TEXT_DRAFT_TTL;
      expect(() => drafts.get(expired.id, 'tab', 2)).toThrow('过期');
    } finally { drafts.clear(); }
  });
  it('keeps text editing and source metadata outside the untrusted web channel', async () => {
    for (const input of [{ type: 'text.prepare' }, { type: 'text.save', draftId: 'real', text: 'edited', title: 'Name' }]) {
      expect(browserCaptureRequestSchema.safeParse(input).success).toBe(true);
      expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: input }).success).toBe(false);
    }
    expect(browserCaptureRequestSchema.safeParse({ type: 'text.save', text: 'forged' }).success).toBe(false);
    expect(browserCaptureRequestSchema.safeParse({ type: 'text.save', draftId: 'id', sourcePageUrl: 'https://forged.example' }).success).toBe(false);
    const { service, root } = await fixture();
    expect((await service.captureRequest({ type: 'text.save', draftId: 'unknown' })).ok).toBe(false);
    expect((await readdir(root)).some(file => file.includes('draft'))).toBe(false);
  });
});
