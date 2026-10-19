import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { BrowserService } from '../../../src/main/browser/service';
import { BrowserStore, newBrowserTab } from '../../../src/main/browser/store';

const root = process.env.WORLDLINEBOX_BROWSER_FIXTURE_ROOT!; const phase = process.env.WORLDLINEBOX_BROWSER_FIXTURE_PHASE!;
app.setPath('userData', path.join(root, 'electron-data')); app.setPath('downloads', path.join(root, 'downloads'));
async function until(condition: () => boolean | Promise<boolean>, label: string, limit = 15_000): Promise<void> {
  const started = Date.now(); while (!await condition()) { if (Date.now() - started > limit) throw Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
}
app.whenReady().then(async () => {
  const payload = Buffer.from('WorldlineBox browser download verification\n'.repeat(100));
  const origin = process.env.WORLDLINEBOX_BROWSER_FIXTURE_ORIGIN!;
  assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  if (phase === 'initial') {
    const seed = new BrowserStore(path.join(root, 'browser')); await seed.init();
    seed.data.preferences.homepage = origin + '/one'; seed.data.tabs = [newBrowserTab(origin + '/one')]; seed.data.activeTabId = seed.data.tabs[0]!.id; seed.data.bookmarks = []; await seed.flush();
  }
  const host = new BrowserWindow({ width: 1100, height: 800, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const service = new BrowserService(() => host, path.join(root, 'browser'));
  const layout = { type: 'layout' as const, visible: true, bounds: { x: 50, y: 100, width: 900, height: 600 } };
  const view = () => {
    const target = host.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView && child.webContents !== host.webContents && child.getVisible());
    assert(target, 'A visible native WebContentsView is required'); return target;
  };
  const receipt: Record<string, unknown> = { phase, root };
  const progress = (step: string) => console.log('BROWSER_FIXTURE_PROGRESS ' + JSON.stringify({ phase, step }));
  try {
    progress('activate');
    await service.handle({ type: 'activate' }); await service.handle(layout);
    await until(() => !service.state().tabs.find(tab => tab.id === service.state().activeTabId)?.loading && view().webContents.getURL().startsWith(origin), 'first page loaded');
    progress('loaded');
    if (phase === 'initial') {
      const first = service.state().activeTabId!; const firstContents = view().webContents;
      await firstContents.executeJavaScript("document.cookie='fixture_login=retained; Max-Age=86400; SameSite=Lax'; localStorage.setItem('fixture_login','retained'); window.runtimeMarker='page-stays-alive'");
      await service.handle({ type: 'bookmark.save', title: '测试收藏', folder: '验收' });
      await service.handle({ type: 'tab.new' }); const blank = service.state().activeTabId!;
      assert.equal(service.state().tabs.find(tab => tab.id === blank)?.url, 'about:blank');
      await service.handle({ type: 'bookmark.save', id: service.state().bookmarks[0]!.id, title: '测试收藏', folder: '验收' });
      await assert.rejects(service.handle({ type: 'bookmark.save', title: '空白页', folder: '' }), /不能收藏/);
      await service.handle({ type: 'tab.close', id: blank }); receipt.newTabsAreBlank = true; receipt.editBookmarkFromBlankTab = true;
      await service.handle({ type: 'tab.new', url: origin + '/two' });
      await until(() => view().webContents.getTitle() === 'Beta', 'second tab loaded');
      assert.equal(service.state().tabs.length, 2);
      await service.handle({ type: 'tab.select', id: first });
      assert.equal(view().webContents.id, firstContents.id);
      assert.equal(await firstContents.executeJavaScript('window.runtimeMarker'), 'page-stays-alive'); receipt.tabSwitchPreservesPage = true;
      await service.handle({ ...layout, visible: false });
      assert(host.contentView.children.filter(child => child instanceof WebContentsView).every(child => !child.getVisible() || (child as WebContentsView).webContents === host.webContents));
      await service.handle(layout); assert.equal(view().webContents.id, firstContents.id); receipt.moduleSwitchPreservesPage = true;
      await service.handle({ type: 'tab.navigate', text: origin + '/two' }); await until(() => firstContents.getTitle() === 'Beta', 'same-tab navigation');
      await service.handle({ type: 'tab.action', action: 'back' }); await until(() => firstContents.getTitle() === 'Alpha', 'history back');
      assert(firstContents.navigationHistory.canGoForward()); receipt.backForwardNavigation = true;
      await service.handle({ type: 'tab.zoom', factor: 1.25 }); assert.equal(firstContents.getZoomFactor(), 1.25);
      await service.handle({ type: 'tab.action', action: 'mute' }); assert.equal(firstContents.isAudioMuted(), true);
      await service.handle({ type: 'tab.action', action: 'pin' }); assert.equal(service.state().tabs[0]!.pinned, true);
      progress('video');
      await firstContents.executeJavaScript("(()=>{const c=document.createElement('canvas');c.width=64;c.height=64;const v=document.getElementById('video');v.srcObject=c.captureStream(5);c.getContext('2d').fillRect(0,0,64,64);v.play();})()", true);
      await until(async () => await firstContents.executeJavaScript("document.getElementById('video').readyState>=2"), 'video playback');
      progress('enter-fullscreen');
      // Chromium completes fullscreen only for a shown native owner. Keep this
      // correctness fixture transparent and non-focusable on the user's desktop.
      host.setOpacity(0); host.setFocusable(false); host.showInactive();
      await firstContents.executeJavaScript("void document.getElementById('video').requestFullscreen().catch(error=>{window.fullscreenFailure=String(error)})", true);
      await until(() => service.state().fullscreen, 'HTML video fullscreen');
      assert.equal(await firstContents.executeJavaScript("document.fullscreenElement?.id"), 'video');
      assert.equal(view().getBounds().x, 0); assert.equal(view().getBounds().y, 0);
      await firstContents.executeJavaScript('void document.exitFullscreen()'); await until(() => !service.state().fullscreen, 'exit fullscreen');
      assert.equal(view().getBounds().x, layout.bounds.x); receipt.videoFullscreen = true;
      progress('download');
      const downloadDirectory = path.join(root, 'downloads', 'WorldlineBox'); await mkdir(downloadDirectory, { recursive: true });
      await writeFile(path.join(downloadDirectory, 'sample.bin'), 'existing file'); firstContents.downloadURL(origin + '/download');
      await until(() => service.state().downloads[0]?.status === 'completed', 'native download completion');
      const downloaded = service.state().downloads[0]!; assert.equal(path.basename(downloaded.path), 'sample (1).bin');
      assert.deepEqual(await readFile(downloaded.path), payload); assert.equal(await readFile(path.join(downloadDirectory, 'sample.bin'), 'utf8'), 'existing file');
      receipt.downloadSha256 = createHash('sha256').update(await readFile(downloaded.path)).digest('hex'); receipt.nonOverwritingDownload = true;
      progress('download-history-management');
      firstContents.downloadURL(origin + '/slow-download');
      await until(() => service.state().downloads.some(item => item.url === origin + '/slow-download' && item.status === 'progressing' && item.received > 0), 'live native download');
      const live = service.state().downloads.find(item => item.url === origin + '/slow-download')!;
      await service.handle({ type: 'download.records.remove', ids: [downloaded.id, live.id, downloaded.id, 'already-removed'] });
      assert(!service.state().downloads.some(item => item.id === downloaded.id), 'Selected finished history is removed');
      assert(service.state().downloads.some(item => item.id === live.id), 'Selected active download survives cleanup');
      assert.deepEqual(await readFile(downloaded.path), payload, 'History removal keeps the actual file');
      await service.handle({ type: 'download.records.clear' });
      assert.equal(service.state().downloads.length, 1);
      await service.handle({ type: 'download.action', id: live.id, action: 'pause' });
      await service.handle({ type: 'download.records.clear' });
      assert.equal(service.state().downloads[0]!.id, live.id, 'Paused native download survives cleanup');
      await service.handle({ type: 'download.action', id: live.id, action: 'resume' });
      await service.handle({ type: 'download.action', id: live.id, action: 'cancel' });
      await until(() => service.state().downloads.find(item => item.id === live.id)?.status === 'cancelled', 'native download cancellation');
      await service.handle({ type: 'download.records.clear' }); assert.equal(service.state().downloads.length, 0);
      assert.deepEqual(await readFile(downloaded.path), payload);
      firstContents.downloadURL(origin + '/download');
      await until(() => service.state().downloads[0]?.status === 'completed', 'new download after clearing history');
      assert.notEqual(service.state().downloads[0]!.path, downloaded.path, 'Removed history never allows overwriting the retained file');
      receipt.downloadHistoryKeepsFiles = true; receipt.downloadCleanupKeepsActiveAndPaused = true; receipt.downloadAfterCleanup = true;
      progress('clear-cache');
      await service.handle({ type: 'data.clear', cache: true, siteData: false, history: false, downloads: false });
      assert((await firstContents.executeJavaScript('document.cookie')).includes('fixture_login=retained'));
      assert.equal(await firstContents.executeJavaScript("localStorage.getItem('fixture_login')"), 'retained'); receipt.cacheOnlyKeepsSignIn = true;
      assert(service.store.history('', 0, 50).history.some(item => item.title === 'Beta'));
      receipt.initialTabId = first; receipt.bookmarkCount = service.state().bookmarks.length;
    } else {
      const restored = service.state(); assert.equal(restored.tabs.length, 2); assert.equal(restored.bookmarks[0]!.title, '测试收藏');
      assert.equal(restored.downloads[0]!.status, 'completed'); assert.equal(restored.tabs[0]!.pinned, true); assert.equal(view().webContents.getZoomFactor(), 1.25);
      assert(view().webContents.navigationHistory.canGoForward()); receipt.navigationHistoryRestored = true;
      assert((await view().webContents.executeJavaScript('document.cookie')).includes('fixture_login=retained'));
      assert.equal(await view().webContents.executeJavaScript("localStorage.getItem('fixture_login')"), 'retained'); receipt.restartKeepsCookiesAndStorage = true;
      assert.equal(host.contentView.children.filter(child => child instanceof WebContentsView && child.webContents !== host.webContents).length, 1); receipt.backgroundTabsRestoredLazily = true;
      await service.handle({ type: 'data.clear', cache: false, siteData: true, history: false, downloads: false, origin });
      assert.equal(await view().webContents.executeJavaScript('document.cookie'), '');
      assert.equal(await view().webContents.executeJavaScript("localStorage.getItem('fixture_login')"), null); receipt.siteDataClearIsExplicit = true;
      assert.equal(service.state().bookmarks.length, 1);
    }
    progress('shutdown');
    await service.shutdown(); await writeFile(path.join(root, phase + '-result.json'), JSON.stringify(receipt, null, 2));
    console.log('BROWSER_FIXTURE_RESULT ' + JSON.stringify(receipt)); host.destroy(); app.exit(0);
  } catch (error) { console.error(error); await service.shutdown(); host.destroy(); app.exit(1); }
}).catch(error => { console.error(error); app.exit(1); });
