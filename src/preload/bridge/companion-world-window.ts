import { ipcRenderer } from 'electron';
import { COMPANION_WORLD_WINDOW_CHANNEL, COMPANION_WORLD_WINDOW_CHANGED_CHANNEL, COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL,
  companionWorldWindowResultSchema, companionWorldWindowVisibilitySchema, companionWorldWindowOpenSchema,
  companionWorldObserverRequestSchema, companionWorldWindowControlSchema, type CompanionWorldWindowApi } from '../../shared/companion-world-window';

async function invoke(command: unknown) {
  const parsed = companionWorldWindowResultSchema.safeParse(await ipcRenderer.invoke(COMPANION_WORLD_WINDOW_CHANNEL, command));
  return parsed.success ? parsed.data : { ok: false, error: '世界窗口返回格式不正确。' };
}
export const companionWorld: CompanionWorldWindowApi = Object.freeze<CompanionWorldWindowApi>({
  open: input => invoke({ type: 'open', ...companionWorldWindowOpenSchema.parse(input ?? {}) }),
  context: () => invoke({ type: 'context' }),
  request: async input => {
    const result = await invoke({ type: 'request', request: companionWorldObserverRequestSchema.parse(input) });
    return result.response ?? { ok: false, error: result.error ?? '世界状态暂时无法读取。' };
  },
  control: action => invoke({ type: 'control', action: companionWorldWindowControlSchema.parse(action) }),
  onChanged: listener => {
    const handler = () => listener(); ipcRenderer.on(COMPANION_WORLD_WINDOW_CHANGED_CHANNEL, handler);
    return () => { ipcRenderer.removeListener(COMPANION_WORLD_WINDOW_CHANGED_CHANNEL, handler); };
  },
  onVisibility: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { const parsed = companionWorldWindowVisibilitySchema.safeParse(value); if (parsed.success) listener(parsed.data); };
    ipcRenderer.on(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, handler); return () => { ipcRenderer.removeListener(COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL, handler); };
  },
});
