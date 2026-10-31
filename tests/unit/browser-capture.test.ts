import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserCaptureTarget } from '../../src/shared/browser-capture';
import { BrowserCaptureHost, type BrowserCaptureHooks, type BrowserCaptureSource } from '../../src/main/browser/capture-host';
import { captureHttpUrl, captureReferer, MAX_BROWSER_CAPTURE_BYTES, readPickedCaptureImage, stageBrowserCapture } from '../../src/main/browser/capture-download';

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(path.join(tmpdir(), 'worldlinebox-capture-test-')); roots.push(value); return value; }
async function until(condition: () => boolean) { for (let index = 0; !condition(); index++) { if (index > 100) throw Error('capture did not finish'); await new Promise(resolve => setTimeout(resolve, 5)); } }

async function fixture(fetch: (url: string, init: RequestInit) => Promise<Response> = vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } })), chooseLocalImage: () => Promise<string | undefined> = async () => undefined) {
  const directory = await root();
  const libraries = [{ libraryId: 'a', displayName: '甲' }, { libraryId: 'b', displayName: '乙' }];
  const imported: Parameters<BrowserCaptureHooks['importStaged']>[0][] = [];
  const hooks: BrowserCaptureHooks = {
    async listTargets(libraryId = 'a') { return { libraries, activeLibraryId: 'a', defaultTarget: { libraryId, folderId: null },
      folders: [{ libraryId, folderId: libraryId + '-folder', name: '目录', relativePath: '目录', assetCount: 0 }], recentBrowsedFolderIds: [] }; },
    async importStaged(input) { expect(await readFile(input.stagedFilePath)).toEqual(png); imported.push(input); return { assetId: 'asset-' + input.target.libraryId }; },
    openAssets: vi.fn(),
  };
  const frame = { url: 'https://site.example/private-page', processId: 2, routingId: 7, isDestroyed: () => false, send: vi.fn() };
  const source = { tabId: 'tab', contents: { isDestroyed: () => false }, frame } as unknown as BrowserCaptureSource;
  const host = new BrowserCaptureHost(directory, hooks, { fetch, tempRoot: directory, changed: vi.fn(), chooseLocalImage, sources: () => [source], source: () => source });
  return { directory, fetch, host, hooks, source, imported };
}

describe('built-in browser capture trust and import lifecycle', () => {
  it('shares four concurrent frame discovery reads only while their identical target read is in flight', async () => {
    const { host, hooks, source } = await fixture();
    const original = hooks.listTargets.bind(hooks);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const list = vi.fn(async () => { await gate; return original(); }); hooks.listTargets = list;
    const calls = Array.from({ length: 4 }, (_, index) => host.content({ type: 'runtime.message', message: {
      type: index % 2 ? 'worldlinebox-list-folders' : 'worldlinebox-connection-status',
    } }, { ...source, frame: { ...source.frame, routingId: index + 1 } } as BrowserCaptureSource));
    await until(() => list.mock.calls.length === 1);
    release(); const results = await Promise.all(calls);
    expect(list).toHaveBeenCalledOnce();
    expect(results[0]).toEqual({ kind: 'connected' });
    expect(results[1]).toMatchObject({ kind: 'ok', folders: [{ folderId: 'a-folder' }] });
    await host.content({ type: 'runtime.message', message: { type: 'worldlinebox-connection-status' } }, source);
    expect(list).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });

  it('does not reuse the old discovery read after switching its target library', async () => {
    const { host, hooks, source } = await fixture(); await host.handle({ type: 'state' });
    const original = hooks.listTargets.bind(hooks); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    hooks.listTargets = vi.fn(async libraryId => { if (++calls === 1) { await gate; return original('a'); } return original(libraryId); });
    const old = host.content({ type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } }, source);
    await until(() => calls === 1);
    const selected = await host.handle({ type: 'target.set', target: { libraryId: 'b', folderId: 'b-folder' } });
    expect(selected.ok).toBe(true);
    const fresh = await host.content({ type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } }, source);
    expect(fresh).toMatchObject({ kind: 'ok', folders: [{ libraryId: 'b', folderId: 'b-folder' }] });
    release(); await old;
    expect(host.state().target?.libraryId).toBe('b'); expect(host.state().folders[0]?.libraryId).toBe('b');
    await host.shutdown();
  });

  it('freshly rejects a save after permission is revoked while a read-only discovery is in flight', async () => {
    const { host, hooks, source, imported, fetch } = await fixture();
    const original = hooks.listTargets.bind(hooks); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    hooks.listTargets = vi.fn(async libraryId => {
      if (++calls === 1) { const before = await original(libraryId); await gate; return before; }
      const current = await original(libraryId); return { ...current, libraries: current.libraries.map(library => ({ ...library, readOnly: true })) };
    });
    const reading = host.content({ type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } }, source);
    await until(() => calls === 1);
    const saved = await host.handle({ type: 'save', tabId: 'tab', kind: 'image', mediaUrl: 'https://cdn.example/a.png', target: { libraryId: 'a', folderId: null } });
    expect(saved).toMatchObject({ ok: false }); expect(imported).toEqual([]); expect(fetch).not.toHaveBeenCalled();
    release(); await reading; expect(host.state().libraries.every(library => library.readOnly)).toBe(true);
    await host.shutdown();
  });
  it('streams authenticated media to an owned stage and preserves referer and MIME filename', async () => {
    const directory = await root();
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(new Response(png, { headers: { 'content-type': 'application/octet-stream' } }));
    const staged = await stageBrowserCapture({ fetch, tempRoot: directory, mediaUrl: 'https://cdn.example/large.jpg', sourcePageUrl: 'https://site.example/page', kind: 'image', signal: new AbortController().signal });
    expect(staged.filename).toBe('large.png'); expect(staged.contentType).toBe('image/png'); expect(staged.byteLength).toBe(png.length);
    expect(await readFile(staged.stagedFilePath)).toEqual(png);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', referrer: 'https://site.example/page', headers: { Referer: 'https://site.example/page' } });
    expect(captureReferer('https://wx1.sinaimg.cn/a.jpg', 'https://other.example/')).toBe('https://weibo.com/');
    expect(captureReferer('https://sinaimg.cn.attacker.example/a.jpg', 'https://other.example/')).toBe('https://other.example/');
  });

  it('rejects oversized responses and non-http or credential-bearing URLs before import', async () => {
    const directory = await root();
    const fetch = vi.fn(async () => new Response(png, { headers: { 'content-length': String(MAX_BROWSER_CAPTURE_BYTES + 1) } }));
    await expect(stageBrowserCapture({ fetch, tempRoot: directory, mediaUrl: 'https://cdn.example/a.png', sourcePageUrl: 'https://site.example/', kind: 'image', signal: new AbortController().signal })).rejects.toThrow('500 MiB');
    expect(await readdir(directory)).toEqual([]);
    for (const url of ['file:///C:/secret.png', 'javascript:alert(1)', 'https://name:password@example.com/a.png', 'blob:https://example.com/id']) expect(() => captureHttpUrl(url)).toThrow();
  });

  it('snapshots the tree target across a different library selection and ignores a page-claimed source URL', async () => {
    const { host, source, imported } = await fixture();
    await host.content({ type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } }, source);
    await host.handle({ type: 'target.set', target: { libraryId: 'b', folderId: 'b-folder' } });
    await host.content({ type: 'runtime.message', message: { type: 'worldlinebox-save-request', intent: {
      kind: 'image', sourcePageUrl: 'https://attacker.example/forged', mediaUrl: 'https://cdn.example/a.png', targetFolderId: 'a-folder' } } }, source);
    expect(imported).toHaveLength(1); expect(imported[0]?.target).toEqual({ libraryId: 'a', folderId: 'a-folder' });
    expect(imported[0]?.sourcePageUrl).toBe('https://site.example/private-page');
    expect(host.state().target).toEqual({ libraryId: 'b', folderId: 'b-folder' }); expect(host.state().folders[0]?.libraryId).toBe('b');
    await host.shutdown();
  });

  it('rejects a folder from another library instead of silently saving at the root', async () => {
    const { host, imported } = await fixture();
    const result = await host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/a.png', target: { libraryId: 'a', folderId: 'b-folder' } });
    expect(result.ok).toBe(false); expect(imported).toEqual([]); await host.shutdown();
  });

  it('aborts a download when its library closes and cleans the stage without a worker import', async () => {
    let downloaded = false;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(png); downloaded = true;
        init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true }); } });
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    });
    const { host, imported, directory } = await fixture(fetch);
    const result = await host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/a.png' });
    expect(result.ok).toBe(true); await until(() => downloaded); host.closeLibrary('a');
    expect(host.state().target).toBeNull(); expect(host.state().libraries.some(library => library.libraryId === 'a')).toBe(false);
    await until(() => host.state().jobs[0]?.status === 'cancelled'); await host.shutdown();
    expect(imported).toEqual([]); expect((await readdir(directory)).filter(name => name.startsWith('worldlinebox-browser-capture-'))).toEqual([]);
  });

  it('drains a commit already accepted by the worker and does not report it cancelled', async () => {
    const { host, hooks } = await fixture(); let release!: () => void; let committing = false;
    hooks.importStaged = async () => { committing = true; await new Promise<void>(resolve => { release = resolve; }); return { assetId: 'asset' }; };
    const result = await host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/a.png' });
    expect(result.ok).toBe(true); await until(() => committing);
    const job = host.state().jobs[0]!; await host.handle({ type: 'cancel', id: job.id });
    const stopping = host.shutdown(); release(); await stopping;
    expect(host.state().jobs[0]?.status).toBe('saved'); expect(host.state().jobs[0]?.assetId).toBe('asset');
  });

  it('preserves the selected native file through the same content validation without storing its local URL', async () => {
    const directory = await root(); const filename = path.join(directory, 'native.png'); await writeFile(filename, png);
    expect(await readPickedCaptureImage(filename)).toEqual({ filename: 'native.png', contentType: 'image/png', bodyBase64: png.toString('base64') });
    const { host, source, imported } = await fixture();
    const response = await host.content({ type: 'runtime.message', message: { type: 'worldlinebox-local-save-request', kind: 'image', filename: 'native.png', contentType: 'image/png', bodyBase64: png.toString('base64') } }, source);
    expect(response).toMatchObject({ notification: { title: '已保存到 WorldlineBox' } }); expect(imported[0]?.mediaUrl).toBeUndefined(); await host.shutdown();
  });

  it('only exposes its own preferences and broadcasts the original extension storage keys', async () => {
    const { host, source } = await fixture();
    await host.handle({ type: 'preferences.save', preferences: { notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: false } });
    expect(await host.content({ type: 'storage.get', area: 'sync', keys: ['worldlineboxDragRadialMenuEnabled'] }, source)).toEqual({ worldlineboxDragRadialMenuEnabled: false });
    expect(source.frame.send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'storage.changed', changes: expect.objectContaining({ worldlineboxDragRadialMenuEnabled: { oldValue: true, newValue: false } }) }));
    const badTarget: BrowserCaptureTarget = { libraryId: 'missing', folderId: null };
    expect((await host.handle({ type: 'target.set', target: badTarget })).ok).toBe(false); await host.shutdown();
  });

  it('snapshots the native-picker target and never records the local path as a source URL', async () => {
    const directory = await root(); const filename = path.join(directory, 'private-name.png'); await writeFile(filename, png);
    let picked!: (filename: string) => void; let selecting = false;
    const { host, imported } = await fixture(undefined, () => { selecting = true; return new Promise(resolve => { picked = resolve; }); });
    const opening = host.handle({ type: 'local.open' }); await until(() => selecting);
    await host.handle({ type: 'target.set', target: { libraryId: 'b', folderId: null } }); picked(filename);
    const result = await opening; expect(result.ok).toBe(true); await until(() => host.state().jobs[0]?.status === 'saved');
    expect(imported[0]?.target.libraryId).toBe('a'); expect(imported[0]?.sourcePageUrl).toBeUndefined(); expect(imported[0]?.mediaUrl).toBeUndefined();
    expect(host.state().target?.libraryId).toBe('b'); await host.shutdown();
  });

  it('fences a library close that races before a new job has entered the download map', async () => {
    const { host, hooks, fetch, imported } = await fixture(); const listTargets = hooks.listTargets;
    let checks = 0; let checking = false; let release!: () => void;
    hooks.listTargets = async libraryId => { if (++checks === 2) { checking = true; await new Promise<void>(resolve => { release = resolve; }); } return listTargets(libraryId); };
    const saving = host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/a.png' });
    await until(() => checking); host.closeLibrary('a'); release();
    expect((await saving).ok).toBe(false); expect(fetch).not.toHaveBeenCalled(); expect(imported).toEqual([]); await host.shutdown();
  });

  it('enforces four concurrent downloads even when target checks resolve together', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(png); init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
    } }), { headers: { 'content-type': 'image/png' } }));
    const { host } = await fixture(fetch); await host.handle({ type: 'state' });
    const responses = await Promise.all(Array.from({ length: 5 }, () => host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/a.png' })));
    expect(responses.filter(response => response.ok)).toHaveLength(4); expect(fetch).toHaveBeenCalledTimes(4); await host.shutdown();
    expect(host.state().jobs.every(job => job.status === 'cancelled')).toBe(true);
  });
});
