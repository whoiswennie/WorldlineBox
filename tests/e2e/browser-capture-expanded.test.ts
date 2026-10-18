import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { BrowserCaptureJob, BrowserCaptureRequest } from '../../src/shared/browser-capture';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { library: WorldlineBoxLibraryApi; browser: WorldlineBoxBrowserApi };
async function capture(shell: Page, request: BrowserCaptureRequest) {
  return shell.evaluate(async input => {
    const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.browser.capture(input);
    if (!result.ok) throw Error(result.error);
    return result;
  }, request);
}
async function libraryAssets(shell: Page, libraryId: string) {
  return shell.evaluate(async libraryId => {
    const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.listAssets({ libraryId, recursive: true });
    if (!result.ok) throw Error(result.error.message);
    return result.value;
  }, libraryId);
}
async function saved(shell: Page, request: BrowserCaptureRequest): Promise<BrowserCaptureJob> {
  const result = await capture(shell, request);
  if (!result.jobId) throw Error('Capture did not start a job');
  await expect.poll(async () => (await capture(shell, { type: 'state' })).state.jobs.find(job => job.id === result.jobId)?.status, { timeout: 40_000 }).not.toBe('saving');
  const job = (await capture(shell, { type: 'state' })).state.jobs.find(job => job.id === result.jobId);
  if (!job) throw Error('Missing completed capture job');
  expect(job.status, job.message).toBe('saved');
  expect(job.assetId).toBeTruthy();
  return job;
}
function wav() {
  const samples = 4410, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(88200, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 44100 * 440 * Math.PI * 2) * 16000), 44 + index * 2);
  return bytes;
}
function pdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(body);
  body += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(body + 'trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
}
function cleanup(root: string) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-browser-expanded-')) throw Error('Invalid expanded capture fixture cleanup');
  rmSync(resolved, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
}

// eslint-disable-next-line no-empty-pattern
test('browser capture creates folders and imports real selected text, page snapshots, audio and documents with bounded searchable history', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-browser-expanded-'));
  const linked = path.join(root, 'external', 'Linked collection'); mkdirSync(linked, { recursive: true });
  const libraryName = 'Expanded captures', libraryPath = path.join(root, libraryName), profile = path.join(root, 'profile');
  const nativeFile = path.join(root, 'picked-notes.txt'); writeFileSync(nativeFile, 'Native file picker content\n', 'utf8');
  const audio = wav(), pdfDocument = pdf(), linkedDocument = Buffer.concat([pdf(), Buffer.from('\n% linked capture variant\n')]);
  const authorised: string[] = [], denied: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    if (url === '/collection') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'expanded_capture=ready; Path=/; SameSite=Lax',
        'content-security-policy': "default-src 'self'; script-src 'none'; style-src 'none'; media-src 'self'" });
      response.end('<!doctype html><html><head><title>Mixed capture fixture</title></head><body><h1>Readable page heading</h1><p id="selection">Selected words from the real web page.</p><p id="other">Other paragraph is present only in the page snapshot.</p><audio id="audio" controls preload="none" src="/protected.wav"></audio><a href="/protected.pdf">Fixture PDF</a><iframe src="about:blank"></iframe></body></html>'); return;
    }
    if (url === '/protected.wav' || url === '/protected.pdf' || url === '/linked.pdf') {
      if (!request.headers.cookie?.includes('expanded_capture=ready') || !request.headers.referer?.endsWith('/collection')) {
        denied.push(url); response.writeHead(403); response.end('Cookie and Referer required'); return;
      }
      authorised.push(url);
      const bytes = url.endsWith('.wav') ? audio : url === '/linked.pdf' ? linkedDocument : pdfDocument;
      response.writeHead(200, { 'content-type': url.endsWith('.wav') ? 'audio/wav' : 'application/pdf', 'content-length': bytes.length, 'cache-control': 'no-store' }); response.end(bytes); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port');
  const origin = 'http://127.0.0.1:' + address.port;
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let stderr = '';
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile,
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root, WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath, WORLDLINEBOX_E2E_LINKED_SOURCE: linked }) });
    application.process().stderr?.on('data', chunk => { stderr += String(chunk); });
    // Stub the user's native selection only; BrowserService and all import/
    // capture logic remain the production implementation in this app process.
    await application.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const title = (args.at(-1) as { title?: string }).title ?? '';
        return { canceled: false, filePaths: [/Create Library|创建资源库/iu.test(title) ? fixture.root : /Open Library|打开资源库/iu.test(title) ? fixture.libraryPath : /本地文件/iu.test(title) ? fixture.nativeFile : fixture.linked] };
      };
    }, { root, libraryPath, nativeFile, linked });
    const shell = await application.firstWindow();
    const native = await application.browserWindow(shell);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await shell.locator('[data-application-module="assets"]').click();
    await shell.getByRole('button', { name: '创建资源库', exact: true }).click();
    await shell.getByRole('textbox', { name: '名称', exact: true }).fill(libraryName);
    await shell.getByRole('button', { name: '创建', exact: true }).click();
    await expect(shell.getByRole('button', { name: '当前资源库 ' + libraryName })).toBeVisible({ timeout: 30_000 });
    await expect(shell.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30_000 });
    const libraryId = await shell.evaluate(async () => {
      const opened = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.listOpen();
      if (!opened.ok || !opened.value[0]) throw Error('No real opened library');
      return opened.value[0].libraryId;
    });
    await shell.locator('[data-application-module="browser"]').click();
    const addressBox = shell.getByRole('textbox', { name: '搜索或输入网址' });
    await addressBox.fill(origin + '/collection'); await addressBox.press('Enter');
    await expect.poll(() => application!.context().pages().some(page => page.url() === origin + '/collection')).toBe(true);
    const web = application.context().pages().find(page => page.url() === origin + '/collection')!;
    await expect(web.getByRole('heading', { name: 'Readable page heading' })).toBeVisible();
    expect(await web.evaluate(() => ({ node: typeof Reflect.get(globalThis, 'require'), bridge: typeof Reflect.get(globalThis, 'worldlinebox') }))).toEqual({ node: 'undefined', bridge: 'undefined' });
    await capture(shell, { type: 'preferences.save', preferences: { notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: true } });
    await capture(shell, { type: 'target.set', target: { libraryId, folderId: null } });

    // Create a managed destination through the actual sidebar form.
    await shell.getByRole('button', { name: '保存到资产库', exact: true }).click();
    const panel = shell.locator('[data-browser-capture]');
    await panel.getByRole('button', { name: '新建文件夹', exact: true }).click();
    await panel.getByRole('textbox', { name: '文件夹名称', exact: true }).fill('From browser');
    await panel.getByRole('button', { name: '创建并选中', exact: true }).click();
    await expect.poll(async () => (await capture(shell, { type: 'state' })).state.target?.folderId).toBeTruthy();
    const target = (await capture(shell, { type: 'state' })).state.target!;
    expect((await capture(shell, { type: 'state' })).state.folders.find(folder => folder.folderId === target.folderId)?.name).toBe('From browser');
    expect(existsSync(path.join(libraryPath, 'Assets', 'From browser'))).toBe(true);
    await testInfo.attach('capture-sidebar-save', { body: await panel.screenshot({ path: path.resolve('artifacts/capture-sidebar-save.png') }), contentType: 'image/png' });

    const pageJob = await saved(shell, { type: 'page.save' });
    expect(pageJob.kind).toBe('page'); expect(pageJob.target).toEqual(target);
    const pageText = await shell.evaluate(async input => {
      const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.readTextAsset(input);
      if (!result.ok) throw Error(result.error.message); return result.value.content;
    }, { libraryId, assetId: pageJob.assetId! });
    expect(pageText).toContain('Readable page heading');
    expect(pageText).toContain('Other paragraph is present only in the page snapshot.');
    expect(pageText).toContain(origin + '/collection');
    expect(pageJob.filename).toMatch(/\.txt$/);

    await web.locator('#selection').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range); });
    const textJob = await saved(shell, { type: 'text.save' });
    const selectedText = await shell.evaluate(async input => {
      const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.readTextAsset(input);
      if (!result.ok) throw Error(result.error.message); return result.value.content;
    }, { libraryId, assetId: textJob.assetId! });
    expect(selectedText).toContain('Selected words from the real web page.');
    expect(selectedText).not.toContain('Other paragraph is present only in the page snapshot.');

    // A caller cannot supply invented selection text through the strict bridge.
    const spoofed = await shell.evaluate(async () => {
      try {
        const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.browser.capture({ type: 'text.save', text: 'invented privileged selection' } as unknown as BrowserCaptureRequest);
        return { rejected: !result.ok, error: result.ok ? '' : result.error };
      } catch (cause) { return { rejected: true, error: String(cause) }; }
    });
    expect(spoofed.rejected).toBe(true);
    expect(spoofed.error).toMatch(/unrecognized_keys|无效/);
    const audioJob = await saved(shell, { type: 'save', kind: 'audio', mediaUrl: origin + '/protected.wav' });
    const documentJob = await saved(shell, { type: 'save', kind: 'file', mediaUrl: origin + '/protected.pdf' });
    const captured = await libraryAssets(shell, libraryId);
    expect(captured.find(asset => asset.assetId === audioJob.assetId)?.mediaType).toBe('audio');
    expect(captured.find(asset => asset.assetId === documentJob.assetId)?.mediaType).toBe('document');
    expect(readFileSync(path.join(libraryPath, 'Assets', 'From browser', 'protected.wav'))).toEqual(audio);
    expect(readFileSync(path.join(libraryPath, 'Assets', 'From browser', 'protected.pdf'))).toEqual(pdfDocument);
    expect(authorised).toEqual(expect.arrayContaining(['/protected.wav', '/protected.pdf']));
    expect(denied).toEqual([]);
    for (const job of [pageJob, textJob, audioJob, documentJob]) {
      const metadata = await shell.evaluate(async input => {
        const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.getAssetMetadata(input);
        if (!result.ok) throw Error(result.error.message); return result.value;
      }, { libraryId, assetId: job.assetId! });
      expect(metadata.sourcePageUrl).toBe(origin + '/collection');
    }
    const picked = await saved(shell, { type: 'file.open' });
    expect(picked.kind).toBe('file');
    expect(readFileSync(path.join(libraryPath, 'Assets', 'From browser', 'picked-notes.txt'), 'utf8')).toBe('Native file picker content\n');

    const linkedRoot = await shell.evaluate(async libraryId => {
      const result = await (globalThis as unknown as { worldlinebox: Bridge }).worldlinebox.library.importFolderAsLinked({ libraryId });
      if (!result.ok) throw Error(result.error.message); return result.value.folderId;
    }, libraryId);
    const linkedCreated = await capture(shell, { type: 'folder.create', target: { libraryId, folderId: linkedRoot }, name: 'Browser child' });
    expect(linkedCreated.folderId).toBeTruthy();
    expect(linkedCreated.state.target).toEqual({ libraryId, folderId: linkedCreated.folderId });
    expect(existsSync(path.join(linked, 'Browser child'))).toBe(true);
    const linkedJob = await saved(shell, { type: 'save', kind: 'file', mediaUrl: origin + '/linked.pdf' });
    expect((await libraryAssets(shell, libraryId)).find(asset => asset.assetId === linkedJob.assetId)?.locationKind).toBe('linked');
    expect(readFileSync(path.join(linked, 'Browser child', 'linked.pdf'))).toEqual(linkedDocument);
    expect((await capture(shell, { type: 'state' })).state.folders.some(folder => folder.folderId === linkedCreated.folderId && folder.kind === 'linked')).toBe(true);

    await capture(shell, { type: 'target.set', target });
    for (let index = 0; index < 12; index++) {
      await web.evaluate(index => {
        document.title = 'HistorySnapshot-' + String(index).padStart(2, '0');
        const element = document.getElementById('selection')!;
        element.textContent = 'Unique history fixture text ' + index;
        const range = document.createRange(); range.selectNodeContents(element);
        const selected = window.getSelection(); selected?.removeAllRanges(); selected?.addRange(range);
      }, index);
      await saved(shell, { type: 'text.save' });
    }
    expect(await panel.locator('.capture-history-item').count()).toBe(0);
    expect(await panel.locator('.capture-activity-preview').count()).toBe(1);
    await panel.getByRole('tab', { name: '记录', exact: true }).click();
    await expect(panel.locator('.capture-history-item')).toHaveCount(10);
    await expect(panel.locator('.capture-pagination')).toContainText('1 / 2');
    await panel.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(panel.locator('.capture-pagination')).toContainText('2 / 2');
    await expect(panel.locator('.capture-history-item')).toHaveCount(8);
    await panel.getByRole('textbox', { name: '搜索文件名或消息', exact: true }).fill('HistorySnapshot-11');
    await expect(panel.locator('.capture-history-item')).toHaveCount(1);
    await expect(panel.locator('.capture-history-item')).toContainText('HistorySnapshot-11');
    await testInfo.attach('capture-sidebar-history', { body: await panel.screenshot({ path: path.resolve('artifacts/capture-sidebar-history.png') }), contentType: 'image/png' });
    const history = await capture(shell, { type: 'history.list', page: 1, pageSize: 10, query: 'HistorySnapshot-', status: 'saved' });
    expect(history.history?.total).toBe(12); expect(history.history?.items).toHaveLength(10);
    const secondPage = await capture(shell, { type: 'history.list', page: 2, pageSize: 10, query: 'HistorySnapshot-', status: 'saved' });
    expect(secondPage.history?.items).toHaveLength(2);
    await testInfo.attach('expanded-browser-capture-summary', { body: JSON.stringify({ managedFolderCreated: target.folderId, linkedFolderCreated: linkedCreated.folderId,
      pageAndSelectionReadFromRealDOM: true, nativeFilePicker: true, cookieAndRefererProtectedAudioAndPDF: authorised, boundedSearchableHistory: history.history?.total }), contentType: 'application/json' });
    expect(stderr).not.toContain("Error occurred in handler for 'worldlinebox:browser:capture:content:request'");
    expect(stderr).not.toContain('Invalid webContents');
  } finally {
    server.closeAllConnections(); await application?.close();
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('expanded-browser-capture-stderr', { body: stderr, contentType: 'text/plain' });
      const logs = path.join(profile, 'logs');
      if (existsSync(logs)) for (const name of readdirSync(logs)) if (name.endsWith('.log')) await testInfo.attach(name, { body: readFileSync(path.join(logs, name)), contentType: 'text/plain' });
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(root);
  }
});
