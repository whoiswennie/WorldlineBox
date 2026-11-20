import { screen, type BrowserWindow, type Rectangle, type WindowOpenHandlerResponse } from 'electron';
import { DEFAULT_MUSIC_LYRICS_LAYOUT, MUSIC_LYRICS_CAPTION_METRICS, MUSIC_LYRICS_LOCK_INSET, MUSIC_LYRICS_LOCK_SIZE, MUSIC_LYRICS_WINDOW, type MusicLyricsWindowConfig } from '../../shared/music';

const windows = new WeakMap<BrowserWindow, (config: MusicLyricsWindowConfig) => void>();
export function configureDesktopLyricsWindow(owner: BrowserWindow, config: MusicLyricsWindowConfig) {
  windows.get(owner)?.(config);
}

const { toolbarSpace, edgeSpace, lineHeight } = MUSIC_LYRICS_CAPTION_METRICS;
const defaultConfig: MusicLyricsWindowConfig = {
  locked: DEFAULT_MUSIC_LYRICS_LAYOUT.locked,
  orientation: DEFAULT_MUSIC_LYRICS_LAYOUT.orientation,
  fontSize: DEFAULT_MUSIC_LYRICS_LAYOUT.fontSize,
  captionExtent: Math.ceil(DEFAULT_MUSIC_LYRICS_LAYOUT.fontSize * lineHeight) + 2 * edgeSpace,
};

function place(workArea: Rectangle, config: MusicLyricsWindowConfig, previous?: Rectangle): Rectangle {
  const { orientation, fontSize, captionExtent } = config;
  const vertical = orientation === 'vertical';
  const width = Math.min(workArea.width, vertical ? Math.max(150, captionExtent) : 315 + fontSize * 14);
  const height = Math.min(workArea.height, vertical ? 2 * toolbarSpace + 100 + fontSize * 10 : toolbarSpace + captionExtent);
  const x = previous ? previous.x + (previous.width - width) / 2 : workArea.x + (workArea.width - width) / 2;
  const y = (previous ? previous.y + previous.height : workArea.y + workArea.height - 24) - height;
  return {
    x: Math.round(Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)),
    width, height,
  };
}

export function bindDesktopLyricsWindow(owner: BrowserWindow, savedBounds?: Rectangle, rememberBounds?: (bounds: Rectangle) => void) {
  let lyrics: BrowserWindow | undefined;
  let config = defaultConfig;
  let previous = savedBounds;
  let placed: Rectangle | undefined;
  let placing = false;
  let passThrough: boolean | undefined;
  let hitTest: ReturnType<typeof setInterval> | undefined;
  const syncPointer = () => {
    if (!lyrics || lyrics.isDestroyed()) return;
    const bounds = lyrics.getContentBounds(), pointer = screen.getCursorScreenPoint();
    const left = bounds.x + bounds.width - MUSIC_LYRICS_LOCK_INSET - MUSIC_LYRICS_LOCK_SIZE;
    const top = bounds.y + MUSIC_LYRICS_LOCK_INSET;
    const overLock = pointer.x >= left && pointer.x < left + MUSIC_LYRICS_LOCK_SIZE && pointer.y >= top && pointer.y < top + MUSIC_LYRICS_LOCK_SIZE;
    const ignore = config.locked && !overLock;
    if (passThrough !== ignore) { passThrough = ignore; lyrics.setIgnoreMouseEvents(ignore); }
  };
  const restoreBounds = () => {
    if (!lyrics || lyrics.isDestroyed()) return;
    const bounds = lyrics.getBounds();
    const next = place(screen.getDisplayMatching(bounds).workArea, config, previous);
    if (next.x === bounds.x && next.y === bounds.y && next.width === bounds.width && next.height === bounds.height) return;
    placing = true;
    try {
      lyrics.setBounds(next);
      placed = lyrics.getBounds();
    } finally { placing = false; }
  };
  const configure = (next: MusicLyricsWindowConfig) => {
    const resized = next.orientation !== config.orientation || next.fontSize !== config.fontSize || next.captionExtent !== config.captionExtent;
    config = next;
    if (!lyrics || lyrics.isDestroyed()) return;
    if (resized) restoreBounds();
    if (config.locked && !hitTest) { hitTest = setInterval(syncPointer, 32); hitTest.unref(); }
    if (!config.locked) { clearInterval(hitTest); hitTest = undefined; }
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
    placed = child.getBounds();
    child.once('closed', () => {
      if (lyrics !== child) return;
      lyrics = undefined; passThrough = undefined; clearInterval(hitTest); hitTest = undefined;
    });
    child.on('move', () => {
      const bounds = child.getBounds();
      // Only a drag updates the anchor. Growing a long lyric near a screen edge can shift its bounds.
      if (!placing && (bounds.x !== placed?.x || bounds.y !== placed?.y)) {
        placed = previous = bounds;
        rememberBounds?.(bounds);
      }
      syncPointer();
    });
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
    configure(config);
    child.showInactive();
  });
  return (url: string, frameName: string): WindowOpenHandlerResponse | undefined => {
    if (frameName !== MUSIC_LYRICS_WINDOW) return;
    if (url !== 'about:blank' || (lyrics && !lyrics.isDestroyed())) return { action: 'deny' };
    const { workArea } = screen.getDisplayMatching(previous ?? owner.getBounds());
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'WorldlineBox · 桌面歌词', frame: false, transparent: true, show: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, fullscreenable: false,
      ...place(workArea, config, previous),
      webPreferences: { backgroundThrottling: false },
    } };
  };
}
