import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";

import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveElectronExecutablePath } from "./electron-test-helpers";

// ---------------------------------------------------------------------------
// WorldlineBox-b8a853 unified Back/Forward timeline: switching tabs is a step, and
// Back/Forward cross tab switches (activate the entry's tab, restore its
// location).
// ---------------------------------------------------------------------------

test.describe.configure({ timeout: 120_000 });

function launchApp(
  temporaryRoot: string,
  libraryPath: string,
  importFiles: string,
) {
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
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
      createFolder(input: {
        libraryId: string;
        name: string;
      }): Promise<{ ok: boolean; error?: { message?: string } }>;
    };
    const library = (
      globalThis as typeof globalThis & { worldlinebox: { library: LibraryApi } }
    ).worldlinebox.library;
    const opened = await library.listOpen();
    const libraryId = opened.value?.[0]?.libraryId;
    if (!opened.ok || !libraryId) throw new Error("Expected an open library.");
    const result = await library.createFolder({ libraryId, name: folderName });
    if (!result.ok) {
      throw new Error(result.error?.message ?? "Could not create folder.");
    }
  }, name);
  const refreshButton = window.getByRole("button", { name: "刷新磁盘变化" });
  await refreshButton.click();
  await expect(refreshButton).toBeEnabled({ timeout: 15_000 });
}

function folderRow(window: Page, name: string) {
  const escaped = name.replace(/"/g, '\\"');
  return window.locator(
    `.navigation-pane button.nav-row[data-nav-folder-kind="managed"][title="${escaped}"]`,
  );
}

async function waitForNavigation(window: Page) {
  await expect(window.locator(".workspace-canvas-host")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}

test("Back and Forward cross tab switches on the shared timeline", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-tab-history-"));
  const libraryName = "标签历史验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const sourcePath = path.join(temporaryRoot, "note.txt");
  writeFileSync(sourcePath, "tab history fixture", "utf8");

  const application = await launchApp(temporaryRoot, libraryPath, sourcePath);

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await waitForNavigation(window);

    await createFolderViaApi(window, "文件夹甲");
    await createFolderViaApi(window, "文件夹乙");

    const tabs = window.getByRole("tablist", { name: "工作区标签页" }).getByRole("tab");
    const crumb = window.locator(".scope-crumb-label.is-current");

    // Tab 1 → 文件夹甲.
    await folderRow(window, "文件夹甲").click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("文件夹甲");
    const firstTabName = await tabs.first().getAttribute("aria-label");

    // New tab (shows 所有资产) → 文件夹乙.
    await window.getByRole("button", { name: "新建标签页" }).click();
    await expect(tabs).toHaveCount(2);
    await waitForNavigation(window);
    await folderRow(window, "文件夹乙").click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("文件夹乙");

    // Back #1: same tab, returns to 所有资产.
    await window.getByRole("button", { name: "后退" }).click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("所有资产");

    // Back #2 crosses the tab switch: tab 1 becomes active at 文件夹甲.
    await window.getByRole("button", { name: "后退" }).click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("文件夹甲");
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
    expect(await tabs.first().getAttribute("aria-label")).toBe(firstTabName);

    // Forward #1 crosses back to tab 2 at 所有资产.
    await window.getByRole("button", { name: "前进" }).click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("所有资产");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");

    // Forward #2 lands on 文件夹乙 in tab 2.
    await window.getByRole("button", { name: "前进" }).click();
    await waitForNavigation(window);
    await expect(crumb).toHaveText("文件夹乙");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
