/**
 * What `library.open` must do to the libraries it is leaving behind.
 *
 * A switch through the recent-library list sends `library.open` for the
 * replacement WITHOUT a preceding `library.close` (`library.open-recent.request`
 * dispatches open directly). The outgoing library's automatic media work
 * therefore kept the single Worker thread busy and the open command starved
 * behind it: switching away from a busy network library never completed —
 * measured as ≥90 s with the loading overlay up and no Worker activity logged,
 * versus a completed switch once that work is stopped.
 *
 * Two rules, both easy to get wrong and both guarded by tests here:
 *
 * 1. **Every** currently open library is stopped, not just "the" current one —
 *    the Worker can hold more than one open handle.
 * 2. Queued jobs are **preserved** on a switch. Only scheduling is stopped. A
 *    switch is not a close: the library will be reopened, and cancelling its
 *    queued thumbnails just forces them to be re-enqueued (measured churn:
 *    `generate_thumbnail` cancelled 106 with attempt counts up to 4 while only
 *    26 succeeded). Closing and deleting do cancel, via
 *    `stopAutomaticWorkForLibrary`.
 */
export type LibraryWorkStopper = {
  /** Abort scheduled/running queue controllers, retries and dimension probes. */
  stopScheduling(libraryId: string): void;
  /**
   * Drop *queued viewport hints* (`asset.thumbnail.visible-window`) for the
   * library. Preserving queued jobs must not preserve these: a hint is an
   * idempotent report of what is on screen, the renderer re-reports it as soon
   * as the replacement library mounts, and a backlog of stale hints for the
   * library being left delays the replacement's first page instead. Measured:
   * a 12 s deep hint backlog queued ahead of the incoming `browse.session.open`.
   */
  dropQueuedViewportHints(libraryId: string): void;
  /** Cancel queued (not yet started) jobs for the library. */
  cancelQueuedJobs(libraryId: string): void;
  /** Abort AI analysis work for the library. */
  abortAiJobs(libraryId: string): void;
  /** Nudge the renderer's progress/task surfaces for the library. */
  publishAiProgress(libraryId: string): void;
};

export function stopOutgoingLibrariesForOpen(input: {
  openLibraryIds: readonly string[];
  stopper: LibraryWorkStopper;
  /**
   * Defaults to false: switching preserves the outgoing library's queued jobs.
   * Pass true only for a path that also destroys the library.
   */
  cancelQueuedJobs?: boolean;
}): string[] {
  const stopped: string[] = [];
  for (const libraryId of input.openLibraryIds) {
    input.stopper.stopScheduling(libraryId);
    input.stopper.dropQueuedViewportHints(libraryId);
    if (input.cancelQueuedJobs === true) input.stopper.cancelQueuedJobs(libraryId);
    input.stopper.abortAiJobs(libraryId);
    input.stopper.publishAiProgress(libraryId);
    stopped.push(libraryId);
  }
  return stopped;
}
