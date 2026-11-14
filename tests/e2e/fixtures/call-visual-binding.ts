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
    BrowserWindow.getAllWindows()[0]!.webContents.send(payload.channel, payload.state);
  }, { channel: DSH_LAUNCHER_CHANGED_CHANNEL, state: { ...launcher, ...result.state } });
}
