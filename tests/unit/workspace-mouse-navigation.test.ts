// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  isEditableMouseNavTarget,
  isWorkspaceMouseSideButton,
  bindIframeWorkspaceMouseNav,
  resolveWorkspaceMouseNavAction,
  resolveWorkspaceMouseNavButton,
} from "../../src/renderer/workspace-mouse-navigation";

afterEach(() => {
  document.body.replaceChildren();
});

describe("resolveWorkspaceMouseNavButton", () => {
  it("maps Chromium side buttons to back and forward", () => {
    expect(resolveWorkspaceMouseNavButton(3)).toBe("back");
    expect(resolveWorkspaceMouseNavButton(4)).toBe("forward");
    expect(resolveWorkspaceMouseNavButton(0)).toBeNull();
    expect(resolveWorkspaceMouseNavButton(2)).toBeNull();
  });
});

describe("isWorkspaceMouseSideButton", () => {
  it("recognizes only the browser back and forward buttons", () => {
    expect(isWorkspaceMouseSideButton(3)).toBe(true);
    expect(isWorkspaceMouseSideButton(4)).toBe(true);
    expect(isWorkspaceMouseSideButton(0)).toBe(false);
    expect(isWorkspaceMouseSideButton(2)).toBe(false);
  });
});

describe("resolveWorkspaceMouseNavAction", () => {
  it("skips when a modal dialog is open", () => {
    expect(
      resolveWorkspaceMouseNavAction(
        { button: 3, target: null },
        { isModalOpen: true },
      ),
    ).toBeNull();
    expect(
      resolveWorkspaceMouseNavAction(
        { button: 4, target: null },
        { isModalOpen: true },
      ),
    ).toBeNull();
  });

  it("leaves modified side buttons to custom shortcut handlers", () => {
    expect(resolveWorkspaceMouseNavAction({
      button: 3,
      target: null,
      ctrlKey: true,
    })).toBeNull();
    expect(resolveWorkspaceMouseNavAction({
      button: 4,
      target: null,
      shiftKey: true,
    })).toBeNull();
    expect(resolveWorkspaceMouseNavAction({
      button: 3,
      target: null,
      metaKey: true,
    })).toBeNull();
    expect(resolveWorkspaceMouseNavAction({
      button: 4,
      target: null,
      altKey: true,
    })).toBeNull();
  });

  it("skips a search field outside the viewer", () => {
    const input = document.createElement("input");
    input.type = "search";
    document.body.append(input);
    expect(isEditableMouseNavTarget(input)).toBe(true);
    expect(resolveWorkspaceMouseNavAction({ button: 3, target: input })).toBeNull();
  });

  it("skips Inspector textareas outside the viewer", () => {
    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    expect(resolveWorkspaceMouseNavAction({ button: 3, target: textarea })).toBeNull();
  });

  it("still navigates from the text viewer textarea", () => {
    const root = document.createElement("div");
    root.className = "workspace-viewer";
    const textarea = document.createElement("textarea");
    root.append(textarea);
    document.body.append(root);
    expect(isEditableMouseNavTarget(textarea)).toBe(false);
    expect(resolveWorkspaceMouseNavAction({ button: 3, target: textarea })).toBe("back");
    expect(resolveWorkspaceMouseNavAction({ button: 4, target: textarea })).toBe(
      "forward",
    );
  });

  it("still navigates from viewer chrome range and select controls", () => {
    const root = document.createElement("div");
    root.className = "workspace-viewer";
    const range = document.createElement("input");
    range.type = "range";
    const select = document.createElement("select");
    root.append(range, select);
    document.body.append(root);
    expect(resolveWorkspaceMouseNavAction({ button: 3, target: range })).toBe("back");
    expect(resolveWorkspaceMouseNavAction({ button: 4, target: select })).toBe(
      "forward",
    );
  });

  it("does not treat a range slider outside the viewer as an editable field", () => {
    const range = document.createElement("input");
    range.type = "range";
    document.body.append(range);
    expect(isEditableMouseNavTarget(range)).toBe(false);
    expect(resolveWorkspaceMouseNavAction({ button: 3, target: range })).toBe("back");
  });
});

describe("bindIframeWorkspaceMouseNav", () => {
  it("forwards a modified side-button mousedown with modifiers and without workspace history", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const unbind = bindIframeWorkspaceMouseNav(iframe);
    const frameDocument = iframe.contentDocument!;
    const forwarded: MouseEvent[] = [];
    const forwardedPointers: PointerEvent[] = [];
    const onMouseDown = (event: Event) => {
      if (event.target === iframe) forwarded.push(event as MouseEvent);
    };
    const onPointerDown = (event: Event) => {
      forwardedPointers.push(event as PointerEvent);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("pointerdown", onPointerDown);
    const source = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      button: 3,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });

    frameDocument.body.dispatchEvent(source);

    expect(source.defaultPrevented).toBe(true);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      button: 3,
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(forwardedPointers).toHaveLength(0);
    expect(resolveWorkspaceMouseNavAction(forwarded[0]!)).toBeNull();

    window.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("pointerdown", onPointerDown);
    unbind();
    iframe.remove();
  });

  it("keeps unmodified iframe pointer side buttons on the workspace history route", () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const unbind = bindIframeWorkspaceMouseNav(iframe);
    const forwarded: PointerEvent[] = [];
    const onPointerDown = (event: Event) => forwarded.push(event as PointerEvent);
    window.addEventListener("pointerdown", onPointerDown);

    iframe.contentDocument!.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 3,
      }),
    );

    expect(forwarded).toHaveLength(1);
    expect(resolveWorkspaceMouseNavAction(forwarded[0]!)).toBe("back");
    window.removeEventListener("pointerdown", onPointerDown);
    unbind();
    iframe.remove();
  });
});
