import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView } from 'electron';
import { applicationNetworkState, closeApplicationNetwork, getApplicationNetwork, testApplicationPixivNetwork } from '../../../src/main/application-network';
import { BrowserService } from '../../../src/main/browser/service';

const root = process.env.WORLDLINEBOX_PIXIV_LIVE_ROOT!;
app.setPath('userData', path.join(root, 'electron-data'));
app.on('window-all-closed', () => undefined);
app.whenReady().then(async () => {
  const host = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const service = new BrowserService(() => host, path.join(root, 'browser'));
  try {
    const network = await getApplicationNetwork();
    const modes = [];
    for (const proxyRouting of ['global', 'smart'] as const) {
      await network.patch({ proxyMode: 'custom', proxyUrl: process.env.WORLDLINEBOX_PIXIV_PROXY ?? 'http://127.0.0.1:7897', proxyRouting });
      await testApplicationPixivNetwork(network);
      const state = applicationNetworkState(network);
      modes.push({ proxyRouting, directCdnHosts: state.smartDirectHosts, check: state.pixivCheck });
      console.log('PIXIV_LIVE_MODE ' + JSON.stringify(modes.at(-1)));
    }
    await service.handle({ type: 'activate' });
    await service.handle({ type: 'layout', visible: true, bounds: { x: 0, y: 0, width: 1280, height: 900 } });
    await service.handle({ type: 'tab.new', url: 'https://www.pixiv.net/' });
    const view = host.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView && child.getVisible());
    if (!view) throw Error('The production browser did not create a native view.');
    view.webContents.backgroundThrottling = false;
    let rendered: unknown;
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        rendered = await view.webContents.executeJavaScript('({url:location.href,title:document.title,styles:document.styleSheets.length,images:[...document.images].filter(image=>image.complete&&image.naturalWidth>0).length,body:!!document.body?.innerText.length})');
        if (rendered && typeof rendered === 'object' && 'styles' in rendered && Number(rendered.styles) > 0 && 'body' in rendered && rendered.body) break;
      } catch { /* Navigation can replace the frame while it is being sampled. */ }
    }
    await mkdir(path.join(root, 'evidence'), { recursive: true });
    const result = { modes, browser: rendered, limitations: ['Public connection checks do not verify authenticated bookmarks, follows, R-18, posting, ugoira playback or payments.'] };
    await writeFile(path.join(root, 'evidence/result.json'), JSON.stringify(result, null, 2));
    try { await writeFile(path.join(root, 'evidence/pixiv-smart.png'), (await view.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG()); }
    catch (error) { console.log('PIXIV_CAPTURE_UNAVAILABLE ' + String(error)); }
    console.log('PIXIV_LIVE_RESULT ' + JSON.stringify(result));
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { await service.shutdown(); await closeApplicationNetwork(); host.destroy(); }
}).catch(error => { console.error(error); app.exit(1); });
