import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { test, expect, _electron as electron } from '@playwright/test';
import { build } from 'vite';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('capture preload reuses the extension in all sandboxed frames without exposing privileged APIs to the page', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-capture-preload-'));
  const output = path.join(root, 'build'); await mkdir(output); await mkdir(path.join(root, 'electron-data'));
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  await writeFile(path.join(root, 'pixel.png'), pixel);
  await writeFile(path.join(root, 'gallery.html'), '<!doctype html><html><body><img id="media" draggable="true" width="80" height="80" src="pixel.png"></body></html>');
  await build({ configFile: path.resolve('vite.browser-capture-preload.config.ts'), logLevel: 'error',
    build: { outDir: output, emptyOutDir: false } });
  const bundle = await readFile(path.join(output, 'browser-capture.js'), 'utf8');
  expect([...bundle.matchAll(/require\(["']([^"']+)["']\)/gu)].map(match => match[1])).toEqual(['electron']);
  expect(bundle).not.toContain('exposeInMainWorld');
  // Add a test-only isolated-world probe to the same real preload. It reports
  // sandbox state directly to Main and is never included in production builds.
  await build({ configFile: path.resolve('vite.browser-capture-preload.config.ts'), logLevel: 'error',
    build: { outDir: output, emptyOutDir: false,
      lib: { entry: path.resolve('tests/fixtures/browser-capture/preload-probe.ts'), formats: ['cjs'], fileName: () => 'browser-capture-probe.js' },
      rollupOptions: { external: ['electron', 'node:fs'] } } });
  await build({ configFile: false, logLevel: 'error', ssr: { noExternal: true, external: ['electron'] },
    build: { ssr: path.resolve('tests/fixtures/browser-capture/preload-main.ts'), outDir: output, emptyOutDir: false, target: 'node24',
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } });
  let childOrigin = '';
  function server(withFrame: boolean) {
    return http.createServer((request, response) => {
      if (request.url === '/pixel.png') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(pixel); return; }
      response.writeHead(200, { 'content-type': 'text/html',
        'content-security-policy': "default-src 'self'; script-src 'none'; style-src 'none'; img-src 'self'; frame-src http://127.0.0.1:*" });
      // No inline page styling: the fixture itself must respect the same CSP.
      response.end('<!doctype html><html><body><div><img id="media" draggable="true" width="80" height="80" src="/pixel.png"></div>'
        + (withFrame ? '<div>' + '<br>'.repeat(20) + '</div><iframe width="900" height="500" src="' + childOrigin + '/child"></iframe>' : '') + '</body></html>');
    });
  }
  const childServer = server(false); const mainServer = server(true);
  async function listen(value: http.Server): Promise<string> {
    await new Promise<void>(resolve => value.listen(0, '127.0.0.1', resolve));
    const address = value.address(); if (!address || typeof address === 'string') throw new Error('No fixture server port');
    return `http://127.0.0.1:${address.port}`;
  }
  childOrigin = await listen(childServer); const origin = await listen(mainServer);
  try {
    const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [path.join(output, 'main.cjs')],
      env: electronLaunchEnv({ WORLDLINEBOX_CAPTURE_PRELOAD_ROOT: root, WORLDLINEBOX_CAPTURE_PRELOAD_ORIGIN: origin, WORLDLINEBOX_CAPTURE_PRELOAD_CHILD_ORIGIN: childOrigin }) });
    const child = application.process();
    let driver = Promise.resolve(); let lineBuffer = ''; let log = '';
    async function reply(value: { id?: number; error?: string; start?: boolean }): Promise<void> {
      await application.evaluate((_electron, response) => {
        (globalThis as typeof globalThis & { captureFixtureDriver(response: typeof value): void }).captureFixtureDriver(response);
      }, value);
    }
    async function drive(command: { id: number; url: string; action: 'save' | 'disabled' }): Promise<void> {
      try {
        const page = application.context().pages().find(candidate => candidate.frames().some(frame => frame.url() === command.url));
        if (!page) throw new Error('Cannot find capture fixture page for ' + command.url);
        const frame = page.frames().find(candidate => candidate.url() === command.url)!;
        const box = await frame.locator('#media').boundingBox(); if (!box) throw new Error('No media hit target');
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 10, { steps: 5 });
        await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 30, { steps: 8 });
        if (command.action === 'save') {
          const folder = frame.locator('[data-worldlinebox-radial-menu] .cmd .body').filter({ hasText: 'Fixture folder' }).first();
          await expect(folder).toBeVisible({ timeout: 8_000 });
          const layout = await frame.locator('[data-worldlinebox-radial-menu]').evaluate(host => {
            const root = host.shadowRoot!;
            return { treePosition: getComputedStyle(root.querySelector('.tree-host')!).position,
              slideDisplay: getComputedStyle(root.querySelector('.slide')!).display, adoptedStyles: root.adoptedStyleSheets.length };
          });
          expect(layout).toEqual({ treePosition: 'fixed', slideDisplay: 'flex', adoptedStyles: 1 });
          const target = await folder.boundingBox(); if (!target) throw new Error('No original extension folder target');
          expect(target.width).toBeGreaterThan(40); expect(target.height).toBeGreaterThan(10);
          await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
          await page.mouse.move(target.x + target.width / 2 + 1, target.y + target.height / 2);
        } else await new Promise(resolve => setTimeout(resolve, 100));
        await page.mouse.up();
        await reply({ id: command.id });
      } catch (error) { console.log('CAPTURE_DRIVER_ERROR', command.id, String(error)); await reply({ id: command.id, error: String(error) }); }
    }
    function outputChunk(chunk: Buffer): void {
      const text = String(chunk); log += text; lineBuffer += text;
      let end: number;
      while ((end = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, end).trim(); lineBuffer = lineBuffer.slice(end + 1);
        if (line.startsWith('BROWSER_CAPTURE_DRIVER ')) {
          const command: { id: number; url: string; action: 'save' | 'disabled' } = JSON.parse(line.slice('BROWSER_CAPTURE_DRIVER '.length));
          driver = driver.then(() => drive(command));
        }
      }
    }
    child.stdout?.on('data', outputChunk); child.stderr?.on('data', outputChunk);
    const timer = setTimeout(() => child.kill(), 55_000);
    const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try {
      await reply({ start: true });
      const code = await exit;
      await driver;
      await test.info().attach('browser-capture-preload', { body: log, contentType: 'text/plain' });
      expect(code, log + '\nEvidence: ' + root).toBe(0); expect(log).toContain('BROWSER_CAPTURE_PRELOAD_RESULT');
      console.log(log.split(/\r?\n/u).find(line => line.startsWith('BROWSER_CAPTURE_PRELOAD_RESULT ')));
    } finally { clearTimeout(timer); await application.close().catch(() => undefined); }
  } finally {
    for (const value of [mainServer, childServer]) { value.closeAllConnections(); await new Promise<void>(resolve => value.close(() => resolve())); }
  }
});
