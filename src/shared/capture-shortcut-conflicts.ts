import type { CaptureToolsSettings, CaptureToolTask } from './capture-tools';
import type { ShortcutBindings } from './shortcut-bindings';
import { SHORTCUT_ACTIONS, type ShortcutPlatform } from './shortcut-catalog';
import { formatElectronAccelerator, resolveActionChords } from './shortcut-resolution';

/** Compare Electron accelerator aliases without depending on Electron in the renderer. */
function acceleratorIdentity(value: string, platform: ShortcutPlatform): string {
  const parts = value.toLowerCase().split('+').map(part => part.trim().replace(/\s+/g, ''));
  const aliases: Readonly<Record<string, string>> = {
    ctrl: 'control', cmd: 'command', cmdorctrl: platform === 'mac' ? 'command' : 'control',
    commandorcontrol: platform === 'mac' ? 'command' : 'control', option: 'alt',
    super: platform === 'mac' ? 'command' : 'meta', esc: 'escape', return: 'enter',
    left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown',
    period: '.', comma: ',',
  };
  const key = parts.pop();
  if (!key) return '';
  return [...parts.map(part => aliases[part] ?? part).sort(), aliases[key] ?? key].join('+');
}

export type CaptureShortcutConflict = {
  readonly actionId: string;
  readonly task: CaptureToolTask;
};

/** Global screen-tool bindings overlap every application/viewer/sidebar scope. */
export function findCaptureShortcutConflict(
  bindings: ShortcutBindings,
  platform: ShortcutPlatform,
  shortcuts: CaptureToolsSettings['shortcuts'],
): CaptureShortcutConflict | null {
  const globals = new Map(Object.entries(shortcuts).flatMap(([task, value]) => {
    const identity = acceleratorIdentity(value, platform);
    return identity ? [[identity, task as CaptureToolTask] as const] : [];
  }));
  for (const action of SHORTCUT_ACTIONS) {
    for (const chord of resolveActionChords(action.id, platform, bindings)) {
      const accelerator = formatElectronAccelerator(chord, platform);
      if (!accelerator) continue;
      const task = globals.get(acceleratorIdentity(accelerator, platform));
      if (task) return { actionId: action.id, task };
    }
  }
  return null;
}
