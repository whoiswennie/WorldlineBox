import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveElectronExecutablePath } from "./electron-test-helpers";

// ---------------------------------------------------------------------------
// WorldlineBox-565785: a restored scroll offset must be in place in the FIRST frame
// the new content paints. Sampling the canvas every animation frame across a
// Back restore and a tab switch must never see a frame that already has
// content (scroll extent > 0) but sits at scrollTop 0 — that top frame is the
// flicker the UX principles (0005) tell us to remove.
// ---------------------------------------------------------------------------

test.describe.configure({ timeout: 120_000 });

function launchApp(temporaryRoot: string, libraryPath: string, importFiles: string) {
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  return electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      WORLDLINEBOX_E2E_IMPORT_FILES: importFiles,
    },
  });
}

async function createFolderViaApi(window: Page, name: string) {
  await window.evaluate(async (folderName) => {
    type LibraryApi = {
      listOpen(): Promise<{ ok: boolean; value?: Array<{ libraryId: string }> }>;
      createFolder(input: { libraryId: string; name: string }): Promise<{ ok: boolean }>;
    };
    const library = (globalThis as typeof globalThis & { worldlinebox: { library: LibraryApi } }).worldlinebox.library;
    const opened = await library.listOpen();
    const libraryId = opened.value?.[0]?.libraryId;
    if (!opened.ok || !libraryId) throw new Error("no library");
    await library.createFolder({ libraryId, name: folderName });
  }, name);
  const refresh = window.getByRole("button", { name: "刷新磁盘变化" });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 15_000 });
}

function folderRow(window: Page, name: string) {
  const escaped = name.replace(/"/g, '\\"');
  return window.locator(
    `.navigation-pane button.nav-row[data-nav-folder-kind="managed"][title="${escaped}"]`,
  );
}

async function waitForNavigation(window: Page) {
  await expect(window.locator(".workspace-canvas-host")).toHaveAttribute("aria-busy", "false");
}

/** Records scrollTop/extent on every animation frame for `ms` milliseconds. */
async function startFrameProbe(window: Page, ms: number) {
  await window.evaluate((duration) => {
    const g = globalThis as unknown as { __samples: Array<[number, number]> };
    g.__samples = [];
    const el = document.querySelector(".workspace-canvas") as HTMLElement | null;
    if (!el) return;
    const started = performance.now();
    const tick = () => {
      const extent = Math.max(0, el.scrollHeight - el.clientHeight);
      g.__samples.push([Math.round(el.scrollTop), Math.round(extent)]);
      if (performance.now() - started < duration) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, ms);
}

async function readFrameProbe(window: Page) {
  return window.evaluate(() => {
    const g = globalThis as unknown as { __samples: Array<[number, number]> };
    const withContent = g.__samples.filter(([, extent]) => extent > 0);
    return {
      contentFrames: withContent.length,
      topFrames: withContent.filter(([top]) => top === 0).length,
      first: withContent.slice(0, 3),
    };
  });
}

test("a restored scroll offset is painted in the first content frame", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-scroll-restore-"));
  const libraryName = "滚动恢复验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const sources: string[] = [];
  for (let i = 0; i < 160; i += 1) {
    const p = path.join(temporaryRoot, `asset-${String(i).padStart(3, "0")}.txt`);
    writeFileSync(p, `asset ${i}`, "utf8");
    sources.push(p);
  }

  const application = await launchApp(temporaryRoot, libraryPath, sources.join(path.delimiter));
  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await waitForNavigation(window);
    await window.getByRole("button", { name: "导入文件", exact: true }).first().click();
    await waitForNavigation(window);
    await createFolderViaApi(window, "空文件夹");

    const canvas = window.locator(".workspace-canvas");
    await expect(window.locator(".asset-card").first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(
      () => canvas.evaluate((el) => el.scrollHeight - el.clientHeight),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    await canvas.evaluate((el) => {
      const extent = el.scrollHeight - el.clientHeight;
      el.scrollTop = extent * 0.6;
    });
    const backTarget = await canvas.evaluate((el) => el.scrollTop);
    expect(backTarget).toBeGreaterThan(0);

    // --- Back restore ---
    await folderRow(window, "空文件夹").click();
    await waitForNavigation(window);
    await startFrameProbe(window, 1_500);
    await window.getByRole("button", { name: "后退" }).click();
    await waitForNavigation(window);
    await window.waitForTimeout(1_200);
    const back = await readFrameProbe(window);
    expect(back.contentFrames).toBeGreaterThan(0);
    expect(back.topFrames).toBe(0);
    expect(back.first[0]?.[0]).toBeGreaterThan(0);

    // --- Tab switch restore ---
    const tabs = window.getByRole("tablist", { name: "工作区标签页" }).getByRole("tab");
    await window.getByRole("button", { name: "新建标签页" }).click();
    await expect(tabs).toHaveCount(2);
    await waitForNavigation(window);
    await expect.poll(
      () => canvas.evaluate((el) => el.scrollHeight - el.clientHeight),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
    await canvas.evaluate((el) => {
      const extent = el.scrollHeight - el.clientHeight;
      el.scrollTop = extent * 0.3;
    });
    await startFrameProbe(window, 1_500);
    await tabs.first().click();
    await waitForNavigation(window);
    await window.waitForTimeout(1_200);
    const tab = await readFrameProbe(window);
    expect(tab.contentFrames).toBeGreaterThan(0);
    expect(tab.topFrames).toBe(0);
    expect(tab.first[0]?.[0]).toBeGreaterThan(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
