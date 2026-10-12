import type { MediaJobStatus } from "../shared/library-api";

export type MediaJobSummaryCounts = Pick<
  MediaJobStatus,
  "queued" | "running" | "succeeded" | "failed" | "paused" | "cancelled"
>;

function countsFrom(status: MediaJobSummaryCounts): MediaJobSummaryCounts {
  return {
    queued: status.queued,
    running: status.running,
    succeeded: status.succeeded,
    failed: status.failed,
    paused: status.paused,
    cancelled: status.cancelled,
  };
}

/** Apply an O(1) summary snapshot without discarding an already loaded list page. */
export function applyMediaJobSummary(
  previous: MediaJobStatus | null,
  summary: MediaJobSummaryCounts,
): MediaJobStatus {
  return {
    ...countsFrom(summary),
    jobs: previous?.jobs ?? [],
    nextCursor: previous?.nextCursor ?? null,
    hasMore: previous?.hasMore === true,
  };
}

/** Replace the visible list with a freshly fetched first page. */
export function replaceMediaJobListPage(page: MediaJobStatus): MediaJobStatus {
  return {
    ...countsFrom(page),
    jobs: page.jobs,
    nextCursor: page.nextCursor ?? null,
    hasMore: page.hasMore === true,
  };
}

/** Append the next cursor page; later counts win, duplicate job IDs are skipped. */
export function appendMediaJobListPage(
  current: MediaJobStatus | null,
  page: MediaJobStatus,
): MediaJobStatus {
  const seen = new Set((current?.jobs ?? []).map((job) => job.jobId));
  return {
    ...countsFrom(page),
    jobs: [...(current?.jobs ?? []), ...page.jobs.filter((job) => !seen.has(job.jobId))],
    nextCursor: page.nextCursor ?? null,
    hasMore: page.hasMore === true,
  };
}
