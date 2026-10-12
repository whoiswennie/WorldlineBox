// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import { LocaleProvider } from "../../src/renderer/i18n";
import {
  resetTextViewerModeForTests,
  TextViewerControls,
} from "../../src/renderer/TextViewerControls";
import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";

const NOTES = [
  "# Creatures",
  "",
  "| Name | Score |",
  "| :--- | ---: |",
  "| hp | 12 |",
  "",
  "See [docs](https://example.test/docs).",
].join("\n");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  resetTextViewerModeForTests();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  resetTextViewerModeForTests();
});

function renderViewer(content: string): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const api = {
    readTextAsset: () => Promise.resolve({
      ok: true as const,
      value: {
        assetId: "asset",
        revisionId: "rev",
        content,
        truncated: false,
        byteSize: content.length,
        lineCount: content.split("\n").length,
        editable: true,
        mimeType: "text/markdown",
      },
    }),
  } as unknown as WorldlineBoxLibraryApi;
  act(() => {
    root?.render(createElement(LocaleProvider, {
      initialPreference: "zh-CN",
      children: createElement(TextViewerControls, {
        api,
        assetId: "asset",
        libraryId: "lib",
        markdown: true,
        onClose: () => undefined,
      }),
    }));
  });
}

async function flushLoad(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickLabel(label: string): void {
  const button = host?.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (button === null || button === undefined) throw new Error(`missing ${label}`);
  act(() => {
    button.click();
  });
}

test("markdown viewer opens on the formatted preview", async () => {
  renderViewer(NOTES);
  await flushLoad();
  expect(host?.querySelector("table")).not.toBeNull();
  expect(host?.querySelector(".preview-text-gutter")).toBeNull();
  expect(host?.querySelector("textarea")).toBeNull();
  expect(host?.textContent ?? "").not.toContain("| :--- |");
  expect(host?.querySelector('[aria-label="Markdown"]')?.getAttribute("aria-pressed")).toBe("true");
});

test("source wrap has no line numbers, and preview shows the edit", async () => {
  renderViewer(NOTES);
  await flushLoad();
  clickLabel("源码");
  const wrapped = host?.querySelector("textarea");
  expect(wrapped?.classList.contains("is-wrap")).toBe(true);
  expect(host?.querySelector(".preview-text-gutter")).toBeNull();

  clickLabel("自动换行");
  expect(host?.querySelector(".preview-text-gutter")?.textContent).toContain("1");
  expect(host?.querySelector("textarea.is-wrap")).toBeNull();

  const editor = host?.querySelector("textarea");
  if (!(editor instanceof HTMLTextAreaElement)) throw new Error("missing editor");
  act(() => {
    const next = editor.value.replace("| hp | 12 |", "| hp | 40 |");
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(editor, next);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    editor.dispatchEvent(new Event("change", { bubbles: true }));
  });
  clickLabel("Markdown");
  expect(host?.querySelector("table")?.textContent).toContain("40");
  expect(host?.querySelector(".preview-text-gutter")).toBeNull();
  expect(host?.querySelector("textarea")).toBeNull();
});
