// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  isEditableMouseNavTarget,
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
