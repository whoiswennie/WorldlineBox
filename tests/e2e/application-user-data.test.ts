import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

const cookieUrl = 'https://worldlinebox-profile-test.invalid/';
const storageKey = 'worldlinebox:e2e:profile-persistence';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function launcherState(page: Page): Promise<DshLauncherState> {
  const result = await page.evaluate(() => (window as unknown as { worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi } }).worldlinebox.dshLauncher.request({ type: 'state' }));
  if (!result.ok || !result.state) throw new Error(!result.ok ? result.error : 'Launcher state is missing.');
  return result.state;
}

async function actualPaths(application: ElectronApplication) {
  return application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), logs: app.getPath('logs') }));
}

async function launch(env: NodeJS.ProcessEnv): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], env: electronLaunchEnv(env) });
  try {
    const page = await application.firstWindow();
    await (await application.browserWindow(page)).evaluate(window => {
      window.hide();
      // Normal mode deliberately retains its production startup path. Keep its
      // later ready-to-show event from interrupting the user's desktop session.
      window.on('show', () => window.hide());
    });
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    return { application, page };
  } catch (error) { await application.close(); throw error; }
}

async function missing(file: string): Promise<boolean> {
  try { await stat(file); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

test('normal launches share the unified profile and migrate legacy cache once; E2E isolates both paths and browser storage', async () => {
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'The desktop DSH integration is Windows x64.');
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-user-data-e2e-'));
  const canonical = path.join(root, 'canonical', 'WorldlineBox');
  const legacy = path.join(root, 'legacy-user-data');
  const source = path.join(legacy, 'dsh-launcher');
  const target = path.join(canonical, 'dsh-launcher');
  await mkdir(path.join(source, 'operations'), { recursive: true });
  await mkdir(path.join(source, 'cache'));
  const installerBytes = Buffer.from('Verified cache fixture; never executed as an installer.');
  const installerSha256 = digest(installerBytes);
  const cacheRelative = `cache/${installerSha256}.exe`;
  const originalFiles = new Map<string, Buffer>();
  for (const registry of ['instances.json', 'runtimes.json', 'snapshots.json', 'packs.json']) originalFiles.set(registry, Buffer.from('[]\n'));
  originalFiles.set('operations/operations.json', Buffer.from(JSON.stringify([{ id: 'historical-download', kind: 'runtime.download', label: '历史下载', status: 'failed', phase: 'failed', error: 'Invalid URL', startedAt: '2026-10-12T08:20:34Z', finishedAt: '2026-10-12T08:20:35Z' }])));
  originalFiles.set('operations/historical-download.log', Buffer.from('Historical download diagnostics.\n'));
  originalFiles.set(cacheRelative, installerBytes);
  for (const [relative, bytes] of originalFiles) await writeFile(path.join(source, relative), bytes);
  const normalEnvironment = {
    WORLDLINEBOX_E2E: '0', WORLDLINEBOX_ALLOW_MULTI_INSTANCE: '0', WORLDLINEBOX_DISTRIBUTION: 'development',
    WORLDLINEBOX_USER_DATA_PATH: canonical, WORLDLINEBOX_DEV_USER_DATA_PATH: legacy,
  };
  const identity = `profile-${path.basename(root)}`;
  const first = await launch(normalEnvironment);
  let firstPaths: Awaited<ReturnType<typeof actualPaths>>;
  try {
    firstPaths = await actualPaths(first.application);
    expect(firstPaths).toEqual({ userData: canonical, sessionData: canonical, logs: path.join(canonical, 'logs') });
    await expect.poll(async () => (await launcherState(first.page)).operations.length).toBe(1);
    const current = await launcherState(first.page);
    expect(current.rootPath).toBe(target);
    expect(current.runtimes).toEqual([]); expect(current.instances).toEqual([]);
    expect(current.operations[0]).toMatchObject({ id: 'historical-download', status: 'failed', error: 'Invalid URL' });
    await expect(first.page.locator('.launcher-banner[role="alert"]')).toHaveCount(0);
    expect(digest(await readFile(path.join(target, cacheRelative)))).toBe(installerSha256);
    expect(await readFile(path.join(target, 'operations', 'historical-download.log'))).toEqual(originalFiles.get('operations/historical-download.log'));
    await first.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: identity });
    await first.application.evaluate(async ({ session }, value) => {
      await session.defaultSession.cookies.set({ url: value.url, name: 'worldlinebox_profile_fixture', value: value.identity, secure: true, httpOnly: true, expirationDate: Date.now() / 1000 + 3600 });
      await session.defaultSession.cookies.flushStore();
    }, { url: cookieUrl, identity });
  } finally { await first.application.close(); }
  for (const [relative, bytes] of originalFiles) expect(await readFile(path.join(source, relative))).toEqual(bytes);
  // Added only after migration: an existing target must never be merged or replaced.
  await writeFile(path.join(source, 'cache', 'added-after-migration.keep'), 'old profile remains independent');
  await writeFile(path.join(target, 'canonical-only.keep'), 'canonical profile remains independent');
  const second = await launch(normalEnvironment);
  let secondPaths: Awaited<ReturnType<typeof actualPaths>>;
  try {
    secondPaths = await actualPaths(second.application);
    expect(secondPaths).toEqual(firstPaths!);
    const current = await launcherState(second.page);
    expect(current.rootPath).toBe(target);
    expect(current.operations).toHaveLength(1);
    await expect(second.page.locator('.launcher-banner[role="alert"]')).toHaveCount(0);
    expect(await missing(path.join(target, 'cache', 'added-after-migration.keep'))).toBe(true);
    expect(await readFile(path.join(target, 'canonical-only.keep'), 'utf8')).toBe('canonical profile remains independent');
    expect(digest(await readFile(path.join(target, cacheRelative)))).toBe(installerSha256);
    expect(await second.page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(identity);
    const cookies = await second.application.evaluate(({ session }, url) => session.defaultSession.cookies.get({ url }), cookieUrl);
    expect(cookies.find(cookie => cookie.name === 'worldlinebox_profile_fixture')?.value).toBe(identity);
  } finally { await second.application.close(); }
  const isolated = path.join(root, 'e2e-user-data');
  const third = await launch({ ...normalEnvironment, WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: isolated, WORLDLINEBOX_ALLOW_MULTI_INSTANCE: '1' });
  let e2ePaths: Awaited<ReturnType<typeof actualPaths>>;
  try {
    e2ePaths = await actualPaths(third.application);
    expect(e2ePaths).toEqual({ userData: isolated, sessionData: isolated, logs: path.join(isolated, 'logs') });
    const current = await launcherState(third.page);
    expect(current.rootPath).toBe(path.join(isolated, 'dsh-launcher'));
    expect(current.operations).toEqual([]); expect(current.runtimes).toEqual([]); expect(current.instances).toEqual([]);
    expect(await missing(path.join(current.rootPath, cacheRelative))).toBe(true);
    expect(await missing(path.join(current.rootPath, 'operations', 'historical-download.log'))).toBe(true);
    expect(await third.page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
    const cookies = await third.application.evaluate(({ session }, url) => session.defaultSession.cookies.get({ url }), cookieUrl);
    expect(cookies.find(cookie => cookie.name === 'worldlinebox_profile_fixture')).toBeUndefined();
    await expect(third.page.locator('.launcher-banner[role="alert"]')).toHaveCount(0);
  } finally { await third.application.close(); }
  for (const [relative, bytes] of originalFiles) expect(await readFile(path.join(source, relative))).toEqual(bytes);
  expect(await readFile(path.join(source, 'cache', 'added-after-migration.keep'), 'utf8')).toBe('old profile remains independent');
  expect(await readFile(path.join(target, 'canonical-only.keep'), 'utf8')).toBe('canonical profile remains independent');
  expect(digest(await readFile(path.join(target, cacheRelative)))).toBe(installerSha256);
  expect(await readdir(path.join(canonical, 'logs'))).not.toEqual([]);
  await test.info().attach('application-user-data-evidence', { body: JSON.stringify({ root, installerSha256, firstPaths: firstPaths!, secondPaths: secondPaths!, e2ePaths: e2ePaths! }, null, 2), contentType: 'application/json' });
  // Keep this explicitly created test profile as evidence. Never inspect or remove real APPDATA.
});
