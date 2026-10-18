export function makePrivacySafeReport<T extends Record<string, unknown>>(
  report: T & { profiles: Array<Record<string, unknown> & { queries?: Array<Record<string, unknown>> }>; textQueries: unknown[] },
  imagePaths: string[],
  queryImagePath: string | null,
): T;
