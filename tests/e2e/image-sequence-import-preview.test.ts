import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import sharp from "sharp";

import { resolveElectronExecutablePath, waitForLibraryLoadingToFinish } from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

/** 预览必须证明真的解码出图，不能只看 DOM 里有没有 <img>。 */
async function expectDecodedPreview(image: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        image.evaluate(
          (element) =>
            element instanceof HTMLImageElement &&
            element.complete &&
            element.naturalWidth > 0,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}

// WorldlineBox-866c20：确认面板改成陈述式标题，并在面板里按当前范围/帧率循环预览序列帧。
test("the image sequence confirm panel shows a statement title and a live frame preview", async () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "worldlinebox-image-sequence-preview-e2e-"),
  );
  const sourceRoot = path.join(temporaryRoot, "frames");
  const libraryName = "序列帧面板验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const framePaths = [0, 1, 2, 3].map((index) =>
    path.join(sourceRoot, `walk_${String(index).padStart(3, "0")}.png`),
  );
  const colors = [
    { r: 210, g: 60, b: 60, alpha: 1 },
    { r: 60, g: 180, b: 100, alpha: 1 },
    { r: 60, g: 100, b: 210, alpha: 1 },
    { r: 200, g: 180, b: 60, alpha: 1 },
  ];
  mkdirSync(sourceRoot, { recursive: true });
  await Promise.all(
    framePaths.map((framePath, index) =>
      sharp({
        create: {
          width: 240,
          height: 135,
          channels: 4,
          background: colors[index]!,
        },
      })
        .png()
        .toFile(framePath),
    ),
  );

  const applicationDirectory =
    process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  const application = await electron.launch({
    args: [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: {
      ...process.env,
      WORLDLINEBOX_E2E: "1",
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      // 保留确认面板（E2E 默认会自动展开序列，见 Main 的 e2eAutoExpand）。
      WORLDLINEBOX_E2E_SEQUENCE_PROMPT: "1",
      // 四张连续帧一起交给导入：关闭自动成组后，Worker 会给出待确认的序列。
      WORLDLINEBOX_E2E_IMPORT_FILES: framePaths.join(path.delimiter),
    },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    // 建库后的 transition 未结束就导入会撞上 WorldlineBox-283094（导入失败 / transition in progress）；
    // 等 loading 结束后再给转换一个稳定窗口（与其它 E2E 的既有做法一致）。
    await waitForLibraryLoadingToFinish(window);
    await window.waitForTimeout(2500);
    await window
      .getByRole("button", { name: "导入文件", exact: true })
      .first()
      .click();

    // 标题是陈述句，不再问「导入序列帧？」。
    const dialog = window.getByRole("dialog", { name: "导入序列帧" });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(window.getByRole("dialog", { name: "导入序列帧？" })).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "导入为序列帧", exact: true }),
    ).toBeVisible();

    // 预览：真实解码的帧。本次流程是「导入完成 → 面板确认成组」，
    // 因此帧已经是库内资产，走既有 worldlinebox://source 通道。
    const preview = dialog.locator('[data-sequence-preview="ready"]');
    await expect(preview).toBeVisible();
    const previewImage = preview.locator("img");
    await expect(previewImage).toHaveAttribute("src", /^worldlinebox:\/\/source\//);
    await expectDecodedPreview(previewImage);
    await expect(preview.locator(".image-sequence-preview-caption")).toContainText(
      "FPS",
    );

    // 帧率换档立刻生效：2 FPS 时预览应在 1 秒内推进到下一帧。
    await dialog.getByLabel("帧率（FPS）").fill("2");
    const firstSrc = await previewImage.getAttribute("src");
    await expect
      .poll(async () => previewImage.getAttribute("src"), { timeout: 5_000 })
      .not.toBe(firstSrc);
    await expect(preview.locator(".image-sequence-preview-caption")).toContainText(
      "2 FPS",
    );
    await expectDecodedPreview(previewImage);

    // 缩小范围立刻生效：只看第 2 帧时预览停在那一帧。
    await dialog.locator("#image-sequence-import-first").fill("2");
    await dialog.locator("#image-sequence-import-last").fill("2");
    await expect(preview.locator(".image-sequence-preview-caption")).toContainText(
      "当前第 2 帧",
    );
    await expect(preview.locator(".image-sequence-preview-caption")).toContainText(
      "范围 1 帧",
    );
    await expectDecodedPreview(previewImage);

    // 恢复完整范围后确认导入：序列帧照旧成组。
    await dialog.locator("#image-sequence-import-first").fill("0");
    await dialog.locator("#image-sequence-import-last").fill("3");
    await dialog
      .getByRole("button", { name: "导入为序列帧", exact: true })
      .click();
    await expect(window.locator(".asset-card")).toHaveCount(1, {
      timeout: 30_000,
    });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
