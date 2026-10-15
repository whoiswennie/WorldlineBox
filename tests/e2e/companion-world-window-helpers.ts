import { expect, type ElectronApplication, type Page } from '@playwright/test';

export async function openCompanionWorldWindow(application: ElectronApplication, page: Page): Promise<Page> {
  const opened = application.waitForEvent('window');
  await page.getByRole('button', { name: '打开伙伴世界', exact: true }).click();
  const observer = await opened, native = await application.browserWindow(observer);
  await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  await expect(observer.getByRole('region', { name: '伙伴世界', exact: true })).toBeVisible();
  return observer;
}
