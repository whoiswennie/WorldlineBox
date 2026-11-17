import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

const source = process.env.WORLDLINEBOX_E2E_YACHIYO_MODEL;
const mikuSource = process.env.WORLDLINEBOX_E2E_MIKU_MODEL;

async function openCompanionWorkspace(app: ElectronApplication, profile: string, source: string): Promise<Page> {
  const workspace = '[data-application-module="companions"]';
  let page: Page | undefined;
  await expect.poll(async () => {
    for (const candidate of app.windows()) {
      if (await candidate.locator(workspace).count().catch(() => 0)) { page = candidate; return true; }
    }
    return false;
  }, { timeout: 45_000 }).toBe(true);
  if (!page) throw Error('Missing companion workspace');
  await app.evaluate(({ app, BrowserWindow, dialog }, fixture) => {
    if (app.getPath('userData') !== fixture.profile) throw Error('Unexpected test profile');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture.source] });
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setAudioMuted(true);
      window.webContents.setBackgroundThrottling(false);
      window.setSize(1600, 1000);
    }
  }, { profile, source });
  await page.locator(workspace).click();
  await page.getByRole('button', { name: '关闭 DSH 配置', exact: true }).click();
  await enableCallVisualFixture(app, page);
  return page;
}

test('loads both built-in Live2D models in a clean video call without importing assets', async () => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-bundled-call-models-'));
  const app = await electron.launch({
    ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }),
  });
  try {
    const page = await openCompanionWorkspace(app, profile, '');
    const bundledResources = new Set<string>();
    await page.exposeFunction('recordBundledModelResource', (url: string) => {
      const file = decodeURIComponent(new URL(url).pathname).split('/companion-call/')[1];
      if (file) bundledResources.add(file);
    });
    await page.evaluate(() => {
      const record = (url: string) => {
        const track = Reflect.get(window, 'recordBundledModelResource') as (url: string) => Promise<void>;
        void track(new URL(url, document.baseURI).href);
      };
      const fetchResource = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const result = await fetchResource(...args);
        if (result.ok) record(result.url);
        return result;
      };
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => record(this.responseURL), { once: true });
        Reflect.apply(send, this, args);
      };
      const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...src,
        set(this: HTMLImageElement, value: string) {
          this.addEventListener('load', () => record(this.currentSrc), { once: true });
          src.set!.call(this, value);
        },
      });
    });
    const fixtures = [
      { name: '大肥鱼', moc: 'dafeiyu/大肥鱼.moc3' },
      { name: '月见八千代', moc: 'yachiyo/八千代辉夜姬.moc3' },
    ];
    for (const fixture of fixtures) {
      await page.getByRole('tab', { name: /^联系人/u }).click();
      await page.locator('.bot-contact').filter({ has: page.getByText(fixture.name, { exact: true }) }).click();
      const header = page.locator('.bot-chat-header');
      await expect(header.locator('h2')).toHaveText(fixture.name);
      if (fixture.name === '月见八千代') {
        const portrait = header.locator('img[src$="/companion-call/yachiyo/portrait.png"]');
        await expect(portrait).toBeVisible();
        await expect.poll(() => portrait.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      }
      await header.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      const meeting = page.getByRole('dialog', { name: `与${fixture.name}会面`, exact: true });
      await meeting.getByRole('button', { name: '接通', exact: true }).click();
      await expect(meeting.locator('.bot-call-live2d[data-pet-figure] canvas')).toBeVisible({ timeout: 60_000 });
      await expect(meeting.locator('.bot-call-loading')).toHaveCount(0);
      await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
      await expect.poll(() => [...bundledResources]).toContain(fixture.moc);
      await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
      await expect(meeting).toBeHidden();
    }
    for (const file of ['八千代辉夜姬.8192/texture_00.png', '八千代辉夜姬.8192/texture_01.png']) {
      await expect.poll(() => [...bundledResources]).toContain('yachiyo/' + file);
    }
  } finally {
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- The real Electron app owns this page.
test('imports the SnowBear model and renders it in Yachiyo’s video call', async ({}, testInfo) => {
  test.skip(!source, 'Set WORLDLINEBOX_E2E_YACHIYO_MODEL to the original extracted model folder.');
  test.setTimeout(150_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-yachiyo-call-'));
  const app = await electron.launch({
    ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }),
  });
  try {
    const page = await openCompanionWorkspace(app, profile, source!);
    const loaded = new Set<string>();
    page.on('response', response => {
      if (response.ok() && response.url().startsWith('worldlinebox://call-model/imports/')) loaded.add(decodeURIComponent(new URL(response.url()).pathname));
    });
    await page.getByRole('tab', { name: /^联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('月见八千代', { exact: true }) }).click();
    const header = page.locator('.bot-chat-header');
    await expect(header.locator('h2')).toHaveText('月见八千代');
    const persona = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      return (await api.request({ type: 'companion.personas.get', companionId: 'yachiyo-runami', id: 'default' })).persona?.prompt;
    });
    expect(persona).toContain('月读');
    expect(persona).toContain('语气参考');
    await header.getByRole('button', { name: '角色卡', exact: true }).click();
    const card = page.getByRole('dialog', { name: '角色卡 · 月见八千代', exact: true });
    await card.getByRole('button', { name: '形象与表演', exact: true }).click();
    await card.getByRole('button', { name: '导入模型文件夹', exact: true }).click();
    await expect(card.getByText('泪珠', { exact: true })).toBeVisible();
    await expect(card.getByText('笑咪咪', { exact: true })).toBeVisible();
    const moc = '八千代辉夜姬.moc3';
    const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
    const directory = path.join(profile, 'companion-call-model-imports', createHash('sha256').update('yachiyo-runami').digest('hex'));
    const generation = JSON.parse(await readFile(path.join(directory, 'active.json'), 'utf8')) as string;
    expect(await sha256(path.join(directory, generation, 'model', moc))).toBe(await sha256(path.join(source!, moc)));
    await card.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(card).toBeHidden();
    await header.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与月见八千代会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d[data-pet-figure] canvas')).toBeVisible({ timeout: 90_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0);
    await expect(meeting.locator('.bot-call-model-error')).toHaveCount(0);
    for (const file of ['八千代辉夜姬.model3.json', moc, '八千代辉夜姬.8192/texture_00.png', '八千代辉夜姬.8192/texture_01.png', '笑咪咪.exp3.json']) {
      expect([...loaded].some(asset => asset.endsWith('/model/' + file))).toBe(true);
    }
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    const evidence = path.resolve('artifacts/companion-yachiyo');
    await mkdir(evidence, { recursive: true });
    const screenshot = path.join(evidence, 'yachiyo-call.png');
    await writeFile(screenshot, Buffer.from(png, 'base64'));
    await testInfo.attach('Yachiyo Live2D call', { path: screenshot, contentType: 'image/png' });
  } finally {
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- The real Electron app owns this page.
test('a portrait-only companion can choose any model folder and restore its default', async ({}) => {
  test.setTimeout(150_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-gpt-call-'));
  const app = await electron.launch({
    ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }),
  });
  try {
    const page = await openCompanionWorkspace(app, profile, path.resolve('public/companion-call/dafeiyu'));
    await page.getByRole('tab', { name: /^联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    const header = page.locator('.bot-chat-header');
    const card = page.getByRole('dialog', { name: '角色卡 · GPT', exact: true });
    const openCard = async () => {
      await header.getByRole('button', { name: '角色卡', exact: true }).click();
      await card.getByRole('button', { name: '形象与表演', exact: true }).click();
    };
    await openCard();
    await card.getByRole('button', { name: '导入模型文件夹', exact: true }).click();
    await expect(card.getByText('模型已导入。', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '更换模型文件夹', exact: true })).toBeVisible();
    await card.getByRole('button', { name: '关闭', exact: true }).click();
    await header.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与GPT会面', exact: true });
    const manifest = page.waitForResponse(response => response.ok() && /^worldlinebox:\/\/call-model\/imports\/.+\/model\/call\.model3\.json$/u.test(response.url()));
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await manifest;
    await expect(meeting.locator('.bot-call-live2d[data-pet-figure] canvas')).toBeVisible({ timeout: 90_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0);
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
    await expect(meeting).toBeHidden();
    await openCard();
    await card.getByRole('button', { name: '恢复默认形象', exact: true }).click();
    await expect(card.getByText('当前使用静态形象。', { exact: true })).toBeVisible();
    const otherStage = await page.evaluate(async () => {
      const api = (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot;
      return (await api.request({ type: 'companion.call-performance', companionId: 'builtin-dafeiyu' })).callStage;
    });
    expect(otherStage).toMatchObject({ mode: 'live2d', model: 'dafeiyu/call.model3.json' });
  } finally {
    await app.close();
    removeCompanionTestDirectory(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- The real Electron app owns this page.
test('automatically frames the imported Miku model and keeps manual adjustments after restarting', async ({}) => {
  test.skip(!mikuSource, 'Set WORLDLINEBOX_E2E_MIKU_MODEL to the original extracted model folder.');
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-miku-framing-'));
  const launch = () => electron.launch({
    ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }),
  });
  let app = await launch();
  const openGpt = async (instance: ElectronApplication) => {
    const page = await openCompanionWorkspace(instance, profile, mikuSource!);
    await page.getByRole('tab', { name: /^联系人/u }).click();
    await page.locator('.bot-contact').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    return page;
  };
  const openCall = async (page: Page) => {
    await page.locator('.bot-chat-header').getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与GPT会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await expect(meeting.locator('.bot-call-live2d[data-pet-figure] canvas')).toBeVisible({ timeout: 90_000 });
    await expect(meeting.locator('.bot-call-loading')).toHaveCount(0);
    return meeting;
  };
  const readFigure = (meeting: ReturnType<Page['getByRole']>) => meeting.locator('.bot-call-live2d').evaluate(stage => {
    const [x, y, width, height] = stage.getAttribute('data-pet-figure')!.split(',').map(Number);
    return { centerX: (x! + width! / 2) / stage.clientWidth, top: y! / stage.clientHeight, height: height! / stage.clientHeight };
  });
  try {
    const page = await openGpt(app);
    await page.locator('.bot-chat-header').getByRole('button', { name: '角色卡', exact: true }).click();
    const card = page.getByRole('dialog', { name: '角色卡 · GPT', exact: true });
    await card.getByRole('button', { name: '形象与表演', exact: true }).click();
    await card.getByRole('button', { name: '导入模型文件夹', exact: true }).click();
    await expect(card.getByText('当前模型：miku', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '关闭', exact: true }).click();
    const meeting = await openCall(page);
    const figure = await readFigure(meeting);
    expect(figure.centerX).toBeCloseTo(.5, 1);
    expect(figure.top).toBeGreaterThanOrEqual(.035);
    expect(figure.height).toBeGreaterThan(.7);
    const evidence = path.resolve('artifacts/companion-live2d-framing');
    await mkdir(evidence, { recursive: true });
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    await writeFile(path.join(evidence, 'miku-auto-framing.png'), Buffer.from(png, 'base64'));
    const controls = async (dialog: typeof meeting) => {
      await dialog.getByRole('button', { name: '会面菜单', exact: true }).click();
      await dialog.getByRole('button', { name: '场景与互动', exact: true }).click();
      return dialog.locator('aside[aria-label="场景与形象互动"]');
    };
    const panel = await controls(meeting);
    await panel.getByRole('slider', { name: '水平位置', exact: true }).press('End');
    await panel.getByRole('slider', { name: '垂直位置', exact: true }).press('Home');
    await panel.getByRole('slider', { name: '形象大小', exact: true }).press('ArrowRight');
    const size = await panel.getByRole('slider', { name: '形象大小', exact: true }).inputValue();
    await meeting.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
    await app.close();
    app = await launch();
    const reopened = await openCall(await openGpt(app));
    const restored = await controls(reopened);
    await expect(restored.getByRole('slider', { name: '水平位置', exact: true })).toHaveValue('0.4');
    await expect(restored.getByRole('slider', { name: '垂直位置', exact: true })).toHaveValue('-0.4');
    await expect(restored.getByRole('slider', { name: '形象大小', exact: true })).toHaveValue(size);
    expect((await readFigure(reopened)).centerX).toBeCloseTo(.9, 1);
    await restored.getByRole('button', { name: '自动取景', exact: true }).click();
    await expect(restored.getByRole('slider', { name: '水平位置', exact: true })).toHaveValue('0');
    await expect(restored.getByRole('slider', { name: '垂直位置', exact: true })).toHaveValue('0');
    await expect(restored.getByRole('slider', { name: '形象大小', exact: true })).toHaveValue('1');
    expect((await readFigure(reopened)).centerX).toBeCloseTo(.5, 1);
  } finally {
    await app.close().catch(() => undefined);
    removeCompanionTestDirectory(profile);
  }
});
