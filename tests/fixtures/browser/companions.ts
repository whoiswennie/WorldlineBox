import { strict as assert } from 'node:assert';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, nativeImage } from 'electron';
import { BrowserService } from '../../../src/main/browser/service';
import { BrowserStore, newBrowserTab } from '../../../src/main/browser/store';
import type { CompanionBrowserArguments, CompanionBrowserScope } from '../../../src/shared/companion-browser';

const root = process.env.WORLDLINEBOX_BROWSER_FIXTURE_ROOT!, origin = process.env.WORLDLINEBOX_BROWSER_FIXTURE_ORIGIN!;
app.setPath('userData', path.join(root, 'electron-data'));
const alice = { companionId: 'alice', companionName: '小爱', conversationId: 'room' };
const bob = { companionId: 'bob', companionName: '小贝', conversationId: 'other_room' };
async function until(condition: () => boolean, label: string) {
  const started = Date.now(); while (!condition()) { if (Date.now() - started > 15000) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
}
app.whenReady().then(async () => {
  const store = new BrowserStore(path.join(root, 'browser')); await store.init();
  store.data.tabs = [newBrowserTab(origin + '/user')]; const first = store.data.tabs[0]!.id; store.data.activeTabId = first; await store.flush();
  const host = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await host.loadURL('data:text/html,<body style="margin:0;background:%23182028;height:100vh;color:white">Companion browser verification</body>');
  host.setOpacity(0); host.setFocusable(false);
  host.showInactive();
  const service = new BrowserService(() => host, path.join(root, 'browser'));
  const run = (args: CompanionBrowserArguments, owner: CompanionBrowserScope = alice, signal?: AbortSignal) => service.companionTool(owner, args, signal);
  const views = () => host.contentView.children.filter((item): item is WebContentsView => item instanceof WebContentsView);
  try {
    await service.handle({ type: 'activate' }); await service.handle({ type: 'layout', visible: true, bounds: { x: 0, y: 100, width: 1000, height: 600 } });
    await until(() => !service.state().tabs[0]!.loading && views()[0]!.webContents.getURL().startsWith(origin), 'user page');
    await views()[0]!.webContents.executeJavaScript("document.cookie='shared_login=actual; Max-Age=3600; SameSite=Lax'");
    const opened = await run({ action: 'open', url: origin + '/companion' });
    const second = (opened.value as { tabId: string }).tabId; assert(second && second !== first);
    const secondView = views().find(view => view.webContents.getURL() === origin + '/companion')!;
    assert(secondView); assert.equal(service.state().activeTabId, first); assert(!secondView.getVisible());
    assert.equal(secondView.webContents.session, views()[0]!.webContents.session);
    assert((await run({ action: 'read', tabId: second, offset: 0, length: 8000 })).value);
    const text = JSON.stringify((await run({ action: 'read', tabId: second, offset: 0, length: 8000 })).value);
    assert(text.includes('shared_login=actual'), 'Real page reused the signed-in Session');
    assert.deepEqual(service.state().companions!.activities, []);

    const observe = async (owner: CompanionBrowserScope) => {
      const result = await run({ action: 'observe', tabId: second, query: 'Search', offset: 0, limit: 40 }, owner);
      return (result.value as { result: { elements: Array<{ ref: string }> } }).result.elements[0]!.ref;
    };
    const aliceRef = await observe(alice), bobRef = await observe(bob);
    await run({ action: 'fill', tabId: second, ref: aliceRef, text: 'Alice' });
    assert.equal(await secondView.webContents.executeJavaScript('document.querySelector("input").value'), 'Alice');
    await run({ action: 'fill', tabId: second, ref: bobRef, text: 'Bob' }, bob);
    assert.equal(await secondView.webContents.executeJavaScript('document.querySelector("input").value'), 'Bob');
    assert.equal(service.state().activeTabId, first, 'Reading and native input do not steal the active tab');

    const pendingA = run({ action: 'wait', tabId: second, ms: 3000 });
    const pendingB = run({ action: 'wait', tabId: second, ms: 3000 }, bob);
    const settled = Promise.allSettled([pendingA, pendingB]);
    await until(() => service.state().companions!.activities.length === 2, 'two actual viewers');
    assert.equal(secondView.getVisible(), false, 'Companion activity keeps background pages hidden');
    assert.deepEqual(service.state().companions!.activities.map(item => item.companionName).sort(), ['小爱', '小贝']);
    await service.handle({ type: 'tab.select', id: second }); await service.handle({ type: 'tab.select', id: first });
    assert.equal(service.state().companions!.activities.length, 2, 'User switching does not end the actual calls');
    await service.handle({ type: 'companion.pause', tabId: second, paused: true });
    assert((await settled).every(result => result.status === 'rejected')); assert.equal(service.state().companions!.activities.length, 0);
    assert(service.state().tabs.some(tab => tab.id === second), 'Stopping companions keeps the page');
    await assert.rejects(run({ action: 'read', tabId: second, offset: 0, length: 100 }), /暂停/);
    await service.handle({ type: 'companion.pause', tabId: second, paused: false });
    const screenshot = await run({ action: 'screenshot', tabId: second });
    assert(screenshot.screenshot); const image = nativeImage.createFromBuffer(Buffer.from(screenshot.screenshot));
    assert(image.getSize().width >= 900 && image.getSize().height >= 500); assert(screenshot.screenshot.length > 1000);
    assert.deepEqual([...image.toBitmap().subarray(0, 3)], [68, 51, 34], 'Screenshot pixels belong to the requested background page');
    assert.equal(service.state().activeTabId, first); assert.equal(secondView.getVisible(), false);
    const link = (await run({ action: 'observe', tabId: second, query: 'New tab', offset: 0, limit: 40 })).value as { result: { elements: Array<{ ref: string }> } };
    await run({ action: 'click', tabId: second, ref: link.result.elements[0]!.ref });
    await until(() => service.state().tabs.some(tab => tab.url === origin + '/popup'), 'companion popup');
    assert.equal(service.state().activeTabId, first, 'A companion-opened popup does not steal the selected tab');
    const popup = service.state().tabs.find(tab => tab.url === origin + '/popup')!;
    await run({ action: 'tab', tabId: popup.id, operation: 'close' });
    await assert.rejects(run({ action: 'tab', tabId: first, operation: 'close' }), /只能/);
    await run({ action: 'tab', tabId: second, operation: 'close' }); assert(!service.state().tabs.some(tab => tab.id === second));

    const videoPage = (await run({ action: 'open', url: origin + '/video' })).value as { tabId: string };
    const video = await run({ action: 'video', tabId: videoPage.tabId, index: 0, operation: 'seek', time: 2 });
    const videoState = (video.value as { result: { currentTime: number; width: number; tracks: unknown[] } }).result;
    assert(Math.abs(videoState.currentTime - 2) < 0.15 && videoState.width === 64, 'Seeks the actual HTML video');
    assert(JSON.stringify(videoState.tracks).includes('Existing site subtitle, no ASR.'), 'Reads an existing site text track');
    assert((await run({ action: 'screenshot', tabId: videoPage.tabId })).screenshot);
    assert.equal(service.state().activeTabId, first); await run({ action: 'tab', tabId: videoPage.tabId, operation: 'close' });

    const closing = run({ action: 'wait', tabId: first, ms: 3000 }); const closedResult = Promise.allSettled([closing]);
    await until(() => service.state().companions!.activities.length === 1, 'close test');
    await service.handle({ type: 'tab.close', id: first }); assert.equal((await closedResult)[0]!.status, 'rejected');
    assert.equal(service.state().companions!.activities.length, 0);
    await service.handle({ type: 'companion.pause', paused: true });
    await assert.rejects(run({ action: 'open', url: origin + '/blocked' }), /暂停/);
    await service.handle({ type: 'companion.pause', paused: false });
    await service.shutdown(); host.destroy();
    console.log('COMPANION_BROWSER_RESULT ' + JSON.stringify({ sharedUserSession: true, independentRefs: true, twoViewers: true, userSwitching: true, stoppedWithoutClosing: true,
      hiddenOrdinaryTabScreenshot: true, actualVideoSeek: true, existingSubtitles: true, closedTabCancels: true, noDsh: true, externalRecognitionModels: false })); app.exit(0);
  } catch (error) { console.error(error); await service.shutdown().catch(() => undefined); if (!host.isDestroyed()) host.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
