import { ipcRenderer } from 'electron';
import { APPLICATION_NETWORK_CHANGED, APPLICATION_NETWORK_REQUEST, applicationNetworkRequestSchema,
  applicationNetworkResponseSchema, applicationNetworkStateSchema, type ApplicationNetworkRequest,
  type ApplicationNetworkState, type WorldlineBoxApplicationNetworkApi } from '../../shared/application-network';

export const network: WorldlineBoxApplicationNetworkApi = Object.freeze({
  async request(request: ApplicationNetworkRequest) {
    const input = applicationNetworkRequestSchema.parse(request);
    const response = applicationNetworkResponseSchema.safeParse(await ipcRenderer.invoke(APPLICATION_NETWORK_REQUEST, input));
    return response.success ? response.data : { ok: false as const, error: '全局网络返回了无效数据。' };
  },
  onChanged(listener: (state: ApplicationNetworkState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const state = applicationNetworkStateSchema.safeParse(input); if (state.success) listener(state.data);
    };
    ipcRenderer.on(APPLICATION_NETWORK_CHANGED, handler);
    return () => ipcRenderer.removeListener(APPLICATION_NETWORK_CHANGED, handler);
  },
});
