import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorkspaceRequest } from '../../src/shared/companion-workspace';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type BridgeWindow = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; library: WorldlineBoxLibraryApi } };
const createDialog = (page: Page) => page.getByRole('dialog', { name: '创建伙伴资产库', exact: true });
const existingDialog = (page: Page) => page.getByRole('dialog', { name: '使用已有资产库', exact: true });
const selectedName = (page: Page) => page.locator('.companion-workspace-name');
const submit = (page: Page) => createDialog(page).getByRole('button', { name: '选择位置并创建', exact: true });
test.describe.configure({ timeout: 180_000 });

// All renderer operations use the real preload/main/SQLite lifecycle. Only the
// native picker response is supplied by the isolated Electron test fixture.
// No chat model, embedding inference, existing profile or real user library is used.
// eslint-disable-next-line no-empty-pattern
test('creates the companion library in place, handles cancellation and creation failure, and restores the choice after restart', async ({}, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-onboarding-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    await enterCompanions(page);
    await expect(createDialog(page)).toBeVisible();
    await expect(createDialog(page).getByRole('textbox', { name: '资产库名称', exact: true })).toHaveValue('伙伴资产库');
    await captureOnboarding(page);
    await expect(page.getByRole('button', { name: '前往资产管理创建资产库', exact: true })).toHaveCount(0);
    expect((await workspace(page, { type: 'status' })).selected).toBeUndefined();
    expect(existsSync(path.join(profile, 'companion-library.json'))).toBe(false);

    await createDialog(page).getByRole('button', { name: '关闭伙伴资产库设置', exact: true }).click();
    await expect(createDialog(page)).toBeHidden();
    await page.getByRole('region', { name: '伙伴资产库', exact: true }).getByRole('button', { name: '创建伙伴资产库', exact: true }).click();
    await expect(createDialog(page)).toBeVisible();
    // Cancelling the folder picker leaves the form editable and creates nothing.
    await setPickers(application, { createParent: null });
    await submit(page).click();
    await expect(submit(page)).toBeEnabled();
    await expect(createDialog(page).getByRole('alert')).toHaveCount(0);
    expect((await workspace(page, { type: 'status' })).selected).toBeUndefined();
    expect(existsSync(path.join(root, '伙伴资产库'))).toBe(false);
    await expect.poll(() => createDialog(page).evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(createDialog(page)).toBeHidden();
    await page.getByRole('region', { name: '伙伴资产库', exact: true }).getByRole('button', { name: '创建伙伴资产库', exact: true }).click();
    await expect(createDialog(page)).toBeVisible();

    // A genuine worker creation conflict must not overwrite the existing folder.
    const occupied = path.join(root, '同名目录'); mkdirSync(occupied);
    writeFileSync(path.join(occupied, '保留.txt'), '用户原有文件');
    await setPickers(application, { createParent: root });
    await createDialog(page).getByRole('textbox', { name: '资产库名称', exact: true }).fill('同名目录');
    await submit(page).click();
    await expect(createDialog(page).getByRole('alert')).toBeVisible();
    await expect(submit(page)).toBeEnabled();
    expect(readFileSync(path.join(occupied, '保留.txt'), 'utf8')).toBe('用户原有文件');
    expect((await workspace(page, { type: 'status' })).selected).toBeUndefined();

    const name = '我们的伙伴资产库';
    await createDialog(page).getByRole('textbox', { name: '资产库名称', exact: true }).fill(name);
    await submit(page).click();
    await expect(createDialog(page)).toBeHidden();
    await expect(selectedName(page)).toHaveText(name);
    await expect(page.locator('[data-application-module="companions"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('button', { name: '发起聊天', exact: true })).toBeVisible();
    const selection = (await workspace(page, { type: 'status' })).selected!;
    expect(selection.libraryPath).toBe(path.join(root, name));
    expect(selection.memoryRoot).toBe(path.join(selection.libraryPath, '伙伴记忆'));
    expect(selection.dataRoot).toBe(path.join(selection.libraryPath, '.worldlinebox', 'companions'));
    expect(existsSync(path.join(selection.libraryPath, '.worldlinebox', 'library.db'))).toBe(true);
    expect(existsSync(selection.memoryRoot)).toBe(true);
    expect(existsSync(selection.dataRoot)).toBe(true);
    expect(readdirSync(root).some(entry => entry.startsWith('.worldlinebox-create-'))).toBe(false);
    expect(existsSync(path.join(profile, 'companions'))).toBe(false);

    await application.close(); application = undefined;
    started = await launch(profile); application = started.application; page = started.page;
    await enterCompanions(page);
    await expect(selectedName(page)).toHaveText(name);
    await expect(createDialog(page)).toHaveCount(0);
    expect((await workspace(page, { type: 'status' })).selected).toEqual(selection);
    const proof = JSON.stringify({ realCreateAndBind: true, remainsInCompanions: true, pickerCancel: true, workerFailureRetry: true, preservedConflict: true, restoredAcrossRestart: true, library: selection }, null, 2);
    saveEvidence('create-proof.json', proof);
    await testInfo.attach('companion-library-create-proof', { body: proof, contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('offers opened libraries in the companion dialog and keeps the bound workspace when changing is cancelled', async ({}, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-onboarding-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    const started = await launch(profile); application = started.application; const page = started.page;
    const library = await createLibrary(page, '已有伙伴资产库');
    await enterCompanions(page);
    await createDialog(page).getByRole('button', { name: /使用已有资产库/u }).click();
    await expect(existingDialog(page)).toBeVisible();
    await expect(existingDialog(page).getByRole('button', { name: '使用资产库 已有伙伴资产库', exact: true })).toBeVisible();
    await page.screenshot({ path: evidencePath('existing-library-light.png'), animations: 'disabled' });
    await existingDialog(page).getByRole('button', { name: '使用资产库 已有伙伴资产库', exact: true }).click();
    await expect(selectedName(page)).toHaveText(library.displayName);
    const selection = (await workspace(page, { type: 'status' })).selected!;
    expect(selection.libraryId).toBe(library.libraryId);

    await page.getByRole('button', { name: '更换资产库', exact: true }).click();
    await expect(createDialog(page)).toBeVisible();
    // Existing conversations remain mounted underneath the modal when switching.
    await expect(page.getByRole('button', { name: '发起聊天', exact: true })).toBeVisible();
    await createDialog(page).getByRole('button', { name: '关闭伙伴资产库设置', exact: true }).click();
    await expect(createDialog(page)).toBeHidden();
    expect((await workspace(page, { type: 'status' })).selected).toEqual(selection);
    await expect(selectedName(page)).toHaveText(library.displayName);
    await testInfo.attach('companion-library-existing-proof', { body: JSON.stringify({ existingLibraryId: library.libraryId, selectedInPlace: true, cancelPreservesSelection: true, conversationsRemainMounted: true }), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('opens another library from the same dialog and preserves the current library after picker cancellation or an invalid folder', async ({}, testInfo) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companion-onboarding-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    const started = await launch(profile); application = started.application; const page = started.page;
    const first = await createLibrary(page, '当前伙伴资产库');
    const second = await createLibrary(page, '另一个伙伴资产库');
    const closed = await page.evaluate(id => (window as unknown as BridgeWindow).worldlinebox.library.close({ libraryId: id }), second.libraryId);
    expect(closed.ok).toBe(true);
    await enterCompanions(page);
    await createDialog(page).getByRole('button', { name: /使用已有资产库/u }).click();
    await existingDialog(page).getByRole('button', { name: '使用资产库 当前伙伴资产库', exact: true }).click();
    await expect(selectedName(page)).toHaveText(first.displayName);
    const selection = (await workspace(page, { type: 'status' })).selected!;

    await page.getByRole('button', { name: '更换资产库', exact: true }).click();
    await createDialog(page).getByRole('button', { name: /使用已有资产库/u }).click();
    await expect(existingDialog(page).getByRole('button', { name: '使用资产库 另一个伙伴资产库', exact: true })).toHaveCount(0);
    await setPickers(application, { chooseLibrary: null });
    await existingDialog(page).getByRole('button', { name: '打开其他资产库…', exact: true }).click();
    await expect(existingDialog(page).getByRole('button', { name: '打开其他资产库…', exact: true })).toBeEnabled();
    await expect(existingDialog(page).getByRole('alert')).toHaveCount(0);
    expect((await workspace(page, { type: 'status' })).selected).toEqual(selection);

    const invalid = path.join(root, '普通文件夹'); mkdirSync(invalid);
    await setPickers(application, { chooseLibrary: invalid });
    await existingDialog(page).getByRole('button', { name: '打开其他资产库…', exact: true }).click();
    await expect(existingDialog(page).getByRole('alert')).toBeVisible();
    expect((await workspace(page, { type: 'status' })).selected).toEqual(selection);
    await setPickers(application, { chooseLibrary: second.displayPath });
    await existingDialog(page).getByRole('button', { name: '打开其他资产库…', exact: true }).click();
    await expect(existingDialog(page)).toBeHidden();
    await expect(selectedName(page)).toHaveText(second.displayName);
    expect((await workspace(page, { type: 'status' })).selected?.libraryId).toBe(second.libraryId);
    expect(existsSync(selection.memoryRoot)).toBe(true);
    expect(existsSync(path.join(selection.libraryPath, '.worldlinebox', 'library.db'))).toBe(true);
    await testInfo.attach('companion-library-open-proof', { body: JSON.stringify({ nativePickerCancelPreservesSelection: true, invalidFolderPreservesSelection: true, previouslyClosedLibraryOpenedAndBound: true, previousLibraryRetained: true }), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); cleanup(root); }
});

async function launch(profile: string) {
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: path.dirname(profile) }) });
  await preparePackagedCompanionLaunch(application, profile);
  await setPickers(application, { createParent: path.dirname(profile), chooseLibrary: null });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(win => { win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  return { application, page };
}
async function enterCompanions(page: Page) {
  await page.locator('[data-application-module="companions"]').click();
  await expect(page.locator('[data-application-module="companions"]')).toHaveAttribute('aria-current', 'page');
}
async function createLibrary(page: Page, displayName: string) {
  const result = await page.evaluate(name => (window as unknown as BridgeWindow).worldlinebox.library.create({ displayName: name }), displayName);
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value;
}
async function workspace(page: Page, input: CompanionWorkspaceRequest) {
  const result = await page.evaluate(command => (window as unknown as BridgeWindow).worldlinebox.companions.workspace!(command), input);
  expect(result.ok, result.error).toBe(true); return result;
}
async function setPickers(application: ElectronApplication, paths: { createParent?: string | null; chooseLibrary?: string | null }) {
  await application.evaluate(({ dialog }, paths) => {
    if ('createParent' in paths) process.env.WORLDLINEBOX_E2E_CREATE_PARENT_PATH = paths.createParent ?? '';
    // The companion picker deliberately uses the actual native-dialog boundary.
    process.env.WORLDLINEBOX_E2E_COMPANION_LIBRARY_PATH = '';
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const title = (args.at(-1) as { title?: string }).title ?? '';
      const selected = /Create Library|创建资源库/iu.test(title) ? paths.createParent : paths.chooseLibrary;
      if (!/Create Library|创建资源库|伙伴.*资产库/iu.test(title)) throw new Error('Unexpected onboarding fixture dialog: ' + title);
      return selected ? { canceled: false, filePaths: [selected] } : { canceled: true, filePaths: [] };
    };
  }, paths);
}
function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-companion-onboarding-')) throw new Error('Unexpected onboarding fixture cleanup target.');
  removeCompanionTestDirectory(root);
}
function evidencePath(name: string) {
  const output = path.resolve('artifacts/vcp-validation/companion-library-onboarding');
  mkdirSync(output, { recursive: true }); return path.join(output, name);
}
function saveEvidence(name: string, content: string) { writeFileSync(evidencePath(name), content, 'utf8'); }
async function captureOnboarding(page: Page) {
  const original = await page.locator('html').getAttribute('data-theme');
  const screenshots: Array<{ theme: string; actualPaneColor: string; innerWidth: number; innerHeight: number; documentOverflow: boolean; dialogOverflow: boolean }> = [];
  let lightPaneColor = '';
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await expect(createDialog(page)).toBeVisible();
    const paneColor = () => createDialog(page).evaluate(dialog => getComputedStyle(dialog).backgroundColor);
    if (theme === 'light') lightPaneColor = await paneColor();
    else await expect.poll(paneColor, { message: 'The real dark theme must change the dialog surface before its screenshot.' }).not.toBe(lightPaneColor);
    await page.screenshot({ path: evidencePath(`create-library-${theme}.png`), animations: 'disabled' });
    screenshots.push(await createDialog(page).evaluate((dialog, theme) => ({ theme, actualPaneColor: getComputedStyle(dialog).backgroundColor, innerWidth, innerHeight,
      documentOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
    }), theme));
  }
  await setTheme(page, original === 'dark' ? 'dark' : 'light');
  expect(screenshots[0]!.actualPaneColor).not.toBe(screenshots[1]!.actualPaneColor);
  expect(screenshots.every(shot => !shot.documentOverflow && !shot.dialogOverflow)).toBe(true);
  saveEvidence('screenshot-proof.json', JSON.stringify(screenshots, null, 2));
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('button', { name: '设置', exact: true }).click(); const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
  await settings.getByRole('tab', { name: '外观', exact: true }).click(); await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click(); await page.keyboard.press('Escape'); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}
