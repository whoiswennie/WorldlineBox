/**
 * Custom embedding HTTP services.
 * `openai-embeddings-v1` posts to `/v1/embeddings` and may send `dimensions`.
 * `llamacpp-multimodal-v1` uses that endpoint with image content objects.
 * `dashscope-multimodal-v1` posts to DashScope's multimodal embedding API
 * (`parameters.dimension`). The adapter is chosen by the user, never inferred from the model id.
 * A saved address is not a verified model.
 */

import {
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
  normalizeSemanticImageBytes,
  normalizeSemanticImageEdgePx,
} from "./image-limits";
import { explicitEmbeddingModalities } from "./modalities";

export const EMBEDDING_HTTP_ADAPTERS = ["openai-embeddings-v1", "llamacpp-multimodal-v1", "dashscope-multimodal-v1"] as const;
export type EmbeddingHttpAdapter = (typeof EMBEDDING_HTTP_ADAPTERS)[number];
export const EMBEDDING_HTTP_ADAPTER = "openai-embeddings-v1";
export const DASHSCOPE_MULTIMODAL_PATH = "/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";

/** DashScope `parameters.instruct` for text→image library search (reduces text-doc dominance). */
export const DASHSCOPE_VISUAL_SEARCH_INSTRUCT =
  "Retrieve images relevant to the user's query. Prefer visual matches over plain text documents.";
export const EMBEDDING_DIMENSION_MAX = 8192;
export const EMBEDDING_SERVICE_DESTINATIONS = ["loopback", "lan", "internet"] as const;
export type EmbeddingServiceDestination = (typeof EMBEDDING_SERVICE_DESTINATIONS)[number];
export const EMBEDDING_TEXT_STATUSES = ["unsupported", "declared", "verified", "failed"] as const;
export type EmbeddingTextStatus = (typeof EMBEDDING_TEXT_STATUSES)[number];

/** Why the last probe failed. Cleared when verified or the endpoint changes. */
export const EMBEDDING_PROBE_FAILURES = ["network", "auth", "format", "dimensions", "https"] as const;
export type EmbeddingProbeFailure = (typeof EMBEDDING_PROBE_FAILURES)[number];

export function isEmbeddingProbeFailure(value: string): value is EmbeddingProbeFailure {
  return (EMBEDDING_PROBE_FAILURES as readonly string[]).includes(value);
}

export const EMBEDDING_SELECTION_ID = /^(?:embeddinggemma-2-(?:compact|balanced|quality)|svc_[a-z0-9]{8,40})$/;

export function isEmbeddingSelectionId(value: string): boolean {
  return EMBEDDING_SELECTION_ID.test(value);
}

export function isEmbeddingServiceSelectionId(value: string): boolean {
  return /^svc_[a-z0-9]{8,40}$/.test(value);
}

export type EmbeddingServiceIssue =
  | "name"
  | "model"
  | "url"
  | "loopback"
  | "lan"
  | "https"
  | "modalities"
  | "dimensions"
  | "imageEdge"
  | "imageBytes";

export function isEmbeddingHttpAdapter(value: string): value is EmbeddingHttpAdapter {
  return (EMBEDDING_HTTP_ADAPTERS as readonly string[]).includes(value);
}

/** Blank means the probe may read the returned length. A filled value must be a positive integer. */
export function parseEmbeddingDimensions(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > EMBEDDING_DIMENSION_MAX) return null;
  return value;
}

export type NormalizedEmbeddingServiceUrl = {
  baseUrl: string;
  protocol: "http:" | "https:";
  hostname: string;
  place: EmbeddingServiceDestination;
};

const NAME_MAX = 80;
const MODEL_MAX = 120;

export function normalizeEmbeddingServiceUrl(value: string): NormalizedEmbeddingServiceUrl | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  if (!hostname) return null;
  url.hash = "";
  url.search = "";
  url.hostname = hostname;
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    protocol: url.protocol,
    hostname,
    place: classifyEmbeddingHost(hostname),
  };
}

export function classifyEmbeddingHost(hostname: string): EmbeddingServiceDestination {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "loopback";
  if (host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return "lan";
  if (isPrivateIpv4(host)) return "lan";
  if (host.includes(":") && (host.startsWith("fe80") || host.startsWith("fc") || host.startsWith("fd"))) {
    return "lan";
  }
  return "internet";
}

export function validateEmbeddingServiceDraft(input: {
  name: string;
  modelName: string;
  /** Ignored for place checks — destination is derived from the URL. Kept optional for callers. */
  destination?: EmbeddingServiceDestination;
  baseUrl: string;
  modalities?: readonly string[];
  dimensions?: number | null;
  maxImageEdgePx?: number;
  maxImageBytes?: number;
}): EmbeddingServiceIssue | null {
  const name = input.name.trim();
  const modelName = input.modelName.trim();
  if (!name || name.length > NAME_MAX) return "name";
  if (!modelName || modelName.length > MODEL_MAX) return "model";
  const url = normalizeEmbeddingServiceUrl(input.baseUrl);
  if (!url) return "url";
  // Only the URL matters: classify place from the host, and require https for cloud hosts.
  if (url.place === "internet" && url.protocol !== "https:") return "https";
  if (input.modalities !== undefined && explicitEmbeddingModalities(input.modalities) === null) return "modalities";
  if (input.dimensions != null && parseEmbeddingDimensions(input.dimensions) === null) return "dimensions";
  if (input.maxImageEdgePx !== undefined && normalizeSemanticImageEdgePx(input.maxImageEdgePx) === null) {
    return "imageEdge";
  }
  if (input.maxImageBytes !== undefined && normalizeSemanticImageBytes(input.maxImageBytes) === null) {
    return "imageBytes";
  }
  return null;
}

/** llama-server uses `/v1/embeddings`. A base that already ends in `/v1` only adds `/embeddings`. */
export function embeddingHttpEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/embeddings` : `${path}/v1/embeddings`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function embeddingServiceEndpoint(adapter: EmbeddingHttpAdapter, baseUrl: string): string {
  if (adapter !== "dashscope-multimodal-v1") return embeddingHttpEndpoint(baseUrl);
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  if (!url.pathname.includes("multimodal-embedding")) url.pathname = DASHSCOPE_MULTIMODAL_PATH;
  return url.toString();
}

/** Independent asset inputs; each item produces one vector in the selected format. */
export type EmbeddingHttpContent =
  | { text: string }
  | { image: string }
  | { video: string };

function toDashScopeContents(inputs: readonly string[] | readonly EmbeddingHttpContent[]): EmbeddingHttpContent[] {
  return inputs.map((entry) => {
    if (typeof entry === "string") return { text: entry };
    return entry;
  });
}

function toOpenAiInputs(inputs: readonly string[] | readonly EmbeddingHttpContent[]): string[] {
  return inputs.map((entry) => {
    if (typeof entry === "string") return entry;
    if ("text" in entry) return entry.text;
    throw new Error("OpenAI embeddings accept text only.");
  });
}

function toLlamaCppInputs(inputs: readonly string[] | readonly EmbeddingHttpContent[]): unknown[] {
  return inputs.map((entry) => {
    if (typeof entry === "string") return entry;
    if ("text" in entry) return entry.text;
    if ("image" in entry) {
      return { content: [{ type: "image_url", image_url: { url: entry.image } }] };
    }
    // Video assets use the existing thumbnail path, rather than native video input.
    throw new Error("llama.cpp embeddings accept text and image inputs.");
  });
}

export function embeddingRequestBody(input: {
  adapter: EmbeddingHttpAdapter;
  modelName: string;
  inputs: readonly string[] | readonly EmbeddingHttpContent[];
  dimensions: number | null;
  /** DashScope only: task instruction for the query (not used when indexing corpus items). */
  instruct?: string | null;
}): Record<string, unknown> {
  if (input.adapter === "dashscope-multimodal-v1") {
    const body: Record<string, unknown> = {
      model: input.modelName,
      input: { contents: toDashScopeContents(input.inputs) },
    };
    const parameters: Record<string, unknown> = {};
    if (input.dimensions) parameters.dimension = input.dimensions;
    const instruct = input.instruct?.trim();
    if (instruct) parameters.instruct = instruct;
    if (Object.keys(parameters).length > 0) body.parameters = parameters;
    return body;
  }
  const body: Record<string, unknown> = {
    model: input.modelName,
    input: input.adapter === "llamacpp-multimodal-v1"
      ? toLlamaCppInputs(input.inputs)
      : toOpenAiInputs(input.inputs),
  };
  if (input.dimensions) body.dimensions = input.dimensions;
  return body;
}

export function embeddingHttpProfileKey(input: {
  adapter: EmbeddingHttpAdapter;
  baseUrl: string;
  modelName: string;
  dimensions: number;
  /** Included so a limit change rebuilds vectors in a separate profile. */
  maxImageEdgePx?: number;
  maxImageBytes?: number;
}): string {
  return [
    input.adapter,
    input.baseUrl,
    input.modelName.trim(),
    String(input.dimensions),
    String(input.maxImageEdgePx ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX),
    String(input.maxImageBytes ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES),
  ].join("\n");
}

export function readEmbeddingResponse(
  payload: unknown,
  expected: number,
  expectedDimensions: number | null,
  adapter: EmbeddingHttpAdapter,
): number[][] | null {
  return adapter === "dashscope-multimodal-v1"
    ? readDashScopeEmbeddings(payload, expected, expectedDimensions)
    : readEmbeddingHttpBatch(payload, expected, expectedDimensions);
}

export function readEmbeddingHttpBatch(
  payload: unknown,
  expected: number,
  expectedDimensions: number | null = null,
): number[][] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expected) return null;
  const rows: Array<number[] | undefined> = new Array(expected);
  for (const item of data) {
    if (!item || typeof item !== "object") return null;
    const row = item as { index?: unknown; embedding?: unknown };
    if (typeof row.index !== "number" || !Number.isInteger(row.index)) return null;
    if (row.index < 0 || row.index >= expected || rows[row.index]) return null;
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) return null;
    if (row.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
    let norm = 0;
    for (const value of row.embedding) norm += value * value;
    if (norm === 0) return null;
    rows[row.index] = row.embedding as number[];
  }
  if (rows.some((row) => !row)) return null;
  return acceptEmbeddingRows(rows as number[][], expectedDimensions);
}

function readDashScopeEmbeddings(
  payload: unknown,
  expected: number,
  expectedDimensions: number | null,
): number[][] | null {
  if (!payload || typeof payload !== "object") return null;
  const output = (payload as { output?: unknown }).output;
  if (!output || typeof output !== "object") return null;
  const embeddings = (output as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== expected) return null;
  const rows: Array<number[] | undefined> = new Array(expected);
  for (const [position, item] of embeddings.entries()) {
    if (!item || typeof item !== "object") return null;
    const record = item as { index?: unknown; embedding?: unknown };
    if (!Array.isArray(record.embedding) || record.embedding.length === 0) return null;
    if (record.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
    let norm = 0;
    for (const value of record.embedding) norm += value * value;
    if (norm === 0) return null;
    const index = typeof record.index === "number" ? record.index : position;
    if (!Number.isInteger(index) || index < 0 || index >= expected || rows[index]) return null;
    rows[index] = record.embedding as number[];
  }
  if (rows.some((row) => !row)) return null;
  return acceptEmbeddingRows(rows as number[][], expectedDimensions);
}

function acceptEmbeddingRows(rows: number[][], expectedDimensions: number | null): number[][] | null {
  const width = rows[0]?.length;
  if (!width || rows.some((row) => row.length !== width)) return null;
  if (expectedDimensions != null && width !== expectedDimensions) return null;
  return rows;
}

export function embeddingsDiffer(left: readonly number[], right: readonly number[]): boolean {
  if (left.length !== right.length) return true;
  return left.some((value, index) => Math.abs(value - (right[index] ?? 0)) > 1e-6);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = numbers;
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return true;
  if (first === 169 && second === 254) return true;
  return false;
}
