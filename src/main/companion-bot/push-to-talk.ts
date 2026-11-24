import { powerMonitor, type BrowserWindow } from 'electron';
import type * as Koffi from 'koffi';
import type { BotPushToTalkEvent } from '../../shared/companion-push-to-talk';

const WM_INPUT = 0xff, WM_INPUT_DEVICE_CHANGE = 0xfe;
const RID_INPUT = 0x10000003, RIDEV_REMOVE = 0x01, RIDEV_INPUTSINK = 0x100, RIDEV_DEVNOTIFY = 0x2000;
const VK_CONTROL = 0x11, VK_LCONTROL = 0xa2, VK_RCONTROL = 0xa3;
const holdDelayMs = 200;
const isControl = (key: number) => key === VK_CONTROL || key === VK_LCONTROL || key === VK_RCONTROL;

/** Observe Windows keyboard events without claiming Ctrl or replacing normal input. */
export function registerBotPushToTalk(window: BrowserWindow, emit: (event: BotPushToTalkEvent) => void): () => void {
  if (process.platform !== 'win32') return () => undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const user32 = (require('koffi') as typeof Koffi).load('user32.dll');
  const register = user32.func('int __stdcall RegisterRawInputDevices(const uint8_t *devices, uint32_t count, uint32_t size)');
  const read = user32.func('uint32_t __stdcall GetRawInputData(uintptr_t input, uint32_t command, uint8_t *data, uint8_t *size, uint32_t headerSize)');
  const keyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const isDown = (key: number) => (keyState(key) & 0x8000) !== 0;
  const handle = window.getNativeWindowHandle(), pointerSize = handle.length;
  const readPointer = (pointer: Buffer) => pointerSize === 8 ? pointer.readBigUInt64LE() : pointer.readUInt32LE();
  const keyboard = Buffer.alloc(8 + pointerSize);
  keyboard.writeUInt16LE(1); // Generic Desktop Controls usage page.
  keyboard.writeUInt16LE(6, 2); // Keyboard usage.
  keyboard.writeUInt32LE(RIDEV_INPUTSINK | RIDEV_DEVNOTIFY, 4);
  handle.copy(keyboard, 8);
  if (!register(keyboard, 1, keyboard.length)) throw Error('无法注册伙伴语音的 Windows 键盘输入。');

  const headerSize = 8 + 2 * pointerSize;
  const input = Buffer.alloc(headerSize + 16), size = Buffer.alloc(4);
  const held = new Set<number>();
  let pending: ReturnType<typeof setTimeout> | undefined, recording = false;
  const stop = (event: 'release' | 'discard' | 'cancel') => {
    clearTimeout(pending);
    pending = undefined;
    if (recording) { recording = false; emit(event); }
  };
  const cancel = () => { held.clear(); stop('cancel'); };
  const start = () => {
    pending = undefined;
    if (!isDown(VK_CONTROL)) return;
    // A key may already have been held before Ctrl went down.
    for (let key = 1; key < 0xff; key++) if (!isControl(key) && isDown(key)) return;
    recording = true;
    emit('press');
  };
  window.hookWindowMessage(WM_INPUT, (_message, rawHandle) => {
    size.writeUInt32LE(input.length);
    if (read(readPointer(rawHandle), RID_INPUT, input, size, headerSize) !== input.length || input.readUInt32LE() !== 1) return;
    const key = input.readUInt16LE(headerSize + 6);
    if (key >= 0xff) return;
    const flags = input.readUInt16LE(headerSize + 2);
    const released = (flags & 1) !== 0; // RI_KEY_BREAK.
    if (!isControl(key)) {
      if (!released && held.size) stop('discard');
      return;
    }
    const side = key === VK_CONTROL ? (flags & 2 ? VK_RCONTROL : VK_LCONTROL) : key;
    if (released) {
      if (held.delete(side) && !held.size) stop('release');
    } else if (!held.has(side)) {
      held.add(side);
      if (held.size === 1) pending = setTimeout(start, holdDelayMs);
      else stop('discard');
    }
  });
  window.hookWindowMessage(WM_INPUT_DEVICE_CHANGE, notification => {
    if (notification.readUInt32LE() === 2) cancel(); // GIDC_REMOVAL.
  });
  powerMonitor.on('suspend', cancel);
  powerMonitor.on('lock-screen', cancel);
  return () => {
    cancel();
    powerMonitor.off('suspend', cancel);
    powerMonitor.off('lock-screen', cancel);
    keyboard.writeUInt32LE(RIDEV_REMOVE, 4);
    keyboard.fill(0, 8);
    register(keyboard, 1, keyboard.length);
    if (!window.isDestroyed()) {
      window.unhookWindowMessage(WM_INPUT);
      window.unhookWindowMessage(WM_INPUT_DEVICE_CHANGE);
    }
  };
}
