import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserService } from '../../../src/main/browser/service';
import { closeApplicationNetwork } from '../../../src/main/application-network';
import { nativeCallback, nativeServiceFixture } from '../bot-native-service';
import type { BotRequest } from '../../../src/shared/companion-bot';
import { browserRequestSchema } from '../../../src/shared/browser';

const profile = path.resolve(process.env.WORLDLINEBOX_BROWSER_APPS_PROFILE ?? '');
if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-browser-apps-')) throw Error('Expected an owned browser-apps profile');
app.setPath('userData', profile); app.setPath('sessionData', profile);
void app.whenReady().then(async () => {
  const owner = new BrowserWindow({ width: 1400, height: 950, show: false, webPreferences: { offscreen: true, preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false } });
  owner.webContents.setBackgroundThrottling(false); owner.webContents.setAudioMuted(true);
  const browser = new BrowserService(() => owner, path.join(profile, 'browser'));
  const calls: Array<{ tabId: string; result: unknown }> = [];
  // Deterministic Agent boundary. Real host validation, SQLite persistence,
  // authenticated tool callbacks and native Chromium page reads stay intact.
  const bot = await nativeServiceFixture(async input => {
    const context = JSON.parse(input.prompt).browserContext as { tabId: string } | undefined;
    if (!context) return '未附加网页';
    const read = await nativeCallback(input, 'browser', { action: 'read', tabId: context.tabId }, 'read-selected-' + input.eventId);
    if (!read.ok) throw Error(read.error);
    calls.push({ tabId: context.tabId, result: read.result });
    return JSON.stringify(read.result);
  }, { resolveBrowserContext: id => browser.resolveCompanionContext(id), browserTool: (scope, input, signal) => browser.companionTool(scope, input, signal) });
  ipcMain.handle('fixture:browser', (_event, value: unknown) => browser.handle(browserRequestSchema.parse(value)));
  ipcMain.handle('fixture:bot', (_event, input: BotRequest) => bot.service.handle(input));
  ipcMain.handle('fixture:proof', () => ({ calls, botRoot: bot.root }));
  let closing = false;
  app.on('before-quit', event => {
    if (closing) return; event.preventDefault(); closing = true;
    void bot.close().then(() => browser.shutdown()).then(() => closeApplicationNetwork()).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
  });
  await owner.loadFile(path.join(__dirname, 'renderer/index.html'));
}).catch(error => { console.error(error); app.exit(1); });
