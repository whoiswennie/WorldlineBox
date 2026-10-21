import { isEmbeddingServiceSelectionId } from "../shared/embedding/http-service";
import { isLocalTextEmbeddingModelId } from '../shared/embedding/global-profile';
import {
  isSemanticSearchModelId,
  SETTINGS_LOCAL_SEMANTIC_MODELS,
  type EmbeddingIndexPhase,
  type SemanticSearchModelId,
} from "../shared/embedding/profile";
import type { EmbeddingModality } from "../shared/embedding/modalities";

export type SemanticInstallModel = {
  modelId: SemanticSearchModelId;
  installed: boolean;
};

export type SemanticServiceReady = {
  modalities: readonly EmbeddingModality[];
  textStatus: string;
  dimensions: number | null;
};

/** Toolbar semantic search is available only for a ready library binding that can encode text. */
export function semanticToolbarReady(input: {
  selectionId: string | null;
  runtimeInstalled: boolean;
  models: readonly SemanticInstallModel[];
  service: SemanticServiceReady | null;
}): boolean {
  if (!input.selectionId) return false;
  if (isSemanticSearchModelId(input.selectionId)) {
    return input.runtimeInstalled
      && input.models.some((model) => model.modelId === input.selectionId && model.installed);
  }
  if ((!isEmbeddingServiceSelectionId(input.selectionId) && !isLocalTextEmbeddingModelId(input.selectionId)) || !input.service) return false;
  return input.service.textStatus === "verified"
    && input.service.dimensions != null
    && input.service.modalities.includes("text");
}

/** The jobs affordance stays quiet unless a download or an index is actually running. */
export function semanticBackgroundWorkActive(input: {
  installing: boolean;
  enabled: boolean;
  phase: EmbeddingIndexPhase | null;
}): boolean {
  if (input.installing) return true;
  if (!input.enabled) return false;
  return input.phase === "starting" || input.phase === "indexing";
}


/** Prefer the settings default when installed; otherwise the first ready local model. */
export function resolveLocalSimilarModelId(input: {
  runtimeInstalled: boolean;
  models: readonly SemanticInstallModel[];
  preferredModelId?: string | null;
}): SemanticSearchModelId | null {
  if (!input.runtimeInstalled) return null;
  const installed = new Set(
    input.models.filter((model) => model.installed).map((model) => model.modelId),
  );
  if (installed.size === 0) return null;
  if (
    input.preferredModelId
    && isSemanticSearchModelId(input.preferredModelId)
    && installed.has(input.preferredModelId)
  ) {
    return input.preferredModelId;
  }
  for (const modelId of SETTINGS_LOCAL_SEMANTIC_MODELS) {
    if (installed.has(modelId)) return modelId;
  }
  for (const model of input.models) {
    if (model.installed) return model.modelId;
  }
  return null;
}
