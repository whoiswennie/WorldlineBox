import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from "./electron-test-helpers";

test("application rail keeps asset navigation and opens settings in both themes", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-app-nav-"));
  const application = await electron.launch({
    executablePath: resolveElectronExecutablePath(),
    args: [resolveElectronAppPath()],
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
    }),
  });
  try {
    const window = await application.firstWindow();
    const nativeWindow = await application.browserWindow(window);
    await nativeWindow.evaluate((win) => { win.unmaximize(); win.setSize(1440, 900); });
    const launcher = window.locator('[data-application-module="dsh"]');
    await expect(launcher).toHaveAttribute("aria-current", "page");
    await expect(window.locator('[data-application-module]').first()).toHaveAttribute("data-application-module", "dsh");
    await window.getByRole("button", { name: "设置", exact: true }).click();
    const initialSettings = window.getByRole("dialog", { name: "通用设置", exact: true });
    await expect(initialSettings).toBeVisible();
    await expect(launcher).toHaveAttribute("aria-current", "page");
    await expect(window.locator('[data-application-view="assets"]')).toBeHidden();
    await initialSettings.getByRole("tab", { name: "全局模型", exact: true }).click();
    await initialSettings.getByRole("tab", { name: "插件", exact: true }).click();
    await initialSettings.getByRole("tab", { name: "MCP", exact: true }).click();
    await initialSettings.getByRole("tab", { name: "常规", exact: true }).click();
    await initialSettings.getByRole("button", { name: "查看诊断日志", exact: true }).click();
    await expect(window.getByRole("dialog", { name: "诊断日志", exact: true })).toBeVisible();
    await expect(launcher).toHaveAttribute("aria-current", "page");
    await window.keyboard.press("Escape");
    await expect(window.getByRole("dialog", { name: "诊断日志", exact: true })).toHaveCount(0);
    await expect(initialSettings).toHaveCount(0);
    await expect(launcher).toHaveAttribute("aria-current", "page");
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole("button", { name: "创建资源库", exact: true }).click();
    await window.getByRole("textbox", { name: "名称", exact: true }).fill("世界线资产库");
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await expect(window.locator(".dialog-backdrop")).toHaveCount(0);
    const assets = window.getByRole("button", { name: "资产管理", exact: true });
    const settings = window.getByRole("button", { name: "设置", exact: true });
    await expect(assets).toHaveAttribute("aria-current", "page");
    await expect(window.locator("[data-application-module]")).toHaveCount(5);
    const rail = await window.locator(".application-navigation").boundingBox();
    const settingsBox = await settings.boundingBox();
    expect(rail).not.toBeNull();
    expect(settingsBox).not.toBeNull();
    expect(settingsBox!.y).toBeGreaterThan(rail!.height * 0.85);

    await window.getByRole("button", { name: "收起导航", exact: true }).click();
    await assets.click();
    await expect(window.getByRole("button", { name: "展开导航", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "展开导航", exact: true }).click();
    await settings.click();
    const dialog = window.getByRole("dialog", { name: "通用设置", exact: true });
    await expect(dialog).toBeVisible();
    await expect(settings).toHaveAttribute("aria-expanded", "true");
    await dialog.getByRole("tab", { name: "外观", exact: true }).click();
    await dialog.getByRole("radio", { name: "WorldlineBox", exact: true }).click();
    await dialog.getByRole("radio", { name: "亮色", exact: true }).click();
    await window.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(settings).toHaveAttribute("aria-expanded", "false");
    await expect(assets).toHaveCSS("color", "rgb(37, 41, 54)");
    await window.screenshot({ path: test.info().outputPath("sidebar-light.png") });

    await window.keyboard.press(process.platform === "darwin" ? "Meta+," : "Control+,");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("tab", { name: "外观", exact: true }).click();
    await dialog.getByRole("radio", { name: "暗色", exact: true }).click();
    await window.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(assets).toHaveCSS("color", "rgb(241, 242, 244)");
    await window.screenshot({ path: test.info().outputPath("sidebar-dark.png") });
    await window.locator('[data-application-module="dsh"]').click();
    await expect(window.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,');
    await expect(launcher).toHaveAttribute('aria-current', 'page');
    await expect(dialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toHaveAttribute('aria-current', 'page');
  } finally {
    await application.close();
    const resolvedRoot = path.resolve(temporaryRoot);
    if (path.dirname(resolvedRoot) === path.resolve(tmpdir()) && path.basename(resolvedRoot).startsWith("worldlinebox-app-nav-")) {
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
  }
});
