import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserCaptureHost, type BrowserCaptureHooks, type BrowserCaptureSource } from '../../src/main/browser/capture-host';
import { stageBrowserCapture, stagePickedCaptureFile } from '../../src/main/browser/capture-download';
import { browserCaptureContentRequestSchema, browserCaptureRequestSchema, DEFAULT_BROWSER_CAPTURE_PREFERENCES, type BrowserCaptureJob } from '../../src/shared/browser-capture';

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }));
const roots: string[] = [];
afterEach(async () => { for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary() { const directory = await mkdtemp(path.join(tmpdir(), 'worldlinebox-expanded-capture-')); roots.push(directory); return directory; }
async function until(condition: () => boolean) { for (let count = 0; !condition(); count++) { if (count > 100) throw Error('Capture timed out'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const target = { libraryId: 'library', folderId: null };
const source = { tabId: 'tab', contents: { isDestroyed: () => false }, frame: { url: 'https://page.example/article?source=actual',
  processId: 1, routingId: 2, isDestroyed: () => false, send: vi.fn() } } as unknown as BrowserCaptureSource;
async function fixture(directoryInput?: string, fetch: (url: string, init: RequestInit) => Promise<Response> = vi.fn(async () => new Response(png, { headers: { 'content-type': 'image/png' } }))) {
  const directory = directoryInput ?? await temporary();
  const imported: Array<Parameters<BrowserCaptureHooks['importStaged']>[0] & { bytes: Buffer }> = [];
  const folders = [{ ...target, folderId: 'parent', name: 'Parent', relativePath: 'Parent', assetCount: 0 }];
  const hooks: BrowserCaptureHooks = {
    listTargets: vi.fn(async () => ({ libraries: [{ libraryId: target.libraryId, displayName: 'Library' }], activeLibraryId: target.libraryId, defaultTarget: target, folders, recentBrowsedFolderIds: [] })),
    importStaged: vi.fn(async input => { imported.push({ ...input, bytes: await readFile(input.stagedFilePath) }); return { assetId: 'asset-' + imported.length }; }),
    createFolder: vi.fn(async input => { folders.push({ ...input.target, folderId: 'new-folder', name: input.name, relativePath: input.name, assetCount: 0 }); return 'new-folder'; }), openAssets: vi.fn(),
  };
  const host = new BrowserCaptureHost(directory, hooks, { tempRoot: directory, fetch, changed: vi.fn(), chooseLocalImage: async () => undefined,
    sources: () => [source], source: () => source });
  return { host, hooks, imported, directory };
}
function oldJob(index: number): BrowserCaptureJob { return { id: 'job-' + index, tabId: 'tab', target, kind: 'image', status: 'saved', message: 'Saved',
  filename: 'photo-' + index + '.png', startedAt: '2026-10-18T00:00:00Z', finishedAt: '2026-10-18T00:00:01Z' }; }

describe('expanded capture import validation', () => {
  it.each([
    ['audio/mpeg', Buffer.from('494433040000000000000000', 'hex'), 'audio', 'music.exe', 'music.mp3'],
    ['audio/wav', Buffer.from('RIFF0000WAVEfmt ', 'ascii'), 'audio', 'music.wav', 'music.wav'],
    ['application/pdf', Buffer.from('%PDF-1.7\n1 0 obj\n'), 'file', 'paper.pdf', 'paper.pdf'],
    ['text/plain', Buffer.from('A readable document\n你好'), 'file', 'note.cmd', 'note.txt'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('504b03041400000000000000', 'hex'), 'file', 'document.docx', 'document.docx'],
    ['image/avif', Buffer.from('00000020667479706d6966310000000061766966', 'hex'), 'image', 'cover.jpg', 'cover.avif'],
  ] as const)('streams and validates %s with safe final extension', async (contentType, bytes, kind, inputName, finalName) => {
    const directory = await temporary();
    const fetch = vi.fn(async () => new Response(bytes, { headers: { 'content-type': contentType } }));
    const result = await stageBrowserCapture({ tempRoot: directory, fetch, mediaUrl: 'https://cdn.example/' + inputName, sourcePageUrl: source.frame.url,
      kind, signal: new AbortController().signal });
    expect(result.filename).toBe(finalName); expect(await readFile(result.stagedFilePath)).toEqual(bytes);
    expect(fetch.mock.calls[0]).toEqual(['https://cdn.example/' + inputName, expect.objectContaining({ credentials: 'include', referrer: source.frame.url })]);
  });

  it.each([
    ['text/html', Buffer.from('<html><script>alert(1)</script>'), 'file'],
    ['image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image'],
    ['text/plain', Buffer.from('MZ executable'), 'file'],
    ['text/plain', Buffer.from('<!DOCTYPE html><html>login'), 'file'],
    ['image/png', Buffer.from('ID3 fake-image'), 'image'],
    ['audio/mpeg', png, 'audio'],
    ['application/octet-stream', Buffer.from('unrecognized binary'), 'file'],
    ['text/plain', Buffer.from([0xff, 0xff, 0xff]), 'file'],
  ] as const)('rejects incorrect or executable content %s and removes its temporary directory', async (contentType, bytes, kind) => {
    const directory = await temporary();
    await expect(stageBrowserCapture({ tempRoot: directory, fetch: async () => new Response(bytes, { headers: { 'content-type': contentType } }),
      mediaUrl: 'https://cdn.example/asset', sourcePageUrl: source.frame.url, kind, signal: new AbortController().signal })).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it('validates genuine native files without trusting the filename alone', async () => {
    const directory = await temporary(); const filename = path.join(directory, 'article.pdf'); await writeFile(filename, '%PDF-1.7\nhello');
    const staged = await stagePickedCaptureFile({ filename, tempRoot: directory, signal: new AbortController().signal });
    expect(staged.contentType).toBe('application/pdf'); expect(staged.filename).toBe('article.pdf');
    await writeFile(filename, 'MZ wrong bytes');
    await expect(stagePickedCaptureFile({ filename, tempRoot: directory, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('saves selected Unicode text and readable page snapshots with actual source metadata', async () => {
    const { host, imported } = await fixture();
    expect((await host.saveText(source, target, { text: '选中的文字 🎵', title: 'A / title' })).ok).toBe(true);
    await until(() => imported.length === 1 && host.state().jobs[0]?.status === 'saved');
    expect(imported[0]?.kind).toBe('text'); expect(imported[0]?.filename).toBe('A _ title.txt');
    expect(imported[0]?.bytes.toString('utf8')).toContain('选中的文字 🎵'); expect(imported[0]?.sourcePageUrl).toBe(source.frame.url);
    expect((await host.savePage(source, target, { title: 'Article', text: 'A lasting readable copy' })).ok).toBe(true);
    await until(() => imported.length === 2 && host.state().jobs[0]?.status === 'saved');
    expect(imported[1]?.contentType).toBe('text/plain'); expect(imported[1]?.bytes.toString()).toContain('https://page.example/article');
    expect((await host.saveText(source, target, { text: '   ' })).ok).toBe(false); await host.shutdown();
  });
});

describe('capture history and folder scope', () => {
  it('bounds completed history, recovers interrupted jobs, pages/searches persisted records and clears completed only', async () => {
    const directory = await temporary();
    await writeFile(path.join(directory, 'capture.json'), JSON.stringify({ history: [{ ...oldJob(1001), status: 'saving' }, ...Array.from({ length: 999 }, (_, i) => oldJob(i))] }));
    const { host } = await fixture(directory);
    const recovered = await host.handle({ type: 'history.list', pageSize: 10 });
    expect(recovered.ok && recovered.history?.total).toBe(1000); expect(recovered.ok && recovered.history?.items[0]?.status).toBe('cancelled');
    expect(host.state().jobs).toHaveLength(50);
    await host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/new.png' });
    await until(() => host.state().jobs[0]?.status === 'saved');
    const last = await host.handle({ type: 'history.list', page: 10000, pageSize: 10 });
    expect(last.ok && last.history?.total).toBe(1000); expect(last.ok && last.history?.page).toBe(100);
    const search = await host.handle({ type: 'history.list', query: 'PHOTO-42.PNG', status: 'saved' });
    expect(search.ok && search.history?.items.map(job => job.id)).toEqual(['job-42']);
    await host.shutdown();
    const reloaded = await fixture(directory); const persisted = await reloaded.host.handle({ type: 'history.list', query: 'new.png' });
    expect(persisted.ok && persisted.history?.total).toBe(1);
    await reloaded.host.handle({ type: 'history.clear' }); await reloaded.host.shutdown();
    const data = JSON.parse(await readFile(path.join(directory, 'capture.json'), 'utf8'));
    expect(data.history).toEqual([]); expect(data.preferences).toEqual(DEFAULT_BROWSER_CAPTURE_PREFERENCES);
  });

  it('keeps an in-flight capture alive when the completed history is cleared', async () => {
    const fetch = vi.fn(async (_url?: string, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(png); init?.signal?.addEventListener('abort', () => controller.error(Error('cancelled')), { once: true });
    } }), { headers: { 'content-type': 'image/png' } }));
    const { host } = await fixture(undefined, fetch);
    await host.handle({ type: 'save', kind: 'image', mediaUrl: 'https://cdn.example/inflight.png' });
    await host.handle({ type: 'history.clear' }); expect(host.state().jobs).toHaveLength(1); expect(host.state().jobs[0]?.status).toBe('saving');
    await host.shutdown(); expect(host.state().jobs[0]?.status).toBe('cancelled');
  });

  it('creates a single scoped directory and selects it; invalid names and foreign parents never reach the hook', async () => {
    const { host, hooks } = await fixture();
    for (const name of ['..', '../escape', 'CON', 'nul.txt', 'trailing.', 'a:b', 'line\nname']) {
      expect(browserCaptureRequestSchema.safeParse({ type: 'folder.create', target, name }).success).toBe(false);
      expect((await host.handle({ type: 'folder.create', target, name })).ok).toBe(false);
    }
    expect((await host.handle({ type: 'folder.create', target: { libraryId: 'foreign', folderId: 'foreign' }, name: 'Wrong' })).ok).toBe(false);
    expect(hooks.createFolder).not.toHaveBeenCalled();
    const result = await host.handle({ type: 'folder.create', target: { libraryId: 'library', folderId: 'parent' }, name: '  新目录  ' });
    expect(result.ok && result.folderId).toBe('new-folder'); expect(host.state().target?.folderId).toBe('new-folder');
    expect(hooks.createFolder).toHaveBeenCalledWith({ target: { libraryId: 'library', folderId: 'parent' }, name: '新目录' }); await host.shutdown();
  });

  it('keeps new privileged actions and spoofed document payloads outside the webpage channel', () => {
    for (const type of ['file.open', 'page.save', 'text.save', 'folder.create', 'history.list', 'history.clear']) {
      expect(browserCaptureContentRequestSchema.safeParse({ type: 'runtime.message', message: { type } }).success).toBe(false);
    }
    expect(browserCaptureRequestSchema.safeParse({ type: 'page.save', text: 'forged', sourcePageUrl: 'https://forged.example' }).success).toBe(false);
    expect(browserCaptureRequestSchema.safeParse({ type: 'history.list', pageSize: 101 }).success).toBe(false);
  });

  it('awaits an actual screenshot commit and reports import failures to the utility editor', async () => {
    const { host, hooks } = await fixture(); let release!: () => void; let committed = false;
    hooks.importStaged = async () => { await new Promise<void>(resolve => { release = resolve; }); return { assetId: 'screenshot' }; };
    const started = await host.saveBytes(undefined, target, { bytes: png, filename: 'Screenshot.png', contentType: 'image/png' });
    if (!started.ok || !started.jobId) throw Error('No screenshot job');
    const waiting = host.waitForJob(started.jobId).then(job => { committed = true; return job; });
    await until(() => !!release); expect(committed).toBe(false); release(); expect((await waiting).assetId).toBe('screenshot');
    hooks.importStaged = async () => { throw Error('Target is no longer writable'); };
    const failed = await host.saveBytes(undefined, target, { bytes: png, filename: 'Second.png', contentType: 'image/png' });
    if (!failed.ok || !failed.jobId) throw Error('No screenshot job');
    await expect(host.waitForJob(failed.jobId)).rejects.toThrow('Target is no longer writable'); await host.shutdown();
  });
});
