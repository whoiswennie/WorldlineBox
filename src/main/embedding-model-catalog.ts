import {
  declaredChannelsForTier,
  embeddingProfileKey,
  isEmbeddingGemmaTier,
  type EmbeddingChannel,
  type EmbeddingGemmaTier,
  type EmbeddingModelSummary,
} from "../shared/embedding/profile";

export type EmbeddingModelRecord = {
  id: string;
  name: string;
  tier: EmbeddingGemmaTier;
  modelDirectory: string;
  runtimePath: string;
  /** Channels that passed a probe on this computer. Empty until probed. */
  verifiedChannels: EmbeddingChannel[];
};

export type EmbeddingModelCatalog = {
  version: 1;
  defaultModelId: string | null;
  models: EmbeddingModelRecord[];
};

const NAME_MAX = 80;
const PATH_MAX = 1024;

export function emptyEmbeddingModelCatalog(): EmbeddingModelCatalog {
  return { version: 1, defaultModelId: null, models: [] };
}

export function parseEmbeddingModelCatalog(input: unknown): EmbeddingModelCatalog {
  if (!input || typeof input !== "object") return emptyEmbeddingModelCatalog();
  const record = input as Partial<EmbeddingModelCatalog>;
  const models = Array.isArray(record.models)
    ? record.models.filter(isModelRecord)
    : [];
  const defaultModelId = typeof record.defaultModelId === "string"
    && models.some((model) => model.id === record.defaultModelId)
    ? record.defaultModelId
    : null;
  return { version: 1, defaultModelId, models };
}

export function summarizeEmbeddingModels(catalog: EmbeddingModelCatalog): EmbeddingModelSummary[] {
  return catalog.models.map((model) => ({
    id: model.id,
    name: model.name,
    tier: model.tier,
    profileKey: embeddingProfileKey(model.tier),
    modelDirectory: model.modelDirectory,
    runtimePath: model.runtimePath,
    declaredChannels: [...declaredChannelsForTier()],
    verifiedChannels: [...model.verifiedChannels],
    isDefault: catalog.defaultModelId === model.id,
  }));
}

export function upsertEmbeddingModel(
  catalog: EmbeddingModelCatalog,
  input: {
    id: string;
    name: string;
    tier: string;
    modelDirectory: string;
    runtimePath: string;
  },
): EmbeddingModelCatalog {
  const name = input.name.trim();
  const modelDirectory = input.modelDirectory.trim();
  const runtimePath = input.runtimePath.trim();
  if (!name || name.length > NAME_MAX) throw new EmbeddingModelCatalogError("invalid-name");
  if (!isEmbeddingGemmaTier(input.tier)) throw new EmbeddingModelCatalogError("invalid-tier");
  if (!modelDirectory || modelDirectory.length > PATH_MAX || !runtimePath || runtimePath.length > PATH_MAX) {
    throw new EmbeddingModelCatalogError("invalid-path");
  }
  const existing = catalog.models.find((model) => model.id === input.id);
  const next: EmbeddingModelRecord = {
    id: input.id,
    name,
    tier: input.tier,
    modelDirectory,
    runtimePath,
    verifiedChannels: existing && existing.tier === input.tier
      && existing.modelDirectory === modelDirectory
      && existing.runtimePath === runtimePath
      ? existing.verifiedChannels
      : [],
  };
  const models = existing
    ? catalog.models.map((model) => (model.id === input.id ? next : model))
    : [...catalog.models, next];
  return { ...catalog, models };
}

export function deleteEmbeddingModel(catalog: EmbeddingModelCatalog, id: string): EmbeddingModelCatalog {
  return {
    ...catalog,
    defaultModelId: catalog.defaultModelId === id ? null : catalog.defaultModelId,
    models: catalog.models.filter((model) => model.id !== id),
  };
}

export function setDefaultEmbeddingModel(catalog: EmbeddingModelCatalog, id: string): EmbeddingModelCatalog {
  if (!catalog.models.some((model) => model.id === id)) {
    throw new EmbeddingModelCatalogError("missing-model");
  }
  return { ...catalog, defaultModelId: id };
}

export class EmbeddingModelCatalogError extends Error {
  readonly code: "invalid-name" | "invalid-tier" | "invalid-path" | "missing-model";

  constructor(code: EmbeddingModelCatalogError["code"]) {
    super(code);
    this.name = "EmbeddingModelCatalogError";
    this.code = code;
  }
}

function isModelRecord(value: unknown): value is EmbeddingModelRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EmbeddingModelRecord>;
  return typeof record.id === "string"
    && record.id.length > 0
    && typeof record.name === "string"
    && typeof record.tier === "string"
    && isEmbeddingGemmaTier(record.tier)
    && typeof record.modelDirectory === "string"
    && typeof record.runtimePath === "string"
    && Array.isArray(record.verifiedChannels)
    && record.verifiedChannels.every((channel) => channel === "text" || channel === "image");
}
