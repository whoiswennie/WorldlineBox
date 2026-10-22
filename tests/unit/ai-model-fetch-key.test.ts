import { describe, expect, it } from "vitest";

import { buildAiModelsFetchKey } from "../../src/renderer/ai-model-fetch-key";

const baseInput = {
  profileId: "profile-a",
  apiFormat: "openai_chat" as const,
  baseUrl: " https://example.test/v1 ",
  apiKey: "",
  hasStoredKey: true,
};

describe("buildAiModelsFetchKey", () => {
  it("invalidates cached models when the selected profile changes", () => {
    expect(buildAiModelsFetchKey(baseInput)).not.toBe(
      buildAiModelsFetchKey({ ...baseInput, profileId: "profile-b" }),
    );
  });

  it("invalidates cached models when the draft credential changes", () => {
    expect(buildAiModelsFetchKey({ ...baseInput, apiKey: "first-key" })).not.toBe(
      buildAiModelsFetchKey({ ...baseInput, apiKey: "second-key" }),
    );
  });

  it("normalizes endpoint whitespace while distinguishing stored and typed keys", () => {
    expect(buildAiModelsFetchKey(baseInput)).toBe(
      buildAiModelsFetchKey({ ...baseInput, baseUrl: "https://example.test/v1" }),
    );
    expect(buildAiModelsFetchKey(baseInput)).not.toBe(
      buildAiModelsFetchKey({ ...baseInput, apiKey: "typed-key" }),
    );
  });
});
