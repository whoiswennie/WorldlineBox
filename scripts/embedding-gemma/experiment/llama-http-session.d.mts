export function chooseLoopbackPort(): Promise<number>;
export type EmbeddingFetch = (input: string, init?: RequestInit) => Promise<Response>;
export interface EmbeddingRequestOptions {
  baseUrl: string;
  model: string;
  input: unknown;
  fetcher?: EmbeddingFetch;
  timeoutMs?: number;
}
export interface ImageEmbeddingRequestOptions {
  baseUrl: string;
  model: string;
  dataUrl: string;
  fetcher?: EmbeddingFetch;
  timeoutMs?: number;
}
export interface LlamaServerSessionOptions {
  executable: string;
  files: import('./core.mjs').ProfileModelFiles;
  gpuLayers?: number;
  runtimeCommit?: string | null;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  fetcher?: EmbeddingFetch;
}
export function postEmbedding(options: EmbeddingRequestOptions): Promise<number[]>;
export function postImageDataUrl(options: ImageEmbeddingRequestOptions): Promise<number[]>;
export function startLlamaServerSession(options: LlamaServerSessionOptions): Promise<{
  startupMs: number;
  metadata: Record<string, unknown>;
  embedText(text: string): Promise<number[]>;
  embedImage(imagePath: string): Promise<number[]>;
  embedImageDataUrl(dataUrl: string): Promise<number[]>;
  close(): Promise<void>;
  getDiagnostics(): string;
}>;
