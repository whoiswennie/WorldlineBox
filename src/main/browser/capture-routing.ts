/** Only renderer-owned libraries can promise focus and reveal after capture. */
export function captureLibraryWindowId(input: {
  libraryId: string;
  contexts: ReadonlyMap<number, { libraryId?: string | null }>;
  liveWindowIds: ReadonlySet<number>;
  focusedWindowId?: number | null;
  lastTargetWindowId?: number | null;
  mainWindowId?: number | null;
}): number | null {
  const candidates = [input.focusedWindowId, input.lastTargetWindowId, input.mainWindowId, ...input.contexts.keys()];
  for (const id of candidates) if (id != null && input.liveWindowIds.has(id) && input.contexts.get(id)?.libraryId === input.libraryId) return id;
  return null;
}
