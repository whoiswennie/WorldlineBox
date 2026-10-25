import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Locator } from "@playwright/test";

import {
  resolveElectronExecutablePath,
  waitForLibraryLoadingToFinish,
} from "./electron-test-helpers";

test.describe.configure({ timeout: 120_000 });

/** 卡片缩略图必须真的解码出图（不能只断言 DOM 里有 <img>）。 */
async function expectDecodedImage(locator: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        locator.evaluate(
          (element) =>
            element instanceof HTMLImageElement &&
            element.complete &&
            element.naturalWidth > 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

// WorldlineBox-485aeb：字体资产的卡片样张与查看器预览都要证明「真的解码出字」。
test("a font asset renders a card sample and a viewer preview with real glyphs", async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-font-e2e-"));
  const libraryName = "字体预览验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  // 仓库自带的真实字体（DejaVuSans.ttf）复制到临时目录后导入。
  const fontSource = path.join(temporaryRoot, "DejaVuSans.ttf");
  copyFileSync(
    path.resolve("resources/fonts/DejaVuSans.ttf"),
    fontSource,
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
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, "user-data"),
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
      WORLDLINEBOX_E2E_IMPORT_FILES: fontSource,
    },
  });

  try {
    const window = await application.firstWindow();
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole("button", { name: "创建资源库" }).click();
    await window.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await window.getByRole("button", { name: "创建", exact: true }).click();
    await waitForLibraryLoadingToFinish(window);
    await window.waitForTimeout(2500);
    await window
      .getByRole("button", { name: "导入文件", exact: true })
      .first()
      .click();

    const card = window.locator(".asset-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(window.locator(".asset-card")).toHaveCount(1);

    // 卡片样张来自 offscreen 样张页生成的 artifact（不是通用文件图标）。
    const cardImage = card.locator("img").first();
    await expect(cardImage).toHaveAttribute("src", /^worldlinebox:\/\/preview\//, {
      timeout: 30_000,
    });
    await expectDecodedImage(cardImage);
    // 封面是 16:9 的样张（不是 4:3）。
    const thumbnailRatio = await cardImage.evaluate((element) =>
      element instanceof HTMLImageElement && element.naturalWidth > 0
        ? element.naturalWidth / element.naturalHeight
        : 0,
    );
    expect(thumbnailRatio).toBeGreaterThan(1.7);
    expect(thumbnailRatio).toBeLessThan(1.85);
    // 字体自带格式角标（TTF），说明识别成独立媒体类型而不是「其他」。
    await expect(card.getByText("TTF", { exact: true })).toBeVisible();

    // Inspector：字体格式 + 从字体文件读出的元信息（家族/字形数/字符集）。
    await expect(window.getByText("TTF 字体", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.locator('.inspector-tech-bar [data-field="font-family"]'))
      .toContainText("DejaVu Sans", { timeout: 15_000 });
    await expect(window.locator('.inspector-tech-bar [data-field="font-glyphs"]'))
      .toBeVisible();
    await expect(window.locator('.inspector-tech-bar [data-field="font-script"]'))
      .toContainText("拉丁文");

    // 打开查看器：字形由 Renderer 自己用 FontFace 渲染（不再走 iframe）。
    await card.dblclick();
    await expect(window.locator(".workspace-viewer")).toBeVisible({ timeout: 30_000 });
    const specimenRows = window.locator(".font-viewer-specimen-row");
    await expect(specimenRows).toHaveCount(3);
    // 每个资产一个字体家族（导航切换时新旧查看器会同时挂载，共用家族名会串字体）。
    const fontFamily = await specimenRows.first().evaluate((row) => {
      const first = getComputedStyle(row).fontFamily.split(",")[0] ?? "";
      return first.trim().replaceAll('"', "");
    });
    expect(fontFamily.startsWith("WorldlineBoxFontViewer-")).toBe(true);
    await expect
      .poll(
        () =>
          window.evaluate(
            (family) => document.fonts.check(`16px "${family}"`),
            fontFamily,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    // 画布像素证据：用加载到的字体绘制文字必须出现非透明像素。
    const paintedPixels = await window.evaluate((family) => {
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      if (!context) return -1;
      context.fillStyle = "#000";
      context.font = `48px "${family}"`;
      context.fillText("WorldlineBox", 4, 60);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let index = 3; index < data.length; index += 4) {
        if ((data[index] ?? 0) > 0) painted += 1;
      }
      return painted;
    }, fontFamily);
    expect(paintedPixels).toBeGreaterThan(50);

    const specimenSizes = async (): Promise<number[]> =>
      specimenRows.evaluateAll((rows) =>
        rows.map((row) => Number.parseFloat(getComputedStyle(row).fontSize)),
      );
    const defaultSizes = await specimenSizes();
    // 查看界面同时显示至少三种字号，且都比封面大标题以外的行更小/更大。
    expect(new Set(defaultSizes).size).toBe(3);
    // 查看文案与卡片封面（字体预览 AaBbCc 0123）不同。
    const specimenText = await specimenRows.first().innerText();
    expect(specimenText).not.toBe("字体预览 AaBbCc 0123");
    expect(specimenText).toContain("?");

    // 字号控件放大整组样张。
    await window.getByLabel(/字号/).fill("120");
    await expect
      .poll(async () => (await specimenSizes())[0], { timeout: 15_000 })
      .toBe(120);

    // 鼠标滚轮在样张上调整字号（滚轮向上 = 变大）。
    await window.locator(".font-viewer-stage").dispatchEvent("wheel", { deltaY: -100 });
    await expect
      .poll(async () => (await specimenSizes())[0], { timeout: 15_000 })
      .toBe(124);

    // Ctrl+滚轮与直接滚轮是同一个动作：改字号（不做独立缩放滑块）。
    await window
      .locator(".font-viewer-stage")
      .dispatchEvent("wheel", { ctrlKey: true, deltaY: -100 });
    await expect
      .poll(async () => (await specimenSizes())[0], { timeout: 15_000 })
      .toBe(128);
    await window.locator(".font-viewer-stage").dispatchEvent("wheel", { deltaY: 100 });
    await expect
      .poll(async () => (await specimenSizes())[0], { timeout: 15_000 })
      .toBe(124);

    // 粗体 / 斜体 / 下划线开关反映到样张的排版上。
    await window.getByRole("button", { name: "粗体" }).click();
    await expect
      .poll(() =>
        specimenRows
          .first()
          .evaluate((row) => getComputedStyle(row).fontWeight),
      )
      .toBe("700");
    await window.getByRole("button", { name: "斜体" }).click();
    await expect
      .poll(() =>
        specimenRows
          .first()
          .evaluate((row) => getComputedStyle(row).fontStyle),
      )
      .toBe("italic");
    await window.getByRole("button", { name: "下划线" }).click();
    await expect
      .poll(() =>
        specimenRows
          .first()
          .evaluate((row) => getComputedStyle(row).textDecorationLine),
      )
      .toContain("underline");

    // 工具条上的控件标签是图标（配 hover 提示），不是文字。
    await expect(window.locator(".font-viewer-controls .font-viewer-control .icon"))
      .toHaveCount(3);
    await expect(window.locator(".font-viewer-controls .font-viewer-control > span"))
      .toHaveCount(1);
    // 所有控件（含图标、输入框、下拉、滑杆、数值）共用同一条竖直中心线（偏差 <= 1px）。
    const toolbarCenters = await window
      .locator(".font-viewer-controls")
      .evaluate((root) =>
        [...root.querySelectorAll(
          "label, button, .icon, input, select, .font-viewer-control-value, .font-viewer-style-glyph",
        )].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            key: `${element.tagName}.${element.getAttribute("class") ?? ""}`,
            center: rect.top + rect.height / 2,
          };
        }),
      );
    const centerValues = toolbarCenters.map((entry) => entry.center);
    expect(Math.max(...centerValues) - Math.min(...centerValues)).toBeLessThanOrEqual(1);
    // 语言控件在工具条最后。
    const lastControlIsLanguage = await window
      .locator(".font-viewer-controls > *")
      .last()
      .evaluate((element) =>
        Boolean(element.querySelector('button[aria-label="语言"]')),
      );
    expect(lastControlIsLanguage).toBe(true);

    // 预览语言：默认按字体判定（DejaVu 是拉丁字体 → 英文），下拉直接显示语言，
    // 可手动切到德文/日文等；静态字体（只有一套字形）不显示字重控件。
    const languageSelect = window.getByRole("button", { name: "语言" });
    await expect(languageSelect).toBeVisible();
    await expect(languageSelect).toHaveText("英文");
    await languageSelect.click();
    await expect(window.getByRole("option")).toHaveCount(18);
    await window.getByRole("option", { name: "德文" }).click();
    await expect(specimenRows.first()).toContainText("Schrift Vorschau");
    await languageSelect.click();
    await window.getByRole("option", { name: "日文" }).click();
    await expect(specimenRows.first()).toContainText("フォント文字プレビュー");
    await languageSelect.click();
    await window.getByRole("option", { name: "英文" }).click();
    await expect(specimenRows.first()).toContainText("AaBbCc");
    await expect(window.getByRole("button", { name: "字重" })).toHaveCount(0);

    // 自定义预览文字：按语言记住（换回该语言/换字体时沿用），可撤回（图标按钮）。
    const textField = window.getByLabel("预览文字");
    const resetButton = window.getByRole("button", { name: "恢复默认文字" });
    await expect(resetButton).toBeDisabled();
    await textField.fill("WorldlineBox 字体");
    await expect(specimenRows.first()).toHaveText("WorldlineBox 字体");
    await expect(resetButton).toBeEnabled();
    // 切到德文是德文默认文案，切回英文仍是刚才输入的文字（按语言持久化）。
    await languageSelect.click();
    await window.getByRole("option", { name: "德文" }).click();
    await expect(specimenRows.first()).toContainText("Schrift Vorschau");
    await languageSelect.click();
    await window.getByRole("option", { name: "英文" }).click();
    await expect(specimenRows.first()).toHaveText("WorldlineBox 字体");
    // 撤回：回到该语言的默认文字。
    await resetButton.click();
    await expect(specimenRows.first()).toContainText("AaBbCc");
    await expect(resetButton).toBeDisabled();

    // WorldlineBox-485aeb 回归：点进查看界面之后 Esc 仍要能退出（iframe 焦点曾吞掉 Esc）。
    await specimenRows.first().click();
    await window.keyboard.press("Escape");
    await expect(window.locator(".workspace-viewer")).toBeHidden({ timeout: 15_000 });
  } finally {
    await application.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
