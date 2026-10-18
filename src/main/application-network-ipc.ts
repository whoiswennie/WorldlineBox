import { ipcMain, type BrowserWindow } from 'electron';
import { APPLICATION_NETWORK_CHANGED, APPLICATION_NETWORK_REQUEST, applicationNetworkRequestSchema,
  type ApplicationNetworkResponse } from '../shared/application-network';
import { applicationNetworkState, clearApplicationNetworkDiagnostics, onApplicationNetworkDiagnostics } from './application-network';
import type { LauncherNetwork } from './dsh/launcher-network';

/** A global policy API with no dependency on DSH service activation. */
export function registerApplicationNetworkIpc(getWindow: () => BrowserWindow | null | undefined, network: LauncherNetwork): () => void {
  const publish = () => {
    const owner = getWindow();
    if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      try { owner.webContents.send(APPLICATION_NETWORK_CHANGED, applicationNetworkState(network)); }
      catch { /* A closing Renderer must not turn an applied policy into a failed save. */ }
    }
  };
  const stopPolicy = network.subscribe(publish);
  const stopDiagnostics = onApplicationNetworkDiagnostics(publish);
  ipcMain.handle(APPLICATION_NETWORK_REQUEST, async (event, input: unknown): Promise<ApplicationNetworkResponse> => {
    const owner = getWindow();
    if (!owner || owner.isDestroyed() || owner.webContents.isDestroyed() || event.sender !== owner.webContents || event.senderFrame !== owner.webContents.mainFrame)
      return { ok: false, error: '无权访问全局网络设置。' };
    const parsed = applicationNetworkRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '无效的全局网络请求。' };
    try {
      let text: string | undefined;
      switch (parsed.data.type) {
        case 'state': break;
        case 'network.inspect': await network.inspect(); break;
        case 'network.save': await network.save(parsed.data.settings); await network.inspect(); break;
        case 'network.patch': await network.patch(parsed.data.patch); await network.inspect(); break;
        case 'network.proxy.toggle': await network.setProxyEnabled(parsed.data.enabled); await network.inspect(); break;
        case 'network.test': text = await network.test(); break;
        case 'network.diagnostics.clear': clearApplicationNetworkDiagnostics(); break;
      }
      return { ok: true, state: applicationNetworkState(network), ...(text === undefined ? {} : { text }) };
    } catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }; }
  });
  return () => { stopPolicy(); stopDiagnostics(); ipcMain.removeHandler(APPLICATION_NETWORK_REQUEST); };
}
