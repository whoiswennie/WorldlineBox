import {
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from '@playwright/test';

import {
  electronLaunchEnv,
  importFilesThroughBridge,
  resolveElectronExecutablePath,
} from './electron-test-helpers';
import { removePathWithSyncRetry } from '../../src/worker/windows-fs-retry';

test.describe.configure({ timeout: 180_000 });

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const VALID_PNG_ALT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function killApplication(application: ElectronApplication): Promise<void> {
  const child = application.process();
  if (child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      // Electron's UtilityProcess workers outlive a direct child kill on
      // Windows; terminate the whole app tree so the restart fixture releases
      // its SQLite and media handles before recovery is tested.
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
      });
    } catch {
      // The process may have exited between the exitCode check and taskkill.
    }
    await once(child, 'exit');
    return;
  }
  const descendants = (pid: number): number[] => {
    try {
      const output = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
      return output
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number)
        .flatMap((childPid) => [childPid, ...descendants(childPid)]);
    } catch {
      return [];
    }
  };
  const descendantPids = descendants(child.pid ?? 0).reverse();
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  for (const descendant of descendantPids) {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {
      // The child may have exited with its parent already.
    }
  }
  await exited;
}

function readLatestImportOperation(libraryPath: string): string {
  const databasePath = path.join(libraryPath, '.worldlinebox', 'library.db');
  const executablePath = resolveElectronExecutablePath();
  const script = [
    "const Database = require('better-sqlite3');",
    "const db = new Database(process.env.WORLDLINEBOX_E2E_DB_PATH, { readonly: true });",
    "const row = db.prepare(\"SELECT status || '|' || COALESCE(error_code, '') AS value FROM file_operations WHERE kind = 'import' ORDER BY updated_at DESC LIMIT 1\").get();",
    "process.stdout.write(row?.value ?? '');",
    'db.close();',
  ].join('\n');
  return execFileSync(executablePath, ['-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WORLDLINEBOX_E2E_DB_PATH: databasePath,
    },
    encoding: 'utf8',
  }).trim();
}

test('recovers an interrupted import after a complete Electron process restart', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-file-operation-restart-e2e-'));
  const profilePath = path.join(temporaryRoot, 'user-data');
  const libraryName = '文件操作进程恢复';
  const libraryPath = path.join(temporaryRoot, libraryName);
  const stableSource = path.join(temporaryRoot, 'stable.png');
  const interruptedSource = path.join(temporaryRoot, 'interrupted.png');
  const interruptedDestination = path.join(libraryPath, 'Assets', 'interrupted.png');
  writeFileSync(stableSource, VALID_PNG);
  writeFileSync(interruptedSource, VALID_PNG_ALT);

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = (extra: NodeJS.ProcessEnv = {}) => electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_RESTORE_RECENT: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath,
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      ...extra,
    }),
  });

  let application: ElectronApplication | undefined;
  try {
    application = await launch({ WORLDLINEBOX_E2E_IMPORT_FILES: stableSource });
    const firstWindow = await application.firstWindow();
    await firstWindow.getByRole('button', { name: '创建资源库' }).click();
    await firstWindow.getByRole('textbox', { name: '名称' }).fill(libraryName);
    await firstWindow.getByRole('button', { name: '创建', exact: true }).click();
    await importFilesThroughBridge(firstWindow);
    await expect(firstWindow.getByText('stable.png', { exact: true })).toBeVisible();
    await application.close();
    application = undefined;

    application = await launch({
      WORLDLINEBOX_E2E_IMPORT_FILES: interruptedSource,
      WORLDLINEBOX_E2E_LIBRARY_TERMINATE_AT: 'crash-after-place',
    });
    const interruptedWindow = await application.firstWindow();
    await expect(
      interruptedWindow.getByRole('button', { name: `当前资源库 ${libraryName}` }),
    ).toBeVisible({ timeout: 30_000 });

    // Do not await the bridge call: the E2E-only Worker termination is meant
    // to leave the request without a response while its manifest/filesystem
    // state is durable. Kill the complete app as soon as placement is seen.
    const importPromise = interruptedWindow.evaluate(async () => {
      const bridge = (globalThis as typeof globalThis & {
        worldlinebox: { library: { importFiles: (input: { libraryId: string }) => Promise<unknown>; listOpen: () => Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }> } };
      }).worldlinebox;
      const opened = await bridge.library.listOpen();
      const libraryId = opened.value?.[0]?.libraryId;
      if (!opened.ok || !libraryId) throw new Error('Expected an open library.');
      return bridge.library.importFiles({ libraryId });
    });
    void importPromise.catch(() => undefined);
    await expect.poll(
      () => existsSync(interruptedDestination),
      { timeout: 30_000, intervals: [50, 100, 250] },
    ).toBe(true);
    await killApplication(application);
    application = undefined;

    // Job leases intentionally outlive a crashed process for a bounded safety
    // window. Waiting past that window proves recovery is not merely relying
    // on a clean Worker shutdown path.
    await new Promise((resolve) => setTimeout(resolve, 16_000));

    application = await launch();
    const restartedWindow = await application.firstWindow();
    await expect(
      restartedWindow.getByRole('button', { name: `当前资源库 ${libraryName}` }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(restartedWindow.getByText('stable.png', { exact: true })).toBeVisible();
    await expect(restartedWindow.getByText('interrupted.png', { exact: true })).toHaveCount(0);

    // The recovery pass removes the placed file and marks the durable journal
    // explicitly; this checks DB state in addition to the visible card/disk.
    expect(existsSync(interruptedDestination)).toBe(false);
    const operationsPath = path.join(libraryPath, '.worldlinebox', 'operations');
    expect(existsSync(operationsPath) ? readdirSync(operationsPath).length : 0).toBe(0);
    await application.close();
    application = undefined;
    expect(readLatestImportOperation(libraryPath)).toBe('rolled_back|PROCESS_INTERRUPTED');
  } finally {
    if (application && application.process().exitCode === null) await application.close();
    removePathWithSyncRetry(temporaryRoot, { retryLimit: 20, retryDelayMs: 200 });
  }
});
