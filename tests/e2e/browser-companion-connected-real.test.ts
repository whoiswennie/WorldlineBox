import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBrowserApi, BrowserRequest } from '../../src/shared/browser';
import type { WorldlineBoxBotApi, BotRequest, BotMessage } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import sharp from 'sharp';

// eslint-disable-next-line no-empty-pattern -- Real DSH model, real native tab, real authenticated loopback application.
test('native context menu captures the full page and connects a companion to the same authenticated browser application', async ({}, testInfo) => {
  test.skip(process.env.WORLDLINEBOX_BROWSER_COMPANION_REAL !== '1', 'Requires the owned real-model profile.'); test.setTimeout(600000);
  const profile = path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE ?? '');
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-project-real-')) throw Error('Requires an owned real acceptance profile.');
  const evidence = path.resolve('artifacts/browser-companion-connected-real'); await mkdir(evidence, { recursive: true });
  const output = path.join(evidence, 'complete-page-' + Date.now().toString(36) + '.png'), report: Record<string, unknown> = { realNativeBrowser: true, realDshModel: true, profile, stages: [] };
  const server = createServer((request, response) => {
    if (request.url === '/login') { response.writeHead(302, { 'set-cookie': 'reader_session=owned_fixture; HttpOnly; SameSite=Lax; Path=/', location: '/workspace' }); response.end(); return; }
    const signedIn = request.headers.cookie?.includes('reader_session=owned_fixture');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>已登录的工作台</title><style>*{box-sizing:border-box}html,body{margin:0;font:18px sans-serif;background:#fff;color:#24324b}header{height:180px;background:#e9efff;padding:28px}main{min-height:11820px;padding:28px}input{padding:12px;font:inherit;width:400px}footer{height:120px;background:rgb(24,160,92);color:white;padding:30px}</style></head><body><header><h1>伙伴浏览器连接验收</h1><p id="account">${signedIn ? '已登录：测试会员' : '未登录'}</p></header><main><label for="filter">筛选关键词</label><input id="filter" aria-label="筛选关键词" autocomplete="off"><p id="result">筛选结果：全部</p><p>这是用户当前已经打开的工作台。任务目标只是在本地筛选，不会向外发送或保存。</p>${'<p>真实长网页内容，保留用户当前视口和登录状态。</p>'.repeat(60)}</main><footer>长图底部校验：完整网页已捕获。</footer><script>document.querySelector('#filter').addEventListener('input',e=>document.querySelector('#result').textContent='筛选结果：'+(e.target.value||'全部'))</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture port'); const origin = `http://127.0.0.1:${address.port}`;
  const app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1' }) });
  const page = await app.firstWindow();
  const browser = async (input: BrowserRequest) => { const result = await page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { browser: WorldlineBoxBrowserApi }).browser.request(input), input); if (!result.ok) throw Error(result.error); return result; };
  const bot = (input: BotRequest) => page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), input);
  const stage = async (name: string) => { (report.stages as object[]).push({ name, at: new Date().toISOString() }); console.log('[connected browser] ' + name); await writeFile(path.join(evidence, 'progress.json'), JSON.stringify(report, null, 2)); };
  const capture = async (name: string) => { const filename = path.join(evidence, name + '.png'); await page.screenshot({ path: filename, fullPage: true }); await testInfo.attach(name, { path: filename, contentType: 'image/png' }); };
  const native = async () => app.evaluate(async ({ webContents }, origin) => { const contents = webContents.getAllWebContents().find(contents => contents.getURL() === origin + '/workspace'); if (!contents) throw Error('Original native tab is absent'); return { id: contents.id, url: contents.getURL(), document: await contents.executeJavaScript(`({account:document.querySelector('#account').textContent,filter:document.querySelector('#filter').value,result:document.querySelector('#result').textContent,scrollY,viewportHeight:innerHeight,height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth})`) as { account: string; filter: string; result: string; scrollY: number; viewportHeight: number; height: number; width: number } }; }, origin);
  const contextMenu = async () => {
    await expect.poll(async () => (await native()).document.viewportHeight).toBeGreaterThan(200);
    await app.evaluate(async ({ webContents }, origin) => {
      Reflect.set(globalThis, 'connectedBrowserMenu', undefined); const contents = webContents.getAllWebContents().find(contents => contents.getURL() === origin + '/workspace')!;
      // CDP delivers an actual Chromium right click even when the offscreen
      // acceptance window has no OS focus. The normal Electron menu handler runs.
      contents.debugger.attach('1.3');
      try { await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', clickCount: 1, x: 120, y: 100 }); await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', clickCount: 1, x: 120, y: 100 }); }
      finally { contents.debugger.detach(); }
    }, origin);
    await expect.poll(() => app.evaluate(() => !!Reflect.get(globalThis, 'connectedBrowserMenu')), { timeout: 15000 }).toBe(true);
  };
  const chooseMenu = async (id: string) => app.evaluate(({ BrowserWindow }, id) => { const menu = Reflect.get(globalThis, 'connectedBrowserMenu') as Electron.Menu; const item = menu.getMenuItemById(id); if (!item?.enabled) throw Error('Missing or disabled native menu item ' + id); item.click(item, BrowserWindow.getAllWindows()[0], {} as Electron.KeyboardEvent); }, id);
  try {
    await expect(page.locator('[data-application-module="browser"]')).toBeVisible();
    await app.evaluate(({ BrowserWindow, Menu, dialog }, output) => { const win = BrowserWindow.getAllWindows()[0]!; win.setSize(1680, 1040); win.webContents.setBackgroundThrottling(false); Menu.prototype.popup = function () { Reflect.set(globalThis, 'connectedBrowserMenu', this); }; dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.locator('[data-application-module="browser"]').click(); expect((await browser({ type: 'tab.new', url: origin + '/login' })).ok).toBe(true);
    await expect.poll(async () => (await browser({ type: 'state' })).ok && (await browser({ type: 'state' })).state?.tabs.some(tab => tab.url === origin + '/workspace' && !tab.loading)).toBe(true);
    const original = await native(), state = (await browser({ type: 'state' })).state!, tabId = state.activeTabId!, tabCount = state.tabs.length;
    expect(original.document.account).toBe('已登录：测试会员');
    await stage('native-right-click-full-page-image'); await contextMenu(); await chooseMenu('browser-page-image');
    await expect.poll(async () => (await browser({ type: 'state' })).state?.pageImage?.phase, { timeout: 90000 }).toBe('preview');
    await expect(page.getByRole('dialog', { name: '网页转长图', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认保存…', exact: true }).click();
    await expect.poll(async () => readFile(output).then(bytes => bytes.length).catch(() => 0), { timeout: 30000 }).toBeGreaterThan(24);
    await page.getByRole('button', { name: '关闭长图预览', exact: true }).click();
    const metadata = await sharp(output).metadata(); expect(metadata.height).toBeGreaterThan(10000); expect(metadata.height).toBeGreaterThan(original.document.viewportHeight * 4);
    const bottom = await sharp(output).extract({ left: 10, top: metadata.height! - 30, width: 1, height: 1 }).removeAlpha().raw().toBuffer(); expect([...bottom]).toEqual([24, 160, 92]);
    expect((await native()).document.scrollY).toBe(original.document.scrollY); report.fullPageImage = { width: metadata.width, height: metadata.height, bottomPixel: [...bottom], scrollPreserved: true };
    await stage('native-right-click-summon-and-at-search'); await contextMenu(); await chooseMenu('browser-summon-companion');
    const picker = page.getByRole('dialog', { name: '呼唤伙伴', exact: true }); await expect(picker).toBeVisible(); await picker.getByLabel('@伙伴名称', { exact: true }).fill('@大肥鱼'); await capture('summon-companion-picker'); await picker.getByRole('button', { name: /大肥鱼/ }).click();
    await expect(picker).toBeHidden(); await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const openContext = page.getByRole('button', { name: '查看所附网页', exact: true }).last(), removeContext = page.getByRole('button', { name: '移除网页上下文', exact: true });
    const openBox = await openContext.boundingBox(), removeBox = await removeContext.boundingBox();
    expect(openBox && removeBox && Math.abs(openBox.y + openBox.height / 2 - removeBox.y - removeBox.height / 2)).toBeLessThan(1);
    await expect(page.locator('.bot-compose-dock [data-browser-context-tab],.bot-compose [data-browser-context-tab],.bot-composer-container [data-browser-context-tab]').or(page.locator('.bot-thread-column [data-browser-context-tab]').last()).first()).toBeVisible();
    const roomId = (await bot({ type: 'conversation.open', companionId: 'builtin-dafeiyu' })).conversationId!;
    await page.getByRole('button', { name: '新话题', exact: true }).click();
    const send = async (content: string): Promise<BotMessage> => {
      const before = Math.max(0, ...(await bot({ type: 'state', conversationId: roomId })).snapshot!.messages.map(message => message.sequence));
      await page.locator('.bot-composer textarea').fill(content); await page.locator('.bot-composer .bot-send').click();
      let reply: BotMessage | undefined; await expect.poll(async () => { const messages = (await bot({ type: 'state', conversationId: roomId })).snapshot!.messages; reply = messages.find(message => message.sequence > before && message.senderId === 'builtin-dafeiyu' && message.execution); if (reply?.status === 'failed') throw Error(reply.error ?? 'Native browser task failed'); return reply?.status; }, { timeout: 240000, intervals: [500] }).toBe('sent'); return reply!;
    };
    await stage('dsh-operates-original-authenticated-tab');
    const first = await send('请使用本条消息附加的世界线盒子内置浏览器。优先用 browser 工具 observe/read 当前 tabId，不要新开页面或其他浏览器。核对网页显示的登录账号，用该工具把“筛选关键词”输入框填成“鲸鱼”，只做本地筛选。最后报告实际账号和筛选结果，不要问问题，不要联系其他伙伴。');
    expect(first.content).toContain('测试会员'); expect(first.content).toContain('鲸鱼'); expect(first.execution!.steps.filter(step => step.toolName === 'browser').length).toBeGreaterThanOrEqual(2);
    const after = await native(); expect(after.id).toBe(original.id); expect(after.document.filter).toBe('鲸鱼'); expect(after.document.result).toBe('筛选结果：鲸鱼'); expect((await browser({ type: 'state' })).state!.tabs.length).toBe(tabCount);
    await capture('connected-browser-task-reply');
    await stage('follow-up-uses-same-session-and-application');
    const second = await send('继续刚才的网页任务。仍使用相同的内置浏览器标签页，把筛选关键词改成“星海”，核实页面显示后回复实际结果。不要开新网页。');
    expect(second.execution!.sessionId).toBe(first.execution!.sessionId); expect((await native()).document.filter).toBe('星海'); expect((await native()).id).toBe(original.id);
    await page.getByRole('button', { name: '应用', exact: true }).click(); await page.getByRole('dialog', { name: '连接应用', exact: true }).getByRole('button', { name: /内置浏览器/ }).click(); await expect(page.getByRole('button', { name: '移除网页上下文', exact: true })).toBeVisible(); await page.getByRole('button', { name: '移除网页上下文', exact: true }).click();
    report.passed = true; report.fullPageImagePath = output; report.sameNativeWebContents = original.id; report.tabId = tabId; report.noNewTab = true; report.sessionId = first.execution!.sessionId; report.nativeBrowserCalls = first.execution!.steps.filter(step => step.toolName === 'browser').length; report.sameSessionFollowup = true; report.existingLoginUsed = true;
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); await writeFile(path.join(evidence, 'failure.json'), JSON.stringify(report, null, 2)); await capture('failure').catch(() => undefined); throw error; }
  finally { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
