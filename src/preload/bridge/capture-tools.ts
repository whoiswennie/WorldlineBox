import { ipcRenderer } from 'electron';
import { CAPTURE_TOOLS_REQUEST, CAPTURE_TOOLS_CHANGED, CAPTURE_TOOLS_STOP_RECORDING, captureToolsRequestSchema, captureToolsResponseSchema, captureToolsStateSchema, type CaptureToolsRequest, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';

export const captureTools: WorldlineBoxCaptureToolsApi = Object.freeze({
  async request(request: CaptureToolsRequest) {
    const input = captureToolsRequestSchema.parse(request);
    const parsed = captureToolsResponseSchema.safeParse(await ipcRenderer.invoke(CAPTURE_TOOLS_REQUEST, input));
    return parsed.success ? parsed.data : { ok: false as const, error: '屏幕工具返回了无效数据。' };
  },
  onChanged(listener: (state: CaptureToolsState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const parsed = captureToolsStateSchema.safeParse(input); if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(CAPTURE_TOOLS_CHANGED, handler);
    return () => ipcRenderer.removeListener(CAPTURE_TOOLS_CHANGED, handler);
  },
  onStopRecording(listener: () => void) {
    const handler = () => listener(); ipcRenderer.on(CAPTURE_TOOLS_STOP_RECORDING, handler);
    return () => ipcRenderer.removeListener(CAPTURE_TOOLS_STOP_RECORDING, handler);
  },
});
