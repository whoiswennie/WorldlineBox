import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from "@playwright/test";
import sharp from "sharp";

import {
  electronLaunchEnv,
  resolveElectronExecutablePath,
  waitForLibraryLoadingToFinish,
} from "./electron-test-helpers";

test.describe.configure({ timeout: 180_000 });

type MockAiRequest = {
  model: string;
  path: string;
  authorization: string | undefined;
  isProbe: boolean;
  isModelList: boolean;
};

async function openAiSettings(window: Page): Promise<Locator> {
  await window.getByRole("button", { name: "设置", exact: true }).click();
  const settings = window.getByRole("dialog", { name: "通用设置", exact: true });
  await settings.getByRole("tab", { name: "全局模型", exact: true }).click();
  return settings;
}

async function saveProfile(
  settings: Locator,
  input: { name: string; model: string; apiKey?: string; baseUrl: string },
): Promise<void> {
  await settings.locator("#ai-config-profile-name").fill(input.name);
  await settings.locator("#ai-config-model").fill(input.model);
  await settings.locator("#ai-config-base-url").fill(input.baseUrl);
  if (input.apiKey !== undefined) {
    await settings.locator("#ai-config-api-key").fill(input.apiKey);
  }
  await settings
    .getByRole("button", { name: /保存配置|Save configuration/ })
    .click();
  await expect(settings.locator("#ai-config-profile-name")).toHaveValue(input.name);
  const selector = settings.locator("#ai-config-profile");
  const profileId = await selector.getAttribute("data-value");
  if (!profileId) throw new Error(`Expected a saved profile named ${input.name}.`);
  await expect(selector).toContainText(input.name);
  if (input.apiKey !== undefined) {
    await expect(selector).not.toContainText(/需要 API Key|API key needed/u);
  }
}

async function testProfile(
  settings: Locator,
  input: { model: string; apiKey: string; path?: string },
  requests: MockAiRequest[],
): Promise<void> {
  await settings
    .getByRole("button", { name: /测试连接|Test connection/ })
    .click();
  await expect
    .poll(
      () => requests.some((request) =>
        request.isProbe
        && request.model === input.model
        && (!input.path || request.path === input.path)
        && request.authorization === `Bearer ${input.apiKey}`),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function activateSelectedProfile(settings: Locator, name: string): Promise<void> {
  await settings
    .getByRole("button", { name: /设为当前|Set as current/ })
    .click();
  const selected = settings.locator("#ai-config-profile");
  await expect(selected).toContainText(name);
  await expect(selected).toContainText(/当前使用|In use/);
}

async function selectProfile(settings: Locator, name: string): Promise<string> {
  const selector = settings.locator("#ai-config-profile");
  await selector.click();
  const option = settings.page().getByRole("listbox").getByRole("option").filter({ hasText: name });
  await expect(option).toHaveCount(1);
  const profileId = await option.getAttribute("data-value");
  if (!profileId) throw new Error(`Expected a saved profile named ${name}.`);
  await option.click();
  await expect(selector).toHaveAttribute("data-value", profileId);
  await expect(settings.locator("#ai-config-profile-name")).toHaveValue(name);
  return profileId;
}

async function expectOpenProfileOption(
  settings: Locator,
  profileId: string,
  pattern: RegExp,
): Promise<void> {
  const selector = settings.locator("#ai-config-profile");
  await selector.click();
  await expect(settings.page().getByRole("listbox").locator(`[data-value="${profileId}"]`)).toContainText(pattern);
  await selector.click();
}

test("switches AI profiles for analysis and restores the active profile after restart", async () => {
  const requests: MockAiRequest[] = [];
  let pauseNextProbe = false;
  let releasePausedProbe: (() => void) | undefined;
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method === "GET" && request.url?.endsWith("/models")) {
        requests.push({
          model: "",
          path: request.url,
          authorization: request.headers.authorization,
          isProbe: false,
          isModelList: true,
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "draft-endpoint-model" }] }));
        return;
      }
      if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
      }

      let parsed: { model?: unknown };
      try {
        parsed = JSON.parse(body) as { model?: unknown };
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const isProbe = body.includes("Reply with the single word OK");
      const model = typeof parsed.model === "string" ? parsed.model : "";
      requests.push({
        model,
        path: request.url ?? "",
        authorization: request.headers.authorization,
        isProbe,
        isModelList: false,
      });
      const content = isProbe
        ? "OK"
        : JSON.stringify({
            description: "分析配置切换验收",
            tags: ["档案切换"],
            rating: 4,
          });
      const reply = () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      };
      if (isProbe && pauseNextProbe) {
        pauseNextProbe = false;
        releasePausedProbe = reply;
      } else reply();
    });
  });

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "worldlinebox-ai-profile-switch-"));
  const libraryName = "AI 配置切换验收";
  const libraryPath = path.join(temporaryRoot, libraryName);
  const userDataPath = path.join(temporaryRoot, "user-data");
  const imagePath = path.join(temporaryRoot, "profile-switch.png");
  let application: ElectronApplication | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    // Seed only the legacy analysis settings so the real asset-analysis path
    // has its existing disclosure acceptance while the test creates profiles.
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(
      path.join(userDataPath, "ai-config.json"),
      JSON.stringify({
        apiFormat: "openai_chat",
        model: "initial-model",
        baseUrl,
        descriptionEnabled: true,
        tagEnabled: true,
        ratingEnabled: true,
        analysisSettings: { forceExistingTags: false },
        concurrencyLimit: 2,
        maxAnalysisImageEdgePx: 2048,
        languages: ["zh-CN"],
        autoAnalyzeEnabled: false,
        disclaimerAccepted: true,
      }),
      "utf8",
    );
    await sharp({
      create: {
        width: 320,
        height: 240,
        channels: 3,
        background: { r: 96, g: 160, b: 224 },
      },
    }).png().toFile(imagePath);

    const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
    const launch = (includeImport: boolean) => electron.launch({
      args: [applicationDirectory],
      cwd: applicationDirectory,
      executablePath: resolveElectronExecutablePath(),
      env: electronLaunchEnv({
        WORLDLINEBOX_E2E: "1",
        WORLDLINEBOX_E2E_HIDE_WINDOW: "1",
        WORLDLINEBOX_E2E_SHOW_INACTIVE: "1",
        WORLDLINEBOX_E2E_RESTORE_RECENT: "1",
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
        WORLDLINEBOX_E2E_OPEN_LIBRARY_PATH: libraryPath,
        WORLDLINEBOX_E2E_USER_DATA_PATH: userDataPath,
        WORLDLINEBOX_E2E_IMPORT_FILES: includeImport ? imagePath : "",
      }),
    });

    application = await launch(true);
    const firstWindow = await application.firstWindow();
    await firstWindow.locator('[data-application-module="assets"]').click();
    await firstWindow.getByRole("button", { name: "创建资源库" }).click();
    await firstWindow.getByRole("textbox", { name: "名称" }).fill(libraryName);
    await firstWindow.getByRole("button", { name: "创建", exact: true }).click();
    await firstWindow.getByRole("button", { name: "导入文件", exact: true }).first().click();

    const settings = await openAiSettings(firstWindow);
    const endpoint = baseUrl;
    const firstProfile = { name: "Profile One", model: "profile-model-one", apiKey: "profile-key-one", baseUrl: endpoint };
    const secondProfile = { name: "Profile Two", model: "profile-model-two", apiKey: "profile-key-two", baseUrl: endpoint };
    const profileSelector = settings.locator("#ai-config-profile");
    const originalActiveProfileId = await profileSelector.getAttribute("data-value");
    if (!originalActiveProfileId) throw new Error("Expected the migrated profile to be selected.");
    await settings.getByRole("button", { name: /^新建$|^Add$/ }).click();
    await saveProfile(settings, {
      name: firstProfile.name,
      model: firstProfile.model,
      baseUrl: firstProfile.baseUrl,
    });
    await expectOpenProfileOption(settings, originalActiveProfileId, /当前使用|In use/);
    expect(requests).toHaveLength(0);
    await expect(settings.getByRole("button", { name: /设为当前|Set as current/ })).toBeDisabled();

    await settings.locator("#ai-config-api-key").fill(firstProfile.apiKey);
    await saveProfile(settings, firstProfile);
    expect(requests.some((request) => request.isProbe)).toBe(false);
    await expectOpenProfileOption(settings, originalActiveProfileId, /当前使用|In use/);
    await expect(settings.getByRole("button", { name: /设为当前|Set as current/ })).toBeEnabled();
    const draftBaseUrl = `http://127.0.0.1:${port}/draft/v1`;
    await settings.locator("#ai-config-base-url").fill(draftBaseUrl);
    await settings.getByRole("button", { name: /选择模型|Choose model/ }).click();
    await expect(
      firstWindow
        .getByRole("listbox", { name: /选择模型|Choose model/ })
        .getByRole("option", { name: "draft-endpoint-model" }),
    ).toBeVisible();
    await expect.poll(() => requests.some((request) =>
      request.isModelList
      && request.path === "/draft/v1/models"
      && request.authorization === `Bearer ${firstProfile.apiKey}`), { timeout: 30_000 }).toBe(true);
    await testProfile(settings, {
      model: firstProfile.model,
      apiKey: firstProfile.apiKey,
      path: "/draft/v1/chat/completions",
    }, requests);
    await saveProfile(settings, {
      name: firstProfile.name,
      model: firstProfile.model,
      baseUrl: draftBaseUrl,
    });
    await activateSelectedProfile(settings, firstProfile.name);

    await settings.getByRole("button", { name: /^新建$|^Add$/ }).click();
    await saveProfile(settings, secondProfile);
    // An old profile's slow probe must not replace the newly selected draft's
    // status or inline feedback when its response eventually arrives.
    await selectProfile(settings, firstProfile.name);
    await expect(settings.getByRole("button", { name: /测试连接|Test connection/ })).toBeEnabled();
    pauseNextProbe = true;
    await settings.getByRole("button", { name: /测试连接|Test connection/ }).click();
    await expect.poll(() => Boolean(releasePausedProbe)).toBe(true);
    await selectProfile(settings, secondProfile.name);
    releasePausedProbe!();
    releasePausedProbe = undefined;
    await expect(settings.getByRole("button", { name: /测试连接|Test connection/ })).toBeEnabled();
    await expect(settings.locator('.ai-connection-indicator[data-state="connected"]')).toHaveCount(0);
    await expect(settings.locator(".ai-config-test-cluster")).not.toContainText(/连接成功|Connection successful/);
    // Selecting a saved profile edits its draft; the active marker must stay
    // on the first profile until the user explicitly activates the second.
    await profileSelector.click();
    const firstProfileOption = settings.page().getByRole("listbox").getByRole("option").filter({ hasText: firstProfile.name });
    await expect(firstProfileOption).toContainText(/当前使用|In use/);
    await profileSelector.click();
    await testProfile(settings, secondProfile, requests);
    await activateSelectedProfile(settings, secondProfile.name);

    await selectProfile(settings, firstProfile.name);
    await profileSelector.click();
    const openProfiles = settings.page().getByRole("listbox");
    await expect(openProfiles.locator('[aria-selected="true"]')).not.toContainText(/当前使用|In use/);
    await expect(openProfiles.getByRole("option").filter({ hasText: secondProfile.name })).toContainText(/当前使用|In use/);
    await profileSelector.click();
    await activateSelectedProfile(settings, firstProfile.name);
    await selectProfile(settings, secondProfile.name);
    await activateSelectedProfile(settings, secondProfile.name);
    await expect(settings.locator("#ai-config-model")).toHaveValue(secondProfile.model);
    await settings.press("Escape");
    await expect(settings).toBeHidden({ timeout: 15_000 });

    const asset = firstWindow.locator(".asset-card").filter({ hasText: "profile-switch.png" });
    await expect(asset).toBeVisible({ timeout: 15_000 });
    await asset.click();
    await asset.click({ button: "right" });
    await firstWindow.getByRole("menuitem", { name: "AI 分析" }).click();

    await expect
      .poll(
        () => requests.some((request) =>
          !request.isProbe
          && request.model === secondProfile.model
          && request.authorization === `Bearer ${secondProfile.apiKey}`),
        { timeout: 60_000 },
      )
      .toBe(true);

    await application.close();
    application = undefined;

    // A fresh Electron process with the same isolated userData is the restart
    // boundary for the selected profile assertion.
    application = await launch(false);
    const restartedWindow = await application.firstWindow();
    await restartedWindow.locator('[data-application-module="assets"]').click();
    await expect(
      restartedWindow.getByRole("button", { name: `当前资源库 ${libraryName}` }),
    ).toBeVisible({ timeout: 30_000 });
    await waitForLibraryLoadingToFinish(restartedWindow);
    const restartedSettings = await openAiSettings(restartedWindow);
    const selectedProfile = restartedSettings.locator("#ai-config-profile");
    await expect(selectedProfile).toContainText(secondProfile.name);
    await expect(selectedProfile).toContainText("当前使用");
    await expect(restartedSettings.locator("#ai-config-model")).toHaveValue(secondProfile.model);

    const requestCountBeforeRestartProbe = requests.length;
    await restartedSettings
      .getByRole("button", { name: /测试连接|Test connection/ })
      .click();
    await expect
      .poll(
        () => requests.slice(requestCountBeforeRestartProbe).some((request) =>
          request.isProbe
          && request.model === secondProfile.model
          && request.authorization === `Bearer ${secondProfile.apiKey}`),
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    try {
      releasePausedProbe?.();
      if (application) await application.close();
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
