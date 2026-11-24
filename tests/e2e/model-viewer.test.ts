import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "@playwright/test";

import { resolveElectronAppPath, resolveElectronExecutablePath } from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

/**
 * 3D model viewer journeys (0030 slice C, WorldlineBox-qvc6).
 *
 * Decode proof per the core-journey gate: stats are computed from the loaded
 * BufferGeometry after a successful parse, so "三角面 12" for a cube is
 * evidence the model was actually decoded — not just a mounted <canvas>.
 */

async function launchWithModels(modelFiles: string[]) {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-model-viewer-e2e-"),
  );
  const libraryName = "模型查看验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const applicationDirectory = resolveElectronAppPath();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_ENABLE_SWIFTSHADER: "1",
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      WORLDLINEBOX_E2E_IMPORT_FILES: modelFiles.join(path.delimiter),
    },
  });
  const window = await application.firstWindow();
  window.on("console", (message) => {
    const text = message.text();
    if (/model|fbx|gltf|webgl|error|fail|worldlinebox/i.test(text)) {
      console.log(`[renderer-console] ${message.type()}: ${text.slice(0, 300)}`);
    }
  });
  window.on("response", (response) => {
    if (response.status() >= 400) {
      console.log(`[resp-${response.status()}] ${response.url().slice(0, 250)}`);
    }
  });
  await window.locator('[data-application-module="assets"]').click();
  await window.getByRole("button", { name: "创建资源库" }).click();
  await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
  await window.getByRole("button", { name: "创建", exact: true }).click();
  await window
    .getByRole("button", { name: "导入文件", exact: true })
    .first()
    .click();
  await expect(window.getByRole("button", { name: "刷新磁盘变化", exact: true }))
    .toBeEnabled({ timeout: 60_000 });
  return { application, window, temporaryRoot, libraryPath };
}

function fixtureModels(name: string): string {
  return path.join(process.cwd(), "tests", "fixtures", "models", name);
}

async function openModelViewer(
  window: Page,
  options: { activate?: boolean } = {},
) {
  if (options.activate !== false) {
    await window.keyboard.press("Space");
  }
  const viewer = window.getByRole("region", { name: "3D 模型预览" });
  await expect(viewer).toBeVisible({ timeout: 45_000 });
  await expect(viewer.locator("canvas")).toBeVisible();
  // Ready phase = toolbar present (the WebGL canvas mounts during loading
  // too, so it is not a readiness signal on its own). Model load / FBX
  // conversion happens after the surface mounts, so allow generous time.
  const toggle = viewer.getByRole("button", { name: "显示或隐藏统计" });
  const errorState = viewer.locator(".model-viewer-state.is-error");
  await Promise.race([
    toggle.waitFor({ state: "attached", timeout: 60_000 }),
    errorState.waitFor({ state: "attached", timeout: 60_000 }),
  ]);
  if ((await toggle.count()) === 0) {
    const message = await errorState.innerText();
    console.log(`[viewer-error] ${message}`);
    throw new Error(`Model viewer failed to reach ready: ${message}`);
  }
  await expect(errorState).toHaveCount(0);
  await revealModelToolbar(window);
  return viewer;
}

async function revealModelToolbar(window: Page) {
  const box = await window.locator('.workspace-viewer').boundingBox();
  if (!box) throw new Error('Expected the viewer bounds.');
  await window.mouse.move(box.x + box.width / 2, box.y + box.height - 24);
}

async function revealStats(window: Page) {
  await revealModelToolbar(window);
  const button = window.getByRole("button", { name: "显示或隐藏统计" });
  await button.click();
  const stats = window.locator('dl[aria-label="模型统计"]');
  await expect(stats).toBeVisible();
  return stats;
}

test("persists double-sided and info choices and copies the viewed file path", async () => {
  const { application, window } = await launchWithModels([
    fixtureModels("cube.obj"), fixtureModels("cube.mtl"),
  ]);
  try {
    const card = window.locator('.asset-card[data-asset-name="cube.obj"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    let viewer = await openModelViewer(window, { activate: false });
    const stats = window.locator('dl[aria-label="模型统计"]');
    await expect(stats).toBeHidden();
    await viewer.getByRole("button", { name: "双面", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "双面", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await revealStats(window);
    await viewer.getByRole("combobox", { name: "显示模式" }).click();
    await window.getByRole("option", { name: "网格灰模", exact: true }).click();
    await window.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await card.dblclick();
    viewer = await openModelViewer(window, { activate: false });
    await expect(viewer.getByRole("button", { name: "双面", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    await expect(viewer.getByRole("combobox", { name: "显示模式" }))
      .toHaveAttribute("data-value", "shaded-wireframe");
    await expect(stats).toBeVisible();
    await expect(stats).toContainText("12");

    await application.evaluate(({ clipboard }) => clipboard.writeText("path-shortcut-sentinel"));
    await window.keyboard.press(process.platform === "darwin" ? "Alt+Meta+C" : "Control+Shift+C");
    await expect.poll(() => application.evaluate(({ clipboard }) => clipboard.readText()))
      .toMatch(/cube\.obj$/u);

    await revealModelToolbar(window);
    await viewer.getByRole("button", { name: "双面", exact: true }).click();
    await viewer.getByRole("button", { name: "显示或隐藏统计" }).click();
    await window.keyboard.press("Escape");
    await card.dblclick();
    viewer = await openModelViewer(window, { activate: false });
    await expect(viewer.getByRole("button", { name: "双面", exact: true }))
      .toHaveAttribute("aria-pressed", "false");
    await expect(stats).toBeHidden();
  } finally {
    await application.close();
  }
});

test("opens an OBJ model with its MTL companion in the 3D viewer", async () => {
  const { application, window } = await launchWithModels([
    fixtureModels("cube.obj"),
    fixtureModels("cube.mtl"),
  ]);
  try {
    const assetCard = window
      .locator(".asset-card")
      .filter({ hasText: "cube.obj" });
    await expect(assetCard).toBeVisible({ timeout: 15_000 });
    await assetCard.dblclick();
    const viewer = await openModelViewer(window, { activate: false });

    // Real decode proof: 12 triangles / 8 vertices for the cube fixture.
    const stats = await revealStats(window);
    await expect(stats).toContainText("三角面");
    await expect(stats).toContainText("12");
    await expect(stats).toContainText("材质");
    await expect(viewer.locator("canvas")).toBeVisible();
  } finally {
    await application.close();
  }
});

test("decodes the source FBX in the viewer without saving a converted model", async () => {
  const { application, window, temporaryRoot, libraryPath } = await launchWithModels([
    path.join(
      process.cwd(),
      "tests",
      "fixtures",
      "fbx",
      "blender_272_cube_7400_binary.fbx",
    ),
  ]);
  try {
    const assetCard = window
      .locator(".asset-card")
      .filter({ hasText: "blender_272_cube_7400_binary.fbx" });
    await expect(assetCard).toBeVisible({ timeout: 15_000 });
    await assetCard.click();
    await openModelViewer(window);

    const stats = await revealStats(window);
    await expect(stats).toContainText("三角面");
    await expect(stats).toContainText("12");
    expect(readdirSync(path.join(libraryPath, ".worldlinebox", "artifacts")))
      .not.toContainEqual(expect.stringMatching(/\.model_glb$/u));
  } finally {
    try {
      await application.close();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});

test("shows HDRI names in the trigger and larger previews in the picker", async () => {
  const { application, window } = await launchWithModels([
    fixtureModels("cube.obj"),
    fixtureModels("cube.mtl"),
  ]);
  try {
    const assetCard = window
      .locator(".asset-card")
      .filter({ hasText: "cube.obj" });
    await expect(assetCard).toBeVisible({ timeout: 15_000 });
    await assetCard.dblclick();
    const viewer = await openModelViewer(window, { activate: false });
    const trigger = viewer.getByRole("button", { name: "环境光" });
    const displayMode = viewer.getByRole("combobox", { name: "显示模式" });

    const [triggerStyle, displayModeStyle] = await Promise.all([
      trigger.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderColor: style.borderColor,
          height: style.height,
        };
      }),
      displayMode.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderColor: style.borderColor,
          height: style.height,
        };
      }),
    ]);
    expect(triggerStyle).toEqual(displayModeStyle);

    await expect(trigger.locator(".model-viewer-hdri-trigger-thumb")).toHaveCount(0);
    await revealModelToolbar(window);
    await trigger.click();

    const picker = window.locator('.model-viewer-hdri-picker[role="listbox"]');
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("option")).toHaveCount(4);
    const previews = picker.locator(".model-viewer-hdri-option-thumb");
    await expect(previews).toHaveCount(4);
    await expect(picker.getByText("自定义", { exact: false })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          previews.evaluateAll((elements) =>
            elements.every((element) => {
              const image = element as HTMLImageElement;
              return image.complete && image.naturalWidth > 0;
            }),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);

    const previewBox = await previews.first().boundingBox();
    expect(previewBox?.width).toBeGreaterThanOrEqual(136);
    expect(previewBox?.height).toBeGreaterThanOrEqual(76);
    await expect
      .poll(() =>
        previews
          .first()
          .evaluate((element) => getComputedStyle(element.nextElementSibling!).fontSize),
      )
      .toBe("12px");

    await picker.getByRole("option", { name: "室内" }).click();
    await expect(trigger.locator(".model-viewer-hdri-trigger-name")).toHaveText("室内");
    await expect(trigger.locator(".model-viewer-hdri-trigger-thumb")).toHaveCount(0);
  } finally {
    await application.close();
  }
});
