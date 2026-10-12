// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FatalAlertDialog } from "../../src/renderer/FatalAlertDialog";
import { LocaleProvider } from "../../src/renderer/i18n";
import { useDialogFocusTrap } from "../../src/renderer/use-dialog-focus-trap";

function FocusTrapHarness({ children }: { children: ReactNode }) {
  useDialogFocusTrap(true);
  return children;
}

describe("FatalAlertDialog library recovery action", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    root?.unmount();
    root = undefined;
    container?.remove();
    container = undefined;
  });

  it("offers a direct switch-library action after a failed operation", async () => {
    const onSwitchLibrary = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          { children: null, initialPreference: "zh-CN" },
          createElement(FatalAlertDialog, {
            message: "无法打开资源库",
            onDismiss: vi.fn(),
            onSwitchLibrary,
          }),
        ),
      );
    });

    const switchButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "切换资源库",
    );
    expect(switchButton).toBeDefined();
    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSwitchLibrary).toHaveBeenCalledTimes(1);
  });

  it("uses cancel and confirm for an already-open library prompt", async () => {
    const onDismiss = vi.fn();
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const onSwitchLibrary = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          { children: null, initialPreference: "zh-CN" },
          createElement(FatalAlertDialog, {
            cancelLabel: "取消",
            confirmLabel: "确认",
            message: "所选资源库和当前打开资源库有相同的资源库ID，可能是同一资源库的不同路径。是否视为不同资源库进行打开。",
            title: "资源库已打开",
            onCancel,
            onConfirm,
            onDismiss,
            onSwitchLibrary,
          }),
        ),
      );
    });

    const labels = [...container.querySelectorAll("button")].map(
      (button) => button.textContent?.trim(),
    );
    expect(labels).toContain("取消");
    expect(labels).toContain("确认");
    expect(labels).not.toContain("切换资源库");
    expect(labels).not.toContain("知道了");

    const cancelButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "取消",
    );
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onSwitchLibrary).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    const confirmButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "确认",
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onSwitchLibrary).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    const closeButton = container.querySelector(".dialog-close");
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("marks the blocking alert as a modal that the global focus trap can own", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          { children: null, initialPreference: "zh-CN" },
          createElement(FatalAlertDialog, {
            message: "无法打开资源库",
            onDismiss: vi.fn(),
          }),
        ),
      );
    });

    const alert = container.querySelector('[role="alertdialog"]');
    expect(alert).toBeTruthy();
    expect(alert?.getAttribute("aria-modal")).toBe("true");
  });

  it("keeps Tab focus inside the blocking alert", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(
          LocaleProvider,
          { children: null, initialPreference: "zh-CN" },
          createElement(
            FocusTrapHarness,
            null,
            createElement(FatalAlertDialog, {
              message: "无法打开资源库",
              onDismiss: vi.fn(),
              onSwitchLibrary: vi.fn(),
            }),
          ),
        ),
      );
    });

    const alert = container.querySelector('[role="alertdialog"]');
    const focusable = [
      ...alert!.querySelectorAll<HTMLElement>("button:not(:disabled)"),
    ];
    expect(focusable.length).toBeGreaterThan(1);
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(first);
  });
});
