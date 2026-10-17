import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page, type ElectronApplication } from "@playwright/test";

import {
  closeLibraryViaSwitcher,
  importFilesThroughBridge,
  resolveElectronExecutablePath,
} from "./electron-test-helpers";

function sidebarFolderRow(window: Page, folderName: string) {
  return window
    .locator(".navigation-pane .nav-row-label", { hasText: folderName })
    .locator("xpath=ancestor::button[contains(@class, 'nav-row')]");
}

async function activateAssets(application: ElectronApplication, window: Page) {
  const nativeWindow = await application.browserWindow(window);
  await nativeWindow.evaluate(win => { win.setOpacity(0); win.setFocusable(false); win.webContents.setBackgroundThrottling(false); win.showInactive(); });
  await window.locator('[data-application-module="assets"]').click();
}

test("creates, closes, and reopens a library through the sandboxed UI", async () => {
  const testInfo = test.info();
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-electron-test-"),
  );
  const libraryName = "视觉参考";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
    },
  });

  try {
    const window = await application.firstWindow();
    if (process.env.WORLDLINEBOX_E2E_HIDE_WINDOW === "1") {
      const anyWindowVisible = await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((candidate) => candidate.isVisible()),
      );
      expect(anyWindowVisible).toBe(false);
    }
    await activateAssets(application, window);
    await expect(
      window.getByRole("heading", { name: "创建本地资源库" }),
    ).toBeVisible();

    const rendererCapabilities = await window.evaluate(() => ({
      hasNodeProcess: typeof globalThis.process !== "undefined",
      hasRequire: typeof globalThis.require !== "undefined",
    }));
    expect(rendererCapabilities).toEqual({
      hasNodeProcess: false,
      hasRequire: false,
    });

    const lifecycleEvents = window.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const bridge = globalThis as typeof globalThis & {
            worldlinebox: {
              library: {
                onLifecycle(
                  listener: (event: { type: string }) => void,
                ): () => void;
              };
            };
          };
          const eventTypes: string[] = [];
          const unsubscribe = bridge.worldlinebox.library.onLifecycle((event) => {
            eventTypes.push(event.type);
            if (event.type === "library.closed") {
              unsubscribe();
              resolve(eventTypes);
            }
          });
        }),
    );

    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible();
    const mediaJobSnapshots = await window.evaluate(async () => {
      type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string } };
      type MediaStatus = {
        queued: number;
        running: number;
        succeeded: number;
        failed: number;
        paused: number;
        cancelled: number;
        jobs: unknown[];
      };
      const bridge = globalThis as typeof globalThis & {
        worldlinebox: {
          library: {
            listOpen(): Promise<Result<Array<{ libraryId: string }>>>;
            listMediaJobs(input: {
              libraryId: string;
              summaryOnly?: boolean;
            }): Promise<Result<MediaStatus>>;
          };
        };
      };
      const opened = await bridge.worldlinebox.library.listOpen();
      const libraryId = opened.ok ? opened.value[0]?.libraryId : undefined;
      if (!libraryId) throw new Error("Expected the newly created library to be open.");
      const [summary, detailed] = await Promise.all([
        bridge.worldlinebox.library.listMediaJobs({ libraryId, summaryOnly: true }),
        bridge.worldlinebox.library.listMediaJobs({ libraryId }),
      ]);
      if (!summary.ok || !detailed.ok) {
        throw new Error("Could not read media job status through the preload bridge.");
      }
      return {
        summary: { ...summary.value, jobs: summary.value.jobs.length },
        detailed: { ...detailed.value, jobs: detailed.value.jobs.length },
      };
    });
    expect(mediaJobSnapshots.summary).toMatchObject({
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      paused: 0,
      cancelled: 0,
      jobs: 0,
    });
    expect(mediaJobSnapshots.detailed).toEqual(mediaJobSnapshots.summary);

    await closeLibraryViaSwitcher(window, libraryName);
    await expect(
      window.getByRole("heading", { name: "创建本地资源库" }),
    ).toBeVisible();
    expect(await lifecycleEvents).toEqual([
      "library.opening",
      "library.opened",
      "library.closed",
    ]);
    await window.getByRole("button", { name: "打开资源库" }).click();
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible();
    if (process.env.WORLDLINEBOX_E2E_HIDE_WINDOW !== "1") {
      const screenshotPath = testInfo.outputPath("library-ready.png");
      await window.screenshot({ path: screenshotPath });
      await testInfo.attach("library-ready", {
        path: screenshotPath,
        contentType: "image/png",
      });
    }
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("restores the recent library and saved selection when opening assets after a full restart", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-restart-test-"),
  );
  const libraryName = "重启恢复";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const profilePath = path.join(temporaryRoot, "profile");
  const sourceRoot = path.join(temporaryRoot, "sources");
  mkdirSync(profilePath);
  mkdirSync(sourceRoot);
  const sourcePaths = ["first.txt", "remember-me.txt", "root-import.txt"].map((name) => {
    const sourcePath = path.join(sourceRoot, name);
    writeFileSync(sourcePath, name);
    return sourcePath;
  });
  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const launch = (importFilePath = sourcePaths.slice(0, 2).join(path.delimiter)) =>
    electron.launch({
      args: [applicationDirectory],
      cwd: applicationDirectory,
      executablePath,
      env: {
        ...process.env,
        WORLDLINEBOX_E2E: "1",
        WORLDLINEBOX_E2E_RESTORE_RECENT: "1",
        WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath,
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
        WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
        WORLDLINEBOX_E2E_IMPORT_FILES: importFilePath,
      },
    });

  let application = await launch();
  try {
    let window = await application.firstWindow();
    await activateAssets(application, window);
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible();
    await window.getByRole("button", { name: "添加文件夹" }).click();
    await window.getByLabel("新文件夹名称").fill("恢复文件夹");
    await window.keyboard.press("Enter");
    await sidebarFolderRow(window, "恢复文件夹").click();
    await window
      .getByRole("button", { name: "导入文件", exact: true })
      .first()
      .click();
    // 等导入 reveal 的 pending 过期（280ms）——否则点击会被 reveal 重应用
    // 覆盖（选中回到全选，session 存的是第一个资产而非点击目标）。
    await window.waitForTimeout(500);
    const rememberedCard = window.locator(".asset-card", {
      hasText: "remember-me.txt",
    });
    await window.keyboard.press('Escape');
    await rememberedCard.click();
    await expect(rememberedCard).toHaveAttribute("aria-pressed", "true");
    // 等待会话保存完成（useEffect 异步写 session，close 前必须落盘）
    await window.waitForTimeout(800);
    await expect.poll(() => window.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('worldlinebox.browser-session.')).some(([, value]) => JSON.parse(value).selectedAssetName === 'remember-me.txt'))).toBe(true);
    await application.close();

    application = await launch(sourcePaths[2]!);
    window = await application.firstWindow();
    await expect(window.locator('[data-application-module="dsh"]')).toBeVisible();
    await activateAssets(application, window);
    await expect(
      window.getByText(libraryName, { exact: true }).first(),
    ).toBeVisible();
    const restoredCard = window.locator(".asset-card", {
      hasText: "remember-me.txt",
    });
    await expect(restoredCard).toHaveAttribute("aria-pressed", "true");
    const restoredAssetId = await restoredCard.getAttribute("data-asset-id");
    const focusedTarget = await window.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return element?.closest('.application-navigation') ? 'module-navigation' : element?.dataset.assetId;
    });
    // Explicit sidebar navigation keeps keyboard focus; restoring a selection
    // must not steal focus from the control the user just activated.
    expect([restoredAssetId, 'module-navigation']).toContain(focusedTarget);

    // WorldlineBox-2b30bb: the visual browser session may restore the nested folder,
    // but a fresh import must still target the library root. Use a new source
    // file after restart and verify its durable managedFolderId is null.
    await importFilesThroughBridge(window);
    await expect
      .poll(async () =>
        window.evaluate(async () => {
          const bridge = globalThis as typeof globalThis & {
            worldlinebox: {
              library: {
                listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
                listAssets(input: {
                  libraryId: string;
                  recursive: boolean;
                }): Promise<{ ok: boolean; value?: Array<{
                  displayName: string;
                  managedFolderId: string | null;
                }> }>;
              };
            };
          };
          const opened = await bridge.worldlinebox.library.listOpen();
          const libraryId = opened.value?.[0]?.libraryId;
          if (!opened.ok || !libraryId) return false;
          const listed = await bridge.worldlinebox.library.listAssets({
            libraryId,
            recursive: true,
          });
          return listed.ok && listed.value?.some(
            (asset) => asset.displayName === "root-import.txt" && asset.managedFolderId === null,
          ) === true;
        }),
      )
      .toBe(true);
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("falls back to the start screen when the recent library no longer exists", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-missing-recent-test-"),
  );
  const profilePath = path.join(temporaryRoot, "profile");
  mkdirSync(profilePath);
  writeFileSync(
    path.join(profilePath, "recent-library.json"),
    JSON.stringify({
      version: 1,
      libraryPath: path.join(temporaryRoot, "deleted-library"),
      updatedAt: new Date().toISOString(),
    }),
  );

  const executablePath = resolveElectronExecutablePath();
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath,
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_RESTORE_RECENT: "1",
      WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath,
    },
  });

  try {
    const window = await application.firstWindow();
    await activateAssets(application, window);
    await expect(
      window.getByRole("heading", { name: "创建本地资源库" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() =>
        window.evaluate(() => document.readyState),
      )
      .toBe("complete");
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
