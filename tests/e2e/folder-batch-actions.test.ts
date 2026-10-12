import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import {
  resolveElectronExecutablePath,
  waitForLibraryLoadingToFinish,
} from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

const selectionModifier = process.platform === "darwin" ? "Meta" : "Control";

async function createFolderViaSidebar(window: Page, folderName: string) {
  await window.getByRole("button", { name: "添加文件夹" }).click();
  const input = window.locator(".nav-inline-edit input");
  await expect(input).toBeVisible();
  await input.fill(folderName);
  await input.press("Enter");
  await expect(
    window.locator(`.navigation-pane button.nav-row[title="${folderName}"]`),
  ).toBeVisible({ timeout: 10_000 });
}

function folderCard(window: Page, folderName: string) {
  return window.locator(".folder-card", {
    has: window.locator(".folder-card-name", { hasText: new RegExp(`^${folderName}$`, "u") }),
  });
}

// WorldlineBox-d7acfa 验收补充：侧栏文件夹树也要能 Ctrl/⌘ 多选，并从同一个批量菜单操作。
test("ctrl-click multi-selects sidebar folder rows and batches the action", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-folder-sidebar-batch-e2e-"),
  );
  const libraryName = "侧栏多选验收";
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
    await window.waitForTimeout(2500);
    for (const name of ["SideA", "SideB", "SideC"]) {
      await createFolderViaSidebar(window, name);
    }

    const row = (name: string) =>
      window.locator(`.navigation-pane button.nav-row[title="${name}"]`);

    // Ctrl 点两行：都进入多选，且不触发导航。
    await row("SideA").click({ modifiers: [selectionModifier] });
    await row("SideB").click({ modifiers: [selectionModifier] });
    await expect(
      window.locator(".navigation-pane button.nav-row.is-multi-selected"),
    ).toHaveCount(2);
    await expect(window.getByRole("navigation", { name: "当前浏览范围" })).toContainText(
      "所有资产",
    );

    // 右键其中一行 → 批量菜单（复用画布的批量动作与计数）。
    await row("SideB").click({ button: "right" });
    const trashItem = window.getByRole("menuitem", { name: "移入回收站（2 项）" });
    await expect(trashItem).toBeVisible();
    await trashItem.click();
    await expect(row("SideA")).toHaveCount(0, { timeout: 20_000 });
    await expect(row("SideB")).toHaveCount(0, { timeout: 20_000 });
    await expect(row("SideC")).toBeVisible();

    // 普通点击仍然是「进文件夹」而不是多选。
    await row("SideC").click();
    await expect(
      window.locator(".navigation-pane button.nav-row.is-multi-selected"),
    ).toHaveCount(0);
    await expect(window.getByRole("navigation", { name: "当前浏览范围" })).toContainText(
      "SideC",
    );
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

// WorldlineBox-d7acfa（用户口径）：正在浏览的文件夹是隐式选中的——当前文件夹是 A 时
// Ctrl 点 B，应当 A 与 B 同时被选中。
test("ctrl-click includes the folder currently being browsed", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-folder-browse-anchor-e2e-"),
  );
  const libraryName = "当前文件夹多选验收";
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
    await window.waitForTimeout(2500);
    for (const name of ["CurA", "CurB", "CurC"]) {
      await createFolderViaSidebar(window, name);
    }

    const row = (name: string) =>
      window.locator(`.navigation-pane button.nav-row[title="${name}"]`);
    const multiSelected = window.locator(
      ".navigation-pane button.nav-row.is-multi-selected",
    );

    // 普通点击进入 CurA：没有多选项。
    await row("CurA").click();
    await expect(window.getByRole("navigation", { name: "当前浏览范围" })).toContainText(
      "CurA",
    );
    await expect(multiSelected).toHaveCount(0);

    // 此刻 Ctrl 点 CurB：CurA（正在浏览）与 CurB 同时被选中。
    await row("CurB").click({ modifiers: [selectionModifier] });
    await expect(multiSelected).toHaveCount(2);
    await expect(row("CurA")).toHaveClass(/is-multi-selected/u);
    await expect(row("CurB")).toHaveClass(/is-multi-selected/u);
    // 批量菜单一次覆盖两个文件夹（不去执行，避免删掉正在浏览的 CurA）。
    await row("CurB").click({ button: "right" });
    await expect(window.getByRole("menuitem", { name: "忽略（2 项）" })).toBeVisible();
    await expect(
      window.getByRole("menuitem", { name: "移入回收站（2 项）" }),
    ).toBeVisible();
    await window.keyboard.press("Escape");

    // 再 Ctrl 点 CurA：取消它，只留 CurB。
    await row("CurA").click({ modifiers: [selectionModifier] });
    await expect(multiSelected).toHaveCount(1);
    await expect(row("CurB")).toHaveClass(/is-multi-selected/u);

    // 普通点击进入 CurC：多选清空（只隐式选中当前文件夹）。
    await row("CurC").click();
    await expect(multiSelected).toHaveCount(0);
    await expect(window.getByRole("navigation", { name: "当前浏览范围" })).toContainText(
      "CurC",
    );
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

// WorldlineBox-d7acfa：多选画布文件夹卡片后，批量回收站与忽略对全部选中项生效。
test("multi-selected folder cards trash and ignore every selected folder", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-folder-batch-e2e-"),
  );
  const libraryName = "文件夹批量验收";
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
    await window.waitForTimeout(2500);

    for (const name of ["Alpha", "Beta", "Gamma", "Delta"]) {
      await createFolderViaSidebar(window, name);
    }

    // 进资源库根目录：文件夹卡片行只在这一层渲染。
    await window.getByRole("button", { name: "资源库根目录" }).click();
    await expect(window.locator(".folder-card")).toHaveCount(4, {
      timeout: 15_000,
    });

    // 多选两张卡片（Alpha + Beta）→「移入回收站（2 项）」。
    await folderCard(window, "Alpha").click();
    await folderCard(window, "Beta").click({ modifiers: [selectionModifier] });
    await expect(window.locator(".folder-card.is-selected")).toHaveCount(2);
    await folderCard(window, "Beta").click({ button: "right" });
    // 只选文件夹时也要有组织区：设置图标按可设置的文件夹计数。
    await expect(
      window.getByText("设置图标与颜色…（2 项）", { exact: true }),
    ).toBeVisible();
    const trashItem = window.getByRole("menuitem", { name: "移入回收站（2 项）" });
    await expect(trashItem).toBeVisible();
    await trashItem.click();

    // 两张卡片都离开画布，提示按「2 个文件夹」汇报。
    await expect(window.locator(".folder-card")).toHaveCount(2, {
      timeout: 20_000,
    });
    await expect(window.locator(".workspace-notice")).toContainText("文件夹", {
      timeout: 10_000,
    });
    await expect(folderCard(window, "Alpha")).toHaveCount(0);
    await expect(folderCard(window, "Beta")).toHaveCount(0);

    // 多选剩下两张 →「忽略（2 项）」：两张都不再作为卡片与侧栏行出现。
    await folderCard(window, "Gamma").click();
    await folderCard(window, "Delta").click({ modifiers: [selectionModifier] });
    await expect(window.locator(".folder-card.is-selected")).toHaveCount(2);
    await folderCard(window, "Delta").click({ button: "right" });
    const ignoreItem = window.getByRole("menuitem", { name: "忽略（2 项）" });
    await expect(ignoreItem).toBeVisible();
    await ignoreItem.click();
    await expect(window.locator(".workspace-notice")).toContainText("忽略", {
      timeout: 10_000,
    });
    for (const name of ["Gamma", "Delta"]) {
      await expect(
        window.locator(`.navigation-pane button.nav-row[title="${name}"]`),
      ).toHaveCount(0, { timeout: 15_000 });
    }
    await expect(window.locator(".folder-card")).toHaveCount(0, {
      timeout: 15_000,
    });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
