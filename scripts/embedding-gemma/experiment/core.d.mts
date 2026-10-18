export interface EmbeddingGemmaProfile {
  id: string;
  label: string;
  coreFile: string;
  projectorFile: string;
}

export interface ExperimentModelFile {
  path: string;
  sizeBytes?: number;
  sha256?: string;
}

export interface ProfileModelFiles {
  core: ExperimentModelFile;
  projector: ExperimentModelFile;
}

export interface ExperimentRuntimeSession {
  startupMs?: number;
  metadata: {
    modelLoaded: boolean;
    imageCapability: string;
    runtimeCommit?: string | null;
  };
  embedText(text: string): Promise<number[]>;
  embedImage(imagePath: string): Promise<number[]>;
  embedImageDataUrl(dataUrl: string): Promise<number[]>;
  close(): Promise<void>;
}

export interface ExperimentQueryResult {
  type: 'text' | 'image';
  queryId?: string;
  text?: string;
  filename?: string;
  encodingMs: number;
  results: Array<{ filename: string; score: number }>;
}

export interface ProfileExperimentResult {
  id: string;
  label?: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  canary: { verified: boolean; [key: string]: unknown } | null;
  corpus: Array<{ filename: string; encodingMs: number }>;
  skippedImages: Array<{ filename: string; reason: string }>;
  queries: ExperimentQueryResult[];
  timingsMs: {
    startup: number | null;
    imageEncodingTotal: number;
    queryEncodingTotal: number;
    canary: number | null;
    total: number | null;
  };
  errors: string[];
  error?: { code: string; message: string };
}

export interface ExperimentRunReport {
  schemaVersion: number;
  runId: string;
  status: 'completed' | 'partial' | 'incomplete';
  profiles: ProfileExperimentResult[];
  textQueries: string[];
}

export interface ExperimentRunOptions {
  runId?: string;
  profiles?: readonly EmbeddingGemmaProfile[];
  profileFiles: Record<string, ProfileModelFiles>;
  imagePaths: string[];
  textQueries: Array<{ id?: string; text: string }>;
  queryImagePath?: string | null;
  topK?: number;
  createSession(profile: EmbeddingGemmaProfile, files: ProfileModelFiles): Promise<ExperimentRuntimeSession>;
  onProgress?: (event: Record<string, unknown>) => void;
}

export class ExperimentError extends Error {
  code: string;
}

export const EMBEDDING_DIMENSIONS: number;
export const MIN_CORPUS_IMAGES: number;
export const RECOMMENDED_CORPUS_IMAGES: number;
export const MAX_CORPUS_IMAGES: number;
export const SUPPORTED_IMAGE_EXTENSIONS: Set<string>;
export const TEXT_QUERY_PREFIX: string;
export const IMAGE_CANARY_TEXT: string;
export const MODEL_REVISION: string;
export const PROFILES: readonly EmbeddingGemmaProfile[];

export function discoverCorpusImages(directory: string): Promise<string[]>;
export function resolveProfileFiles(modelDirectory: string, profile: EmbeddingGemmaProfile): Promise<Record<string, ExperimentModelFile>>;
export function sha256File(filePath: string): Promise<string>;
export function normalizeEmbedding(vector: number[], label?: string): number[];
export function cosineSimilarity(left: number[], right: number[]): number;
export function rankTopK(queryEmbedding: number[], corpus: Array<{ filename: string; embedding: number[] }>, topK?: number): Array<{ filename: string; score: number }>;
export function makeVisualCanaryImages(): Record<'red' | 'blue' | 'checkerboard', string>;
export function safeErrorMessage(error: unknown): string;
export function runExperiment(options: ExperimentRunOptions): Promise<ExperimentRunReport>;
