import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function hashFile(filename: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

// eslint-disable-next-line no-empty-pattern -- Native Electron window owns the page.
test('real sticker packs and scoped on-demand media previews support playback, paged Markdown, save and cold reload', async ({}, testInfo) => {
  test.setTimeout(180000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bot-media-ui-'));
  const resolved = path.resolve(profile); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('wlb-bot-media-ui-')) throw Error('Unexpected media profile cleanup');
  const fixtureFile = path.join(profile, '实际附件.bin'), savedFile = path.join(profile, '保存的附件.bin'), pack = path.join(profile, '自定义表情包');
  let app: ElectronApplication | undefined;
  try {
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255, 42]); await writeFile(fixtureFile, bytes); await mkdir(pack);
  const videoFile = path.join(profile, '短视频.mp4'), audioFile = path.join(profile, '声音.wav');
  const markdownFile = path.join(profile, '项目方案.md'), textFile = path.join(profile, '说明.txt'), imageFile = path.join(profile, '参考图.png'), largeFile = path.join(profile, '电影.mp4');
  const markdown = '# 分页阅读验收\n\n```mermaid\nflowchart LR\n A[发送附件] --> B[点击预览]\n B --> C[按需读取]\n```\n\n' + '这份文档按字节分页，当前页面不会保留之前的全部内容。\n'.repeat(1600) + '\n全文末尾校验：紫色鲸鱼。';
  await writeFile(markdownFile, markdown); await writeFile(textFile, '纯文本预览，不应自动变成 Markdown。');
  await copyFile('public/companion-bot/builtins/gpt/portrait.png', imageFile);
  const extraFiles = Array.from({ length: 6 }, (_, index) => path.join(profile, `附录${index + 1}.txt`));
  for (const filename of extraFiles) await writeFile(filename, `这是隔离附件分页验收文件：${path.basename(filename)}`);
  const largeHandle = await open(largeFile, 'w'); try { await largeHandle.truncate(200 * 1024 * 1024 + 1); } finally { await largeHandle.close(); }
  const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
  await copyFile('assets/backgrounds/whale-fantasy-loop.mp4', videoFile);
  await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', '-y', audioFile], { windowsHide: true });
  await copyFile('public/companion-bot/builtins/gpt/portrait.png', path.join(pack, '白龙.png'));
  app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    const page = await app.firstWindow();
    const identity = await app.evaluate(({ app, BrowserWindow }, expected) => {
      if (app.getPath('userData') !== expected) throw Error('Media acceptance must use the owned profile.');
      const frame = { paints: 0 }; Reflect.set(globalThis, '__mediaPreviewFrames', frame);
      for (const owned of BrowserWindow.getAllWindows()) {
        owned.on('show', () => owned.hide()); owned.webContents.setBackgroundThrottling(false);
        owned.webContents.on('paint', (_event, _rect, image) => {
          frame.paints++;
          const size = image.getSize(), content = owned.getContentSize();
          if (!image.isEmpty()) Reflect.set(globalThis, '__mediaPreviewLatestPaint', { sequence: frame.paints, size, content, image });
        });
        owned.setMinimumSize(0, 0); owned.setSize(1800, 1000); owned.hide();
      }
      return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, profile);
    const initialHash = identity.packaged ? await hashFile(identity.appPath) : undefined;
    expect(identity.offscreen).toBe(true);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    const captures: unknown[] = [];
    const capture = async (name: string) => {
      await expect(page.locator('.application-navigation')).toBeVisible();
      await expect.poll(() => page.evaluate(() => { const viewer = document.querySelector('.bot-attachment-viewer')?.getBoundingClientRect(); return !viewer || viewer.x >= 0 && viewer.right <= innerWidth + 1 && viewer.bottom <= innerHeight + 1; })).toBe(true);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const before = await app!.evaluate(({ BrowserWindow }) => { const target = BrowserWindow.getAllWindows()[0]!, baseline = (Reflect.get(globalThis, '__mediaPreviewFrames') as { paints: number }).paints; const content = target.getContentSize(); target.webContents.stopPainting(); target.webContents.startPainting(); target.webContents.invalidate(); return { baseline, content }; });
      await expect.poll(() => app!.evaluate(() => (Reflect.get(globalThis, '__mediaPreviewLatestPaint') as { sequence: number } | undefined)?.sequence ?? 0)).toBeGreaterThan(before.baseline);
      const painted = await app!.evaluate(({ BrowserWindow }, required) => {
        const frame = Reflect.get(globalThis, '__mediaPreviewLatestPaint') as { sequence: number; size: { width: number; height: number }; image: { toPNG(): Buffer } };
        const content = BrowserWindow.getAllWindows()[0]!.getContentSize();
        // Windows can allocate one final raster row/column beyond integer DIP
        // content bounds. Keep that raw border pixel; never resize or crop proof.
        const currentSize = content[0] === required.content[0] && content[1] === required.content[1];
        const rasterSize = Math.abs(frame.size.width - content[0]!) <= 1 && Math.abs(frame.size.height - content[1]!) <= 1;
        if (frame.sequence <= required.baseline || !currentSize || !rasterSize) throw Error(`The offscreen frame is stale or has the old viewport size: ${JSON.stringify({ frame: frame.size, content, before: required })}`);
        return { png: frame.image.toPNG().toString('base64'), sequence: frame.sequence, size: frame.size, content };
      }, before);
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.dataset.theme, panel: getComputedStyle(document.querySelector('.bot-workspace')!).getPropertyValue('--bot-panel'), viewer: document.querySelector('.bot-attachment-viewer')?.getBoundingClientRect().toJSON() }));
      const { png, ...paint } = painted; captures.push({ name, baseline: before.baseline, ...paint, viewport, rawUncropped: true, windowsRasterRoundingTolerance: 1 });
      const file = testInfo.outputPath(name); await writeFile(file, Buffer.from(png, 'base64')); await testInfo.attach(name, { path: file, contentType: 'image/png' }); return file;
    };
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.application-navigation')).toBeVisible();
    expect(await page.locator('.application-navigation [data-application-module]').count()).toBeGreaterThanOrEqual(5);
    await expect(page.locator('.bot-sidebar .bot-settings')).toHaveCount(0);
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await app.evaluate(({ dialog }, paths) => {
      dialog.showOpenDialog = async (...args: unknown[]) => { const options = args.at(-1) as { properties?: string[] }; return { canceled: false, filePaths: [options.properties?.includes('openDirectory') ? paths.pack : paths.file] }; };
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: paths.saved });
    }, { file: fixtureFile, saved: savedFile, pack });
    const conversationId = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const state = await api.request({ type: 'state' }); return state.snapshot!.conversations[0]!.id;
    });
    const fileToggle = (count: number) => page.getByRole('button', { name: new RegExp(`^(?:展开|收起) ${count} 个附件$`, 'u') });
    const expandFiles = async (count: number) => {
      const toggle = fileToggle(count); await expect(toggle).toHaveCount(1);
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    };
    await page.getByRole('button', { name: '表情', exact: true }).click();
    await page.getByRole('tab', { name: '表情包', exact: true }).click();
    await expect(page.locator('.bot-sticker-picker nav button')).toHaveCount(4);
    await expect.poll(() => page.locator('.bot-sticker-grid img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await capture('real-sticker-picker.png');
    await page.locator('.bot-sticker-grid button').first().click();
    await expect(page.locator('.bot-message .is-sticker img')).toHaveCount(1);
    await expect.poll(() => page.locator('.bot-message .is-sticker img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'native-drop-fixture'; input.hidden = true; document.body.append(input); });
    await page.locator('#native-drop-fixture').setInputFiles(fixtureFile);
    await page.evaluate(() => {
      const file = document.querySelector<HTMLInputElement>('#native-drop-fixture')!.files![0]!;
      const transfer = new DataTransfer(); transfer.items.add(file);
      document.querySelector('.bot-thread-column')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.locator('.bot-draft-attachments')).toContainText('实际附件.bin');
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    const onlyAttachmentMessage = page.locator('.bot-message').filter({ has: page.getByRole('button', { name: '系统打开 实际附件.bin', exact: true }).first() });
    await expect(fileToggle(1)).toHaveCount(0);
    await expect(onlyAttachmentMessage.locator('.bot-message-bubble')).toHaveCount(1);
    await expect(onlyAttachmentMessage.locator('.bot-message-bubble .bot-message-text')).toHaveCount(0);
    await expect(onlyAttachmentMessage.locator('.bot-message-bubble .bot-attachment-card')).toHaveCount(1);
    await expect(onlyAttachmentMessage.locator('.bot-message-bubble').locator('video,audio,img')).toHaveCount(0);
    await expect(page.locator('.bot-message .bot-attachment-meta')).toContainText('实际附件.bin');
    await page.locator('.bot-message .bot-file-save').click(); await expect.poll(async () => readFile(savedFile).then(value => value.equals(bytes)).catch(() => false)).toBe(true);
    await app.evaluate(({ shell }) => { shell.openPath = async value => { Reflect.set(globalThis, '__botMediaOpenedFixture', value); return ''; }; });
    await page.locator('.bot-message .bot-file-open').click();
    await expect.poll(() => app!.evaluate(() => typeof Reflect.get(globalThis, '__botMediaOpenedFixture'))).toBe('string');
    const openedPath = await app.evaluate(() => Reflect.get(globalThis, '__botMediaOpenedFixture') as string);
    expect(path.basename(openedPath)).toBe('实际附件.bin'); expect((await readFile(openedPath)).equals(bytes)).toBe(true);
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, [videoFile, audioFile, markdownFile, textFile, imageFile, largeFile, ...extraFiles]);
    await page.getByRole('button', { name: '添加文件', exact: true }).click(); await expect(page.locator('.bot-draft-attachments')).toContainText('短视频.mp4');
    await page.locator('.bot-composer textarea').fill('这些是本次资料与参考附件，点击展开即可逐项预览。');
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    const mixedMessage = page.locator('.bot-message').filter({ has: fileToggle(12) });
    await expect(fileToggle(12)).toHaveAttribute('aria-expanded', 'false');
    await expect(mixedMessage.locator('.bot-message-bubble')).toHaveCount(1);
    await expect(mixedMessage.locator('.bot-message-bubble>.bot-message-text')).toHaveText('这些是本次资料与参考附件，点击展开即可逐项预览。');
    await expect(mixedMessage.locator('.bot-message-bubble').locator('.bot-attachment,video,audio,img,.bot-attachment-bundle')).toHaveCount(0);
    const collapsedRegion = await fileToggle(12).getAttribute('aria-controls');
    await expect(page.locator(`[id="${collapsedRegion}"]`)).toHaveAttribute('hidden', '');
    await capture('media-collapsed-message-light.png');
    await expandFiles(12);
    await expect(page.locator('.bot-message .bot-attachment-meta').filter({ hasText: '声音.wav' })).toBeVisible();
    await expect(page.locator('.bot-attachment-bundle')).toContainText('共 12 个附件');
    await expect(page.locator('.bot-attachment-bundle .bot-attachment-tile')).toHaveCount(6);
    await page.getByRole('button', { name: '查看全部附件', exact: true }).first().click();
    const explorer = page.getByRole('dialog', { name: '全部附件', exact: true });
    await expect(explorer.getByRole('listitem')).toHaveCount(10);
    await explorer.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(explorer.getByRole('listitem')).toHaveCount(2);
    await explorer.getByRole('searchbox', { name: '搜索附件文件名', exact: true }).fill('项目方案');
    await expect(explorer.getByRole('listitem')).toHaveCount(1);
    await expect(explorer).toContainText('项目方案.md');
    await capture('media-attachment-explorer-light.png');
    await page.getByRole('button', { name: '关闭附件列表', exact: true }).click();
    const playbackData = await page.evaluate(async conversationId => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi };
      const state = await bridge.companionBot.request({ type: 'state', conversationId });
      return { media: state.snapshot?.messages.flatMap(item => item.attachments ?? []), rendered: [...document.querySelectorAll('.bot-attachment')].map(item => ({ classes: item.className, text: item.textContent })) };
    }, conversationId);
    await testInfo.attach('media-before-playback.json', { body: JSON.stringify(playbackData, null, 2), contentType: 'application/json' });
    await expect(page.locator('video,audio')).toHaveCount(0); await expect(page.locator('.bot-attachment-document')).toHaveCount(0);
    for (const [selector, name] of [['video', '短视频.mp4'], ['audio', '声音.wav']]) {
      await page.getByRole('button', { name: `打开预览 ${name}`, exact: true }).click();
      const player = page.locator(`.bot-attachment-viewer ${selector}`);
      await expect(player).toHaveAttribute('preload', 'metadata');
      await player.evaluate(async (element: HTMLMediaElement) => { element.muted = true; await element.play(); });
      await expect.poll(() => player.evaluate((element: HTMLMediaElement) => element.currentTime)).toBeGreaterThan(.05);
      await player.evaluate((element: HTMLMediaElement) => element.pause());
      await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    }
    await page.getByRole('button', { name: '打开预览 项目方案.md', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: '项目方案.md', exact: true });
    await expect(viewer.getByRole('heading', { name: '分页阅读验收', exact: true })).toBeVisible();
    await expect(viewer.locator('.companions-diagram-svg svg')).toBeVisible();
    await expect(viewer.getByText('当前分页渲染 · 跨页内容可查看原文', { exact: true })).toBeVisible();
    await expect(viewer.locator('.bot-attachment-document')).not.toContainText('全文末尾校验');
    await expect(viewer.locator('.bot-attachment-document')).not.toContainText('\ufffd');
    await capture('media-markdown-light.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(850, 720));
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    // Recreate the offscreen compositor surface at the final viewport. The
    // Windows OSR paint callback can otherwise retain pixels from the old size.
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expandFiles(12);
    await page.getByRole('button', { name: '打开预览 项目方案.md', exact: true }).click();
    await expect(viewer.locator('.companions-diagram-svg svg')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await capture('media-markdown-narrow-dark.png');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1800, 1000));
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'light' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expandFiles(12);
    await page.getByRole('button', { name: '打开预览 项目方案.md', exact: true }).click();
    await expect(viewer.locator('.companions-diagram-svg svg')).toBeVisible();
    await viewer.getByRole('button', { name: '原文', exact: true }).click();
    await expect(viewer.locator('.bot-attachment-document>pre')).toContainText('```mermaid');
    await viewer.getByRole('button', { name: '下一段', exact: true }).click();
    await expect(viewer.locator('.bot-attachment-document')).not.toContainText('分页阅读验收');
    for (let index = 0; index < 6; index++) {
      await expect(viewer.locator('.bot-attachment-viewer-content')).toHaveAttribute('aria-busy', 'false');
      if (!await viewer.getByRole('button', { name: '下一段', exact: true }).isEnabled()) break;
      await viewer.getByRole('button', { name: '下一段', exact: true }).click();
    }
    await expect(viewer.locator('.bot-attachment-document')).toContainText('全文末尾校验：紫色鲸鱼');
    await expect(viewer.locator('.bot-attachment-document')).not.toContainText('\ufffd');
    await viewer.getByRole('button', { name: '上一段', exact: true }).click();
    await expect(viewer.locator('.bot-attachment-viewer-content')).toHaveAttribute('aria-busy', 'false');
    await expect(viewer.locator('.bot-attachment-document')).not.toContainText('全文末尾校验');
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await page.getByRole('button', { name: '打开预览 说明.txt', exact: true }).click();
    await expect(page.locator('.bot-attachment-document>pre')).toHaveText('纯文本预览，不应自动变成 Markdown。');
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await page.getByRole('button', { name: '打开预览 参考图.png', exact: true }).click();
    await expect.poll(() => page.locator('.bot-attachment-picture img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    const largeCard = page.locator('.bot-attachment-tile').filter({ has: page.getByRole('button', { name: '系统打开 电影.mp4', exact: true }) });
    await expect(largeCard).toContainText('超过 200 MiB');
    await expect(largeCard.getByRole('button', { name: '打开预览 电影.mp4', exact: true })).toHaveCount(0);
    await largeCard.getByRole('button', { name: '系统打开 电影.mp4', exact: true }).click();
    await expect.poll(async () => path.basename(await app!.evaluate(() => Reflect.get(globalThis, '__botMediaOpenedFixture') as string))).toBe('电影.mp4');
    await expect(page.locator('video,audio')).toHaveCount(0);
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, pack);
    await page.getByRole('button', { name: '表情', exact: true }).click();
    await page.getByRole('tab', { name: '表情包', exact: true }).click();
    await page.getByRole('button', { name: '导入表情包', exact: true }).click();
    await expect(page.locator('.bot-sticker-picker nav')).toContainText('自定义表情包');
    await expect(page.locator('.bot-sticker-grid img')).toHaveAttribute('alt', '白龙');
    const state = await page.evaluate(async conversationId => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      return api.request({ type: 'state', conversationId });
    }, conversationId);
    const media = state.snapshot!.messages.flatMap(message => message.attachments ?? []);
    expect(media.some(item => item.kind === 'sticker' && item.animated && item.mimeType === 'image/webp')).toBe(true);
    const fileId = media.find(item => item.name === '实际附件.bin')!.id;
    const markdownId = media.find(item => item.name === '项目方案.md')!.id;
    const rejected = await page.evaluate(async ({ fileId }) => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      const opened = await api.request({ type: 'conversation.open', companionId: 'gpt' });
      return api.request({ type: 'message.send', conversationId: opened.conversationId!, content: '', attachmentIds: [fileId], requestId: crypto.randomUUID() });
    }, { fileId });
    expect(rejected.ok).toBe(false);
    const rejectedRead = await page.evaluate(async ({ markdownId }) => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const opened = await bridge.companionBot.request({ type: 'conversation.open', companionId: 'gpt' });
      return bridge.companionBotMedia.request({ type: 'media.text.read', conversationId: opened.conversationId!, id: markdownId });
    }, { markdownId });
    expect(rejectedRead.ok).toBe(false);
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await page.locator('.bot-contact').filter({ hasText: '大肥鱼' }).click();
    await expect(page.locator('.bot-message .is-sticker img')).toHaveCount(1);
    await expect(fileToggle(1)).toHaveCount(0); await expect(fileToggle(12)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.bot-transcript').locator('.bot-attachment-card')).toHaveCount(1);
    await expect(page.locator('.bot-transcript').locator('.bot-attachment-bundle,video,audio')).toHaveCount(0);
    await expect(mixedMessage).toContainText('这些是本次资料与参考附件');
    await expandFiles(12); await expect(mixedMessage.locator('.bot-attachment-tile')).toHaveCount(6);
    await capture('media-expanded-message-light.png'); await fileToggle(12).click();
    await expect(mixedMessage.locator('.bot-message-bubble').locator('.bot-attachment,video,audio,img')).toHaveCount(0);
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, imageFile);
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    await expect(page.locator('.bot-draft-attachments')).toContainText('参考图.png');
    const priorMessageIds = await page.locator('.bot-message.from-user').evaluateAll(messages => messages.map(message => message.getAttribute('data-bot-message')));
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    let imageMessageId: string | undefined;
    await expect.poll(async () => {
      imageMessageId = await page.evaluate(async input => {
        const state = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state', conversationId: input.conversationId });
        return state.snapshot!.messages.find(message => message.senderId === 'user' && !input.priorMessageIds.includes(message.id)
          && message.attachments?.length === 1 && message.attachments[0]!.name === '参考图.png')?.id;
      }, { conversationId, priorMessageIds });
      return imageMessageId;
    }).toBeTruthy();
    const singleImage = page.locator(`[data-bot-message="${imageMessageId}"]`);
    await expect(singleImage.locator('.bot-message-bubble')).toHaveCount(1);
    await expect(singleImage.locator('.bot-attachment-card')).toHaveCount(1);
    // A thumbnail may not be available yet; the card must still offer direct
    // preview without mounting the original full-size image or player.
    await expect(page.locator('.bot-attachment-picture')).toHaveCount(0);
    await singleImage.getByRole('button', { name: '打开预览 参考图.png', exact: true }).click();
    await expect.poll(() => page.locator('.bot-attachment-picture img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await expect(page.locator('.bot-attachment-picture')).toHaveCount(0);
    const evidence = path.resolve('artifacts/superagent-bot-development/ui'); await mkdir(evidence, { recursive: true });
    const screenshot = await capture('chat-real-media.png');
    await copyFile(screenshot, path.join(evidence, 'chat-real-media.png')); await testInfo.attach('chat-real-media', { path: screenshot, contentType: 'image/png' });
    const bridge = await page.evaluate(() => typeof (Reflect.get(window, 'worldlinebox') as { companionBotMedia: WorldlineBoxBotMediaApi }).companionBotMedia.getDroppedFilePaths);
    expect(bridge).toBe('function');
    const finalHash = identity.packaged ? await hashFile(identity.appPath) : undefined;
    expect(finalHash).toBe(initialHash);
    await writeFile(testInfo.outputPath('media-preview-evidence.json'), JSON.stringify({ identity, initialHash, finalHash, captures, actualIpc: true, attachmentOnlyAndMixedBubbles: true, singleAttachmentDirectActions: true, singleImageOriginalOnDemand: true, collectionOriginalsOnDemand: true, collectionsCollapsedAfterColdReload: true, pagesReplaceContent: true, unicodeBoundaryPreserved: true, nativePlayersOnDemand: true, oversizedSystemOpen: true, crossRoomReadRejected: true }, null, 2));
  } finally {
    await app?.close();
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
