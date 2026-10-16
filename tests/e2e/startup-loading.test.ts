import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

// The only fixture is the isolated profile; native startup, integrity checks,
// renderer handoff and timestamp logging all execute their production paths.
// eslint-disable-next-line no-empty-pattern
test('opens branded loading surfaces without focus and records real startup stages', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const qa = path.resolve('.tools/test-output/startup-qa'); mkdirSync(qa, { recursive: true });
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-startup-'));
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_STARTUP_SCREEN: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: root }, { gpu: 'software' }) });
  try {
    const first = await application.firstWindow();
    if (first.url().startsWith('data:')) {
      // Integrity checks can finish before automation attaches on a fast disk.
      // Observe and capture the native surface when it is still present; never
      // slow the production code just to make this screenshot deterministic.
      const observed = await first.locator('.startup-logo').evaluate(async image => { await (image as HTMLImageElement).decode(); return { width: (image as HTMLImageElement).naturalWidth, phase: document.querySelector('[data-startup-stage]')?.textContent, busy: document.querySelector('.startup-screen')?.getAttribute('aria-busy') }; }).catch(() => undefined);
      if (observed) {
        expect(observed.width).toBe(256); expect(observed.busy).toBe('true'); expect(observed.phase).toBeTruthy();
        await testInfo.attach('native-startup-observation', { body: JSON.stringify(observed), contentType: 'application/json' });
        writeFileSync(path.join(qa, 'native-startup-observation.json'), JSON.stringify(observed, null, 2));
        const screenshot = await first.screenshot({ path: testInfo.outputPath('startup-native.png'), timeout: 1000 }).catch(() => undefined);
        if (screenshot) writeFileSync(path.join(qa, 'startup-native.png'), screenshot);
      }
    }
    await expect.poll(async () => application.windows().find(page => page.url().includes('index.html'))?.url() ?? '', { timeout: 60_000 }).toContain('index.html');
    const page = application.windows().find(page => page.url().includes('index.html'))!;
    await expect(page.locator('.application-navigation')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.startup-screen')).toHaveCount(0);
    const visible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()));
    expect(visible).toBe(false);
    const logs = () => readdirSync(path.join(root, 'logs')).filter(name => name.endsWith('.log')).map(name => readFileSync(path.join(root, 'logs', name), 'utf8')).join('\n');
    await expect.poll(logs).toContain('startup.renderer.ready');
    const content = logs(); for (const phase of ['environment', 'services', 'storage', 'interface', 'main-ready']) expect(content).toContain(`"phase":"${phase}"`);
    expect(content).toContain('durationMs'); expect(content).toContain('totalMs');
    const phaseLog = content.split('\n').filter(line => line.includes('startup.')).join('\n');
    await testInfo.attach('startup-phases', { body: phaseLog, contentType: 'text/plain' });
    writeFileSync(path.join(qa, 'startup-phases.txt'), phaseLog);
    // Exercise the renderer's actual retry navigation, rather than CDP Page.reload
    // which bypasses Electron's will-navigate security handler.
    const beforeReload = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => { window.location.reload(); });
    await expect.poll(() => page.evaluate(() => performance.timeOrigin).catch(() => beforeReload), { timeout: 60_000 }).not.toBe(beforeReload);
    await expect(page.locator('.application-navigation')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.startup-screen')).toHaveCount(0);
    // A controlled replay of the exact shipped HTML/CSS checks both visual themes.
    // This replay is never used as evidence of measured startup duration.
    const native = await application.browserWindow(page);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    expect(await native.evaluate(window => window.isFocused())).toBe(false);
    const shipped = await application.evaluate(({ app }) => {
      // Electron's fs resolves app.asar members; ordinary test-runner Node fs cannot.
      const fs = process.getBuiltinModule('node:fs'), paths = process.getBuiltinModule('node:path');
      const directory = paths.join(app.getAppPath(), '.vite/renderer/main_window');
      const html = fs.readFileSync(paths.join(directory, 'index.html'), 'utf8');
      const asset = (relative: string) => {
        if (!relative.startsWith('./assets/') || relative.includes('..')) throw new Error('Unexpected shipped startup asset');
        return paths.join(directory, relative);
      };
      const shell = html.match(/<div id="startup-shell">([\s\S]*?)<div id="root">/)?.[1];
      const image = shell?.match(/<img[^>]+src="([^"]+)"/)?.[1];
      const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(match => match[0].match(/href="([^"]+)"/)?.[1]).filter((value): value is string => Boolean(value));
      if (!shell || !image || !styles.length) throw new Error('Shipped startup surface is missing');
      return { shell, style: styles.map(value => fs.readFileSync(asset(value), 'utf8')).join('\n'), logo: fs.readFileSync(asset(image)).toString('base64') };
    });
    const { shell, style, logo } = shipped;
    await page.evaluate(({ shell, style, logo }) => {
      const element = document.createElement('div'); element.id = 'startup-visual-check'; element.innerHTML = shell!;
      element.querySelector('img')!.src = 'data:image/png;base64,' + logo; const css = document.createElement('style'); css.textContent = style; element.append(css); document.body.append(element);
    }, { shell, style, logo });
    await expect(page.locator('#startup-visual-check img')).toHaveJSProperty('naturalWidth', 256);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await page.locator('.startup-orbit').evaluate(element => getComputedStyle(element, '::after').animationName)).toBe('none');
      const screenshot = await page.screenshot({ path: testInfo.outputPath(`startup-${theme}.png`) });
      writeFileSync(path.join(qa, `startup-${theme}.png`), screenshot);
    }
  } finally {
    await application.close(); cleanup(root);
  }
});

function cleanup(root: string) { const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-startup-')) throw new Error('Invalid startup cleanup path'); rmSync(absolute, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
