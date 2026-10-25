import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

function cleanup(root: string) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-media-e2e-')) throw new Error('Unexpected media fixture cleanup path.'); if (existsSync(resolved)) removeCompanionTestDirectory(resolved); }

function wave() {
  const samples = 32000, data = Buffer.alloc(44 + samples * 2); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) data.writeInt16LE(Math.round(Math.sin(sample / 16000 * Math.PI * 880) * 2500), 44 + sample * 2); return data;
}

// The chooser is the only stub: all six real files pass through the public picker,
// durable message storage, attachment protocol and Chromium's actual decoders.
// eslint-disable-next-line no-empty-pattern
test('displays real image galleries, plays registered audio and video, and locates document cards without executing them', async ({}, testInfo) => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-media-e2e-')), profile = path.join(root, 'profile');
  const files = ['海边.png', '天空.png', '轻音.wav', '生活片段.webm', '旅行计划.pdf', '随手记.txt'].map(name => path.join(root, name));
  await sharp({ create: { width: 320, height: 200, channels: 3, background: '#7fa3b6' } }).png().toFile(files[0]!); await sharp({ create: { width: 320, height: 200, channels: 3, background: '#d3b999' } }).png().toFile(files[1]!); writeFileSync(files[2]!, wave());
  writeFileSync(files[4]!, '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'); writeFileSync(files[5]!, '合成验收资料：只通过明确操作查看文件位置，不自动执行。');
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  try {
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1520, 1120); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
    await ensureCompanionTestWorkspace(page);
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    const webm = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90; const context = canvas.getContext('2d')!, stream = canvas.captureStream(12), recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' }), chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data); const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); }); recorder.start();
      await new Promise<void>(resolve => { let frame = 0; const draw = () => { context.fillStyle = '#263b50'; context.fillRect(0, 0, 160, 90); context.fillStyle = '#e7c68a'; context.beginPath(); context.arc(25 + frame * 4, 45, 12, 0, Math.PI * 2); context.fill(); if (++frame >= 24) { clearInterval(timer); resolve(); } }; const timer = setInterval(draw, 84); draw(); });
      recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop()); return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    });
    writeFileSync(files[3]!, Buffer.from(webm)); expect(webm.length).toBeGreaterThan(200);
    await application.evaluate(({ dialog, shell }, filenames) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: filenames }); const scope = globalThis as typeof globalThis & { locatedMediaFiles?: string[] }; scope.locatedMediaFiles = []; shell.showItemInFolder = filename => { scope.locatedMediaFiles!.push(filename); }; }, files);
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click(); await page.locator('[data-companion-contact="deepseek-sister"]').click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
    await page.getByRole('button', { name: '发送文件或图片', exact: true }).click(); await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(6); await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('这是一些公开的图片、音视频与文档。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    const own = page.locator('.companions-message.is-own').last(); await expect(own.locator('.companions-attachment-images img')).toHaveCount(2); await expect(own.locator('.is-pdf')).toContainText('PDF 文档'); await expect(own.locator('.is-text')).toContainText('文本文件');
    for (const image of await own.locator('.companions-attachment-images img').all()) await expect(image).toHaveJSProperty('naturalWidth', 320);
    const audio = own.locator('audio'), video = own.locator('video');
    for (const [media, filename] of [[audio, '轻音.wav'], [video, '生活片段.webm']] as const) {
      await own.getByRole('button', { name: '播放：' + filename, exact: true }).click();
      await expect.poll(() => media.evaluate((element: HTMLMediaElement) => element.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
      await expect.poll(() => media.evaluate((element: HTMLMediaElement) => element.currentTime)).toBeGreaterThan(.2);
      await media.evaluate((element: HTMLMediaElement) => element.pause());
    }
    expect(await video.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(160);
    const source = await video.getAttribute('src'); const range = await page.evaluate(async url => { const response = await fetch(url!, { headers: { Range: 'bytes=0-15' } }); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, range: response.headers.get('content-range'), accepts: response.headers.get('accept-ranges') }; }, source);
    expect(range).toMatchObject({ status: 206, bytes: 16, accepts: 'bytes' }); expect(range.range).toMatch(/^bytes 0-15\/\d+$/u);
    const head = await page.evaluate(async url => { const response = await fetch(url!, { method: 'HEAD' }); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength, length: Number(response.headers.get('content-length')) }; }, source); expect(head).toMatchObject({ status: 200, bytes: 0 }); expect(head.length).toBe(webm.length);
    await own.getByRole('button', { name: '预览图片：天空.png', exact: true }).click(); await expect(page.getByRole('dialog', { name: '图片预览：天空.png', exact: true })).toContainText('2 / 2'); await page.keyboard.press('ArrowLeft'); await expect(page.getByRole('dialog', { name: '图片预览：海边.png', exact: true })).toContainText('1 / 2'); await page.keyboard.press('Escape');
    await own.getByRole('button', { name: '预览文件：旅行计划.pdf', exact: true }).click();
    const pdfDialog = page.getByRole('dialog', { name: '文件预览：旅行计划.pdf', exact: true }); await expect(pdfDialog).toBeVisible();
    await pdfDialog.getByRole('button', { name: '文件位置', exact: true }).click(); await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { locatedMediaFiles?: string[] }).locatedMediaFiles)).toEqual([files[4]]);
    await pdfDialog.getByRole('button', { name: '关闭文件预览' }).click();
    await own.getByRole('button', { name: '预览文件：随手记.txt', exact: true }).click(); await expect(page.getByRole('dialog', { name: '文件预览：随手记.txt', exact: true }).locator('pre')).not.toBeEmpty(); await page.keyboard.press('Escape');
    await own.getByRole('button', { name: '播放：轻音.wav', exact: true }).click();
    const persistent = await page.locator('audio').elementHandle(); await page.locator('[data-application-module="browser"]').click();
    await expect(page.getByRole('region', { name: '聊天媒体播放器' }).locator('audio')).toHaveCount(1);
    expect(await persistent!.evaluate(element => element.isConnected)).toBe(true);
    await page.locator('[data-application-module="companions"]').click(); expect(await persistent!.evaluate(element => element.isConnected)).toBe(true);
    const stored = await page.evaluate(() => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request({ type: 'messages', conversationId: 'private-deepseek-sister', limit: 20 })); expect(stored.ok).toBe(true); expect(stored.messages!.find(message => message.authorId === 'user')!.attachments).toHaveLength(6);
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await page.evaluate(() => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request({ type: 'conversation.open', companionId: 'deepseek-sister' }));
    await expect(own.locator('.companions-attachment-images img')).toHaveCount(2);
    for (const image of await own.locator('.companions-attachment-images img').all()) await expect(image).toHaveJSProperty('naturalWidth', 320);
    await expect(own.getByRole('button', { name: '播放：生活片段.webm', exact: true })).toBeVisible();
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); await own.locator('.companions-message-attachments').screenshot({ path: path.join(artifacts, 'verified-companion-multimodal.png') });
    const report = { fixtureKind: 'synthetic_media_files', imageCount: 2, audioActuallyPlayed: true, videoActuallyPlayed: true, videoSize: { width: 160, height: 90, bytes: webm.length }, range, head, documentLocationExplicit: true, storedAttachments: 6 }; writeFileSync(path.join(artifacts, 'verified-companion-multimodal.json'), JSON.stringify(report, null, 2)); await testInfo.attach('actual-media-proof', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { await application.close().catch(() => undefined); cleanup(root); }
});
