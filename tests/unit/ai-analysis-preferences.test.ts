import { expect, test } from "vitest";

import { normalizeAiAnalysisPreferences, parseAiAnalysisPreferences } from "../../src/main/ai-analysis-preferences";

test("invalid persisted boolean strings fall back to safe defaults", () => {
  const result = normalizeAiAnalysisPreferences({
    descriptionEnabled: "false",
    tagEnabled: "false",
    ratingEnabled: "false",
    autoAnalyzeEnabled: "true",
    disclaimerAccepted: "true",
    analysisSettings: {
      descriptionEnabled: "false",
      tagEnabled: "false",
      ratingEnabled: "false",
      forceExistingTags: "true",
    },
  });

  expect(result).toMatchObject({
    descriptionEnabled: true,
    tagEnabled: true,
    ratingEnabled: true,
    autoAnalyzeEnabled: false,
    disclaimerAccepted: false,
    analysisSettings: {
      descriptionEnabled: true,
      tagEnabled: true,
      ratingEnabled: true,
      forceExistingTags: false,
    },
  });
});

test("valid booleans and supported analysis fields are preserved", () => {
  const result = normalizeAiAnalysisPreferences({
    descriptionEnabled: true,
    tagEnabled: false,
    ratingEnabled: true,
    autoAnalyzeEnabled: true,
    disclaimerAccepted: true,
    analysisSettings: {
      descriptionEnabled: false,
      tagEnabled: true,
      ratingEnabled: false,
      forceExistingTags: true,
      maxTags: 12,
      outputStyle: "concise",
      customTagPrompt: "Use short tags.",
      ignoredPrivateField: "must not be retained",
    },
    ignoredRootField: "must not be retained",
  });

  expect(result).toMatchObject({
    descriptionEnabled: true,
    tagEnabled: false,
    ratingEnabled: true,
    autoAnalyzeEnabled: true,
    disclaimerAccepted: true,
    analysisSettings: {
      descriptionEnabled: false,
      tagEnabled: true,
      ratingEnabled: false,
      forceExistingTags: true,
      maxTags: 12,
      outputStyle: "concise",
      customTagPrompt: "Use short tags.",
    },
  });
  expect(result).not.toHaveProperty("ignoredRootField");
  expect(result.analysisSettings).not.toHaveProperty("ignoredPrivateField");
});


test.each([null, [], "invalid", true, 12])("rejects invalid durable preference structure: %j", (input) => {
  expect(() => parseAiAnalysisPreferences(input)).toThrow("invalid structure");
});
