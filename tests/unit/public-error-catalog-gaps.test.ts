import { describe, expect, it } from "vitest";

import { LibraryTransitionInProgressError } from "../../src/renderer/library-transition-lock";
import {
  messageForPublicError,
  toMessage,
} from "../../src/renderer/error-utils";
import type { PublicErrorCode } from "../../src/shared/protocol/errors";

const CODES = [
  "FOLDER_NOT_EMPTY",
  "AUTOMATION_UNDO_GROUP_NOT_FOUND",
  "AUTOMATION_UNDO_NOT_AVAILABLE",
  "AUTOMATION_UNDO_STALE",
  "PLUGIN_HOOK_BLOCKED",
  "HISTORY_TOO_LARGE",
  "SYNC_IN_PROGRESS",
] as const satisfies readonly PublicErrorCode[];

describe("public error catalog gaps", () => {
  it("maps the previously missing codes in both locales", () => {
    for (const code of CODES) {
      for (const locale of ["zh-CN", "en"] as const) {
        const text = messageForPublicError({ code, message: "raw" }, locale);
        expect(text).not.toBe("raw");
        expect(text).not.toBe(code);
      }
    }
  });

  it("does not describe a name conflict as a restore failure", () => {
    const text = messageForPublicError(
      { code: "FOLDER_ALREADY_EXISTS", message: "raw" },
      "zh-CN",
    );
    expect(text).not.toContain("恢复");
  });

  it("localizes a library transition rejection", () => {
    const text = toMessage(new LibraryTransitionInProgressError(), "fallback", "zh-CN");
    expect(text).not.toContain("already in progress");
    expect(text).not.toBe("fallback");
  });
});
