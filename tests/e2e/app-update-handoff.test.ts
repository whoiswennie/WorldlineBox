import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { _electron as electron, expect, test } from '@playwright/test';

import type { WorldlineBoxAppUpdateApi } from '../../src/shared/app-update';
import {
  electronLaunchEnv,
  resolveElectronAppPath,
  resolveElectronExecutablePath,
} from './electron-test-helpers';

type SpawnRecord = {
  executable: string;
  args: string[];
  installerPath?: string;
  windowsHide: boolean;
  detached: boolean;
  spawned: boolean;
  stdio: unknown;
  pid?: number;
};

function nextPatchVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) throw new TypeError(`Invalid package version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function spawnRecords(filePath: string): SpawnRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8').split(/\r?\n/u).filter(Boolean)
    .map((line) => JSON.parse(line) as SpawnRecord);
}

function installerDirectories(tempPath: string): string[] {
  if (!existsSync(tempPath)) return [];
  return readdirSync(tempPath).filter((name) => /^worldlinebox-installer-[A-Za-z0-9]+$/u.test(name))
    .map((name) => path.join(tempPath, name));
}

function assertOwnedFixtureRoot(root: string): void {
  const resolvedRoot = path.resolve(root);
  if (path.dirname(resolvedRoot).toLowerCase() !== path.resolve(tmpdir()).toLowerCase()
    || !/^worldlinebox-update-handoff-e2e-[A-Za-z0-9]+$/u.test(path.basename(resolvedRoot))
    || lstatSync(resolvedRoot).isSymbolicLink()
    || path.dirname(realpathSync(resolvedRoot)).toLowerCase() !== realpathSync(tmpdir()).toLowerCase()) {
    throw new Error(`Refusing to remove an unowned update fixture directory: ${root}`);
  }
}

function diagnosticEvents(profilePath: string): Array<Record<string, unknown>> {
  const logsPath = path.join(profilePath, 'logs');
  if (!existsSync(logsPath)) return [];
  return readdirSync(logsPath).filter((name) => /^worldlinebox-.*\.log$/u.test(name))
    .flatMap((name) => readFileSync(path.join(logsPath, name), 'utf8').split(/\r?\n/u).filter(Boolean))
    .flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
}

// The release transport is a development-only local fixture. Archive hashing,
// extraction, native hidden cleanup and the real application's quit path run
// normally. WorldlineBoxSetup.exe contains inert text and is never executed.
// eslint-disable-next-line no-empty-pattern
test('Windows installed update hands off without a terminal and completes hidden cleanup', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'The installed update handoff is Windows-specific.');
  test.skip(Boolean(process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE),
    'Updater fixtures are intentionally disabled in packaged applications.');
  test.setTimeout(120_000);

  const appPath = path.resolve(resolveElectronAppPath());
  const packageVersion = (JSON.parse(readFileSync(path.join(appPath, 'package.json'), 'utf8')) as { version: string }).version;
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-update-handoff-e2e-'));
  const profilePath = path.join(temporaryRoot, 'profile');
  const downloadsPath = path.join(temporaryRoot, 'downloads');
  const tempPath = path.join(temporaryRoot, 'temp');
  const archivePath = path.join(temporaryRoot, 'setup.zip');
  const releasePath = path.join(temporaryRoot, 'release.json');
  const spawnLogPath = path.join(temporaryRoot, 'spawn-log.jsonl');
  const latestVersion = nextPatchVersion(packageVersion);
  const assetName = `WorldlineBox-win-x86-64-${latestVersion}-setup.zip`;
  const assetUrl = `https://github.com/whoiswennie/WorldlineBox/releases/download/v${latestVersion}/${assetName}`;
  const installerArchive = new AdmZip();
  installerArchive.addFile('WorldlineBoxSetup.exe', Buffer.from('inert WorldlineBox E2E installer fixture'));
  const archiveBytes = installerArchive.toBuffer();
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
  mkdirSync(profilePath);
  mkdirSync(downloadsPath);
  mkdirSync(tempPath);
  writeFileSync(archivePath, archiveBytes);
  writeFileSync(releasePath, JSON.stringify({
    tag_name: `v${latestVersion}`,
    html_url: `https://github.com/whoiswennie/WorldlineBox/releases/tag/v${latestVersion}`,
    draft: false,
    prerelease: false,
    assets: [{ name: assetName, browser_download_url: assetUrl, size: archiveBytes.byteLength, digest: `sha256:${sha256}` }],
  }));

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let applicationProcess: ChildProcess | undefined;
  let installStarted = false;
  const waitForCleanup = async (): Promise<void> => {
    const records = spawnRecords(spawnLogPath);
    const paths = records.flatMap((record) => record.installerPath ? [record.installerPath] : []);
    for (const installerPath of paths) {
      const directory = path.win32.dirname(path.win32.resolve(installerPath));
      expect(path.win32.dirname(directory).toLowerCase()).toBe(path.win32.resolve(tempPath).toLowerCase());
      expect(path.win32.basename(directory)).toMatch(/^worldlinebox-installer-[A-Za-z0-9]+$/u);
      expect(path.win32.basename(installerPath).toLowerCase()).toBe('worldlineboxsetup.exe');
    }
    // Never make a passing cleanup assertion by removing the fixture ourselves.
    // This also runs after a failed test, once its own application has exited.
    await expect.poll(() => ({
      installers: paths.filter(existsSync),
      directories: installerDirectories(tempPath),
    }), { timeout: 35_000, message: `The native cleanup helper must finish before fixture removal: ${temporaryRoot}` })
      .toEqual({ installers: [], directories: [] });
  };
  try {
    application = await electron.launch({
      executablePath: resolveElectronExecutablePath(), args: [appPath], cwd: appPath,
      env: electronLaunchEnv({
        WORLDLINEBOX_E2E: '1',
        WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
        WORLDLINEBOX_E2E_APP_UPDATE_FIXTURE: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath,
        WORLDLINEBOX_E2E_DOWNLOADS_PATH: downloadsPath,
        WORLDLINEBOX_E2E_TEMP_PATH: tempPath,
        WORLDLINEBOX_E2E_UPDATE_RELEASE: releasePath,
        WORLDLINEBOX_E2E_UPDATE_ARCHIVE: archivePath,
        WORLDLINEBOX_E2E_UPDATE_ASSET_URL: assetUrl,
        WORLDLINEBOX_E2E_APP_UPDATE_SPAWN_LOG: spawnLogPath,
        WORLDLINEBOX_DISTRIBUTION: 'installed',
      }, { gpu: 'software' }),
    });
    const childProcess = application.process();
    applicationProcess = childProcess;
    test.skip(await application.evaluate(({ app }) => app.isPackaged),
      'A packaged executable must never enable the inert update fixture.');
    const window = await application.firstWindow();
    await window.waitForLoadState('load');
    const check = await window.evaluate(async () => {
      const appUpdate = (globalThis as unknown as { worldlinebox?: { appUpdate?: WorldlineBoxAppUpdateApi } }).worldlinebox?.appUpdate;
      return appUpdate?.checkForUpdates();
    });
    expect(check).toMatchObject({ ok: true, status: 'available', latestVersion, distribution: 'installed', assetName });
    installStarted = await window.evaluate(() => {
      const appUpdate = (globalThis as unknown as { worldlinebox?: { appUpdate?: WorldlineBoxAppUpdateApi } }).worldlinebox?.appUpdate;
      if (!appUpdate) return false;
      void appUpdate.downloadAndInstall();
      return true;
    });
    expect(installStarted).toBe(true);
    try {
      await expect.poll(() => childProcess.exitCode, { timeout: 30_000 }).toBe(0);
    } catch (error) {
      const updateEvents = diagnosticEvents(profilePath).filter((entry) => String(entry.scope ?? '').startsWith('app-update'));
      const installerEntries = installerDirectories(tempPath).flatMap((directory) => {
        try { return readdirSync(directory); } catch { return []; }
      });
      throw new Error(`${error instanceof Error ? error.message : String(error)}; `
        + `updateEvents=${JSON.stringify(updateEvents)}; installerEntries=${JSON.stringify(installerEntries)}`, { cause: error });
    }

    const records = spawnRecords(spawnLogPath);
    const cleanupSpawn = records.find((record) => path.win32.basename(record.executable).toLowerCase() === 'powershell.exe');
    expect(cleanupSpawn).toMatchObject({ windowsHide: true, detached: false, spawned: true, stdio: 'ignore' });
    expect(cleanupSpawn?.pid).toBeGreaterThan(0);
    expect(cleanupSpawn?.args).toContain('-WindowStyle');
    expect(cleanupSpawn?.args).toContain('Hidden');
    expect(cleanupSpawn?.args).toContain('-NonInteractive');
    expect(cleanupSpawn?.args).toContain('-EncodedCommand');
    const bootstrap = Buffer.from(cleanupSpawn!.args.at(-1)!, 'base64').toString('utf16le');
    expect(bootstrap).toContain('Start-Process -FilePath $env:WORLDLINEBOX_UPDATE_CLEANUP_POWERSHELL');
    expect(bootstrap).toContain('-WindowStyle Hidden -PassThru');
    expect(cleanupSpawn?.installerPath).toBeTruthy();
    expect(records.some((record) => ['cmd.exe', 'ping.exe', 'worldlineboxsetup.exe']
      .includes(path.win32.basename(record.executable).toLowerCase()))).toBe(false);

    await waitForCleanup();
    expect(existsSync(downloadsPath) ? readdirSync(downloadsPath) : []).toEqual([]);
    const events = diagnosticEvents(profilePath);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((entry) => entry.scope === 'main.startup')).toBe(false);
    expect(events.some((entry) => entry.scope === 'app-update.install' && entry.message === 'Update installer opened.')).toBe(true);
    expect(events.some((entry) => entry.scope === 'app-update.cleanup' && entry.level === 'error')).toBe(false);
    await testInfo.attach('WorldlineBox verified update and native cleanup', {
      body: JSON.stringify({ archiveSha256: sha256, archiveBytes: archiveBytes.byteLength, latestVersion,
        localReleaseTransport: true, inertInstallerExecuted: false, nativeCleanupSpawn: cleanupSpawn,
        actualApplicationExitCode: childProcess.exitCode, installerFileAndDirectoryRemovedByHelper: true }),
      contentType: 'application/json',
    });
  } finally {
    if (applicationProcess?.exitCode === null && applicationProcess.signalCode === null) {
      const exited = new Promise<void>((resolve) => { applicationProcess?.once('exit', () => resolve()); });
      applicationProcess.kill();
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }
    await application?.close().catch(() => undefined);
    if (applicationProcess) {
      await expect.poll(() => applicationProcess?.exitCode !== null || applicationProcess?.signalCode !== null,
        { timeout: 5_000, message: 'The fixture application must exit before its profile is removed.' }).toBe(true);
    }
    // A detached helper can outlive Electron. Leave the owned fixture in place
    // on a cleanup timeout instead of racing it with a recursive test removal.
    if (installStarted || existsSync(spawnLogPath)) await waitForCleanup();
    assertOwnedFixtureRoot(temporaryRoot);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
