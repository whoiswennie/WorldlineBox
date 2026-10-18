import { describe, expect, it, vi } from 'vitest';
import { createBuiltinContentChrome, supportsBuiltinContentUrl } from '../../extension/builtin-content';
import { readBrowserCaptureContentResponse, type BrowserCaptureContentRequest } from '../../src/shared/browser-capture';

function fixture(url = 'https://example.test/gallery') {
  let receive: (event: unknown) => void = () => undefined;
  const request = vi.fn<(request: BrowserCaptureContentRequest) => Promise<unknown>>().mockResolvedValue({ kind: 'connected' });
  const unsubscribe = vi.fn();
  const content = createBuiltinContentChrome({ request, subscribe(listener) { receive = listener; return unsubscribe; } }, url);
  return { ...content, request, unsubscribe, event: (value: unknown) => receive(value) };
}

describe('built-in browser content Chrome shim', () => {
  it('provides only the runtime and storage APIs used by the unchanged content script', async () => {
    const { chrome, request } = fixture();
    expect(Object.keys(chrome).sort()).toEqual(['runtime', 'storage']);
    expect(Object.keys(chrome.runtime).sort()).toEqual(['onMessage', 'sendMessage']);
    const response = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'worldlinebox-connection-status' }, resolve));
    expect(response).toEqual({ kind: 'connected' });
    expect(request).toHaveBeenCalledWith({ type: 'runtime.message', message: { type: 'worldlinebox-connection-status' } });
  });

  it('preserves media, page source, and explicit root/folder save targets', async () => {
    const { chrome, request } = fixture();
    for (const targetFolderId of [null, 'folder-managed', 'linked:folder']) {
      const message = { type: 'worldlinebox-save-request', intent: {
        kind: 'video', sourcePageUrl: 'https://example.test/post', mediaUrl: 'https://cdn.example.test/original.mp4', targetFolderId,
      } };
      await new Promise(resolve => chrome.runtime.sendMessage(message, resolve));
      expect(request).toHaveBeenLastCalledWith({ type: 'runtime.message', message });
    }
    const local = { type: 'worldlinebox-local-save-request', kind: 'image', bodyBase64: 'aGVsbG8=', contentType: 'image/png', filename: 'local.png' };
    await new Promise(resolve => chrome.runtime.sendMessage(local, resolve));
    expect(request).toHaveBeenLastCalledWith({ type: 'runtime.message', message: local });
  });

  it('maps Chrome storage callbacks and all-key reads to the persisted allowed keys', async () => {
    const { chrome, request } = fixture();
    request.mockResolvedValue({ worldlineboxDragRadialMenuEnabled: false });
    expect(await new Promise(resolve => chrome.storage.sync.get('worldlineboxDragRadialMenuEnabled', resolve)))
      .toEqual({ worldlineboxDragRadialMenuEnabled: false });
    expect(request).toHaveBeenLastCalledWith({ type: 'storage.get', area: 'sync', keys: ['worldlineboxDragRadialMenuEnabled'] });
    await new Promise<void>(resolve => chrome.storage.sync.set({ worldlineboxDragRadialMenuEnabled: false }, resolve));
    expect(request).toHaveBeenLastCalledWith({ type: 'storage.set', area: 'sync', values: { worldlineboxDragRadialMenuEnabled: false } });
    await new Promise(resolve => chrome.storage.local.get('recentFolderIds', resolve));
    expect(request).toHaveBeenLastCalledWith({ type: 'storage.get', area: 'local', keys: ['recentFolderIds'] });
    await new Promise(resolve => chrome.storage.sync.get(null, resolve));
    expect(request.mock.lastCall?.[0]).toEqual({ type: 'storage.get', area: 'sync', keys: [
      'worldlineboxNotificationsEnabled', 'worldlineboxFocusAppAfterSave', 'worldlineboxRevealInLibraryAfterSave',
      'worldlineboxDragRadialMenuEnabled', 'recentFolderIds',
    ] });
  });

  it('never invokes privileged transport for unknown messages, fields, or storage keys', async () => {
    const { chrome, request } = fixture();
    const invalid = [
      { type: 'arbitrary-ipc', channel: 'execute' },
      { type: 'worldlinebox-connection-status', channel: 'execute' },
      { type: 'worldlinebox-save-request', intent: { kind: 'audio', mediaUrl: 'https://example.test/song', sourcePageUrl: 'https://example.test/' } },
    ];
    for (const message of invalid) {
      const result = await new Promise(resolve => chrome.runtime.sendMessage(message, value => resolve({ value, error: chrome.runtime.lastError?.message })));
      expect(result).toEqual({ value: undefined, error: 'Unsupported browser capture request.' });
      expect(chrome.runtime.lastError).toBeUndefined();
    }
    const result = await new Promise(resolve => chrome.storage.sync.get('arbitrarySecret', value => resolve({ value, error: chrome.runtime.lastError?.message })));
    expect(result).toEqual({ value: {}, error: 'Unsupported browser capture request.' });
    await new Promise<void>(resolve => chrome.storage.local.set({ arbitrarySecret: 'no' }, resolve));
    expect(request).not.toHaveBeenCalled();
  });

  it('sets runtime.lastError only during a failed Chrome callback and still settles storage reads', async () => {
    const { chrome, request } = fixture();
    request.mockRejectedValue(new Error('The selected library is closed.'));
    const result = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'worldlinebox-list-folders' }, value => {
      resolve({ value, error: chrome.runtime.lastError?.message });
    }));
    expect(result).toEqual({ value: undefined, error: 'The selected library is closed.' });
    expect(chrome.runtime.lastError).toBeUndefined();
    expect(await new Promise(resolve => chrome.storage.sync.get('worldlineboxDragRadialMenuEnabled', resolve))).toEqual({});
    expect(chrome.runtime.lastError).toBeUndefined();
  });

  it('turns structured host refusals into normal Chrome callback errors', async () => {
    const { chrome, request } = fixture();
    request.mockImplementation(async () => readBrowserCaptureContentResponse({ ok: false, code: 'document-gone', error: '页面已关闭或正在跳转。' }));
    const result = await new Promise(resolve => chrome.storage.sync.get('worldlineboxDragRadialMenuEnabled', value => {
      resolve({ value, error: chrome.runtime.lastError?.message });
    }));
    expect(result).toEqual({ value: {}, error: '页面已关闭或正在跳转。' });
    expect(chrome.runtime.lastError).toBeUndefined();
    expect(readBrowserCaptureContentResponse({ ok: true, value: { kind: 'connected' } })).toEqual({ kind: 'connected' });
    expect(() => readBrowserCaptureContentResponse({ ok: true, code: 'forbidden', error: 'bad' })).toThrow('无效响应');
  });

  it('does not invoke callbacks after a document unload while a host request is pending', async () => {
    const { chrome, request, dispose, unsubscribe } = fixture();
    let finish: ((value: unknown) => void) | undefined;
    request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const callback = vi.fn();
    chrome.storage.sync.get('worldlineboxDragRadialMenuEnabled', callback);
    await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    dispose();
    finish?.({ worldlineboxDragRadialMenuEnabled: true });
    await Promise.resolve(); await Promise.resolve();
    expect(callback).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('dispatches native save feedback and preference changes to the original listeners', () => {
    const { chrome, event } = fixture();
    const runtime = vi.fn(); const changed = vi.fn();
    chrome.runtime.onMessage.addListener(runtime); chrome.storage.onChanged.addListener(changed);
    const feedback = { type: 'worldlinebox-save-feedback', state: 'saved', title: '已保存到 WorldlineBox', message: 'example.png' };
    event({ type: 'runtime.message', message: feedback });
    expect(runtime).toHaveBeenCalledWith(feedback, {}, expect.any(Function));
    const local = { type: 'worldlinebox-local-context-save-request', mediaUrl: 'file:///C:/image.png', targetFolderId: null };
    event({ type: 'runtime.message', message: local });
    expect(runtime).toHaveBeenLastCalledWith(local, {}, expect.any(Function));
    event({ type: 'runtime.message', message: { type: 'arbitrary-ipc' } });
    expect(runtime).toHaveBeenCalledTimes(2);
    event({ type: 'storage.changed', area: 'sync', changes: {
      worldlineboxDragRadialMenuEnabled: { oldValue: true, newValue: false }, secret: { newValue: 'no' },
    } });
    expect(changed).toHaveBeenCalledWith({ worldlineboxDragRadialMenuEnabled: { oldValue: true, newValue: false } }, 'sync');
    event({ type: 'storage.changed', area: 'other', changes: { worldlineboxDragRadialMenuEnabled: { newValue: true } } });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it.each(['about:blank', 'about:srcdoc', 'chrome-error://chromewebdata/', 'file:///C:/Pictures/gallery.html', 'data:text/html,hi', 'javascript:void(0)', 'not a URL'])('does not grant capture transport to %s', async url => {
    const { chrome, request, event } = fixture(url); const listener = vi.fn();
    chrome.runtime.onMessage.addListener(listener);
    const response = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'worldlinebox-connection-status' }, value => resolve({ value, error: chrome.runtime.lastError?.message })));
    expect(response).toEqual({ value: undefined, error: 'Browser capture is unavailable for this document.' });
    event({ type: 'runtime.message', message: { type: 'worldlinebox-save-feedback', state: 'saving' } });
    expect(listener).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it('supports HTTP and HTTPS contexts and removes IPC subscriptions when disposed', () => {
    for (const url of ['http://example.test/', 'https://example.test/']) expect(supportsBuiltinContentUrl(url)).toBe(true);
    const { chrome, event, dispose, unsubscribe } = fixture(); const listener = vi.fn();
    chrome.runtime.onMessage.addListener(listener); dispose();
    event({ type: 'runtime.message', message: { type: 'worldlinebox-save-feedback', state: 'saving' } });
    expect(listener).not.toHaveBeenCalled(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
