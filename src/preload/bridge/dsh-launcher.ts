import { ipcRenderer } from 'electron';
import { DSH_LAUNCHER_CHANNEL, DSH_LAUNCHER_CHANGED_CHANNEL, DSH_TERMINAL_OUTPUT_CHANNEL, DSH_TASK_EVENT_CHANNEL, dshLauncherResponseSchema, dshLauncherStateSchema, dshTerminalOutputSchema, type DshTerminalOutput, type DshLauncherRequest, type DshLauncherState, type WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { dshTaskEventSchema, type DshTaskEvent } from '../../shared/dsh-tasks';

export const dshLauncher: WorldlineBoxDshLauncherApi = Object.freeze({
  async request(input: DshLauncherRequest) {
    const result = dshLauncherResponseSchema.safeParse(await ipcRenderer.invoke(DSH_LAUNCHER_CHANNEL, input));
    return result.success ? result.data : { ok: false as const, error: 'Invalid DSH launcher response.' };
  },
  onChanged(listener: (state: DshLauncherState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      const parsed = dshLauncherStateSchema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(DSH_LAUNCHER_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DSH_LAUNCHER_CHANGED_CHANNEL, handler);
  },
  onTerminalOutput(listener: (output: DshTerminalOutput) => void) {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => { const parsed = dshTerminalOutputSchema.safeParse(value); if (parsed.success) listener(parsed.data); };
    ipcRenderer.on(DSH_TERMINAL_OUTPUT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DSH_TERMINAL_OUTPUT_CHANNEL, handler);
  },
  onTaskEvent(listener: (event: DshTaskEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const result = dshTaskEventSchema.safeParse(input); if (result.success) listener(result.data);
    };
    ipcRenderer.on(DSH_TASK_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DSH_TASK_EVENT_CHANNEL, handler);
  },
});
