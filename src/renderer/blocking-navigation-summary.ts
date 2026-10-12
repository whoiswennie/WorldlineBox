/**
 * `blockingLibraryLoad` waits for the library navigation snapshot only when
 * that request was actually started (`refreshSidebar`). Ordinary folder
 * switches skip the sidebar on purpose so the browse page stays first.
 * Treating a missing snapshot as a failed asset read made Ctrl+B from
 * All Assets surface "无法读取资产".
 */
export function missingNavigationSummaryIsFailure(input: {
  refreshSidebar: boolean;
  navigationResult: unknown;
}): boolean {
  return input.refreshSidebar && input.navigationResult == null;
}
