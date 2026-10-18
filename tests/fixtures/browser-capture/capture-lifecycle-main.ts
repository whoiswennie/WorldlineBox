import { strict as assert } from 'node:assert';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, WebContentsView, type WebContents, type WebFrameMain } from 'electron';
import { BrowserService } from '../../../src/main/browser/service';
import { BrowserStore, newBrowserTab } from '../../../src/main/browser/store';
import { BROWSER_CAPTURE_CONTENT_REQUEST, type BrowserCaptureContentResponse } from '../../../src/shared/browser-capture';
import type { BrowserCaptureTargets } from '../../../src/main/browser/capture-host';

const root = process.env.WORLDLINEBOX_CAPTURE_LIFECYCLE_ROOT!;
const origin = process.env.WORLDLINEBOX_CAPTURE_LIFECYCLE_ORIGIN!;
app.setPath('userData', path.join(root, 'electron-data'));
const targets: BrowserCaptureTargets = { libraries: [{ libraryId: 'fixture-library', displayName: 'Private fixture library' }],
  activeLibraryId: 'fixture-library', defaultTarget: { libraryId: 'fixture-library', folderId: null },
  folders: [{ libraryId: 'fixture-library', folderId: 'private-folder', name: 'Private folder', relativePath: 'Private folder', assetCount: 0 }], recentBrowsedFolderIds: [] };
const preferences = { type: 'storage.get', area: 'sync', keys: ['worldlineboxDragRadialMenuEnabled'] };
function event(sender: WebContents, senderFrame: WebFrameMain | null): Electron.IpcMainInvokeEvent {
  return { sender, senderFrame } as Electron.IpcMainInvokeEvent;
}
function refused(response: BrowserCaptureContentResponse, code: string): void {
  assert.equal(response.ok, false); assert.equal(!response.ok && response.code, code);
  assert.deepEqual(Object.keys(response).sort(), ['code', 'error', 'ok']);
  assert.equal(JSON.stringify(response).includes('Private'), false, 'Refusals must not leak library/folder data');
}
async function until(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > 12_000) throw new Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

app.whenReady().then(async () => {
  const seed = new BrowserStore(path.join(root, 'browser')); await seed.init();
  seed.data.preferences.homepage = origin + '/main'; seed.data.tabs = [newBrowserTab(origin + '/main')];
  seed.data.activeTabId = seed.data.tabs[0]!.id; await seed.flush();
  const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await owner.loadURL('data:text/html,Capture lifecycle owner');
  let releaseTargets: (() => void) | undefined; let targetRequestStarted = false;
  const service = new BrowserService(() => owner, path.join(root, 'browser'), {
    async listTargets() {
      if (releaseTargets) {
        targetRequestStarted = true;
        await new Promise<void>(resolve => { releaseTargets = resolve; });
      }
      return targets;
    },
    async importStaged() { throw new Error('This read-only lifecycle fixture must never import'); },
    openAssets() { throw new Error('This read-only lifecycle fixture must never open assets'); },
  });
  let automaticRequests = 0;
  ipcMain.handle(BROWSER_CAPTURE_CONTENT_REQUEST, async (request, input: unknown) => {
    automaticRequests++;
    return service.captureContent(request, input);
  });
  const view = () => {
    const value = owner.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView && child.webContents !== owner.webContents && child.getVisible());
    assert(value, 'An owned native browser view must exist'); return value;
  };
  async function pendingTargets(): Promise<void> {
    targetRequestStarted = false; releaseTargets = () => undefined;
  }
  try {
    const unavailable = new BrowserService(() => owner, path.join(root, 'uninitialized'));
    refused(await unavailable.captureContent(event(owner.webContents, owner.webContents.mainFrame), preferences), 'unavailable');
    await service.handle({ type: 'activate' });
    await service.handle({ type: 'layout', visible: true, bounds: { x: 0, y: 0, width: 900, height: 700 } });
    await until(() => view().webContents.getURL() === origin + '/main' && !view().webContents.isLoading(), 'owned page');
    await until(() => automaticRequests > 0, 'production preload preferences through actual service');
    const contents = view().webContents; const main = contents.mainFrame;
    const initial = await service.captureContent(event(contents, main), preferences);
    assert.deepEqual(initial, { ok: true, value: { worldlineboxDragRadialMenuEnabled: true } });
    refused(await service.captureContent(event(owner.webContents, owner.webContents.mainFrame), preferences), 'forbidden');
    refused(await service.captureContent(event(contents, main), { type: 'storage.get', area: 'sync', keys: ['privateSecrets'] }), 'invalid-request');
    refused(await service.captureContent(event(contents, null), preferences), 'document-gone');
    const child = main.frames.find(frame => frame.url === origin + '/child'); assert(child, 'Real child frame must exist');
    await main.executeJavaScript(`document.querySelector('iframe').remove()`);
    await until(() => child.isDestroyed(), 'detached child frame');
    refused(await service.captureContent(event(contents, child), preferences), 'document-gone');

    await pendingTargets();
    const navigating = service.captureContent(event(contents, main), { type: 'runtime.message', message: { type: 'worldlinebox-connection-status' } });
    await until(() => targetRequestStarted, 'pending capture read before navigation');
    await contents.loadURL(origin + '/after-navigation');
    releaseTargets!(); releaseTargets = undefined;
    refused(await navigating, 'document-gone');
    assert.equal((await service.captureContent(event(contents, contents.mainFrame), preferences)).ok, true);

    await pendingTargets();
    const closing = service.captureContent(event(contents, contents.mainFrame), { type: 'runtime.message', message: { type: 'worldlinebox-list-folders' } });
    await until(() => targetRequestStarted, 'pending folder read before close');
    await service.handle({ type: 'tab.close', id: service.state().activeTabId! });
    releaseTargets!(); releaseTargets = undefined;
    refused(await closing, 'document-gone');
    console.log('BROWSER_CAPTURE_LIFECYCLE_RESULT ' + JSON.stringify({ actualService: true, productionPreload: true,
      unowned: true, invalidRequest: true, unavailable: true, detachedFrame: true, navigationWhilePending: true,
      closeWhilePending: true, noPrivateDataOnRefusal: true, automaticRequests }));
    await service.shutdown(); owner.destroy(); app.exit(0);
  } catch (error) {
    releaseTargets?.(); releaseTargets = undefined;
    console.error(error); await service.shutdown(); owner.destroy(); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
