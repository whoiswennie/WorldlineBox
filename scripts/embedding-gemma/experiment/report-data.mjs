import path from 'node:path';

function sanitizeReportText(value, sourceAliases) {
  let sanitized = value
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/gu, '[local path]')
    .replace(/\\\\[^\s"'<>]*/gu, '[local path]')
    .replace(/(^|[\s("'=,:])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/gu, '$1[local path]');
  for (const [filename, alias] of sourceAliases) sanitized = sanitized.split(filename).join(alias);
  return sanitized;
}

function sanitizeReportStrings(value, sourceAliases) {
  if (typeof value === 'string') return sanitizeReportText(value, sourceAliases);
  if (Array.isArray(value)) return value.map((item) => sanitizeReportStrings(item, sourceAliases));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeReportStrings(item, sourceAliases)]));
  }
  return value;
}

export function makePrivacySafeReport(report, imagePaths, queryImagePath) {
  const sampleIdByName = new Map(imagePaths.map((imagePath, index) => [
    path.basename(imagePath),
    `image-${String(index + 1).padStart(3, '0')}`,
  ]));
  const sourceAliases = new Map(sampleIdByName);
  if (queryImagePath) sourceAliases.set(path.basename(queryImagePath), 'query-image');
  const copy = structuredClone(report);
  const textQueryIds = new Map(report.textQueries.map((_, index) => [
    `text-${index + 1}`,
    `text-query-${String(index + 1).padStart(2, '0')}`,
  ]));
  copy.corpusFiles = imagePaths.map((imagePath, index) => `image-${String(index + 1).padStart(3, '0')}`);
  copy.queryImage = queryImagePath ? 'query-image' : null;
  for (const profile of copy.profiles) {
    profile.corpus = profile.corpus?.map((item) => ({ ...item, filename: sampleIdByName.get(item.filename) ?? 'unknown-image' }));
    profile.skippedImages = profile.skippedImages?.map((item) => ({ ...item, filename: sampleIdByName.get(item.filename) ?? 'unknown-image' }));
    profile.queries = profile.queries?.map((query) => ({
      ...query,
      text: undefined,
      queryId: query.type === 'text' ? textQueryIds.get(query.queryId) ?? 'text-query' : 'query-image',
      filename: query.type === 'image' ? 'query-image' : undefined,
      results: query.results?.map((result) => ({
        ...result,
        filename: sampleIdByName.get(result.filename) ?? 'unknown-image',
      })),
    }));
  }
  copy.textQueries = report.textQueries.map((_, index) => `text-query-${String(index + 1).padStart(2, '0')}`);
  return sanitizeReportStrings(copy, sourceAliases);
}
