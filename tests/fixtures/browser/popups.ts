import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, type WebContents } from 'electron';
import { BrowserService } from '../../../src/main/browser/service';
import { BrowserStore, newBrowserTab } from '../../../src/main/browser/store';

const root = process.env.WORLDLINEBOX_BROWSER_POPUP_ROOT!;
const origin = process.env.WORLDLINEBOX_BROWSER_POPUP_ORIGIN!;
app.setPath('userData', path.join(root, 'electron-data'));
// Convert the original uncaught main-process exception into a failing process,
// so this regression never waits on Electron's modal error dialog.
process.on('uncaughtException', error => { console.error('BROWSER_POPUP_UNCAUGHT', error); app.exit(1); });
process.on('unhandledRejection', error => { console.error('BROWSER_POPUP_REJECTION', error); app.exit(1); });

async function until(condition: () => boolean | Promise<boolean>, label: string, limit = 12_000): Promise<void> {
  const started = Date.now();
  while (!await condition()) {
    if (Date.now() - started > limit) throw Error('Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

app.whenReady().then(async () => {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  const seed = new BrowserStore(path.join(root, 'browser')); await seed.init();
  seed.data.tabs = [newBrowserTab(origin + '/opener')]; seed.data.activeTabId = seed.data.tabs[0]!.id;
  await seed.flush();
  const host = new BrowserWindow({ width: 1000, height: 720, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const service = new BrowserService(() => host, path.join(root, 'browser'));
  const views = () => host.contentView.children.filter((child): child is WebContentsView => child instanceof WebContentsView && child.webContents !== host.webContents && !child.webContents.isDestroyed());
  const visible = () => { const view = views().find(child => child.getVisible()); assert(view, 'Expected an active native browser view'); return view.webContents; };
  const progress = (step: string) => console.log('BROWSER_POPUP_PROGRESS ' + step);
  const receipt: Record<string, unknown> = {};
  const closeChild = async (contents: WebContents) => {
    const count = service.state().tabs.length;
    await contents.executeJavaScript('window.close()', true).catch(() => undefined);
    await until(() => contents.isDestroyed() && service.state().tabs.length === count - 1, 'script-closing child removes tab');
  };
  try {
    await service.handle({ type: 'activate' });
    await service.handle({ type: 'layout', visible: true, bounds: { x: 10, y: 10, width: 950, height: 650 } });
    await until(() => visible().getURL() === origin + '/opener' && !visible().isLoading(), 'opener load');
    const opener = visible(); const openerTab = service.state().activeTabId!;
    // Observe Electron's real creation options without changing the callback or
    // manufacturing WebContents; this distinguishes the native-guest and
    // OpenURLFromTab (guestless) routes exercised below.
    const popupRoutes: { url: string; suppliedGuest: boolean; disposition: string }[] = [];
    const handler = (opener as WebContents & { _windowOpenHandler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse })._windowOpenHandler;
    opener.setWindowOpenHandler(details => {
      const response = handler(details); const createWindow = response.createWindow;
      return createWindow ? { ...response, createWindow: options => {
        popupRoutes.push({ url: details.url, disposition: details.disposition, suppliedGuest: !!(options as Electron.WebContentsViewConstructorOptions).webContents });
        return createWindow(options);
      } } : response;
    });
    await opener.executeJavaScript("document.cookie='popup_login=retained; SameSite=Lax'; window.popupMessages=[]; window.addEventListener('message',event=>{if(event.origin===location.origin)window.popupMessages.push(event.data)})");

    progress('target-blank-link');
    const beforeLink = service.state().tabs.length;
    await opener.executeJavaScript("document.querySelector('#link').click()", true);
    await until(() => service.state().tabs.length === beforeLink + 1 && visible().getURL() === origin + '/child?kind=link' && !visible().isLoading(), 'target blank child loads');
    const link = visible(); assert.notEqual(link.id, opener.id);
    assert.equal(await link.executeJavaScript('document.referrer'), origin + '/opener');
    assert((await link.executeJavaScript('document.cookie')).includes('popup_login=retained'));
    const prefs = (link as WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences();
    assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.webSecurity, true);
    assert.deepEqual(await link.executeJavaScript("({require:typeof require,process:typeof process,bridge:typeof window.worldlinebox})"), { require: 'undefined', process: 'undefined', bridge: 'undefined' });
    receipt.targetBlankLoads = true; receipt.sharedCookiesAndReferrer = true; receipt.sandboxPreserved = true;
    // A target=_blank link uses rel=noopener by default in Chromium.
    await service.handle({ type: 'tab.close', id: service.state().activeTabId! });

    progress('native-window-open-and-opener');
    await opener.executeJavaScript("window.child=window.open('/child?kind=script','named-fixture'); window.childWasReturned=!!window.child", true);
    await until(() => visible().getURL() === origin + '/child?kind=script' && !visible().isLoading(), 'window.open child');
    const script = visible(); assert.equal(await opener.executeJavaScript('window.childWasReturned'), true);
    assert.equal(await script.executeJavaScript('window.opener !== null'), true);
    await script.executeJavaScript("window.opener.postMessage('child-ready',location.origin)");
    await until(async () => await opener.executeJavaScript("window.popupMessages.includes('child-ready')"), 'opener postMessage');
    await script.executeJavaScript("window.parentMarker='child-was-adopted'");
    assert.equal(await opener.executeJavaScript('window.child.parentMarker'), 'child-was-adopted');
    receipt.nativeGuestAdopted = true; receipt.openerAndPostMessage = true;
    await closeChild(script);

    progress('blank-then-navigate');
    await service.handle({ type: 'tab.select', id: openerTab });
    await opener.executeJavaScript("window.delayed=window.open('about:blank','_blank'); setTimeout(()=>window.delayed.location.replace('/child?kind=delayed'),80)", true);
    await until(() => visible().getURL() === origin + '/child?kind=delayed' && !visible().isLoading(), 'about blank child navigation');
    receipt.blankThenNavigate = true; await closeChild(visible());

    progress('target-blank-post');
    await service.handle({ type: 'tab.select', id: openerTab });
    await opener.executeJavaScript("document.querySelector('#post').requestSubmit()", true);
    await until(() => visible().getURL() === origin + '/posted' && !visible().isLoading(), 'POST form child');
    const posted = await visible().executeJavaScript('JSON.parse(document.body.textContent)');
    assert.equal(posted.method, 'POST'); assert.equal(posted.body, 'token=post-body-preserved');
    assert.equal(posted.referer, origin + '/opener'); assert(posted.cookie.includes('popup_login=retained'));
    receipt.formPostBodyReferrerAndCookies = true;
    await service.handle({ type: 'tab.close', id: service.state().activeTabId! });

    progress('middle-click-background');
    await service.handle({ type: 'tab.select', id: openerTab });
    // Native Chromium mouse input, including the middle-button disposition.
    // A shown but transparent, non-focusable owner avoids disturbing the desktop.
    host.setOpacity(0); host.setFocusable(false); host.showInactive();
    // Wait for the compositor to present the newly shown view before native
    // input hit testing. DOM readiness alone can precede that first frame.
    await opener.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const point = await opener.executeJavaScript("(()=>{const r=document.querySelector('#background').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
    const beforeBackground = service.state().tabs.length;
    opener.debugger.attach('1.3');
    await opener.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await opener.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'middle', buttons: 4, x: point.x, y: point.y, clickCount: 1 });
    await opener.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'middle', buttons: 0, x: point.x, y: point.y, clickCount: 1 });
    await until(() => service.state().tabs.length === beforeBackground + 1, 'middle click opens background tab');
    opener.debugger.detach();
    const backgroundTab = service.state().tabs.find(tab => tab.url === origin + '/child?kind=background'); assert(backgroundTab);
    assert.equal(service.state().activeTabId, openerTab);
    await until(() => views().some(view => view.webContents.getURL() === origin + '/child?kind=background' && !view.webContents.isLoading()), 'background native contents loads');
    receipt.middleClickStaysInBackground = true;
    await service.handle({ type: 'tab.select', id: backgroundTab.id }); assert.equal(visible().getURL(), origin + '/child?kind=background');
    assert.equal(await visible().executeJavaScript('document.referrer'), origin + '/opener');
    assert((await visible().executeJavaScript('document.cookie')).includes('popup_login=retained'));
    await service.handle({ type: 'tab.close', id: backgroundTab.id });
    console.log('BROWSER_POPUP_NATIVE_ROUTES ' + JSON.stringify(popupRoutes));
    assert(popupRoutes.some(route => route.suppliedGuest), 'The real native-guest route must be exercised');
    assert(popupRoutes.some(route => !route.suppliedGuest), 'The real guestless OpenURLFromTab route must be exercised');
    receipt.nativeAndGuestlessRoutes = [...popupRoutes];

    progress('unsafe-url-denied');
    await service.handle({ type: 'tab.select', id: openerTab });
    const safeCount = service.state().tabs.length;
    assert.equal(await opener.executeJavaScript("window.open('file:///C:/Windows/win.ini','_blank') === null", true), true);
    assert.equal(await opener.executeJavaScript("window.open('data:text/html,unsafe-popup','_blank') === null", true), true);
    assert.equal(service.state().tabs.length, safeCount); receipt.unsafeUrlDenied = true;

    progress('live-page-capacity');
    // Ordinary inactive pages are discarded as the native view limit is crossed.
    for (let index = 0; index < 10; index++) {
      await opener.executeJavaScript(`void window.open('/child?kind=capacity-${index}','_blank')`, true);
      await until(() => visible().getURL() === origin + '/child?kind=capacity-' + index && !visible().isLoading(), 'capacity child ' + index);
      await service.handle({ type: 'tab.select', id: openerTab });
      assert(views().length <= 8);
    }
    receipt.inactivePagesDiscardedAtLimit = true;

    progress('tab-capacity-denied');
    while (service.state().tabs.length < 50) await service.handle({ type: 'tab.new', url: origin + '/child?kind=reserved', background: true });
    assert.equal(await opener.executeJavaScript("window.open('/child?kind=over-limit','_blank') === null", true), true);
    assert.equal(service.state().tabs.length, 50); assert(views().length <= 8); receipt.tabLimitDeniedWithoutException = true;
    const childrenBeforeClosingOpener = views().filter(view => view.webContents !== opener).map(view => view.webContents);
    await service.handle({ type: 'tab.close', id: openerTab });
    await until(() => opener.isDestroyed(), 'closed opener destroyed'); assert(childrenBeforeClosingOpener.every(child => !child.isDestroyed()));
    receipt.childrenOutliveOpenerTab = true;
    await service.shutdown(); await writeFile(path.join(root, 'popup-result.json'), JSON.stringify(receipt, null, 2));
    console.log('BROWSER_POPUP_RESULT ' + JSON.stringify(receipt)); host.destroy(); app.exit(0);
  } catch (error) { console.error(error); await service.shutdown(); host.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
