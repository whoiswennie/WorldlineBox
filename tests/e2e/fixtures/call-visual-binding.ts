import type { ElectronApplication, Page } from '@playwright/test';
import { DSH_LAUNCHER_CHANGED_CHANNEL, type WorldlineBoxDshLauncherApi } from '../../../src/shared/dsh-launcher';
import { botUiSharedLauncher } from '../../fixtures/bot-ui-shared-launcher';

/** Visual-only tests use an explicit launcher presentation fixture. The
 * call itself still uses the real preload, Main and local model files. */
export async function enableCallVisualFixture(application: ElectronApplication, page: Page) {
  const launcher = await page.evaluate(async () => {
    const api = Reflect.get(window, 'worldlinebox') as { dshLauncher: WorldlineBoxDshLauncherApi };
    const result = await api.dshLauncher.request({ type: 'state' });
    return result.ok ? result.state : undefined;
  });
  const result = await botUiSharedLauncher().request({ type: 'state' });
  if (!result.ok || !result.state) throw Error('Missing shared DSH fixture.');
  await application.evaluate(({ BrowserWindow }, payload) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    // Packaged first launch can broadcast real launcher state after setup closes.
    // Keep this visual fixture in place while the bundled runtime initializes.
    contents.send = (channel, ...args) => {
      if (channel === payload.channel) send(channel, payload.state);
      else send(channel, ...args);
    };
    contents.send(payload.channel, payload.state);
  }, { channel: DSH_LAUNCHER_CHANGED_CHANNEL, state: { ...launcher, ...result.state } });
}
