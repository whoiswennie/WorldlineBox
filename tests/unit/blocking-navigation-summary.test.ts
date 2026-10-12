import { describe, expect, it } from "vitest";

import { missingNavigationSummaryIsFailure } from "../../src/renderer/blocking-navigation-summary";

describe("missingNavigationSummaryIsFailure", () => {
  it("fails a library-switch wait when the sidebar snapshot never arrived", () => {
    expect(missingNavigationSummaryIsFailure({
      refreshSidebar: true,
      navigationResult: undefined,
    })).toBe(true);
  });

  it("does not treat a skipped sidebar fetch as an asset-read failure", () => {
    expect(missingNavigationSummaryIsFailure({
      refreshSidebar: false,
      navigationResult: undefined,
    })).toBe(false);
  });

  it("does not fail when a snapshot is present", () => {
    expect(missingNavigationSummaryIsFailure({
      refreshSidebar: true,
      navigationResult: { ok: true },
    })).toBe(false);
  });
});
