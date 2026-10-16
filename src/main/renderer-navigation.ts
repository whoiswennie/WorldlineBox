/** Permit a renderer retry of its exact current trusted document, never a new destination. */
export function isCurrentDocumentReload(currentUrl: string, targetUrl: string): boolean {
  if (!currentUrl || currentUrl !== targetUrl) return false;
  try { return ['file:', 'http:', 'https:'].includes(new URL(currentUrl).protocol); } catch { return false; }
}
