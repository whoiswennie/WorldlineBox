// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { LocaleProvider } from "../../src/renderer/i18n";
import {
  invalidateTextAssetPreviewCache,
  TextAssetPreviewTile,
} from "../../src/renderer/TextAssetPreviewTile";
import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", undefined);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  invalidateTextAssetPreviewCache("lib", "md");
  invalidateTextAssetPreviewCache("lib", "txt");
  vi.unstubAllGlobals();
});

function renderTile(fileName: string, assetId: string, content: string): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const api = {
    readTextAsset: () => Promise.resolve({
      ok: true as const,
      value: {
        assetId,
        revisionId: "rev",
        content,
        truncated: false,
        byteSize: content.length,
        lineCount: 1,
        editable: true,
        mimeType: "text/plain",
      },
    }),
  } as unknown as WorldlineBoxLibraryApi;
  act(() => {
    root?.render(createElement(LocaleProvider, {
      initialPreference: "zh-CN",
      children: createElement(TextAssetPreviewTile, {
        api,
        assetId,
        fileName,
        libraryId: "lib",
        revisionId: "rev",
      }),
    }));
  });
}

test("markdown card preview renders a table instead of the source", async () => {
  renderTile(
    "notes.md",
    "md",
    "# Title\n\n| Name | Score |\n| :--- | ---: |\n| hp | 12 |\n",
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host?.querySelector("table")).not.toBeNull();
  expect(host?.querySelector("pre")).toBeNull();
  expect(host?.textContent ?? "").not.toContain("| :--- |");
  expect(host?.querySelector("button")).toBeNull();
});

test("a card can render several markdown tables without building an unbounded table", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => `| item ${index} | ${index} | note |`).join("\n");
  renderTile(
    "notes.md",
    "md",
    ["# Creatures", "", "| Name | Score | Note |", "| :--- | ---: | :--- |", rows].join("\n"),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host?.querySelectorAll("table")).toHaveLength(1);
  expect(host?.querySelectorAll("tbody tr")).toHaveLength(12);
  expect(host?.querySelector("button")).toBeNull();
});

test("plain text card preview stays a pre of the source", async () => {
  renderTile("notes.txt", "txt", "# Title\n\n| Name | Score |\n");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host?.querySelector("table")).toBeNull();
  expect(host?.querySelector("pre")?.textContent).toContain("# Title");
});
