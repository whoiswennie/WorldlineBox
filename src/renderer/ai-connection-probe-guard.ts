export function isCurrentAiConnectionProbe(input: {
  capturedGeneration: number;
  latestGeneration: number;
  capturedProfileId: string | null;
  activeProfileId: string | null;
}): boolean {
  return input.capturedGeneration === input.latestGeneration
    && input.capturedProfileId === input.activeProfileId;
}
