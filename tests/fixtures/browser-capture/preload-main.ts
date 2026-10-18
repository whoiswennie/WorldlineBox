import { strict as assert } from 'node:assert';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session, WebContentsView, type WebFrameMain } from 'electron';
import { BROWSER_CAPTURE_CONTENT_EVENT, BROWSER_CAPTURE_CONTENT_REQUEST, browserCaptureContentRequestSchema, type BrowserCaptureContentResponse } from '../../../src/shared/browser-capture';

const root = process.env.WORLDLINEBOX_CAPTURE_PRELOAD_ROOT!;
const origin = process.env.WORLDLINEBOX_CAPTURE_PRELOAD_ORIGIN!;
const childOrigin = process.env.WORLDLINEBOX_CAPTURE_PRELOAD_CHILD_ORIGIN!;
app.setPath('userData', path.join(root, 'electron-data'));
let driverId = 0;
const pendingDriver = new Map<number, { resolve(): void; reject(error: Error): void }>();
let ready: () => void = () => undefined;
const driverReady = new Promise<void>(resolve => { ready = resolve; });
// Test-only Main process control, accessed by ElectronApplication.evaluate.
// Nothing is exposed to any webpage or preload world.
(globalThis as typeof globalThis & { captureFixtureDriver(value: { id?: number; error?: string; start?: boolean }): void }).captureFixtureDriver = value => {
  if (value.start) ready();
  if (value.id === undefined) return;
  const waiting = pendingDriver.get(value.id); pendingDriver.delete(value.id);
  if (value.error) waiting?.reject(new Error(value.error)); else waiting?.resolve();
};
async function realDrag(frame: WebFrameMain, action: 'save' | 'disabled' = 'save'): Promise<void> {
  const id = ++driverId;
  const result = new Promise<void>((resolve, reject) => pendingDriver.set(id, { resolve, reject }));
  console.log('BROWSER_CAPTURE_DRIVER ' + JSON.stringify({ id, url: frame.url, action }));
  const timer = setTimeout(() => pendingDriver.get(id)?.reject(new Error('Real mouse driver timed out')), 15_000);
  try { await result; } finally { clearTimeout(timer); pendingDriver.delete(id); }
}

async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > 12_000) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

app.whenReady().then(async () => {
  const browserSession = session.fromPartition('persist:worldlinebox-browser-capture-preload-fixture');
  browserSession.registerPreloadScript({ type: 'frame', filePath: path.join(root, 'build', 'browser-capture-probe.js') });
  const owner = new BrowserWindow({ show: false, width: 1000, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  // Give Playwright a real initialized owner document; an unused BrowserWindow
  // target without any navigation can stall Electron's CDP page discovery.
  await owner.loadURL('data:text/html,<!doctype html><html><body>Capture fixture owner</body></html>');
  const view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInSubFrames: true, webSecurity: true, backgroundThrottling: false } });
  owner.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 960, height: 1060 });
  const content = view.webContents;
  const initialized = new Set<string>(); const folderRequests = new Map<string, number>(); const localUploads: Buffer[] = [];
  const sandboxProbes = new Map<string, unknown>(); let badSenderRejected = 0;
  let remoteSaves = 0;
  content.on('console-message', event => console.log('CAPTURE_PAGE ' + event.message));
  content.on('preload-error', (_event, file, error) => console.error('CAPTURE_PRELOAD_ERROR', file, error));
  ipcMain.handle('worldlinebox:fixture:capture-preload-probe', (event, probe: unknown) => {
    if (event.sender === content && event.senderFrame) sandboxProbes.set(event.senderFrame.url, probe);
  });
  ipcMain.handle(BROWSER_CAPTURE_CONTENT_REQUEST, (event, raw: unknown): BrowserCaptureContentResponse => {
    if (event.sender !== content) { badSenderRejected++; return { ok: false, code: 'forbidden', error: 'Only the owned native browser can use the capture host' }; }
    const value = (() => {
    const frame = event.senderFrame; assert(frame && !frame.isDestroyed());
    const request = browserCaptureContentRequestSchema.parse(raw);
    if (request.type === 'storage.get') {
      console.log('CAPTURE_FRAME_INITIALIZED ' + frame.url);
      initialized.add(frame.url);
      return Object.fromEntries(request.keys.map(key => [key, key === 'recentFolderIds' ? ['folder-one'] : true]));
    }
    if (request.type === 'storage.set') return {};
    if (request.message.type === 'worldlinebox-connection-status') return { kind: 'connected' };
    if (request.message.type === 'worldlinebox-list-folders') {
      folderRequests.set(frame.url, (folderRequests.get(frame.url) ?? 0) + 1);
      return { kind: 'ok', folders: [{ folderId: 'folder-one', name: 'Fixture folder', relativePath: 'Fixture folder', assetCount: 1 }],
        recentFolderIds: ['folder-one'], recentBrowsedFolderIds: [], libraryDisplayName: 'Fixture library' };
    }
    if (request.message.type === 'worldlinebox-local-save-request') {
      const bytes = Buffer.from(request.message.bodyBase64, 'base64');
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(request.message.kind, 'image'); assert.equal(request.message.contentType, 'image/png');
      assert.equal(request.message.targetFolderId, 'folder-one'); localUploads.push(bytes);
    } else if (request.message.type === 'worldlinebox-save-request') {
      assert.equal(request.message.intent.targetFolderId, 'folder-one'); assert.equal(request.message.intent.sourcePageUrl, frame.url);
      remoteSaves++;
    }
    return { notification: { title: '已保存到 WorldlineBox', message: 'Fixture saved' } };
    })();
    return { ok: true, value };
  });
  async function isolation(frame: WebFrameMain, probeExpected = true): Promise<void> {
    assert.deepEqual(await frame.executeJavaScript(`({
      require:typeof require,process:typeof process,Buffer:typeof Buffer,module:typeof module,ipcRenderer:typeof globalThis.ipcRenderer,
      appBridge:typeof globalThis.worldlinebox,
      captureRuntime:typeof globalThis.chrome?.runtime?.sendMessage,
      captureStorage:typeof globalThis.chrome?.storage?.sync?.get
    })`), { require: 'undefined', process: 'undefined', Buffer: 'undefined', module: 'undefined', ipcRenderer: 'undefined', appBridge: 'undefined', captureRuntime: 'undefined', captureStorage: 'undefined' });
    if (probeExpected) {
      await until(() => sandboxProbes.has(frame.url), 'sandbox probe in ' + frame.url);
      assert.deepEqual(sandboxProbes.get(frame.url), { sandboxed: true, contextIsolated: true, nodeBuiltinsAvailable: false });
    }
  }
  async function drag(frame: WebFrameMain): Promise<void> {
    await frame.executeJavaScript(`document.getElementById('media').dispatchEvent(new DragEvent('dragstart', {
      bubbles:true,cancelable:true,clientX:220,clientY:130,dataTransfer:new DataTransfer()
    }))`);
  }
  async function menuVisible(frame: WebFrameMain): Promise<boolean> {
    return await frame.executeJavaScript(`!!document.querySelector('[data-worldlinebox-radial-menu]')?.shadowRoot?.querySelector('.tree-host')`) === true;
  }
  async function escape(frame: WebFrameMain): Promise<void> { await frame.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); }
  try {
    await content.loadURL(origin + '/main');
    await until(() => initialized.has(origin + '/main') && initialized.has(childOrigin + '/child'), 'capture preload in main and cross-origin iframe');
    const main = content.mainFrame;
    const child = main.frames.find(frame => frame.url === childOrigin + '/child'); assert(child, 'Cross-origin iframe must exist');
    await isolation(main); await isolation(child);
    const inertFrames = main.frames.filter(frame => ['about:blank', 'about:srcdoc'].includes(frame.url) || frame.url.startsWith('data:'));
    assert.equal(inertFrames.length, 3, 'Blank, srcdoc and data documents should exist');
    for (const frame of inertFrames) {
      // Electron can omit preloads from inherited blank documents altogether.
      // Either way, their page world must remain unprivileged and IPC-free.
      await isolation(frame, false);
      assert.equal(initialized.has(frame.url), false, 'Ineligible document must never request capture preferences');
      assert.equal(await frame.executeJavaScript(`document.querySelector('[data-worldlinebox-radial-menu]')===null`), true);
    }
    assert.equal(await main.executeJavaScript(`(()=>{try{document.querySelector('iframe').contentWindow.document;return false}catch(error){return error.name==='SecurityError'}})()`), true);
    // A malicious website can dispatch drag events, but cannot grant trusted
    // gesture authority or discover a library's private folder names.
    for (const frame of [main, child]) {
      await drag(frame); await until(() => menuVisible(frame), 'synthetic menu fallback');
      assert.equal(await frame.executeJavaScript(`document.querySelector('[data-worldlinebox-radial-menu]').shadowRoot.textContent.includes('Fixture folder')`), false);
      await frame.executeJavaScript(`(()=>{const body=document.querySelector('[data-worldlinebox-radial-menu]').shadowRoot.querySelector('.pill .body');const box=body.getBoundingClientRect();
        document.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:box.x+box.width/2,clientY:box.y+box.height/2,dataTransfer:new DataTransfer()}));})()`);
      await escape(frame);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(folderRequests.size, 0); assert.equal(remoteSaves, 0); assert.equal(localUploads.length, 0);
    await driverReady;
    for (const frame of [main, child]) {
      await realDrag(frame); assert((folderRequests.get(frame.url) ?? 0) > 0);
      frame.send(BROWSER_CAPTURE_CONTENT_EVENT, { type: 'runtime.message', message: { type: 'worldlinebox-save-feedback', state: 'saved', title: 'Capture feedback', message: 'Saved in fixture' } });
      await until(async () => await frame.executeJavaScript(`Array.from(document.querySelectorAll('div')).some(host=>host.shadowRoot?.querySelector('.bubble')?.textContent.includes('Capture feedback'))`) === true, 'original extension feedback bubble');
    }
    assert.equal(remoteSaves, 2);
    // Preference changes reach each isolated frame and alter the original
    // content script's cached flag without exposing storage to page JavaScript.
    for (const frame of [main, child]) frame.send(BROWSER_CAPTURE_CONTENT_EVENT, { type: 'storage.changed', area: 'sync', changes: { worldlineboxDragRadialMenuEnabled: { oldValue: true, newValue: false } } });
    await new Promise(resolve => setTimeout(resolve, 100));
    const counts = [...folderRequests.entries()];
    await realDrag(main, 'disabled'); await realDrag(child, 'disabled');
    assert.deepEqual([...folderRequests.entries()], counts);

    const fileUrl = pathToFileURL(path.join(root, 'gallery.html')).href;
    await content.loadURL(fileUrl);
    await isolation(content.mainFrame);
    await drag(content.mainFrame); await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(initialized.has(fileUrl), false, 'File documents must never request capture preferences');
    assert.equal(await menuVisible(content.mainFrame), false); assert.equal(localUploads.length, 0);
    // Replacing a document with a web page installs a fresh shim; the old
    // document cannot keep listeners or gesture authority across navigation.
    await content.loadURL(origin + '/after-navigation');
    await until(() => initialized.has(origin + '/after-navigation'), 'new document after navigation');
    await isolation(content.mainFrame);
    await realDrag(content.mainFrame); assert.equal(remoteSaves, 3);
    await content.loadURL('about:blank'); await isolation(content.mainFrame, false);
    assert.equal(initialized.has('about:blank'), false);
    const unowned = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await unowned.loadURL(origin + '/unowned');
    await until(() => badSenderRejected > 0, 'unowned web contents rejected by capture host'); unowned.destroy();
    console.log('BROWSER_CAPTURE_PRELOAD_RESULT ' + JSON.stringify({ allFrames: true, crossOriginFrame: true, sandbox: true,
      noMainWorldBridge: true, originalDragMenu: true, originalFeedback: true, storageBroadcast: true, ineligibleDocumentsSkipped: true,
      documentNavigation: true, syntheticFolderReadRejected: true, syntheticSaveRejected: true, realMouseSaves: remoteSaves,
      unownedSenderRejected: badSenderRejected > 0, probes: [...sandboxProbes.entries()] }));
    owner.destroy(); app.exit(0);
  } catch (error) { console.error(error); owner.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
