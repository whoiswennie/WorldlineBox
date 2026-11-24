import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import sharp from 'sharp';
import { buildMultiPagePdf } from './pdf-fixture';
import { _electron as electron, expect, test } from '@playwright/test';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

test('opens chat documents and exports image, multi-page text and media edits through the native bridge', async () => {
  test.setTimeout(150000);
  const home = await mkdtemp(path.join(tmpdir(), 'wlb-attachment-studio-'));
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(home, 'profile'), WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1' }) });
  try {
    const page = await app.firstWindow(), file = (name: string) => path.join(home, name);
    const ffmpeg = path.resolve('resources/ffmpeg', process.platform + '-' + process.arch, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const source = 'first line\r\n'.repeat(7000) + 'final line';
    await sharp('assets/backgrounds/whale-fantasy-poster.jpg').resize(1600, 1000).png().toFile(file('drawing.png'));
    await writeFile(file('notes.txt'), source); await writeFile(file('report.pdf'), buildMultiPagePdf(2));
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p></w:body></w:document>'));
    zip.writeZip(file('minutes.docx'));
    await promisify(execFile)(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', file('sound.wav')], { windowsHide: true });
    const files = ['drawing.png', 'notes.txt', 'report.pdf', 'minutes.docx', 'sound.wav'].map(file);
    files.push(path.resolve('assets/backgrounds/whale-fantasy-loop.mp4'));
    for (const slides of [false, true]) {
      const dir = slides ? 'ppt' : 'xl', main = slides ? 'presentation' : 'workbook';
      const part = slides ? 'slides/slide2.xml' : 'worksheets/sheet2.xml';
      const archive = new AdmZip();
      archive.addFile(dir + '/' + main + '.xml', Buffer.from('<root xmlns:r="urn:rel">' +
        (slides ? '<sldId r:id="r2"/>' : '<sheet name="Totals" r:id="r2"/>') + '</root>'));
      archive.addFile(dir + '/_rels/' + main + '.xml.rels', Buffer.from('<Relationships><Relationship Id="r2" Target="' + part + '"/></Relationships>'));
      archive.addFile(dir + '/' + part, Buffer.from(slides ? '<slide><p><t>Review slides</t></p></slide>' :
        '<worksheet><row r="4"><c r="C4" t="inlineStr"><is><t>Sparse cell</t></is></c></row></worksheet>'));
      const filename = file(slides ? 'review.pptx' : 'totals.xlsx'); archive.writeZip(filename); files.push(filename);
    }
    await app.evaluate(({ dialog }, fixture) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: fixture.files });
      dialog.showSaveDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { defaultPath: string };
        return { canceled: false, filePath: fixture.home + '/' + options.defaultPath };
      };
    }, { files, home });
    await page.locator('[data-application-module="companions"]').click();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    const imported = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };
      const room = (await bridge.companionBot.request({ type: 'state' })).snapshot!.conversations[0]!;
      const result = await bridge.companionBotMedia.request({ type: 'files.pick', conversationId: room.id });
      if (!result.ok || result.media?.length !== 8) throw Error(result.error ?? 'Local file import failed'); return { roomId: room.id, media: result.media };
    });
    // Seed only the owned fixture's transcript. File bytes, import, validation,
    // paged reads, security scope and all reader interactions are production.
    await app.evaluate(({ app }, input) => {
      const paths = process.getBuiltinModule('node:path');
      if (paths.resolve(app.getPath('userData')) !== paths.resolve(input.profile)) throw Error('Cannot seed a user profile');
      const require = process.getBuiltinModule('node:module').createRequire(paths.join(app.getAppPath(), 'package.json'));
      const Database = require('better-sqlite3') as { new(filename: string): { prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void } };
      const db = new Database(paths.join(input.profile, 'companion-bot-v2', 'bot.sqlite'));
      try { db.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at,attachments_json) VALUES('reader-fixture','reader-fixture',?,'user','我','user','本地文档阅读验收资料。','sent','message','reader-fixture',?,?)").run(input.roomId, new Date().toISOString(), JSON.stringify(input.media)); } finally { db.close(); }
    }, { profile: file('profile'), ...imported });
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    const dismiss = page.getByRole('button', { name: '稍后设置', exact: true });
    await expect(dismiss.or(page.locator('.bot-binding-blocked')).first()).toBeVisible(); if (await dismiss.isVisible()) await dismiss.click();
    async function openFile(name: string) {
      const open = button('打开预览 ' + name);
      if (!await open.count()) await button('展开 8 个附件').click();
      await open.click();
    }
    await openFile('drawing.png'); await button('1:1').click();
    await expect(page.locator('.attachment-control-group output')).toHaveText('100%');
    await button('适应窗口').click();
    await page.screenshot({ path: test.info().outputPath('attachment-image.png') });
    await page.getByLabel('裁切', { exact: true }).selectOption('select');
    const bounds = (await page.locator('.attachment-crop').boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 4);
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.75, { steps: 5 }); await page.mouse.up();
    await expect(page.getByLabel('裁切', { exact: true })).toHaveValue('custom');
    await button('顺时针旋转 90°').click();
    await button('导出静态 PNG').click();
    await expect(page.getByRole('status').filter({ hasText: '已保存副本' })).toBeVisible();
    const image = await sharp(file('drawing-edited.png')).metadata();
    expect(Math.abs(image.width! - 500)).toBeLessThanOrEqual(4);
    expect(Math.abs(image.height! - 800)).toBeLessThanOrEqual(4);
    await button('关闭预览').click();
    await openFile('notes.txt'); await button('查找').click();
    await page.getByRole('searchbox', { name: '查找当前段原文' }).fill('first');
    await button('下一个').click();
    await expect(page.locator('.bot-attachment-document mark')).toHaveText('first');
    await button('编辑原文').click();
    const editor = page.getByRole('textbox', { name: '文档编辑区' });
    await expect(editor).toHaveValue(source.replaceAll('\r\n', '\n'));
    await editor.fill('changed\nsecond line'); await button('关闭预览').click();
    await button('继续编辑').click(); await button('另存副本').click();
    await expect.poll(() => readFile(file('notes-edited.txt'), 'utf8').catch(() => '')).toBe('changed\r\nsecond line');
    expect(await readFile(file('notes.txt'), 'utf8')).toBe(source);
    await button('关闭预览').click();
    await openFile('minutes.docx'); await expect(page.locator('.attachment-office-stage')).toContainText('Quarterly report');
    await button('关闭预览').click(); await openFile('report.pdf');
    await expect(page.locator('.pdf-viewer canvas').first()).toBeVisible(); await button('关闭预览').click();
    for (const [name, extension] of [['sound.wav', 'm4a'], ['whale-fantasy-loop.mp4', 'webm']] as const) {
      await openFile(name); await button('截取片段').click();
      await page.getByRole('spinbutton', { name: /终点/ }).fill('0.5');
      await button('导出片段 · ' + (extension === 'webm' ? 'WebM' : 'M4A')).click();
      await expect(page.getByRole('status').filter({ hasText: '已保存副本' })).toBeVisible();
      const probe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
      const result = await promisify(execFile)(probe, ['-v','error','-show_entries','format=duration','-of','csv=p=0',file(path.parse(name).name + '-edited.' + extension)], { windowsHide: true });
      expect(Number(result.stdout.trim())).toBeCloseTo(0.5, 1);
      await button('关闭预览').click();
    }
    await button('查看全部附件').first().click();
    const explorer = page.getByRole('dialog', { name: '全部附件', exact: true });
    await explorer.getByRole('button', { name: '打开预览 totals.xlsx' }).click();
    await expect(page.locator('.attachment-office-stage tbody td').nth(2)).toHaveText('Sparse cell');
    await button('关闭预览').click();
    await explorer.getByRole('button', { name: '打开预览 review.pptx' }).click();
    await expect(page.locator('.attachment-office-stage')).toContainText('Review slides');
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 4 });
  }
});

