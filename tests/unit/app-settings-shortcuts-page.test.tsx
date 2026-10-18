// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppSettingsShortcutsPage } from "../../src/renderer/AppSettingsShortcutsPage";
import { LocaleProvider } from "../../src/renderer/i18n";
import { ShortcutProvider } from "../../src/renderer/shortcut-provider";
import { DEFAULT_SHORTCUT_BINDINGS } from "../../src/shared/shortcut-bindings";

type SetRequest = {
  platform: "mac" | "windows";
  bindings: Record<string, unknown>;
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;
let originalWorldlineBox: unknown;

function bindingsFor(overrides: Record<string, unknown>) {
  return {
    version: 1 as const,
    platforms: { mac: {}, windows: overrides },
  };
}

async function renderPage(
  setMock: ReturnType<typeof vi.fn>,
  fileApi: {
    exportToFile?: () => Promise<unknown>;
    importFromFile?: () => Promise<unknown>;
  } = {},
) {
  (window as unknown as { worldlinebox?: unknown }).worldlinebox = {
    shortcuts: {
      get: async () => DEFAULT_SHORTCUT_BINDINGS,
      set: setMock,
      exportToFile: fileApi.exportToFile ?? (async () => ({ ok: false, error: "canceled", canceled: true })),
      importFromFile: fileApi.importFromFile ?? (async () => ({ ok: false, error: "canceled", canceled: true })),
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        LocaleProvider,
        { children: null, initialPreference: "zh-CN" },
        createElement(
          ShortcutProvider,
          null,
          createElement(AppSettingsShortcutsPage),
        ),
      ),
    );
    await Promise.resolve();
  });
  const page = container.querySelector<HTMLElement>(".shortcut-settings-page");
  expect(page).not.toBeNull();
  return page!;
}

function rowFor(page: HTMLElement, label: string): HTMLElement {
  const row = [...page.querySelectorAll<HTMLElement>(".shortcut-settings-row")].find(
    (candidate) =>
      candidate.querySelector(".shortcut-settings-row-copy strong")?.textContent === label,
  );
  expect(row, label).toBeDefined();
  return row!;
}

async function pressKey(key: string, code: string) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        code,
        bubbles: true,
        cancelable: true,
      }),
    );
    await Promise.resolve();
  });
}

async function pressMouseSide(button: 3 | 4, modifiers: Partial<MouseEventInit> = {}) {
  const event = new MouseEvent("mousedown", {
    button,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

beforeEach(() => {
  originalWorldlineBox = (window as unknown as { worldlinebox?: unknown }).worldlinebox;
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  (window as unknown as { worldlinebox?: unknown }).worldlinebox = originalWorldlineBox;
});

describe("AppSettingsShortcutsPage", () => {
  it("shows the viewer actions under the localized Viewer group", async () => {
    const page = await renderPage(vi.fn());
    const viewerAction = rowFor(page, "播放/暂停");
    expect(viewerAction).toBeDefined();
    expect(page.textContent).toContain("查看界面");
  });

  it("records modified mouse side buttons, blocks history navigation, and rejects bare side buttons", async () => {
    const setMock = vi.fn(async (request: SetRequest) => ({
      ok: true,
      bindings: bindingsFor(request.bindings),
    }));
    const page = await renderPage(setMock);
    const row = rowFor(page, "重命名资产");
    await act(async () => {
      row.querySelector<HTMLButtonElement>(".shortcut-keycap")!.click();
      await Promise.resolve();
    });

    const bareSide = await pressMouseSide(4);
    expect(bareSide.defaultPrevented).toBe(true);
    expect(page.textContent).toContain("必须与 Ctrl、Alt、Shift 或 Meta 组合");
    expect(setMock).not.toHaveBeenCalled();

    const modifiedSide = await pressMouseSide(3, { ctrlKey: true });
    expect(modifiedSide.defaultPrevented).toBe(true);
    expect(row.querySelector(".shortcut-capture-input")?.textContent)
      .toContain("鼠标后退");
    await pressKey("Enter", "Enter");

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]![0].bindings).toMatchObject({
      "asset.rename": { key: "MouseBack", ctrlKey: true },
    });
    expect(row.querySelector(".shortcut-keycap")?.textContent).toContain("鼠标后退");
  });

  it("records a new chord and updates the row immediately", async () => {
    const setMock = vi.fn(async (request: SetRequest) => ({
      ok: true,
      bindings: bindingsFor(request.bindings),
    }));
    const page = await renderPage(setMock);
    const row = rowFor(page, "重命名资产");
    await act(async () => {
      row.querySelector<HTMLButtonElement>(".shortcut-keycap")!.click();
      await Promise.resolve();
    });
    await pressKey("F3", "F3");
    await pressKey("Enter", "Enter");

    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]![0].bindings).toMatchObject({
      "asset.rename": { key: "F3", code: "F3" },
    });
    expect(row.querySelector(".shortcut-keycap")?.textContent).toContain("F3");
  });

  it("shows a conflict log and accepts another chord", async () => {
    const setMock = vi.fn(async (request: SetRequest) => ({
      ok: true,
      bindings: bindingsFor(request.bindings),
    }));
    const page = await renderPage(setMock);
    const renameRow = rowFor(page, "重命名资产");
    await act(async () => {
      renameRow.querySelector<HTMLButtonElement>(".shortcut-keycap")!.click();
      await Promise.resolve();
    });
    await pressKey("F5", "F5");

    expect(page.textContent).toContain("该键已被「刷新资产」使用。");
    expect(
      renameRow
        .querySelector(".shortcut-capture-input")
        ?.classList.contains("is-conflict"),
    ).toBe(true);
    expect(
      [...page.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "替换" || button.textContent === "取消",
      ),
    ).toBe(false);
    expect(setMock).not.toHaveBeenCalled();

    await pressKey("F4", "F4");
    expect(page.textContent).not.toContain("该键已被「刷新资产」使用。");
    expect(
      renameRow
        .querySelector(".shortcut-capture-input")
        ?.classList.contains("is-conflict"),
    ).toBe(false);
    await pressKey("Enter", "Enter");
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]![0].bindings).toMatchObject({
      "asset.rename": { key: "F4", code: "F4" },
    });
  });

  it("does not offer replacement controls for a conflicting shortcut", async () => {
    const setMock = vi.fn(async (request: SetRequest) => ({
      ok: true,
      bindings: bindingsFor(request.bindings),
    }));
    const page = await renderPage(setMock);
    const renameRow = rowFor(page, "重命名资产");
    await act(async () => {
      renameRow.querySelector<HTMLButtonElement>(".shortcut-keycap")!.click();
      await Promise.resolve();
    });
    await pressKey("c", "KeyC");
    // The recorder ignores the missing modifier; press the real fixed chord.
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // The window-level recorder only sees window events; dispatch there.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "c",
          code: "KeyC",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });

    expect(page.textContent).toContain("该键已被「复制」使用。");
    expect(
      [...page.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "替换",
      ),
    ).toBe(false);
    expect(
      renameRow
        .querySelector(".shortcut-capture-input")
        ?.classList.contains("is-conflict"),
    ).toBe(true);
    expect(
      [...page.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "取消",
      ),
    ).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it("imports and exports shortcut settings through the file API", async () => {
    const setMock = vi.fn();
    const exportToFile = vi.fn(async () => ({ ok: true, path: "shortcuts.json" }));
    const importFromFile = vi.fn(async () => ({
      ok: true,
      bindings: bindingsFor({ "asset.rename": { key: "F3", code: "F3" } }),
    }));
    const page = await renderPage(setMock, { exportToFile, importFromFile });

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[aria-label="导入快捷键"]')!.click();
      await Promise.resolve();
    });
    expect(importFromFile).toHaveBeenCalledTimes(1);
    expect(rowFor(page, "重命名资产").querySelector(".shortcut-keycap")?.textContent)
      .toContain("F3");

    await act(async () => {
      page.querySelector<HTMLButtonElement>('[aria-label="导出快捷键"]')!.click();
      await Promise.resolve();
    });
    expect(exportToFile).toHaveBeenCalledTimes(1);
  });

  it("accepts a drafted chord with the check icon", async () => {
    const setMock = vi.fn(async (request: SetRequest) => ({
      ok: true,
      bindings: bindingsFor(request.bindings),
    }));
    const page = await renderPage(setMock);
    const row = rowFor(page, "重命名资产");
    await act(async () => {
      row.querySelector<HTMLButtonElement>(".shortcut-keycap")!.click();
      await Promise.resolve();
    });
    await pressKey("F3", "F3");
    const accept = row.querySelector<HTMLButtonElement>('[aria-label="确认"]');
    expect(accept).not.toBeNull();
    await act(async () => {
      accept!.click();
      await Promise.resolve();
    });
    expect(setMock).toHaveBeenCalledTimes(1);
  });

});
