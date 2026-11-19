import { screen, type BrowserWindow, type Rectangle, type WindowOpenHandlerResponse } from 'electron';
import { DEFAULT_MUSIC_LYRICS_LAYOUT, MUSIC_LYRICS_LOCK_INSET, MUSIC_LYRICS_LOCK_SIZE, MUSIC_LYRICS_WINDOW, type MusicLyricsLayout } from '../../shared/music';

const windows = new WeakMap<BrowserWindow, (layout: MusicLyricsLayout) => void>();
export function configureDesktopLyricsWindow(owner: BrowserWindow, layout: MusicLyricsLayout) {
  windows.get(owner)?.(layout);
}

function place(workArea: Rectangle, layout: MusicLyricsLayout, previous?: Rectangle): Rectangle {
  const vertical = layout.orientation === 'vertical';
  const width = Math.min(workArea.width, Math.round(vertical ? 92 + layout.fontSize * 2.8 : 315 + layout.fontSize * 14));
  const height = Math.min(workArea.height, Math.round(vertical ? 170 + layout.fontSize * 10 : 42 + layout.fontSize * 2.1));
  const x = previous ? previous.x + (previous.width - width) / 2 : workArea.x + (workArea.width - width) / 2;
  const y = previous ? previous.y + (previous.height - height) / 2 : workArea.y + workArea.height - height - 24;
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)),
    width, height,
  };
}

export function bindDesktopLyricsWindow(owner: BrowserWindow) {
  let lyrics: BrowserWindow | undefined;
  let layout = DEFAULT_MUSIC_LYRICS_LAYOUT;
  let previous: Rectangle | undefined;
  let passThrough: boolean | undefined;
  let hitTest: ReturnType<typeof setInterval> | undefined;
  const syncPointer = () => {
    if (!lyrics || lyrics.isDestroyed()) return;
    const bounds = lyrics.getContentBounds(), pointer = screen.getCursorScreenPoint();
    const left = bounds.x + bounds.width - MUSIC_LYRICS_LOCK_INSET - MUSIC_LYRICS_LOCK_SIZE;
    const top = bounds.y + MUSIC_LYRICS_LOCK_INSET;
    const overLock = pointer.x >= left && pointer.x < left + MUSIC_LYRICS_LOCK_SIZE && pointer.y >= top && pointer.y < top + MUSIC_LYRICS_LOCK_SIZE;
    const ignore = layout.locked && !overLock;
    if (passThrough !== ignore) { passThrough = ignore; lyrics.setIgnoreMouseEvents(ignore); }
  };
  const configure = (next: MusicLyricsLayout) => {
    const resized = next.orientation !== layout.orientation || next.fontSize !== layout.fontSize;
    layout = next;
    if (!lyrics || lyrics.isDestroyed()) return;
    if (resized) {
      const bounds = lyrics.getBounds();
      lyrics.setBounds(place(screen.getDisplayMatching(bounds).workArea, layout, bounds));
    }
    clearInterval(hitTest);
    if (layout.locked) { hitTest = setInterval(syncPointer, 32); hitTest.unref(); }
    syncPointer();
  };
  windows.set(owner, configure);
  const close = () => { if (lyrics && !lyrics.isDestroyed()) lyrics.destroy(); };
  owner.once('closed', close);
  owner.webContents.on('render-process-gone', close);
  owner.webContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) close();
  });
  owner.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName !== MUSIC_LYRICS_WINDOW) return;
    lyrics = child;
    child.once('closed', () => {
      if (lyrics !== child) return;
      lyrics = undefined; passThrough = undefined; clearInterval(hitTest);
    });
    const remember = () => { previous = child.getBounds(); syncPointer(); };
    child.on('move', remember);
    child.on('resize', remember);
    const restoreBounds = () => {
      if (!child.isDestroyed()) {
        const bounds = child.getBounds();
        child.setBounds(place(screen.getDisplayMatching(bounds).workArea, layout, bounds));
      }
    };
    screen.on('display-removed', restoreBounds);
    screen.on('display-metrics-changed', restoreBounds);
    child.once('closed', () => {
      screen.off('display-removed', restoreBounds);
      screen.off('display-metrics-changed', restoreBounds);
    });
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', event => event.preventDefault());
    child.webContents.on('will-frame-navigate', event => event.preventDefault());
    child.webContents.on('will-attach-webview', event => event.preventDefault());
    child.webContents.setZoomFactor(1);
    configure(layout);
    child.showInactive();
  });
  return (url: string, frameName: string): WindowOpenHandlerResponse | undefined => {
    if (frameName !== MUSIC_LYRICS_WINDOW) return;
    if (url !== 'about:blank' || (lyrics && !lyrics.isDestroyed())) return { action: 'deny' };
    const { workArea } = screen.getDisplayMatching(previous ?? owner.getBounds());
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'WorldlineBox · 桌面歌词', frame: false, transparent: true, show: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, fullscreenable: false,
      ...place(workArea, layout, previous),
      webPreferences: { backgroundThrottling: false },
    } };
  };
}
