import type { WebContents } from 'electron';
import { BROWSER_PARTITION, isVideoPlayerUrl } from '../../shared/bilibili';

const players = new Set<number>();
export function isPlayerFullscreen(contents: WebContents | null, permission: string, origin: string) {
  return permission === 'fullscreen' && !!contents && players.has(contents.id) && (origin === 'https://player.bilibili.com' || origin.startsWith('https://player.bilibili.com/'));
}

export function bindBilibiliPlayer(owner: WebContents) {
  owner.on('will-attach-webview', (event, preferences, params) => {
    if (!isVideoPlayerUrl(params.src ?? '') || params.partition !== BROWSER_PARTITION ||
        params.preload || params.webpreferences || params.allowpopups || params.disablewebsecurity || params.nodeintegration ||
        params.blinkfeatures || params.disableblinkfeatures || params.plugins) {
      event.preventDefault();
      return;
    }
    delete preferences.preload;
    Object.assign(preferences, { partition: BROWSER_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webviewTag: false, webSecurity: true,
      allowRunningInsecureContent: false, autoplayPolicy: 'no-user-gesture-required' });
  });
  owner.on('did-attach-webview', (_event, guest) => {
    const id = guest.id;
    players.add(id);
    guest.once('destroyed', () => players.delete(id));
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('will-navigate', (event, url) => { if (!isVideoPlayerUrl(url)) event.preventDefault(); });
    guest.on('will-redirect', (event, url, _inPlace, mainFrame) => { if (mainFrame && !isVideoPlayerUrl(url)) event.preventDefault(); });
  });
}
