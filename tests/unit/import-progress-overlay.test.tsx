// @vitest-environment happy-dom
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ImportProgressOverlay } from "../../src/renderer/ImportProgressOverlay";
import { LocaleProvider } from "../../src/renderer/i18n";

function overlay(): ReactElement {
  return createElement(LocaleProvider, {
    initialPreference: "zh-CN",
    children: createElement(ImportProgressOverlay, {
      transferKind: "import",
      transferName: "",
      onCancel: vi.fn(),
      onStop: vi.fn(),
      progress: {
        type: "import.progress",
        importId: "import-1",
        phase: "copy",
        cancelable: true,
        filesProcessed: 2,
        totalFiles: 8,
        bytesProcessed: 1024,
        totalBytes: 8192,
      },
    }),
  });
}

describe("ImportProgressOverlay", () => {
  it("covers the workspace with counted import progress and a cancel action", () => {
    const html = renderToStaticMarkup(overlay());
    expect(html).toContain('data-import-progress-overlay="true"');
    expect(html).toContain("dialog-backdrop");
    expect(html).toContain("blocking-progress-dialog");
    expect(html).toContain("正在导入");
    expect(html).toContain("2/8");
    expect(html).toContain("取消导入");
    expect(html).toContain("停止导入");
    expect(html).toContain("这次导入全部撤销");
    expect(html).toContain("已处理的文件留在资源库");
    expect(html).not.toContain("安全");
    expect(html).not.toContain("登记");
  });

  it("disables stop and cancel once an interrupt is already in flight", () => {
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, {
        initialPreference: "zh-CN",
        children: createElement(ImportProgressOverlay, {
          actionsDisabled: true,
          transferKind: "import",
          transferName: "",
          onCancel: vi.fn(),
          onStop: vi.fn(),
          progress: {
            type: "import.progress",
            importId: "import-1",
            phase: "copy",
            cancelable: true,
            filesProcessed: 2,
            totalFiles: 8,
            bytesProcessed: 1024,
            totalBytes: 8192,
          },
        }),
      }),
    );
    expect(html).toContain("停止导入");
    expect(html).toContain("取消导入");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("labels linked-folder indexing as processing, not copying", () => {
    const html = renderToStaticMarkup(
      createElement(LocaleProvider, {
        initialPreference: "zh-CN",
        children: createElement(ImportProgressOverlay, {
          transferKind: "import",
          transferName: "",
          onCancel: vi.fn(),
          onDismiss: vi.fn(),
          progress: {
            type: "import.progress",
            importId: "linked-1",
            phase: "copy",
            cancelable: false,
            copiesFiles: false,
            filesProcessed: 2,
            totalFiles: 8,
            bytesProcessed: 1024,
            totalBytes: 8192,
          },
        }),
      }),
    );
    expect(html).toContain("处理中");
    expect(html).not.toContain("复制中");
    expect(html).not.toContain("取消导入");
    expect(html).not.toContain("停止导入");
    expect(html).toContain("隐藏");
    expect(html).toContain("导入会在后台继续");
  });
});
