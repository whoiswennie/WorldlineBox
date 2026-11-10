import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { Readable } from 'node:stream';
import { createInflate } from 'node:zlib';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BrowserRequest, WorldlineBoxBrowserApi } from '../../src/shared/browser';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

async function samplePngRows(file: string, width: number, samples: { x: number; y: number }[]) {
  const png = await readFile(file), rows = new Map(samples.map((sample, index) => [sample.y, { ...sample, index }]));
  function* chunks() { for (let offset = 8; offset < png.length;) { const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8); if (type === 'IDAT') yield png.subarray(offset + 8, offset + 8 + size); offset += size + 12; } }
  const result: number[][] = [], stride = width * 3 + 1; let remaining = Buffer.alloc(0), y = 0;
  for await (const chunk of Readable.from(chunks()).pipe(createInflate())) {
    const bytes = Buffer.concat([remaining, chunk as Buffer]); let offset = 0;
    while (bytes.length - offset >= stride) { if (bytes[offset] !== 0) throw Error('Unexpected PNG row filter'); const target = rows.get(y++); if (target) result[target.index] = [...bytes.subarray(offset + 1 + target.x * 3, offset + 4 + target.x * 3)]; offset += stride; }
    remaining = bytes.subarray(offset);
  }
  return result;
}

// eslint-disable-next-line no-empty-pattern -- Real native tab and production capture/save IPC.
test('previews a 56-image long page before saving, remains responsive, and reports native capture errors', async ({}, testInfo) => {
  test.setTimeout(600000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-image-preview-e2e-'));
  const evidence = path.resolve('artifacts/browser-page-image-preview'); await mkdir(evidence, { recursive: true });
  const output = path.join(evidence, 'page-' + Date.now().toString(36) + '.png');
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/image/')) {
      const number = Number(request.url.split('/').at(-1)); response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1400"><defs><linearGradient id="g"><stop stop-color="hsl(${number * 37 % 360},60%,80%)"/><stop offset="1" stop-color="hsl(${number * 37 % 360},60%,40%)"/></linearGradient></defs><rect width="1000" height="1400" fill="url(#g)"/><circle cx="500" cy="600" r="290" fill="white" opacity=".4"/><text x="80" y="120" font-size="70" fill="#17263a">Example image ${number + 1} / 56</text><rect width="40" height="40" fill="rgb(${number * 3},80,${200 - number * 2})"/></svg>`); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>56 张图片长网页验收</title><style>html,body{margin:0;background:#f5f7fb;font:24px sans-serif}header{height:100px;padding:20px;box-sizing:border-box}img{display:block;margin:auto;width:1000px;height:1400px}footer{height:120px;background:rgb(24,160,92);color:white}</style><header>56 张图片 · 原生网页长图</header>${Array.from({ length: 56 }, (_, i) => `<img src="/image/${i}" loading="lazy" alt="示例图片 ${i + 1}">`).join('')}<footer>END OF PAGE · 完整底部</footer>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture port'); const url = `http://127.0.0.1:${address.port}/`;
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
  const page = await app.firstWindow(), report: Record<string, unknown> = { profile, imageCount: 56, productionIPC: true, realNativeBrowser: true };
  const browser = async (input: BrowserRequest) => { const value = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser.request(input), input); if (!value.ok) throw Error(value.error); return value; };
  const screenshot = async (name: string) => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); await testInfo.attach(name, { path: file, contentType: 'image/png' }); };
  try {
    await app.evaluate(({ BrowserWindow, Menu, dialog }, output) => {
      BrowserWindow.getAllWindows()[0]!.setSize(1680, 1040);
      Menu.prototype.popup = function () { Reflect.set(globalThis, 'imagePreviewMenu', this); };
      dialog.showSaveDialog = async () => { Reflect.set(globalThis, 'imageSavePickerCalls', Number(Reflect.get(globalThis, 'imageSavePickerCalls') ?? 0) + 1); return { canceled: false, filePath: output }; };
      let last = performance.now(); Reflect.set(globalThis, 'imageMaxMainGap', 0);
      Reflect.set(globalThis, 'imageHeartbeat', setInterval(() => { const now = performance.now(); Reflect.set(globalThis, 'imageMaxMainGap', Math.max(Number(Reflect.get(globalThis, 'imageMaxMainGap')), now - last)); last = now; }, 50));
    }, output);
    await page.locator('[data-application-module="browser"]').click(); await browser({ type: 'tab.new', url });
    await expect.poll(async () => (await browser({ type: 'state' })).state?.tabs.find(tab => tab.url === url)?.loading).toBe(false);
    const original = await app.evaluate(async ({ webContents }, url) => { const c = webContents.getAllWebContents().find(c => c.getURL() === url)!; return { id: c.id, document: await c.executeJavaScript('({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,scrollY,ratio:devicePixelRatio})') as { height: number; width: number; scrollY: number; ratio: number } }; }, url);
    report.original = original;
    // The visible More menu and native context menu share the same production job.
    await page.locator('.browser-menu-trigger').click(); await page.getByRole('button', { name: '网页转长图', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '网页转长图', exact: true }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('progressbar')).toBeVisible();
    await expect.poll(async () => (await browser({ type: 'state' })).state?.pageImage?.completed, { timeout: 60000 }).toBeGreaterThan(0);
    await screenshot('generating-progress');
    let lastProgress = -1;
    await expect.poll(async () => { const state = (await browser({ type: 'state' })).state?.pageImage; if (state && state.completed !== lastProgress) { lastProgress = state.completed; console.log('[page image]', state.phase, state.completed, '/', state.total); } if (state?.phase === 'failed') throw Error(state.error); return state?.phase; }, { timeout: 240000, intervals: [250] }).toBe('preview');
    const generated = (await browser({ type: 'state' })).state!.pageImage!;
    expect(generated.height).toBeGreaterThan(65500); expect(generated.width! * generated.height!).toBeGreaterThan(64000000);
    expect(await app.evaluate(() => Reflect.get(globalThis, 'imageSavePickerCalls') ?? 0)).toBe(0);
    expect(await readFile(output).then(() => true).catch(() => false)).toBe(false);
    await expect(dialog.locator('.browser-image-band img').first()).toBeVisible(); await screenshot('preview-before-save');
    await dialog.locator('.browser-image-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await expect(dialog.locator('.browser-image-band').last().locator('img')).toBeVisible(); await screenshot('preview-complete-bottom');
    const native = await app.evaluate(async ({ webContents }, url) => { const c = webContents.getAllWebContents().find(c => c.getURL() === url)!; return { id: c.id, state: await c.executeJavaScript('({scrollY,images:document.images.length,loaded:[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length})') as { scrollY: number; images: number; loaded: number } }; }, url);
    expect(native.id).toBe(original.id); expect(native.state.scrollY).toBe(original.document.scrollY); expect(native.state.loaded).toBe(56);
    await dialog.getByRole('button', { name: '确认保存…', exact: true }).click(); await expect(dialog.getByText('已保存', { exact: true })).toBeVisible();
    const metadata = await sharp(output, { limitInputPixels: false }).metadata(); expect(metadata.width).toBe(generated.width); expect(metadata.height).toBe(generated.height);
    const bottom = [...await sharp(output, { limitInputPixels: false }).extract({ left: 10, top: metadata.height! - 30, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]; expect(bottom).toEqual([24, 160, 92]);
    const ratio = original.document.ratio, imageX = Math.round((generated.width! - 1000 * ratio) / 2 + 10 * ratio);
    const markers = await samplePngRows(output, generated.width!, Array.from({ length: 56 }, (_, index) => ({ x: imageX, y: Math.round((100 + index * 1400 + 10) * ratio) })));
    expect(markers).toEqual(Array.from({ length: 56 }, (_, index) => [index * 3, 80, 200 - index * 2])); report.allImagePositionsVerified = true;
    report.capture = generated; report.output = output; report.bottomPixel = bottom; report.savedOnlyAfterConfirmation = true; report.loadedImages = native.state.loaded; report.originalScrollPreserved = true;
    report.maxMainThreadGapMs = await app.evaluate(() => Reflect.get(globalThis, 'imageMaxMainGap')); expect(report.maxMainThreadGapMs).toBeLessThan(2000);
    await dialog.getByRole('button', { name: '关闭长图预览', exact: true }).click();
    // Exercise production cancellation without waiting for a large capture.
    await browser({ type: 'page.image' }); await expect(dialog).toBeVisible(); await dialog.getByRole('button', { name: '取消生成', exact: true }).click();
    await expect(dialog.getByText('已取消', { exact: true }).first()).toBeVisible(); await dialog.getByRole('button', { name: '关闭长图预览', exact: true }).click();
    // Inject only a native CDP failure; all reporting goes through real production code.
    await app.evaluate(({ webContents }, url) => { const c = webContents.getAllWebContents().find(c => c.getURL() === url)!; c.capturePage = () => Promise.reject(Error('验收：浏览器截图失败，请重新生成')); }, url);
    await browser({ type: 'page.image' }); await expect(dialog.getByRole('alert')).toContainText('验收：浏览器截图失败'); await screenshot('native-error-in-app');
    report.errorShownInApp = true; report.cancellationPassed = true; report.passed = true;
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  } catch (error) { report.error = String(error); await writeFile(path.join(evidence, 'failure.json'), JSON.stringify(report, null, 2)); await screenshot('failure').catch(() => undefined); throw error; }
  finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
