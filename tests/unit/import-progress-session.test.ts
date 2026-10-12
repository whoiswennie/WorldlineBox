import { describe, expect, it } from "vitest";

import {
  isBlockingImportOverlayVisible,
  runImportRpc,
  shouldApplyImportProgressEvent,
} from "../../src/renderer/import-progress-session";
import type { ImportProgressEvent } from "../../src/shared/protocol/responses";

function progress(
  patch: Partial<ImportProgressEvent> = {},
): ImportProgressEvent {
  return {
    type: "import.progress",
    importId: "import-1",
    phase: "copy",
    cancelable: true,
    filesProcessed: 3,
    totalFiles: 10,
    bytesProcessed: 1024,
    totalBytes: 4096,
    ...patch,
  };
}

describe("import overlay session", () => {
  it("does not reopen from a non-terminal event after the import RPC returns", () => {
    expect(
      shouldApplyImportProgressEvent(progress(), false, null, {
        rpcInFlight: false,
      }),
    ).toBe(false);
    expect(
      isBlockingImportOverlayVisible("ready", progress(), false, {
        rpcInFlight: false,
      }),
    ).toBe(false);
  });

  it("still applies a terminal event for an import that has not been retired", () => {
    expect(
      shouldApplyImportProgressEvent(
        progress({ phase: "complete" }),
        false,
        null,
        { rpcInFlight: false },
      ),
    ).toBe(true);
  });

  it("drops a retired import's late complete so it cannot clear a newer import", () => {
    expect(
      shouldApplyImportProgressEvent(
        progress({ phase: "complete" }),
        false,
        "import-1",
        {
          rpcInFlight: true,
          activeImportId: "import-2",
          current: progress({ importId: "import-2", sequence: 1 }),
        },
      ),
    ).toBe(false);
    expect(
      shouldApplyImportProgressEvent(
        progress({ importId: "import-2", sequence: 2 }),
        false,
        "import-1",
        {
          rpcInFlight: true,
          activeImportId: "import-2",
          current: progress({ importId: "import-2", sequence: 1 }),
        },
      ),
    ).toBe(true);
  });

  it("ignores events for a different importId than the in-flight session", () => {
    expect(
      shouldApplyImportProgressEvent(progress(), false, null, {
        rpcInFlight: true,
        activeImportId: "import-2",
      }),
    ).toBe(false);
  });

  it("treats a retiredImportIds set the same as a single dismissed id", () => {
    expect(
      shouldApplyImportProgressEvent(progress({ phase: "complete" }), false, null, {
        rpcInFlight: true,
        activeImportId: "import-2",
        retiredImportIds: new Set(["import-1"]),
      }),
    ).toBe(false);
  });

  it("ignores a stale sequence from the same importId", () => {
    expect(
      shouldApplyImportProgressEvent(progress({ sequence: 4 }), false, null, {
        rpcInFlight: true,
        current: progress({ sequence: 5, filesProcessed: 8 }),
      }),
    ).toBe(false);
    expect(
      shouldApplyImportProgressEvent(progress({ sequence: 6 }), false, null, {
        rpcInFlight: true,
        current: progress({ sequence: 5, filesProcessed: 8 }),
      }),
    ).toBe(true);
  });

  it("keeps a dismissed uncancelable overlay hidden while the RPC is still live", () => {
    expect(
      isBlockingImportOverlayVisible(
        "importing",
        progress({ cancelable: false }),
        false,
        { rpcInFlight: true, overlayDismissed: true },
      ),
    ).toBe(false);
  });

  it("still shows the library-open synthetic spinner without an import RPC", () => {
    expect(
      isBlockingImportOverlayVisible(
        "opening",
        progress({ importId: "", phase: "validate", totalFiles: 0 }),
        false,
        { rpcInFlight: false },
      ),
    ).toBe(true);
  });

  it("closes the RPC gate even when the worker command throws", async () => {
    let depth = 0;
    const gate = {
      begin: () => {
        depth += 1;
      },
      end: () => {
        depth = Math.max(0, depth - 1);
      },
    };
    await expect(
      runImportRpc(gate, async () => {
        expect(depth).toBe(1);
        throw new Error("import failed");
      }),
    ).rejects.toThrow("import failed");
    expect(depth).toBe(0);
  });
});
