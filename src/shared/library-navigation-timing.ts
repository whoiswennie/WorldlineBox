/** Host diagnostics only: no paths, source IDs, payloads or scheduling policy. */
const commands = new Set([
  'library.open', 'library.list', 'library.navigation-summary',
  'browse.session.open', 'browse.session.page', 'browse.session.ids',
  'folder.list', 'folder.browse-entries', 'asset.search',
]);
export function isLibraryNavigationTimingCommand(type: unknown): type is string {
  return typeof type === 'string' && commands.has(type);
}
export function observeLibraryNavigationTiming(operation: () => void): void {
  try { operation(); } catch { /* Timing observation cannot change a request result. */ }
}
