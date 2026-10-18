import { randomUUID } from "node:crypto";

import {
  embeddingHttpProfileKey,
  isEmbeddingHttpAdapter,
  isEmbeddingProbeFailure,
  normalizeEmbeddingServiceUrl,
  parseEmbeddingDimensions,
  validateEmbeddingServiceDraft,
  type EmbeddingHttpAdapter,
  type EmbeddingProbeFailure,
  type EmbeddingServiceDestination,
  type EmbeddingTextStatus,
} from "../shared/embedding/http-service";
import {
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
  normalizeSemanticImageBytes,
  normalizeSemanticImageEdgePx,
} from "../shared/embedding/image-limits";
import {
  explicitEmbeddingModalities,
  normalizeEmbeddingModalities,
  type EmbeddingModality,
} from "../shared/embedding/modalities";

export type EmbeddingServiceRecord = {
  id: string;
  name: string;
  description: string;
  adapter: EmbeddingHttpAdapter;
  destination: EmbeddingServiceDestination;
  baseUrl: string;
  modelName: string;
  textStatus: EmbeddingTextStatus;
  /** Set when textStatus is failed; cleared on verify or endpoint change. */
  probeFailure: EmbeddingProbeFailure | null;
  dimensions: number | null;
  grantedLibraryIds: string[];
  modalities: EmbeddingModality[];
  /** Longest edge, in pixels, for semantic images and video covers. */
  maxImageEdgePx: number;
  /** Max semantic image payload, in bytes, after downscale and recompress. */
  maxImageBytes: number;
};

export type EmbeddingServiceCatalog = {
  version: 1;
  services: EmbeddingServiceRecord[];
};

export type EmbeddingServiceSummary = EmbeddingServiceRecord & {
  hasCredential: boolean;
  profileKey: string | null;
};

export type EmbeddingServiceCredentialStore = {
  has(id: string): boolean;
  read(id: string): string | null;
  write(id: string, apiKey: string): void;
  delete(id: string): void;
};

const SERVICE_ID = /^svc_[a-z0-9]{8,40}$/;
const DESCRIPTION_MAX = 200;
const LIBRARY_LIMIT = 100;

export function emptyEmbeddingServiceCatalog(): EmbeddingServiceCatalog {
  return { version: 1, services: [] };
}

export function createEmbeddingServiceId(): string {
  return `svc_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function parseEmbeddingServiceCatalog(input: unknown): EmbeddingServiceCatalog {
  if (!input || typeof input !== "object") return emptyEmbeddingServiceCatalog();
  const services = (input as { services?: unknown }).services;
  if (!Array.isArray(services)) return emptyEmbeddingServiceCatalog();
  return {
    version: 1,
    services: services.filter(isServiceRecord).map(withServiceDefaults),
  };
}

export function summarizeEmbeddingServices(
  catalog: EmbeddingServiceCatalog,
  credentials: Pick<EmbeddingServiceCredentialStore, "has">,
): EmbeddingServiceSummary[] {
  return catalog.services.map((service) => ({
    ...service,
    grantedLibraryIds: [...service.grantedLibraryIds],
    hasCredential: credentials.has(service.id),
    profileKey: service.textStatus === "verified" && service.dimensions
      ? embeddingHttpProfileKey({
        adapter: service.adapter,
        baseUrl: service.baseUrl,
        modelName: service.modelName,
        dimensions: service.dimensions,
        maxImageEdgePx: service.maxImageEdgePx,
        maxImageBytes: service.maxImageBytes,
      })
      : null,
  }));
}

export function saveEmbeddingService(
  catalog: EmbeddingServiceCatalog,
  credentials: EmbeddingServiceCredentialStore,
  input: {
    id?: string;
    name: string;
    description?: string;
    adapter?: EmbeddingHttpAdapter;
    destination: EmbeddingServiceDestination;
    baseUrl: string;
    modelName: string;
    apiKey?: string;
    modalities?: readonly EmbeddingModality[];
    dimensions?: number | null;
    maxImageEdgePx?: number;
    maxImageBytes?: number;
  },
): EmbeddingServiceCatalog {
  const modalities = input.modalities === undefined
    ? ["text" as const]
    : explicitEmbeddingModalities(input.modalities);
  const dimensions = input.dimensions === undefined || input.dimensions === null
    ? input.dimensions ?? null
    : parseEmbeddingDimensions(input.dimensions);
  // Adapter comes from the user-chosen field only — never from model id heuristics.
  const adapter = input.adapter ?? "openai-embeddings-v1";
  const issue = validateEmbeddingServiceDraft({
    ...input,
    ...(modalities ? { modalities } : { modalities: [] }),
    dimensions: input.dimensions === undefined ? null : dimensions,
    ...(input.maxImageEdgePx !== undefined ? { maxImageEdgePx: input.maxImageEdgePx } : {}),
    ...(input.maxImageBytes !== undefined ? { maxImageBytes: input.maxImageBytes } : {}),
  });
  const url = normalizeEmbeddingServiceUrl(input.baseUrl);
  if (issue || !url || !modalities || !isEmbeddingHttpAdapter(adapter)) {
    throw new EmbeddingServiceRegistryError("invalid");
  }
  if (input.dimensions != null && dimensions === null) throw new EmbeddingServiceRegistryError("invalid");
  const id = input.id ?? createEmbeddingServiceId();
  if (!SERVICE_ID.test(id)) throw new EmbeddingServiceRegistryError("invalid");
  const existing = catalog.services.find((service) => service.id === id);
  const maxImageEdgePx = input.maxImageEdgePx === undefined
    ? (existing?.maxImageEdgePx ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX)
    : normalizeSemanticImageEdgePx(input.maxImageEdgePx);
  const maxImageBytes = input.maxImageBytes === undefined
    ? (existing?.maxImageBytes ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES)
    : normalizeSemanticImageBytes(input.maxImageBytes);
  if (maxImageEdgePx === null || maxImageBytes === null) throw new EmbeddingServiceRegistryError("invalid");
  const modelName = input.modelName.trim();
  const rawDescription = input.description === undefined
    ? (existing?.description ?? "")
    : input.description;
  const description = rawDescription.trim();
  if (description.length > DESCRIPTION_MAX) throw new EmbeddingServiceRegistryError("invalid");
  const destination = url.place;
  const sameEndpoint = Boolean(existing
    && existing.baseUrl === url.baseUrl
    && existing.modelName === modelName
    && existing.destination === destination
    && existing.adapter === adapter);
  const nextDimensions = input.dimensions === undefined
    ? (sameEndpoint && existing ? existing.dimensions : null)
    : dimensions;
  const sameTarget = sameEndpoint && existing?.dimensions === nextDimensions;
  const next: EmbeddingServiceRecord = {
    id,
    name: input.name.trim(),
    description,
    adapter,
    destination,
    baseUrl: url.baseUrl,
    modelName,
    textStatus: sameTarget && existing ? existing.textStatus : "declared",
    probeFailure: sameTarget && existing ? existing.probeFailure : null,
    dimensions: nextDimensions,
    grantedLibraryIds: sameTarget && existing ? [...existing.grantedLibraryIds] : [],
    modalities,
    maxImageEdgePx,
    maxImageBytes,
  };
  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    if (key) credentials.write(id, key);
    else credentials.delete(id);
  }
  const services = existing
    ? catalog.services.map((service) => (service.id === id ? next : service))
    : [...catalog.services, next];
  return { version: 1, services };
}

export function deleteEmbeddingService(
  catalog: EmbeddingServiceCatalog,
  credentials: EmbeddingServiceCredentialStore,
  id: string,
): EmbeddingServiceCatalog {
  credentials.delete(id);
  return { version: 1, services: catalog.services.filter((service) => service.id !== id) };
}

export function grantEmbeddingService(
  catalog: EmbeddingServiceCatalog,
  id: string,
  libraryId: string,
): EmbeddingServiceCatalog {
  if (!libraryId || libraryId.length > 255) throw new EmbeddingServiceRegistryError("invalid");
  const existing = catalog.services.find((service) => service.id === id);
  if (!existing) throw new EmbeddingServiceRegistryError("missing");
  if (existing.grantedLibraryIds.includes(libraryId)) return catalog;
  if (existing.grantedLibraryIds.length >= LIBRARY_LIMIT) throw new EmbeddingServiceRegistryError("invalid");
  return {
    version: 1,
    services: catalog.services.map((service) => (
      service.id === id
        ? { ...service, grantedLibraryIds: [...service.grantedLibraryIds, libraryId] }
        : service
    )),
  };
}

export function markEmbeddingServiceProbe(
  catalog: EmbeddingServiceCatalog,
  id: string,
  result:
    | { ok: true; dimensions: number }
    | { ok: false; failure: EmbeddingProbeFailure },
): EmbeddingServiceCatalog {
  return {
    version: 1,
    services: catalog.services.map((service) => {
      if (service.id !== id) return service;
      if (!result.ok) {
        return { ...service, textStatus: "failed", probeFailure: result.failure };
      }
      if (service.dimensions != null && service.dimensions !== result.dimensions) {
        return { ...service, textStatus: "failed", probeFailure: "dimensions" };
      }
      return {
        ...service,
        textStatus: "verified",
        probeFailure: null,
        dimensions: result.dimensions,
      };
    }),
  };
}

export class EmbeddingServiceRegistryError extends Error {
  readonly code: "invalid" | "missing";

  constructor(code: EmbeddingServiceRegistryError["code"]) {
    super(code);
    this.name = "EmbeddingServiceRegistryError";
    this.code = code;
  }
}

function isServiceRecord(value: unknown): value is EmbeddingServiceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EmbeddingServiceRecord>;
  return typeof record.id === "string"
    && SERVICE_ID.test(record.id)
    && typeof record.name === "string"
    && (record.destination === "loopback" || record.destination === "lan" || record.destination === "internet")
    && typeof record.baseUrl === "string"
    && typeof record.modelName === "string"
    && (record.textStatus === "unsupported" || record.textStatus === "declared" || record.textStatus === "verified" || record.textStatus === "failed")
    && (record.dimensions === null || (typeof record.dimensions === "number" && Number.isInteger(record.dimensions) && record.dimensions > 0))
    && Array.isArray(record.grantedLibraryIds)
    && record.grantedLibraryIds.every((id) => typeof id === "string");
}

function withServiceDefaults(record: EmbeddingServiceRecord): EmbeddingServiceRecord {
  const adapter = isEmbeddingHttpAdapter(String(record.adapter ?? ""))
    ? record.adapter
    : "openai-embeddings-v1";
  const description = typeof (record as { description?: unknown }).description === "string"
    ? (record as { description: string }).description.trim().slice(0, DESCRIPTION_MAX)
    : "";
  const rawFailure = (record as { probeFailure?: unknown }).probeFailure;
  const probeFailure = typeof rawFailure === "string" && isEmbeddingProbeFailure(rawFailure)
    ? rawFailure
    : null;
  return {
    ...record,
    description,
    adapter,
    probeFailure: record.textStatus === "failed" ? probeFailure : null,
    modalities: normalizeEmbeddingModalities(record.modalities),
    maxImageEdgePx: normalizeSemanticImageEdgePx((record as { maxImageEdgePx?: unknown }).maxImageEdgePx)
      ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
    maxImageBytes: normalizeSemanticImageBytes((record as { maxImageBytes?: unknown }).maxImageBytes)
      ?? CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  };
}
