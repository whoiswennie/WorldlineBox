import { expect, test } from "vitest";

import { isCurrentAiConnectionProbe } from "../../src/renderer/ai-connection-probe-guard";

test("a probe result applies only to the captured active profile and latest request", () => {
  expect(isCurrentAiConnectionProbe({
    capturedGeneration: 3,
    latestGeneration: 3,
    capturedProfileId: "ai_000000000000000000000001",
    activeProfileId: "ai_000000000000000000000001",
  })).toBe(true);

  expect(isCurrentAiConnectionProbe({
    capturedGeneration: 3,
    latestGeneration: 3,
    capturedProfileId: "ai_000000000000000000000001",
    activeProfileId: "ai_000000000000000000000002",
  })).toBe(false);

  expect(isCurrentAiConnectionProbe({
    capturedGeneration: 3,
    latestGeneration: 4,
    capturedProfileId: "ai_000000000000000000000001",
    activeProfileId: "ai_000000000000000000000001",
  })).toBe(false);
});
