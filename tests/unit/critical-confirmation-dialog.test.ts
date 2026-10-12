// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CriticalConfirmationDialog } from "../../src/renderer/CriticalConfirmationDialog";
import type { CriticalConfirmationPrompt } from "../../src/shared/critical-confirmation";
import { useDialogFocusTrap } from "../../src/renderer/use-dialog-focus-trap";

const request: CriticalConfirmationPrompt = {
  requestId: "11111111-1111-4111-8111-111111111111",
  title: "确认危险操作",
  heading: "从磁盘删除这个文件夹？",
  message: "选定文件夹及其中的托管资产将被永久删除。",
  detail: "此操作无法撤销，文件不会进入应用回收站。",
  cancelLabel: "取消",
  confirmLabel: "强制删除",
  initialFocus: "confirm",
};

function FocusTrapHarness({ children }: { children: ReactNode }) {
  useDialogFocusTrap(true);
  return children;
}

describe("CriticalConfirmationDialog", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
  });

  async function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
  }

  it("uses the app dialog shell and focuses force delete", async () => {
    await render(createElement(FocusTrapHarness, {
      children: createElement(CriticalConfirmationDialog, {
        request,
        onDecide: vi.fn(),
      }),
    }));
    const dialog = document.querySelector(".dialog-backdrop .ui-dialog-shell");
    expect(dialog).not.toBeNull();
    expect(dialog?.classList.contains("create-dialog")).toBe(true);
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "强制删除");
    expect(confirm?.classList.contains("ui-button--danger")).toBe(true);
    expect(confirm?.getAttribute("data-dialog-default-action")).toBe("true");
    expect(document.activeElement).toBe(confirm);
  });

  it("keeps cancel focused when the prompt says so", async () => {
    await render(createElement(FocusTrapHarness, {
      children: createElement(CriticalConfirmationDialog, {
        request: { ...request, initialFocus: "cancel", confirmLabel: "永久删除" },
        onDecide: vi.fn(),
      }),
    }));
    const cancel = [...document.querySelectorAll("button")].find((button) => button.textContent === "取消");
    expect(document.activeElement).toBe(cancel);
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "永久删除");
    expect(confirm?.getAttribute("data-dialog-default-action")).toBeNull();
  });
});
