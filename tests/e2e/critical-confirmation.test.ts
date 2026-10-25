import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "@playwright/test";

import { resolveElectronExecutablePath, waitForLibraryLoadingToFinish } from "./electron-test-helpers";

// 建库 + 等加载 + 独立确认窗，默认 30 s 不够（与其它 E2E 一致放宽）。
test.describe.configure({ timeout: 120_000 });

test("uses the in-app dialog for library disk deletion", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-critical-confirmation-test-"),
  );
  const libraryName = "critical-confirmation-library";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
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
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await expect(
      window.getByRole("heading", { name: "导入资产以开始整理" }),
    ).toBeVisible({ timeout: 15_000 });
    expect(existsSync(libraryPath)).toBe(true);

    const libraryId = await window.evaluate(async () => {
      const bridge = globalThis as typeof globalThis & {
        worldlinebox: {
          library: {
            listOpen(): Promise<{
              ok: boolean;
              value?: Array<{ libraryId: string }>;
              error?: { message?: string };
            }>;
          };
        };
      };
      const result = await bridge.worldlinebox.library.listOpen();
      if (!result.ok || !result.value?.[0]) {
        throw new Error(result.error?.message ?? "Expected an open library.");
      }
      return result.value[0].libraryId;
    });

    const openCriticalDialog = async () => {
      const deletion = window.evaluate(async (id) => {
        const bridge = globalThis as typeof globalThis & {
          worldlinebox: {
            library: {
              deleteLibraryFromDisk(input: { libraryId: string }): Promise<{
                ok: boolean;
                error?: { message?: string };
              }>;
            };
          };
        };
        const result = await bridge.worldlinebox.library.deleteLibraryFromDisk({
          libraryId: id,
        });
        return result;
      }, libraryId);
      const dialog = window.getByRole("dialog", { name: "从磁盘删除这个资源库？" });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      return { dialog, deletion };
    };

    const first = await openCriticalDialog();
    await expect(first.dialog.locator(".dialog-body-copy")).toHaveText(
      "此操作无法撤销。关联文件夹的源目录不会被删除。",
    );
    await expect(first.dialog.getByRole("button", { name: "从磁盘删除", exact: true })).toBeVisible();
    await expect(
      first.dialog.getByRole("button", { name: /不再显示|总是/ }),
    ).toHaveCount(0);
    await expect(first.dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
    await window.keyboard.press("Escape");
    await expect(first.deletion).resolves.toMatchObject({ ok: false });
    await expect(first.dialog).toBeHidden();
    await expect.poll(() => existsSync(libraryPath)).toBe(true);

    const second = await openCriticalDialog();
    await second.dialog
      .getByRole("button", { name: "从磁盘删除", exact: true })
      .click();
    await expect(second.deletion).resolves.toMatchObject({ ok: true });
    await expect.poll(() => existsSync(libraryPath)).toBe(false);
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

// WorldlineBox-bcaf4a：危险操作确认窗点「取消」是用户主动停下，不是失败。
// 界面必须给一句点名操作的 info 提示，绝不能落到红色错误条。
test("cancelling a folder disk delete reports an info notice instead of an error", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-critical-cancel-copy-"),
  );
  const libraryName = "critical-cancel-library";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
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
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await waitForLibraryLoadingToFinish(window);

    // 建一个托管文件夹，走真实的文件夹右键菜单触发「从硬盘删除…」。
    await window.getByRole("button", { name: "添加文件夹" }).click();
    const folderInput = window.locator(".nav-inline-edit input");
    await expect(folderInput).toBeVisible();
    await folderInput.fill("Alpha");
    await folderInput.press("Enter");
    const alphaRow = window.locator(
      '.navigation-pane button.nav-row[data-nav-folder-kind="managed"][title="Alpha"]',
    );
    await expect(alphaRow).toBeVisible({ timeout: 10_000 });

    await alphaRow.click({ button: "right" });
    const menu = window.getByRole("menu", { name: "文件夹操作：Alpha", exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: "从硬盘中删除" }).click();

    const dialog = window.getByRole("dialog", { name: "从磁盘删除这个文件夹？" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole("button", { name: "强制删除", exact: true })).toBeFocused();
    await dialog
      .getByRole("button", { name: "取消", exact: true })
      .click();

    // info 通知点名了操作……
    await expect(window.locator(".workspace-notice")).toContainText(
      "已取消从硬盘删除。",
      { timeout: 10_000 },
    );
    // ……而且没有红色错误条。
    await expect(
      window.locator('.workspace-notice [data-ui-tone="error"]'),
    ).toHaveCount(0);
    await expect(alphaRow).toBeVisible();
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
