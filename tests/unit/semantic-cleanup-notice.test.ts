import { describe, expect, it } from "vitest";

import { appendSemanticCleanupNotice } from "../../src/renderer/semantic-cleanup-notice";

describe("semantic cleanup notice", () => {
  it("appends retry information only when sidecar cleanup is pending", () => {
    expect(appendSemanticCleanupNotice("Deleted 2 items.", true, " Cleanup will retry."))
      .toBe("Deleted 2 items. Cleanup will retry.");
    expect(appendSemanticCleanupNotice("Deleted 2 items.", false, " Cleanup will retry."))
      .toBe("Deleted 2 items.");
  });
});
