import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };
function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-drop-paste-')) throw new Error('Invalid cleanup path'); rmSync(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
// Only the OS clipboard source is a fixture; DOM native Files, preload webUtils,
// IPC import, managed PNG persistence, attachment URLs and message storage are real.
// eslint-disable-next-line no-empty-pattern
test('accepts native multi-file drops and copied files/images while preserving absolute paths', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-drop-paste-'));
  const profile = path.join(root, 'profile'), files = [path.join(root, '中文 资料.txt'), path.join(root, '海边.png')];
  writeFileSync(files[0]!, '离线拖入验收资料。'); await sharp({ create: { width: 80, height: 80, channels: 3, background: '#8cbcb8' } }).png().toFile(files[1]!);
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  try {
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1480, 1050); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="deepseek-flash"]').click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.id = 'native-drop-fixture'; input.style.display = 'none'; document.body.append(input); });
    await page.locator('#native-drop-fixture').setInputFiles(files);
    const drop = async () => page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#native-drop-fixture')!, data = new DataTransfer();
      for (const file of Array.from(input.files!)) data.items.add(file);
      const area = document.querySelector('[aria-label="消息输入区"]')!;
      area.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      area.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('请处理这两个附件。'); await drop();
    await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(2); await drop();
    await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(2);
    await expect(page.locator('.companions-draft-attachments > span').first()).toHaveAttribute('title', files[0]!);
    await expect(page.locator('.companions-draft-image')).toHaveJSProperty('naturalWidth', 80);
    await page.getByRole('button', { name: '发送', exact: true }).click(); await expect(page.locator('.companions-draft-attachments')).toHaveCount(0);
    const messages = async () => (await page.evaluate(() => (window as unknown as Bridge).worldlinebox.companions.request({ type: 'messages', conversationId: 'private-deepseek-flash', limit: 30 }))).messages!;
    await expect.poll(async () => (await messages()).find(message => message.content === '请处理这两个附件。')?.attachments.map(file => file.path)).toEqual(files);
    await application.evaluate(({ clipboard }, paths) => {
      const names = Buffer.from(paths.join('\0') + '\0\0', 'utf16le'), header = Buffer.alloc(20); header.writeUInt32LE(20, 0); header.writeUInt32LE(1, 16);
      const fixture = Buffer.concat([header, names]); clipboard.has = format => format === 'CF_HDROP'; clipboard.readBuffer = format => format === 'CF_HDROP' ? fixture : Buffer.alloc(0);
    }, files);
    const paste = () => page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(['fixture'], 'clipboard-file')); document.querySelector('textarea[aria-label="输入消息"]')!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })); });
    await paste(); await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(2);
    await page.getByRole('button', { name: '移除附件 中文 资料.txt', exact: true }).click(); await page.getByRole('button', { name: '移除附件 海边.png', exact: true }).click();
    await application.evaluate(({ clipboard, nativeImage }, imagePath) => { clipboard.has = () => false; const image = nativeImage.createFromPath(imagePath); clipboard.readImage = () => image; }, files[1]!);
    await paste(); await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(1);
    await expect(page.locator('.companions-draft-image')).toHaveJSProperty('naturalWidth', 80);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(async () => (await messages()).filter(message => message.authorId === 'user' && message.attachments.length === 1).length).toBe(1);
    const image = (await messages()).find(message => message.authorId === 'user' && message.attachments.length === 1)!.attachments[0]!;
    expect(path.isAbsolute(image.path!)).toBe(true); expect(image.path!.startsWith(profile + path.sep)).toBe(true); expect(existsSync(image.path!)).toBe(true);
    expect(readFileSync(image.path!).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    const layout = await page.locator('[aria-label="消息输入区"]').evaluate(element => ({ width: element.getBoundingClientRect().width, overflow: getComputedStyle(element).overflowX }));
    expect(layout.width).toBeGreaterThan(600);
    await testInfo.attach('file-transfer-proof', { body: JSON.stringify({ originalPathsPreserved: true, nativeFiles: 2, repeatedDropDeduplicated: true, multiFileClipboardParsed: true, clipboardPngPersisted: true, layout }), contentType: 'application/json' });
  } finally {
    await application.close().catch(() => undefined);
    cleanup(root);
  }
});
