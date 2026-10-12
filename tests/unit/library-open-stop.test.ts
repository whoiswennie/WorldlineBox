import { describe, expect, it, vi } from "vitest";

import { stopOutgoingLibrariesForOpen } from "../../src/worker/library-open-stop";

/**
 * Guards the fix for "switching libraries hangs".
 *
 * A switch through the recent list sends `library.open` for the replacement with
 * no preceding `library.close`, so the outgoing library's media work must be
 * stopped by the open path itself. Measured before the fix: switching away from
 * a busy network library never completed (≥90 s, loading overlay stuck, no
 * Worker activity logged); after it: 14330 ms.
 *
 * These are the rules a future refactor is most likely to break.
 */
function stopperSpy() {
  return {
    stopScheduling: vi.fn(),
    dropQueuedViewportHints: vi.fn(),
    cancelQueuedJobs: vi.fn(),
    abortAiJobs: vi.fn(),
    publishAiProgress: vi.fn(),
  };
}

describe("opening a library stops the libraries it leaves behind", () => {
  it("stops scheduling for every open library, not just one", () => {
    const stopper = stopperSpy();
    const stopped = stopOutgoingLibrariesForOpen({
      openLibraryIds: ["library-a", "library-b"],
      stopper,
    });

    expect(stopped).toEqual(["library-a", "library-b"]);
    for (const libraryId of ["library-a", "library-b"]) {
      expect(stopper.stopScheduling).toHaveBeenCalledWith(libraryId);
      expect(stopper.abortAiJobs).toHaveBeenCalledWith(libraryId);
      expect(stopper.publishAiProgress).toHaveBeenCalledWith(libraryId);
    }
  });

  /**
   * Preserving the outgoing library's queued *jobs* must not preserve its
   * queued viewport hints. A hint is an idempotent "what is on screen" report
   * that the renderer re-sends as soon as the replacement mounts, and a deep
   * backlog of them queues ahead of the replacement's first page. Measured: a
   * 12 s deep hint backlog while the switch overlay was up.
   */
  it("drops the outgoing library's queued viewport hints", () => {
    const stopper = stopperSpy();
    stopOutgoingLibrariesForOpen({
      openLibraryIds: ["library-a"],
      stopper,
    });

    expect(stopper.dropQueuedViewportHints).toHaveBeenCalledWith("library-a");
  });

  /**
   * A switch is not a close. Cancelling queued work made the user's library churn
   * (`generate_thumbnail` cancelled 106 with attempt counts up to 4 while only 26
   * succeeded) and forced every queued job to be re-enqueued on the next open.
   */
  it("preserves the outgoing library's queued jobs on a switch", () => {
    const stopper = stopperSpy();
    stopOutgoingLibrariesForOpen({
      openLibraryIds: ["library-a"],
      stopper,
    });

    expect(stopper.stopScheduling).toHaveBeenCalledWith("library-a");
    expect(stopper.cancelQueuedJobs).not.toHaveBeenCalled();
  });

  it("still cancels queued jobs when the caller also destroys the library", () => {
    const stopper = stopperSpy();
    stopOutgoingLibrariesForOpen({
      openLibraryIds: ["library-a"],
      cancelQueuedJobs: true,
      stopper,
    });

    expect(stopper.cancelQueuedJobs).toHaveBeenCalledWith("library-a");
  });

  it("is a no-op on a first open, when nothing is open yet", () => {
    const stopper = stopperSpy();
    expect(stopOutgoingLibrariesForOpen({ openLibraryIds: [], stopper })).toEqual([]);
    expect(stopper.stopScheduling).not.toHaveBeenCalled();
    expect(stopper.dropQueuedViewportHints).not.toHaveBeenCalled();
    expect(stopper.cancelQueuedJobs).not.toHaveBeenCalled();
    expect(stopper.abortAiJobs).not.toHaveBeenCalled();
  });
});
