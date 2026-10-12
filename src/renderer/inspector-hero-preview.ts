export function inspectorHeroPreviewKind(input: {
  selectionCount: number;
  sequenceFrameCount: number | null | undefined;
}): "multi-stack" | "sequence-playback" | "single" {
  if (input.selectionCount >= 2) return "multi-stack";
  if ((input.sequenceFrameCount ?? 0) >= 2) return "sequence-playback";
  return "single";
}
