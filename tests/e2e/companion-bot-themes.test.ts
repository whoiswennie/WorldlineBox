import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator } from '@playwright/test';
import { build } from 'vite';
import type { BotPeerWorkspaceFixture } from '../fixtures/bot-peer-workspace-fixture';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { THEME_PROFILE_PRESETS, type ThemeProfileId } from '../../src/renderer/theme/theme-profiles';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function hashFile(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

// eslint-disable-next-line no-empty-pattern -- Electron owns the page, not a browser fixture.
test('companions inherit appearance profiles and a single playable wallpaper without obscuring conversation controls', async ({}, testInfo) => {
  test.setTimeout(180_000);
  testInfo.annotations.push({ type: 'renderer-wallpaper-contract', description: 'Isolated real packaged IPC/renderer, human-authored BotStore messages, bundled MP4 decoding and controlled focus events. No model credentials, paid inference, DSH task, hardware FPS or foreground-window performance claim.' });
  const prefix = 'wlb-peer-workspace-themes-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  if (path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith(prefix)
    || (await lstat(profile)).isSymbolicLink() || path.resolve(await realpath(profile)) !== path.resolve(profile)) throw Error('Theme checks require their owned profile.');
  const fixtureDirectory = testInfo.outputPath('fixture'); await mkdir(fixtureDirectory, { recursive: true });
  await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: {
    ssr: 'tests/fixtures/bot-theme-workspace-fixture.ts', target: 'node24', outDir: fixtureDirectory, emptyOutDir: false,
    rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } },
  } });
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  const suffix = process.env.WORLDLINEBOX_E2E_THEME_EVIDENCE_SUFFIX;
  if (suffix && !/^[a-z0-9-]{1,40}$/u.test(suffix)) throw Error('Theme evidence suffix must be a short directory label.');
  const checks: unknown[] = [], captures: unknown[] = [], evidence = path.resolve('artifacts/superagent-bot-development/ui', suffix ? `themes-${suffix}` : '.');
  await mkdir(evidence, { recursive: true });
  let initialHash: string | undefined, completed = false;
  try {
    const page = await application.firstWindow(); page.setDefaultTimeout(15_000);
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Theme acceptance must not read a production profile.');
      const tracker = { paints: 0 }; Reflect.set(globalThis, '__themeAcceptanceFrames', tracker);
      for (const owned of BrowserWindow.getAllWindows()) {
        owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false);
        owned.webContents.on('paint', (_event, _rect, image) => {
          tracker.paints++;
          if (!image.isEmpty()) Reflect.set(globalThis, '__themeAcceptanceLatest', { sequence: tracker.paints, size: image.getSize(), image });
        });
        owned.setMinimumSize(0, 0); owned.setSize(1600, 1000); owned.hide();
      }
      return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), pid: process.pid,
        offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, profile);
    expect(identity.offscreen).toBe(true);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    initialHash = identity.packaged ? await hashFile(identity.appPath) : undefined;
    const companions = page.locator('[data-application-module="companions"]');
    await companions.click(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const seeded = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected theme fixture profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), paths = process.getBuiltinModule('node:path');
      const require = createRequire(paths.join(app.getAppPath(), 'package.json')), fs = require('node:fs');
      const catalogFile = paths.join(input.profile, 'ai-profiles.json'), keyRoot = paths.join(input.profile, 'ai-profile-keys');
      const catalog = fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : { activeProfileId: null, profiles: [] };
      if (catalog.activeProfileId || catalog.profiles.length || fs.existsSync(paths.join(input.profile, 'ai-key.enc')) || fs.existsSync(keyRoot) && fs.readdirSync(keyRoot).length) throw Error('Visual theme fixtures cannot contain model credentials.');
      return (require(input.fixture) as { seedPeerWorkspace(profile: string): BotPeerWorkspaceFixture }).seedPeerWorkspace(input.profile);
    }, { profile, fixture: path.join(fixtureDirectory, 'seed.cjs') });
    expect(seeded.pendingEvents).toBe(0);
    const attachmentPaths = ['阅读说明.txt', '主题记录.md', '本群附件.txt'].map(name => path.join(profile, name));
    for (const filename of attachmentPaths) await writeFile(filename, `这是隔离主题验收资料：${path.basename(filename)}，没有用户真实文件。`);
    await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, attachmentPaths);
    const imported = await page.evaluate(async conversationId => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBotMedia: WorldlineBoxBotMediaApi; companionBot: WorldlineBoxBotApi };
      const notice = await bridge.companionBot.request({ type: 'conversation.announcement', conversationId, content: '主题验证 · 共享资料在本群查看，附件默认折叠。', expectedUpdatedAt: null });
      if (!notice.ok) throw Error(notice.error);
      return bridge.companionBotMedia.request({ type: 'files.pick', conversationId });
    }, seeded.peerId);
    expect(imported.ok).toBe(true); expect(imported.media).toHaveLength(3);
    const attachmentFixture = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Unexpected attachment fixture profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), paths = process.getBuiltinModule('node:path');
      const require = createRequire(paths.join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedThemeAttachments(profile: string, room: string, media: BotMediaRef[]): { messageId: string; userSingleId: string; partnerSingleId: string; attachments?: number; pendingEvents: number } }).seedThemeAttachments(input.profile, input.room, input.media);
    }, { profile, fixture: path.join(fixtureDirectory, 'seed.cjs'), room: seeded.peerId, media: imported.media! });
    expect(attachmentFixture.attachments).toBe(3); expect(attachmentFixture.pendingEvents).toBe(0);
    // Reload only after the real main page is ready and the isolated store is seeded.
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    await expect(page.getByRole('log')).toContainText('晚安呀，今天也辛苦了。');
    const openAppearance = async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
      await settings.getByRole('tab', { name: '外观', exact: true }).click(); return settings;
    };
    const openBackground = async (settings: Locator) => { const disclosure = settings.getByRole('button', { name: /^应用背景/u }); if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click(); };
    const capture = async (name: string) => {
      await expect(page.locator('.application-navigation')).toBeVisible();
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = await application.evaluate(({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows()[0]!, baseline = (Reflect.get(globalThis, '__themeAcceptanceFrames') as { paints: number }).paints;
        target.webContents.stopPainting(); target.webContents.startPainting(); target.webContents.invalidate(); return { baseline, content: target.getContentSize() };
      });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__themeAcceptanceLatest') as { sequence: number } | undefined)?.sequence ?? 0)).toBeGreaterThan(before.baseline);
      const paint = await application.evaluate(({ BrowserWindow }, required) => {
        const frame = Reflect.get(globalThis, '__themeAcceptanceLatest') as { sequence: number; size: { width: number; height: number }; image: { toPNG(): Buffer } };
        const content = BrowserWindow.getAllWindows()[0]!.getContentSize();
        if (frame.sequence <= required.baseline || content[0] !== required.content[0] || content[1] !== required.content[1]
          || Math.abs(frame.size.width - content[0]!) > 1 || Math.abs(frame.size.height - content[1]!) > 1) throw Error(`Theme screenshot has a stale compositor surface: ${JSON.stringify({ size: frame.size, content, required })}`);
        return { sequence: frame.sequence, size: frame.size, content, png: frame.image.toPNG().toString('base64') };
      }, before);
      const { png, ...frame } = paint; captures.push({ name, ...frame, rawUncropped: true, windowsRasterRoundingTolerance: 1 });
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await copyFile(file, path.join(evidence, name));
      await testInfo.attach(name, { path: file, contentType: 'image/png' });
    };
    const audit = async (preset: ThemeProfileId, tone: 'light' | 'dark', wallpaper: boolean, transparent = false) => {
      await expect(page.locator('html')).toHaveAttribute('data-theme', tone);
      await expect(companions).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('.application-navigation')).toBeVisible();
      expect(await page.locator('.application-navigation [data-application-module]').count()).toBeGreaterThanOrEqual(5);
      const actual = await page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>('.bot-workspace')!, main = document.querySelector<HTMLElement>('.bot-main')!;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d')!;
        const rgba = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
        const resolve = (property: string) => { const probe = document.createElement('i'); probe.style.color = `var(${property})`; workspace.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return rgba(color); };
        const luminance = (rgb: number[]) => rgb.slice(0, 3).map(channel => { const c = channel / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
        const contrast = (a: number[], b: number[]) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
        const primary = resolve('--bot-text'), secondary = resolve('--bot-muted'), panel = resolve('--bot-panel'), self = resolve('--bot-self');
        const rect = main.getBoundingClientRect(), thread = document.querySelector<HTMLElement>('.bot-thread-column')!;
        const bubblePalettes = [...workspace.querySelectorAll<HTMLElement>('.bot-message-bubble:not(.is-inline-media-only)')].map(element => {
          const style = getComputedStyle(element), text = element.querySelector('.bot-message-text');
          const textStyle = text && getComputedStyle(text);
          return { fromUser: !!element.closest('.from-user'), background: style.backgroundColor, image: style.backgroundImage,
            border: style.borderTopColor, shadow: style.boxShadow, ink: style.color,
            inner: textStyle && { background: textStyle.backgroundColor, image: textStyle.backgroundImage, border: textStyle.borderTopColor, shadow: textStyle.boxShadow, ink: textStyle.color } };
        });
        return { primary, secondary, panel, accent: resolve('--bot-accent'), workspaceBackground: rgba(getComputedStyle(workspace).backgroundColor),
          sidebarBackground: rgba(getComputedStyle(document.querySelector('.bot-sidebar')!).backgroundColor),
          headerBackground: rgba(getComputedStyle(document.querySelector('.bot-chat-header')!).backgroundColor),
          composerBackground: rgba(getComputedStyle(document.querySelector('.bot-composer')!).backgroundColor),
          messageBackground: rgba(getComputedStyle(document.querySelector('.bot-message-bubble')!).backgroundColor),
          mainBackground: rgba(getComputedStyle(main).backgroundColor), primaryContrast: contrast(primary, panel), secondaryContrast: contrast(secondary, panel), userBubbleContrast: contrast(primary, self),
          bounds: rect.toJSON(), viewport: { width: innerWidth, height: innerHeight }, overflow: workspace.scrollWidth > workspace.clientWidth + 1 || thread.scrollWidth > thread.clientWidth + 1,
          effects: [workspace, main, document.querySelector('.bot-sidebar')!].map(element => ({ backdrop: getComputedStyle(element).backdropFilter, filter: getComputedStyle(element).filter })),
          rootVideos: document.querySelectorAll('.application-root>.app-theme-background video').length, nestedVideos: workspace.querySelectorAll('video').length, bubblePalettes };
      });
      checks.push({ preset, tone, wallpaper, transparent, ...actual });
      expect(actual.primaryContrast).toBeGreaterThanOrEqual(4.5); expect(actual.secondaryContrast).toBeGreaterThanOrEqual(4.5); expect(actual.userBubbleContrast).toBeGreaterThanOrEqual(4.5);
      expect(actual.primary).toEqual(hexToRgba(THEME_PROFILE_PRESETS[preset].tokens[tone]['--ui-content-primary']));
      // Canvas unpremultiplication can round translucent RGB by one channel.
      const expectedPanel = hexToRgba(THEME_PROFILE_PRESETS[preset].tokens[tone]['--ui-surface-raised']);
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual.panel[channel]! - expectedPanel[channel]!)).toBeLessThanOrEqual(1);
      expect(actual.panel[3]).toBe(expectedPanel[3]);
      expect(actual.accent).toEqual(hexToRgba(THEME_PROFILE_PRESETS[preset].tokens[tone]['--ui-content-accent']));
      expect(actual.overflow).toBe(false); expect(actual.bounds.left).toBeGreaterThan(0); expect(actual.bounds.right).toBeLessThanOrEqual(actual.viewport.width + 1); expect(actual.bounds.bottom).toBeLessThanOrEqual(actual.viewport.height + 1);
      expect(actual.effects.every(effect => effect.backdrop === 'none' && effect.filter === 'none')).toBe(true);
      expect(actual.nestedVideos).toBe(0); expect(actual.rootVideos).toBe(wallpaper ? 1 : 0);
      expect(actual.workspaceBackground[3]).toBe(wallpaper ? 0 : 255);
      const panelAlpha = hexToRgba(THEME_PROFILE_PRESETS[preset].tokens[tone]['--ui-surface-raised'])[3]!;
      expect(actual.mainBackground[3]).toBe(transparent ? Math.round(.48 * panelAlpha) : panelAlpha);
      expect(actual.sidebarBackground[3]).toBe(transparent ? Math.round(.48 * panelAlpha) : panelAlpha);
      if (transparent) {
        expect(actual.headerBackground[3]).toBeLessThan(128); expect(actual.composerBackground[3]).toBeLessThan(200); expect(actual.messageBackground[3]).toBeLessThan(200);
      }
      await expect(page.locator('.browser-markdown-link-card')).toHaveCount(1);
      const linkGeometry = await page.locator('.browser-markdown-link-card').evaluate(element => {
        const card = element.getBoundingClientRect(), bubble = element.closest('.bot-message-bubble')!.getBoundingClientRect();
        return { card: card.toJSON(), bubble: bubble.toJSON() };
      });
      expect(linkGeometry.card.right).toBeLessThanOrEqual(linkGeometry.bubble.right); expect(linkGeometry.card.left).toBeGreaterThanOrEqual(linkGeometry.bubble.left);
      expect(actual.bubblePalettes.some(item => item.fromUser)).toBe(true);
      expect(actual.bubblePalettes.some(item => !item.fromUser)).toBe(true);
      const { fromUser: _direction, ...expectedPalette } = actual.bubblePalettes.find(item => !item.fromUser)!;
      void _direction;
      for (const { fromUser, ...palette } of actual.bubblePalettes) { void fromUser; expect(palette).toEqual(expectedPalette); }
      const fold = page.getByRole('button', { name: '展开 3 个附件', exact: true });
      await expect(fold).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.bot-attachment-bundle')).toHaveCount(0);
      const cards = page.locator('.bot-message-single-file .bot-attachment-card');
      await expect(cards).toHaveCount(2);
      const cardPalettes = await cards.evaluateAll(elements => elements.map(element => {
        const style = getComputedStyle(element); return { fromUser: !!element.closest('.from-user'), background: style.backgroundColor,
          image: style.backgroundImage, border: style.borderTopColor, shadow: style.boxShadow, ink: style.color };
      }));
      expect(cardPalettes.map(item => item.fromUser).sort()).toEqual([false, true]);
      const { fromUser: _cardDirection, ...expectedCard } = cardPalettes[0]!; void _cardDirection;
      const { fromUser: _otherDirection, ...otherCard } = cardPalettes[1]!; void _otherDirection;
      expect(otherCard).toEqual(expectedCard); checks.push({ preset, tone, expandedCardPalettes: cardPalettes });
      if (actual.viewport.width >= 1450) {
        await expect(page.locator('.bot-group-overview')).toBeVisible();
        await expect(page.getByRole('region', { name: '群公告', exact: true })).toContainText('附件默认折叠');
        await expect(page.getByRole('region', { name: '群成员速览', exact: true }).locator('li')).toHaveCount(3);
        const memberFooter = await page.locator('.bot-chat-context').evaluate(element => {
          const bounds = element.getBoundingClientRect(), footer = element.querySelector('.bot-group-members-pages')!.getBoundingClientRect();
          const style = getComputedStyle(element), list = element.querySelector('.bot-group-member-list')!;
          return { bounds: bounds.toJSON(), footer: footer.toJSON(), inset: parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth),
            distanceFromBottom: bounds.bottom - footer.bottom, listOverflow: getComputedStyle(list).overflowY, listHeight: list.clientHeight };
        });
        expect(Math.abs(memberFooter.distanceFromBottom - memberFooter.inset)).toBeLessThanOrEqual(1);
        expect(memberFooter.listOverflow).toBe('auto'); expect(memberFooter.listHeight).toBeGreaterThan(0);
        await expect(page.locator('.bot-group-members-pages')).toContainText('1 / 1');
        await expect(page.getByRole('button', { name: '下一页群成员', exact: true })).toBeDisabled();
        checks.push({ preset, tone, memberFooter });
      }
    };
    // Verify composed pixels as well as CSS alpha: a second opaque surface
    // would pass a single-layer alpha check while still hiding the wallpaper.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128; const context = canvas.getContext('2d')!;
      context.fillStyle = '#2b7cdb'; context.fillRect(0, 0, 128, 128); context.fillStyle = '#eea63c'; context.fillRect(0, 0, 64, 64); context.fillRect(64, 64, 64, 64);
      localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset: 'forest', overrides: {} }));
      localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' }));
      localStorage.setItem('worldlinebox.background-preferences.v3', JSON.stringify({ version: 3, imageDataUrl: canvas.toDataURL(), imageSource: null, mode: 'tile', imageOpacity: .7, enabled: true, showInMainPanel: false, panelOpacity: 1 }));
    });
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    await expect(page.locator('html')).toHaveAttribute('data-bg-main-panel', 'on');
    await expect(page.locator('.app-theme-background')).toHaveAttribute('data-wallpaper', 'image');
    const samplePoints = await page.evaluate(() => ['.bot-sidebar', '.bot-main'].map(selector => {
      const bounds = document.querySelector(selector)!.getBoundingClientRect(); return { x: Math.floor(bounds.left + 20), y: Math.floor(bounds.bottom - 180) };
    }));
    const sampleWallpaper = async () => {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const encoded = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const { default: sharp } = await import('sharp');
      const pixels = await sharp(Buffer.from(encoded, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return samplePoints.map(point => [...pixels.data.subarray((point.y * pixels.info.width + point.x) * 4, (point.y * pixels.info.width + point.x) * 4 + 3)]);
    };
    const transparentPixels = await sampleWallpaper(); await capture('companions-restored-personal-wallpaper-light.png');
    const pixelSettings = await openAppearance(); await openBackground(pixelSettings);
    await pixelSettings.getByRole('switch', { name: '面板显示背景图', exact: true }).uncheck(); await page.keyboard.press('Escape');
    const opaquePixels = await sampleWallpaper();
    for (let index = 0; index < samplePoints.length; index++) expect(Math.max(...transparentPixels[index]!.map((value, channel) => Math.abs(value - opaquePixels[index]![channel]!)))).toBeGreaterThan(25);
    checks.push({ personalWallpaperCompositedPixels: { samplePoints, transparentPixels, opaquePixels, restoredWithoutThemeSelection: true } });
    // Reproduce an upgraded user profile: a wallpaper is already selected and
    // v3 saved either its old default-off flag or fully opaque panels. Do not
    // click a theme or transparency switch to make this acceptance pass.
    for (const legacy of [{ showInMainPanel: false, panelOpacity: .72 }, { showInMainPanel: true, panelOpacity: 1 }]) {
      await page.evaluate(legacy => {
        localStorage.setItem('worldlinebox.theme-profile.v3', JSON.stringify({ version: 3, preset: 'shuimo-danqing', overrides: {} }));
        localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' }));
        localStorage.setItem('worldlinebox.background-preferences.v3', JSON.stringify({ version: 3, imageDataUrl: null, imageSource: null, mode: 'cover', imageOpacity: .7, enabled: true, ...legacy }));
      }, legacy);
      await page.reload(); await companions.click();
      await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
      await expect(page.locator('html')).toHaveAttribute('data-bg-main-panel', 'on');
      await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      const migrated = await page.evaluate(() => JSON.parse(localStorage.getItem('worldlinebox.background-preferences.v3')!));
      expect(migrated).toMatchObject({ showInMainPanel: true, panelOpacity: .48, panelVisibilityVersion: 1 });
      await audit('shuimo-danqing', 'light', true, true);
      await capture(`companions-restored-wallpaper-${legacy.showInMainPanel ? 'legacy-opaque' : 'legacy-off'}.png`);
    }
    let restoredSettings = await openAppearance(); await openBackground(restoredSettings);
    await restoredSettings.getByRole('switch', { name: '面板显示背景图', exact: true }).uncheck(); await page.keyboard.press('Escape');
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-bg-main-panel', 'on');
    await audit('shuimo-danqing', 'light', true, false);
    restoredSettings = await openAppearance(); await restoredSettings.getByRole('tab', { name: '外观', exact: true }).click();
    await restoredSettings.locator('[data-theme-entry="worldlinebox"]').click(); await page.keyboard.press('Escape');
    for (const [preset, tone] of [['worldlinebox', 'light'], ['worldlinebox', 'dark'], ['forest', 'light'], ['rose', 'dark']] as const) {
      const settings = await openAppearance(); await settings.getByRole('radio', { name: tone === 'light' ? '亮色' : '暗色', exact: true }).click();
      await settings.locator(`[data-theme-entry="${preset}"]`).click(); await page.keyboard.press('Escape');
      await audit(preset, tone, false); await capture(`companions-theme-${preset}-${tone}.png`);
    }
    for (const preset of ['whale-fantasy', 'shuimo-danqing'] as const) {
      for (const tone of ['light', 'dark'] as const) {
        let settings = await openAppearance(); await settings.getByRole('radio', { name: tone === 'light' ? '亮色' : '暗色', exact: true }).click();
        await settings.locator(`[data-theme-entry="${preset}"]`).click();
        await openBackground(settings);
        await expect(settings.getByRole('switch', { name: '面板显示背景图', exact: true })).toBeChecked();
        await page.keyboard.press('Escape');
        const video = page.locator('.app-animated-background-video');
        await expect(video).toHaveCount(1); await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
        expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(1000);
        // Hidden OSR has no native focus. Exercise only the real renderer focus
        // branch, without overriding visibility, playing the element directly,
        // or claiming foreground/hardware performance from this synthetic event.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const start = await video.evaluate((element: HTMLVideoElement) => element.currentTime);
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(start + .1);
        expect(await video.evaluate((element: HTMLVideoElement) => element.muted && element.loop)).toBe(true);
        await video.evaluate(element => Reflect.set(window, '__themeWallpaperNode', element));
        await page.locator('[data-application-module="dsh"]').click(); await companions.click();
        expect(await video.evaluate(element => element === Reflect.get(window, '__themeWallpaperNode'))).toBe(true);
        await audit(preset, tone, true, true); await capture(`companions-theme-${preset}-${tone}.png`);
        await page.getByRole('button', { name: '管理群聊成员', exact: true }).click();
        const members = page.getByRole('dialog', { name: '群聊成员', exact: true }); await expect(members).toBeVisible();
        const modalEffects = await members.evaluate(element => {
          const nodes = [element, ...Array.from(element.parentElement ? [element.parentElement] : [])];
          return nodes.map(node => ({ filter: getComputedStyle(node).filter, backdrop: getComputedStyle(node).backdropFilter, bounds: node.getBoundingClientRect().toJSON() }));
        });
        expect(modalEffects.every(item => item.filter === 'none' && item.backdrop === 'none')).toBe(true);
        checks.push({ preset, tone, modalEffects }); await page.keyboard.press('Escape');
        settings = await openAppearance(); await openBackground(settings);
        await settings.getByRole('switch', { name: '播放背景动画', exact: true }).uncheck();
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true); await expect(video).toHaveAttribute('data-ready', 'false');
        await settings.getByRole('switch', { name: '播放背景动画', exact: true }).check(); await page.keyboard.press('Escape');
        await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(false);
        await page.emulateMedia({ reducedMotion: 'reduce' }); await expect(video).not.toHaveAttribute('src', /.+/u);
        await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
      }
    }
    const footerBaseline = await page.locator('.bot-group-members-pages').evaluate(element => element.getBoundingClientRect().bottom);
    const inspectNoticeLayout = async (label: string) => {
      const geometry = await page.locator('.bot-chat-context').evaluate(element => {
        const bounds = element.getBoundingClientRect(), footer = element.querySelector('.bot-group-members-pages')!.getBoundingClientRect();
        const list = element.querySelector<HTMLElement>('.bot-group-member-list')!, notice = element.querySelector<HTMLElement>('.bot-group-announcement-body')!;
        const save = notice.querySelector('.bot-group-notice-save')?.getBoundingClientRect();
        return { bounds: bounds.toJSON(), footer: footer.toJSON(), listHeight: list.clientHeight, noticeHeight: notice.clientHeight,
          noticeScrollHeight: notice.scrollHeight, noticeBounds: notice.getBoundingClientRect().toJSON(), save: save?.toJSON() };
      });
      expect(Math.abs(geometry.footer.bottom - footerBaseline)).toBeLessThanOrEqual(1);
      expect(geometry.listHeight).toBeGreaterThan(0); expect(geometry.noticeHeight).toBeGreaterThan(0);
      expect(geometry.noticeBounds.bottom).toBeLessThan(geometry.footer.top);
      checks.push({ announcementLayout: label, ...geometry }); return geometry;
    };
    await page.getByRole('button', { name: '编辑群公告', exact: true }).click();
    const longNotice = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 条：资料在群里共享，具体安排以这条公告为准。`).join('\n');
    await page.getByRole('textbox', { name: '公告内容', exact: true }).fill(longNotice);
    await page.getByRole('button', { name: '保存公告', exact: true }).click();
    await expect(page.locator('.bot-group-notice-text')).toContainText('第 60 条');
    const previewLayout = await inspectNoticeLayout('three-line-preview');
    const originalMemberPage = await page.locator('.bot-group-members-pages').textContent();
    const originalSearch = await page.getByRole('searchbox', { name: '搜索群成员', exact: true }).inputValue();
    await page.getByRole('button', { name: '查看全文', exact: true }).click();
    const reader = page.getByRole('dialog', { name: '群公告全文', exact: true }), fullText = reader.getByRole('region', { name: '公告全文内容', exact: true });
    await expect(reader).toBeVisible(); expect(await fullText.textContent()).toBe(longNotice);
    await expect(reader.getByRole('button', { name: '关闭公告全文', exact: true })).toBeFocused();
    const readerGeometry = await fullText.evaluate(element => ({ height: element.clientHeight, scrollHeight: element.scrollHeight,
      textLength: element.textContent!.length, children: element.children.length, bounds: element.getBoundingClientRect().toJSON(),
      backdropFilter: getComputedStyle(element.closest('.bot-group-announcement-reader-backdrop')!).backdropFilter }));
    expect(readerGeometry.scrollHeight).toBeGreaterThan(readerGeometry.height); expect(readerGeometry.children).toBe(0); expect(readerGeometry.backdropFilter).toBe('none');
    await fullText.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const readingLayout = await inspectNoticeLayout('reader-open-scrolled');
    expect(readingLayout.noticeHeight).toBe(previewLayout.noticeHeight); checks.push({ announcementReader: readerGeometry });
    await capture('companions-group-long-announcement.png');
    await reader.getByRole('button', { name: '关闭公告全文', exact: true }).press('Shift+Tab'); await expect(fullText).toBeFocused();
    await fullText.press('Tab'); await expect(reader.getByRole('button', { name: '关闭公告全文', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(reader).toHaveCount(0);
    await expect(page.getByRole('button', { name: '查看全文', exact: true })).toBeFocused();
    await page.getByRole('button', { name: '查看全文', exact: true }).click();
    await reader.getByRole('button', { name: '关闭公告全文', exact: true }).click(); await expect(reader).toHaveCount(0);
    expect(await page.locator('.bot-group-members-pages').textContent()).toBe(originalMemberPage);
    expect(await page.getByRole('searchbox', { name: '搜索群成员', exact: true }).inputValue()).toBe(originalSearch);
    await inspectNoticeLayout('reader-closed');
    await page.getByRole('button', { name: '编辑群公告', exact: true }).click();
    await page.getByRole('textbox', { name: '公告内容', exact: true }).fill(`${longNotice}\n编辑草稿，取消后不更改公告。`);
    await page.getByRole('button', { name: '保存公告', exact: true }).scrollIntoViewIfNeeded();
    const noticeEditor = await inspectNoticeLayout('editing');
    expect(noticeEditor.save!.bottom).toBeLessThan(noticeEditor.footer.top);
    await capture('companions-group-announcement-editor.png');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await inspectNoticeLayout('editor-cancelled');
    await page.getByRole('button', { name: '编辑群公告', exact: true }).click();
    await page.getByRole('textbox', { name: '公告内容', exact: true }).fill('主题验证 · 共享资料在本群查看，附件默认折叠。');
    await page.getByRole('button', { name: '保存公告', exact: true }).click();
    await expect(page.locator('.bot-group-notice-text')).toHaveText('主题验证 · 共享资料在本群查看，附件默认折叠。');
    await inspectNoticeLayout('short-notice-restored');
    const settings = await openAppearance(); await openBackground(settings);
    await settings.getByRole('switch', { name: '面板显示背景图', exact: true }).uncheck(); await page.keyboard.press('Escape');
    await audit('shuimo-danqing', 'dark', true, false);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 720));
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    const lowContentSize = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
    expect(lowContentSize[1]).toBe(720);
    // As with uncropped native paint dimensions above, Windows OSR may expose
    // a final one-pixel renderer row. Record the real viewport in each audit.
    await expect.poll(() => page.evaluate(expected => Math.abs(innerHeight - expected), lowContentSize[1]!)).toBeLessThanOrEqual(1);
    await expect(page.locator('.bot-chat-context')).toBeVisible();
    await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await audit('shuimo-danqing', 'dark', true, false); await capture('companions-group-three-members-low-height.png');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(850, 720));
    // Windows OSR can emit a correctly sized image containing old compositor
    // tiles after resize. A ready-page reload recreates that rendering surface;
    // the previous wide evidence and video-continuity checks are already saved.
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(850);
    await expect(page.locator('.bot-main')).toBeVisible();
    await expect(page.getByRole('button', { name: '展开 3 个附件', exact: true })).toBeVisible();
    await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await audit('shuimo-danqing', 'dark', true, false); await capture('companions-theme-shuimo-narrow-dark.png');
    // Exercise the nonintrusive task entry with an actual Main cancellation.
    // The existing fixture cancels source inboxes and defers all task retries;
    // this local, never-admitted cancellation performs no DSH/model work.
    const taskFixtureDirectory = testInfo.outputPath('task-update-fixture'); await mkdir(taskFixtureDirectory, { recursive: true });
    await build({ configFile: false, envDir: false, publicDir: false, logLevel: 'warn', build: {
      ssr: 'tests/fixtures/bot-task-workspace-fixture.ts', target: 'node24', outDir: taskFixtureDirectory, emptyOutDir: false,
      rollupOptions: { external: ['electron', 'better-sqlite3'], output: { format: 'cjs', entryFileNames: 'seed.cjs' } },
    } });
    const taskSeed = await application.evaluate(({ app }, input) => {
      if (app.getPath('userData') !== input.profile) throw Error('Task update checks require their owned theme profile.');
      const { createRequire } = process.getBuiltinModule('node:module'), paths = process.getBuiltinModule('node:path');
      const require = createRequire(paths.join(app.getAppPath(), 'package.json'));
      return (require(input.fixture) as { seedTaskWorkspace(profile: string, room: string): { ids: string[]; synthetic: boolean } }).seedTaskWorkspace(input.profile, input.room);
    }, { profile, room: seeded.peerId, fixture: path.join(taskFixtureDirectory, 'seed.cjs') });
    await page.reload(); await companions.click();
    await page.locator('.bot-sidebar .bot-conversation').filter({ hasText: seeded.peerTitle }).click();
    const taskEntry = page.locator('.bot-chat-tasks'), taskUpdates = taskEntry.locator('.bot-task-updates');
    await expect(taskEntry).toContainText('群任务');
    await expect(taskEntry.locator(':scope>span:not(.bot-task-updates)')).toHaveCount(1);
    await expect(taskUpdates).toHaveCount(0); await expect(page.locator('.bot-presence-feedback')).toHaveCount(0);
    const updateTransition = await page.evaluate(async input => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const before = await api.request({ type: 'state', conversationId: input.conversationId });
      const previous = before.snapshot?.presence?.['builtin-dafeiyu']?.lastEvent;
      const result = await api.request({ type: 'task.control', operation: 'cancel', conversationId: input.conversationId, taskId: input.taskId, requestId: 'theme-native-task-update' });
      const after = await api.request({ type: 'state', conversationId: input.conversationId });
      const event = after.snapshot?.presence?.['builtin-dafeiyu']?.events?.find(event => event.taskId === input.taskId && event.status === 'cancelled');
      return { previous, event, result, task: after.snapshot?.tasks.find(task => task.id === input.taskId), activeCount: after.snapshot?.taskSummary?.activeCount };
    }, { conversationId: seeded.peerId, taskId: taskSeed.ids[3]! });
    expect(updateTransition.result.ok).toBe(true); expect(updateTransition.task?.status).toBe('cancelled');
    expect(updateTransition.event).toMatchObject({ conversationId: seeded.peerId, taskId: taskSeed.ids[3], kind: 'task-completed', status: 'cancelled' });
    expect(updateTransition.event!.sequence).toBeGreaterThan(updateTransition.previous?.sequence ?? 0);
    await expect(taskUpdates).toHaveAttribute('data-count', '1'); await expect(taskUpdates).toContainText('新动态 1');
    await expect(taskEntry.locator(':scope>span:not(.bot-task-updates)')).toHaveText(String(updateTransition.activeCount));
    await expect(page.locator('.bot-presence-feedback')).toHaveCount(0);
    const taskUpdateGeometry = await taskUpdates.evaluate(element => {
      const header = element.closest('.bot-chat-header')!, entry = element.closest('button')!, title = header.querySelector('.bot-chat-identity')!;
      return { viewport: { width: innerWidth, height: innerHeight }, badge: element.getBoundingClientRect().toJSON(), entry: entry.getBoundingClientRect().toJSON(),
        header: header.getBoundingClientRect().toJSON(), title: title.getBoundingClientRect().toJSON(), nav: header.querySelector('nav')!.getBoundingClientRect().toJSON(),
        background: getComputedStyle(element).backgroundColor, ink: getComputedStyle(element).color,
        headerOverflow: header.scrollWidth > header.clientWidth + 1, mainOverflow: document.querySelector('.bot-main')!.scrollWidth > document.querySelector('.bot-main')!.clientWidth + 1 };
    });
    expect(taskUpdateGeometry.headerOverflow).toBe(false); expect(taskUpdateGeometry.mainOverflow).toBe(false);
    expect(taskUpdateGeometry.badge.right).toBeLessThanOrEqual(taskUpdateGeometry.viewport.width);
    expect(taskUpdateGeometry.badge.left).toBeGreaterThanOrEqual(taskUpdateGeometry.entry.left);
    expect(taskUpdateGeometry.badge.bottom).toBeLessThanOrEqual(taskUpdateGeometry.header.bottom);
    const titleAndActionsShareRow = Math.min(taskUpdateGeometry.title.bottom, taskUpdateGeometry.nav.bottom) > Math.max(taskUpdateGeometry.title.top, taskUpdateGeometry.nav.top);
    if (titleAndActionsShareRow) expect(taskUpdateGeometry.title.right).toBeLessThanOrEqual(taskUpdateGeometry.nav.left + 1);
    else expect(taskUpdateGeometry.nav.top).toBeGreaterThanOrEqual(taskUpdateGeometry.title.bottom - 1);
    await expect.poll(() => page.locator('.app-animated-background-video').evaluate((element: HTMLVideoElement) => element.readyState)).toBeGreaterThanOrEqual(2);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await capture('companions-task-updates-narrow-dark.png');
    await taskEntry.click(); await expect(page.getByRole('dialog', { name: '任务工作台', exact: true })).toBeVisible();
    await expect(taskUpdates).toHaveCount(0);
    await page.getByRole('button', { name: '关闭任务', exact: true }).click(); await expect(taskUpdates).toHaveCount(0);
    checks.push({ taskUpdates: { ...updateTransition, taskUpdateGeometry, panelAcknowledgedCurrentRoom: true, noFloatingFeedback: true, neverAdmittedCancellationOnly: true } });
    const finalHash = identity.packaged ? await hashFile(identity.appPath) : undefined; expect(finalHash).toBe(initialHash);
    const result = { identity, initialHash, finalHash, actualModelInference: false, actualDshExecution: false, actualBundledVideoDecoding: true,
      focusSimulation: 'DOM focus event in hidden offscreen renderer; no native focus/foreground FPS claim',
      contrastMethod: 'Nominal theme reading-surface RGB; actual video composition retained in screenshots, not an all-frames contrast guarantee',
      seeded: { humanAuthored: true, pendingEvents: seeded.pendingEvents, attachmentFixture, realImportedFiles: imported.media!.map(item => ({ id: item.id, name: item.name, size: item.size })) }, checks, captures };
    await writeFile(testInfo.outputPath('companions-theme-evidence.json'), JSON.stringify(result, null, 2));
    await writeFile(path.join(evidence, 'companions-theme-evidence.json'), JSON.stringify(result, null, 2));
    completed = true;
  } finally {
    await writeFile(testInfo.outputPath('companions-theme-checkpoints.json'), JSON.stringify({ initialHash, checks, captures, completed }, null, 2));
    await application.close();
    // The checked directory was created by this case, never a production profile.
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function hexToRgba(hex: string): number[] {
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(hex)) throw Error(`Theme colour assertion requires a hex colour: ${hex}`);
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255];
}
