/** Bounded media-task list pages for WorldlineBox-e97c00. */
export const MEDIA_JOB_LIST_PAGE_SIZE = 100;
export const MEDIA_JOB_LIST_PAGE_MAX = 500;
/** Omitted `limit` keeps the historic first-page size so older callers still see a full window. */
export const MEDIA_JOB_LIST_DEFAULT_LIMIT = MEDIA_JOB_LIST_PAGE_MAX;

export type MediaJobListCursor = {
  createdAt: string;
  jobId: string;
};

export function clampMediaJobListLimit(limit: number | undefined): number {
  if (limit === undefined) return MEDIA_JOB_LIST_DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return MEDIA_JOB_LIST_PAGE_SIZE;
  return Math.min(MEDIA_JOB_LIST_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

export function sliceMediaJobListPage<T extends MediaJobListCursor>(
  rows: readonly T[],
  limit: number,
): { page: T[]; nextCursor: MediaJobListCursor | null; hasMore: boolean } {
  const pageSize = clampMediaJobListLimit(limit);
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : [...rows];
  const last = page.at(-1);
  return {
    page,
    hasMore,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, jobId: last.jobId } : null,
  };
}
