import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  EMBEDDING_GEMMA2_TIER_FILES,
  SEMANTIC_SEARCH_MODELS,
  type SemanticSearchModelId,
} from "../shared/embedding/profile";

export type LocalEmbeddingTestConfig = {
  modelDirectory: string;
  runtimePath: string;
  cpuRuntimePath?: string;
};

const FILE_NAME = "embedding-gemma.local.json";

/** Read the gitignored test config. This does not search the disk for weights. */
export function readLocalEmbeddingTestConfig(
  directories: readonly string[],
): LocalEmbeddingTestConfig | null {
  for (const directory of directories) {
    const filePath = path.join(directory, FILE_NAME);
    if (!existsSync(filePath)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.modelDirectory !== "string" || typeof record.runtimePath !== "string") return null;
    if (!record.modelDirectory.trim() || !record.runtimePath.trim()) return null;
    return {
      modelDirectory: record.modelDirectory,
      runtimePath: record.runtimePath,
    };
  }
  return null;
}

export function localEmbeddingFilesReady(
  config: LocalEmbeddingTestConfig,
  modelId: SemanticSearchModelId,
): boolean {
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
  if (!model) return false;
  const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
  return existsSync(path.join(config.modelDirectory, files.coreFile))
    && existsSync(path.join(config.modelDirectory, files.projectorFile))
    && existsSync(config.runtimePath);
}
