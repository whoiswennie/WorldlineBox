import type { EmbeddingModality } from './modalities';
import { embeddingProfileKey } from './profile';

/** Internal alias for the one application-owned embedding model; no user selection is required. */
export const GLOBAL_EMBEDDING_SELECTION_ID = 'global';
export const LOCAL_TEXT_EMBEDDING_MODEL_ID = 'embeddinggemma-2-compact';
export const LOCAL_TEXT_EMBEDDING_MODEL = Object.freeze({
  id: LOCAL_TEXT_EMBEDDING_MODEL_ID,
  name: 'EmbeddingGemma 2',
  upstream: 'google/embeddinggemma-2',
  repository: 'unsloth/embeddinggemma-2-GGUF',
  revision: '412430755667d84b1ac64fe1fe2693aa6219f1d9',
  fileName: 'embeddinggemma-2-UD-Q4_K_XL.gguf',
  sha256: 'ea905fd08e8061db77a0031cbb5096d459d7cfd2bdd0ad2ba66e483f16719493',
  bytes: 175_673_856,
  projectorFileName: 'mmproj-Q8_0.gguf',
  projectorSha256: '90e7b0238009e2954f856f2081dcf7f35af026b64c765e98f4777053e1754460',
  projectorBytes: 554_821_120,
  packageBytes: 730_494_976,
  dimension: 768,
  contextTokens: 8192,
  pooling: 'mean' as 'mean' | 'last',
  runtimeRelease: 'b11457',
  queryPrefix: 'task: search result | query: ',
  documentPrefix: 'title: none | text: ',
});

export type EmbeddingPurpose = 'query' | 'document';
export type GlobalEmbeddingProfile = {
  selectionId: string;
  /** Changes for model weights, dimensions or text preparation changes. */
  profileKey: string;
  modelName: string;
  dimension: number;
  source: 'local';
  modalities: EmbeddingModality[];
  queryPrefix: string;
  documentPrefix: string;
  contextTokens: number | null;
};

export type LocalTextEmbeddingInstallStatus = {
  modelId: typeof LOCAL_TEXT_EMBEDDING_MODEL_ID;
  phase: 'missing' | 'downloading' | 'verifying' | 'ready' | 'failed';
  installed: boolean;
  runtimeInstalled: boolean;
  revision: string;
  installedRevision: string | null;
  updateAvailable: boolean;
  bytesDownloaded: number;
  totalBytes: number;
  error: string | null;
};

export function localTextEmbeddingProfileKey(): string {
  return embeddingProfileKey('Q4_K_XL');
}

/** Prefixes are applied once by the host, never inferred from user supplied text. */
export function prepareGlobalEmbeddingText(
  profile: Pick<GlobalEmbeddingProfile, 'queryPrefix' | 'documentPrefix'>,
  text: string,
  purpose: EmbeddingPurpose,
): string {
  return `${purpose === 'query' ? profile.queryPrefix : profile.documentPrefix}${text}`;
}

export function isLocalTextEmbeddingModelId(value: string): value is typeof LOCAL_TEXT_EMBEDDING_MODEL_ID {
  return value === LOCAL_TEXT_EMBEDDING_MODEL_ID;
}
