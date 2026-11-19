import { ipcMain, screen, type BrowserWindow, type Point, type Rectangle } from 'electron';
import { CALL_PET_ANCHOR_CHANGED, CALL_PET_AVATAR_EDGE, CALL_PET_AVATAR_SIZE, CALL_PET_CLOSED, CALL_PET_COMMAND, CALL_PET_DOCK_INSET, CALL_PET_MAX_HEIGHT, CALL_PET_MAX_WIDTH, isCallPetWindowName, type CallPetAnchor } from '../../shared/companion-call-window';
import { moveWindowInPhysicalPixels } from '../capture-tools/desktop-regions';
import { sendToLiveWebContents } from '../web-contents-send';

const visiblePets = new WeakMap<BrowserWindow, BrowserWindow>();
const ownedPets = new WeakMap<BrowserWindow, BrowserWindow>();
let meeting: { owner: BrowserWindow; room: string; token: string; connected?: boolean } | undefined;
export function markDesktopMeetingConnected(owner: BrowserWindow, room: string, token?: string) {
  if (meeting?.owner === owner && meeting.room === room && meeting.token === token) meeting.connected = true;
}
export const desktopMeetingActive = (room: string) => meeting?.room === room && meeting.connected === true;
export function reserveDesktopMeeting(owner: BrowserWindow, room: string, token: string) {
  if (!meeting) meeting = { owner, room, token };
  return meeting.owner === owner && meeting.room === room && meeting.token === token;
}
export function allowsDesktopMeeting(owner: BrowserWindow, room: string, token?: string) {
  return meeting ? meeting.owner === owner && meeting.room === room && (!token || token === meeting.token) : token === undefined;
}
export function releaseDesktopMeeting(owner: BrowserWindow, token: string) {
  if (meeting?.owner !== owner || meeting.token !== token) return;
  const room = meeting.room;
  meeting = undefined;
  const pet = ownedPets.get(owner);
  if (pet && !pet.isDestroyed()) pet.destroy();
  return room;
}
export const callPetFor = (owner: BrowserWindow) => visiblePets.get(owner);
export const hasDesktopPet = (owner: BrowserWindow) => ownedPets.has(owner);

function petSize(workArea: Rectangle) {
  return { width: Math.min(CALL_PET_MAX_WIDTH, workArea.width), height: Math.min(CALL_PET_MAX_HEIGHT, workArea.height) };
}

function clampPetPosition(workArea: Rectangle, { width, height }: Pick<Rectangle, 'width' | 'height'>, position: Point): Point {
  return {
    x: Math.max(workArea.x, Math.min(workArea.x + workArea.width - width, position.x)),
    y: Math.max(workArea.y, Math.min(workArea.y + workArea.height - height, position.y)),
  };
}

const avatarInset = CALL_PET_AVATAR_EDGE + CALL_PET_AVATAR_SIZE;

function defaultAnchor({ width, height }: Rectangle): CallPetAnchor {
  return { x: width - avatarInset, y: height - CALL_PET_AVATAR_SIZE - CALL_PET_DOCK_INSET,
    side: 'right', edge: 'bottom', stacked: false };
}

function placeCompactPet(workArea: Rectangle, bounds: Rectangle, desired: Point) {
  const size = CALL_PET_AVATAR_SIZE;
  const point = clampPetPosition({
    x: workArea.x + CALL_PET_AVATAR_EDGE, y: workArea.y + CALL_PET_AVATAR_EDGE,
    width: workArea.width - 2 * CALL_PET_AVATAR_EDGE, height: workArea.height - 2 * CALL_PET_AVATAR_EDGE,
  }, { width: size, height: size }, desired);
  const left = point.x - workArea.x, top = point.y - workArea.y;
  const right = workArea.width - left - size, bottom = workArea.height - top - size;
  const side = right > left ? 'left' : 'right';
  const edge = bottom > top ? 'top' : 'bottom';
  const position = clampPetPosition(workArea, bounds, {
    x: point.x - (side === 'left' ? CALL_PET_AVATAR_EDGE : bounds.width - avatarInset),
    y: point.y - (edge === 'top' ? CALL_PET_DOCK_INSET : bounds.height - size - CALL_PET_DOCK_INSET),
  });
  // When the work area is smaller than two overlays, the avatar can sit
  // inside its window. Give the composer the full width if it no longer fits beside it.
  const x = point.x - position.x, y = point.y - position.y;
  const sideWidth = side === 'left' ? bounds.width - x - size : x;
  const anchor: CallPetAnchor = { x, y, side, edge, stacked: sideWidth < 336 };
  return { anchor, point, position };
}

function fitEllipse(ellipse: Rectangle, content: Rectangle): Rectangle[] {
  const radiusX = ellipse.width / 2, radiusY = ellipse.height / 2;
  const centerX = ellipse.x + radiusX, centerY = ellipse.y + radiusY;
  const top = Math.max(0, Math.floor(ellipse.y));
  const bottom = Math.min(content.height, Math.ceil(ellipse.y + ellipse.height));
  const strips: Rectangle[] = [];
  for (let y = top; y < bottom; y++) {
    const distance = Math.max(0, Math.abs(y + 0.5 - centerY) - 0.5) / radiusY;
    const halfWidth = radiusX * Math.sqrt(Math.max(0, 1 - distance ** 2));
    const left = Math.max(0, Math.floor(centerX - halfWidth));
    const right = Math.min(content.width, Math.ceil(centerX + halfWidth));
    if (right <= left) continue;
    const previous = strips.at(-1);
    if (previous?.x === left && previous.width === right - left && previous.y + previous.height === y) previous.height++;
    else strips.push({ x: left, y, width: right - left, height: 1 });
  }
  return strips;
}

function fitPetShape(window: BrowserWindow, width: number, height: number, rects: unknown[]): Rectangle[] {
  const content = window.getContentBounds();
  const scaleX = content.width / width, scaleY = content.height / height;
  return rects.flatMap(rect => {
    if (!rect || typeof rect !== 'object') return [];
    const { x, y, width, height, circular } = rect as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number' ||
        ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
    if (circular === true) return fitEllipse({ x: x * scaleX, y: y * scaleY, width: width * scaleX, height: height * scaleY }, content);
    const left = Math.max(0, Math.floor(x * scaleX)), top = Math.max(0, Math.floor(y * scaleY));
    const right = Math.min(content.width, Math.ceil((x + width) * scaleX));
    const bottom = Math.min(content.height, Math.ceil((y + height) * scaleY));
    return right > left && bottom > top ? [{ x: left, y: top, width: right - left, height: bottom - top }] : [];
  });
}

export function bindCallPetWindow(owner: BrowserWindow, openLyrics?: (url: string, frameName: string) => Electron.WindowOpenHandlerResponse | undefined): void {
  let pet: BrowserWindow | undefined, previousThrottling = true;
  let dragOffset: Point | undefined;
  let draggedPosition: Point | undefined;
  let draggedAnchor: Point | undefined;
  let compact = false;
  let appliedAnchor: CallPetAnchor | undefined;
  let appliedRevision = 0, revision = 0;
  let pending: (ReturnType<typeof placeCompactPet> & { revision: number }) | undefined;
  let queued: { point: Point; workArea: Rectangle } | undefined;
  let shape: Rectangle[] = [];
  let shapeScale = 0;
  const ownerContents = owner.webContents;
  let opening: { name: string; token: string } | undefined;
  let petName: string | undefined;
  const movePet = (window: BrowserWindow, position: Point) => {
    const physical = screen.dipToScreenPoint(position);
    return moveWindowInPhysicalPixels(window.getNativeWindowHandle(), physical.x, physical.y);
  };
  const moveCompactPet = (window: BrowserWindow, point: Point, workArea: Rectangle) => {
    if (pending) { queued = { point, workArea }; return; }
    const bounds = window.getBounds();
    const next = placeCompactPet(workArea, bounds, point);
    const current = appliedAnchor ?? defaultAnchor(bounds);
    if (JSON.stringify(current) === JSON.stringify(next.anchor)) {
      if (movePet(window, next.position)) draggedAnchor = next.point;
      return;
    }
    // Move once the renderer has measured the clickable regions at the new offset.
    pending = { ...next, revision: ++revision };
    sendToLiveWebContents(ownerContents, CALL_PET_ANCHOR_CHANGED, petName, pending.anchor, pending.revision);
  };
  const reset = () => {
    opening = undefined;
    if (meeting?.owner === owner) releaseDesktopMeeting(owner, meeting.token);
    if (pet && !pet.isDestroyed()) pet.destroy();
  };
  ownerContents.on('render-process-gone', reset);
  ownerContents.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) reset();
  });
  ownerContents.setWindowOpenHandler(({ url, frameName }) => {
    const lyrics = openLyrics?.(url, frameName);
    if (lyrics) return lyrics;
    if (process.platform !== 'win32' || url !== 'about:blank' || !isCallPetWindowName(frameName) || pet || meeting?.owner !== owner || opening?.token === meeting.token) return { action: 'deny' };
    opening = { name: frameName, token: meeting.token };
    const lastPosition = draggedAnchor ?? draggedPosition;
    const { workArea } = lastPosition ? screen.getDisplayNearestPoint(lastPosition) : screen.getDisplayMatching(owner.getBounds());
    const { width, height } = petSize(workArea);
    const position = clampPetPosition(workArea, { width, height }, draggedPosition ?? {
      x: workArea.x + workArea.width - width - 24, y: workArea.y + workArea.height - height - 20,
    });
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'WorldlineBox · 伙伴', ...position, width, height,
      transparent: true, backgroundColor: '#00000000', frame: false, show: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false, maximizable: false, fullscreenable: false, minimizable: false,
      maxWidth: CALL_PET_MAX_WIDTH, maxHeight: CALL_PET_MAX_HEIGHT,
    } };
  });
  ownerContents.on('did-create-window', (window, { frameName }) => {
    if (!isCallPetWindowName(frameName)) return;
    if (!opening || opening.name !== frameName || meeting?.token !== opening.token || pet) { window.destroy(); return; }
    opening = undefined;
    pet = window;
    petName = frameName;
    ownedPets.set(owner, window);
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
    const syncDisplay = () => {
      syncBounds();
      if (compact && draggedAnchor) moveCompactPet(window, draggedAnchor, screen.getDisplayNearestPoint(draggedAnchor).workArea);
    };
    screen.on('display-metrics-changed', syncDisplay);
    screen.on('display-removed', syncDisplay);
    syncBounds();
    window.once('closed', () => {
      screen.off('display-metrics-changed', syncDisplay);
      screen.off('display-removed', syncDisplay);
      if (pet !== window) return;
      ownedPets.delete(owner);
      petName = undefined;
      pet = undefined; dragOffset = undefined; shape = []; shapeScale = 0;
      compact = false; appliedAnchor = undefined; appliedRevision = 0; pending = undefined; queued = undefined;
      visiblePets.delete(owner);
      if (ownerContents.isDestroyed()) return;
      ownerContents.setBackgroundThrottling(previousThrottling);
      sendToLiveWebContents(ownerContents, CALL_PET_CLOSED, frameName);
    });
  });
  const command = (event: Electron.IpcMainEvent, action: unknown) => {
    if (!pet || pet.isDestroyed() || ownerContents.isDestroyed() || event.sender !== ownerContents || event.senderFrame !== ownerContents.mainFrame) return;
    if (action && typeof action === 'object' && 'name' in action && 'type' in action && (action.type === 'close' || action.type === 'return')) {
      if (action.name !== petName) return;
      action = action.type;
    }
    if (action && typeof action === 'object' && 'type' in action && action.type === 'layout') {
      if (!('name' in action) || action.name !== petName ||
          !('width' in action) || typeof action.width !== 'number' || !Number.isFinite(action.width) || action.width <= 0 ||
          !('height' in action) || typeof action.height !== 'number' || !Number.isFinite(action.height) || action.height <= 0 ||
          !('rects' in action) || !Array.isArray(action.rects) || action.rects.length > 32) return;
      const anchorRevision = 'anchorRevision' in action ? action.anchorRevision : undefined;
      if (typeof anchorRevision === 'number') {
        if (anchorRevision !== (pending?.revision ?? appliedRevision)) return;
        if (!compact) {
          compact = true;
          if (draggedAnchor) {
            moveCompactPet(pet, draggedAnchor, screen.getDisplayNearestPoint(draggedAnchor).workArea);
            if (pending) return;
          }
        }
      } else if (compact) {
        compact = false;
        dragOffset = undefined;
        if (pending) { appliedAnchor = pending.anchor; appliedRevision = pending.revision; }
        pending = undefined;
        queued = undefined;
      }
      const next = fitPetShape(pet, action.width, action.height, action.rects);
      // An empty Electron shape restores the full rectangle. Keep the last
      // region while the renderer moves or relays out the dock.
      if (!next.length) return;
      if (pending) {
        if (movePet(pet, pending.position)) draggedAnchor = pending.point;
        appliedAnchor = pending.anchor;
        appliedRevision = pending.revision;
        pending = undefined;
      }
      if (JSON.stringify(next) !== JSON.stringify(shape)) {
        shape = next;
        shapeScale = screen.getDisplayMatching(pet.getBounds()).scaleFactor;
        pet.setShape(shape);
      }
      if (!visiblePets.has(owner)) { visiblePets.set(owner, pet); pet.showInactive(); }
      if (queued) {
        const { point, workArea } = queued;
        queued = undefined;
        moveCompactPet(pet, point, workArea);
      }
      return;
    }
    if (action && typeof action === 'object' && 'type' in action && 'x' in action && 'y' in action
      && typeof action.x === 'number' && Number.isFinite(action.x) && typeof action.y === 'number' && Number.isFinite(action.y)) {
      const cursor = { x: Math.round(action.x), y: Math.round(action.y) };
      if (action.type === 'drag-start') {
        const bounds = pet.getBounds();
        const anchor = compact ? appliedAnchor ?? defaultAnchor(bounds) : { x: 0, y: 0 };
        dragOffset = { x: cursor.x - bounds.x - anchor.x, y: cursor.y - bounds.y - anchor.y };
      } else if (action.type === 'drag-move' && dragOffset) {
        const { workArea } = screen.getDisplayNearestPoint(cursor);
        const point = { x: cursor.x - dragOffset.x, y: cursor.y - dragOffset.y };
        if (compact) moveCompactPet(pet, point, workArea);
        else {
          const position = clampPetPosition(workArea, pet.getBounds(), point);
          if (movePet(pet, position)) draggedPosition = position;
        }
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
  owner.once('closed', () => { ipcMain.off(CALL_PET_COMMAND, command); reset(); });
}
