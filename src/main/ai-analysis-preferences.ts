import {
  DEFAULT_AI_ANALYSIS_SETTINGS,
  normalizeAiAnalysisSettings,
  type AiAnalysisSettings,
} from "../shared/ai-analysis-settings";
import { normalizeAiAnalysisConcurrency } from "../shared/ai-concurrency";
import { normalizeAiAnalysisImageEdgePx } from "../shared/ai-analysis-image";
import {
  DEFAULT_AI_LANGUAGES,
  normalizeAiLanguages,
  type AiLanguageId,
} from "../shared/ai-endpoints";
import {
  normalizeAiReliabilitySettings,
  type AiReliabilitySettings,
} from "../shared/ai-reliability";

export type AiAnalysisPreferences = {
  descriptionEnabled: boolean;
  tagEnabled: boolean;
  ratingEnabled: boolean;
  analysisSettings: AiAnalysisSettings;
  concurrencyLimit: number;
  maxAnalysisImageEdgePx: number;
  reliabilitySettings: AiReliabilitySettings;
  languages: AiLanguageId[];
  autoAnalyzeEnabled: boolean;
  disclaimerAccepted: boolean;
};

export function normalizeAiAnalysisPreferences(input: unknown): AiAnalysisPreferences {
  const source = asRecord(input);
  const analysisSource = asRecord(source.analysisSettings);

  return {
    descriptionEnabled: booleanOr(source.descriptionEnabled, true),
    tagEnabled: booleanOr(source.tagEnabled, true),
    ratingEnabled: booleanOr(source.ratingEnabled, true),
    analysisSettings: normalizeAiAnalysisSettings({
      ...analysisSource,
      descriptionEnabled: booleanOr(
        analysisSource.descriptionEnabled,
        DEFAULT_AI_ANALYSIS_SETTINGS.descriptionEnabled,
      ),
      tagEnabled: booleanOr(
        analysisSource.tagEnabled,
        DEFAULT_AI_ANALYSIS_SETTINGS.tagEnabled,
      ),
      ratingEnabled: booleanOr(
        analysisSource.ratingEnabled,
        DEFAULT_AI_ANALYSIS_SETTINGS.ratingEnabled,
      ),
      forceExistingTags: booleanOr(
        analysisSource.forceExistingTags,
        DEFAULT_AI_ANALYSIS_SETTINGS.forceExistingTags,
      ),
    }),
    concurrencyLimit: normalizeAiAnalysisConcurrency(source.concurrencyLimit),
    maxAnalysisImageEdgePx: normalizeAiAnalysisImageEdgePx(source.maxAnalysisImageEdgePx),
    reliabilitySettings: normalizeAiReliabilitySettings(source.reliabilitySettings),
    languages: normalizeAiLanguages(
      source.languages ?? source.language ?? DEFAULT_AI_LANGUAGES,
    ),
    autoAnalyzeEnabled: booleanOr(source.autoAnalyzeEnabled, false),
    disclaimerAccepted: booleanOr(source.disclaimerAccepted, false),
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}


/** Durable new-format preferences must be structurally valid before legacy cleanup. */
export function parseAiAnalysisPreferences(input: unknown): AiAnalysisPreferences {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("AI analysis preferences have an invalid structure.");
  }
  return normalizeAiAnalysisPreferences(input);
}
