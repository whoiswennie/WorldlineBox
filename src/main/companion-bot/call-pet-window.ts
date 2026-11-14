import { ipcMain, screen, type BrowserWindow, type Point, type Rectangle } from 'electron';
import { CALL_PET_CLOSED, CALL_PET_COMMAND, CALL_PET_MAX_HEIGHT, CALL_PET_MAX_WIDTH, CALL_PET_WINDOW } from '../../shared/companion-call-window';
import { moveWindowInPhysicalPixels } from '../capture-tools/desktop-regions';

const visiblePets = new WeakMap<BrowserWindow, BrowserWindow>();
export const callPetFor = (owner: BrowserWindow) => visiblePets.get(owner);

function petSize(workArea: Rectangle) {
  return { width: Math.min(CALL_PET_MAX_WIDTH, workArea.width), height: Math.min(CALL_PET_MAX_HEIGHT, workArea.height) };
}

function clampPetPosition(workArea: Rectangle, { width, height }: Pick<Rectangle, 'width' | 'height'>, position: Point): Point {
  return {
    x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, position.x)),
    y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, position.y)),
  };
}

function fitPetShape(window: BrowserWindow, width: number, height: number, rects: unknown[]): Rectangle[] {
  const content = window.getContentBounds();
  const scaleX = content.width / width, scaleY = content.height / height;
  return rects.flatMap(rect => {
    if (!rect || typeof rect !== 'object') return [];
    const { x, y, width, height } = rect as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
        ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    const left = Math.max(0, Math.floor(x * scaleX)), top = Math.max(0, Math.floor(y * scaleY));
    const right = Math.min(content.width, Math.ceil((x + width) * scaleX));
    const bottom = Math.min(content.height, Math.ceil((y + height) * scaleY));
    return right > left && bottom > top ? [{ x: left, y: top, width: right - left, height: bottom - top }] : [];
  });
}

export function bindCallPetWindow(owner: BrowserWindow): void {
  let pet: BrowserWindow | undefined, previousThrottling = true;
  let dragOffset: Point | undefined;
  let shape: Rectangle[] = [];
  let shapeScale = 0;
  const ownerContents = owner.webContents;
  ownerContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) pet?.destroy();
  });
  ownerContents.setWindowOpenHandler(({ url, frameName }) => {
    if (process.platform !== 'win32' || url !== 'about:blank' || frameName !== CALL_PET_WINDOW || pet) return { action: 'deny' };
    const { workArea } = screen.getDisplayMatching(owner.getBounds());
    const { width, height } = petSize(workArea);
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'WorldlineBox · 伙伴', x: workArea.x + Math.max(0, workArea.width - width - 24),
      y: workArea.y + Math.max(0, workArea.height - height - 20), width, height,
      transparent: true, backgroundColor: '#00000000', frame: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, fullscreenable: false, minimizable: false,
      maxWidth: CALL_PET_MAX_WIDTH, maxHeight: CALL_PET_MAX_HEIGHT,
    } };
  });
  ownerContents.on('did-create-window', (window, { frameName }) => {
    if (frameName !== CALL_PET_WINDOW) return;
    pet = window;
    previousThrottling = ownerContents.getBackgroundThrottling();
    ownerContents.setBackgroundThrottling(false);
    window.setAlwaysOnTop(true, 'floating');
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => event.preventDefault());
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    const syncBounds = () => {
      const bounds = window.getBounds();
      const { workArea, scaleFactor } = screen.getDisplayMatching(bounds);
      const limit = petSize(workArea);
      const width = Math.min(bounds.width, limit.width), height = Math.min(bounds.height, limit.height);
      // Electron can round fractional DPI bounds up by one DIP.
      if (bounds.width > width + 1 || bounds.height > height + 1) {
        window.setBounds({ ...clampPetPosition(workArea, { width, height }, bounds), width, height });
      }
      if (shape.length && shapeScale !== scaleFactor) {
        shapeScale = scaleFactor;
        window.setShape(shape);
      }
    };
    window.on('resize', syncBounds);
    window.on('move', syncBounds);
    screen.on('display-metrics-changed', syncBounds);
    window.once('closed', () => {
      screen.off('display-metrics-changed', syncBounds);
      pet = undefined; dragOffset = undefined; shape = []; shapeScale = 0;
      visiblePets.delete(owner);
      if (ownerContents.isDestroyed()) return;
      ownerContents.setBackgroundThrottling(previousThrottling);
      ownerContents.send(CALL_PET_CLOSED);
    });
  });
  const command = (event: Electron.IpcMainEvent, action: unknown) => {
    if (!pet || pet.isDestroyed() || ownerContents.isDestroyed() || event.sender !== ownerContents || event.senderFrame !== ownerContents.mainFrame) return;
    if (action && typeof action === 'object' && 'type' in action && action.type === 'layout') {
      if (!('width' in action) || typeof action.width !== 'number' || !Number.isFinite(action.width) || action.width <= 0 ||
          !('height' in action) || typeof action.height !== 'number' || !Number.isFinite(action.height) || action.height <= 0 ||
          !('rects' in action) || !Array.isArray(action.rects) || action.rects.length > 32) return;
      const next = fitPetShape(pet, action.width, action.height, action.rects);
      // An empty Electron shape restores the full rectangle. Keep the last
      // region while the renderer moves or relays out the dock.
      if (!next.length) return;
      if (JSON.stringify(next) !== JSON.stringify(shape)) {
        shape = next;
        shapeScale = screen.getDisplayMatching(pet.getBounds()).scaleFactor;
        pet.setShape(shape);
      }
      if (!visiblePets.has(owner)) { visiblePets.set(owner, pet); pet.showInactive(); }
      return;
    }
    if (action && typeof action === 'object' && 'type' in action && 'x' in action && 'y' in action
      && typeof action.x === 'number' && Number.isFinite(action.x) && typeof action.y === 'number' && Number.isFinite(action.y)) {
      const cursor = { x: Math.round(action.x), y: Math.round(action.y) };
      if (action.type === 'drag-start') {
        const { x, y } = pet.getBounds();
        dragOffset = { x: cursor.x - x, y: cursor.y - y };
      } else if (action.type === 'drag-move' && dragOffset) {
        const { workArea } = screen.getDisplayNearestPoint(cursor);
        const position = clampPetPosition(workArea, pet.getBounds(), { x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y });
        const physical = screen.dipToScreenPoint(position);
        moveWindowInPhysicalPixels(pet.getNativeWindowHandle(), physical.x, physical.y);
      }
      return;
    }
    switch (action) {
      case 'return':
        pet.close();
        if (owner.isMinimized()) owner.restore();
        owner.show(); owner.focus();
        break;
      case 'close': pet.close(); break;
      case 'drag-end': dragOffset = undefined; break;
    }
  };
  ipcMain.on(CALL_PET_COMMAND, command);
  owner.once('closed', () => { ipcMain.off(CALL_PET_COMMAND, command); if (pet && !pet.isDestroyed()) pet.destroy(); });
}
