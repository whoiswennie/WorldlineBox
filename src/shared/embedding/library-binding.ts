import { isEmbeddingSelectionId, isEmbeddingServiceSelectionId } from "./http-service";
import { isSemanticSearchModelId, type SemanticSearchModelId } from "./profile";

export type EmbeddingLibraryBinding = {
  selectionId: string | null;
  enabled: boolean;
};

export type EmbeddingBindingIssue = "off" | "missing" | "install" | "configure" | "ready";

export type EmbeddingBindingService = {
  textStatus: string;
  dimensions: number | null;
};

export function emptyEmbeddingBindings(): Record<string, EmbeddingLibraryBinding> {
  return {};
}

export function parseEmbeddingBindings(input: unknown): Record<string, EmbeddingLibraryBinding> {
  if (!input || typeof input !== "object") return {};
  const bindings: Record<string, EmbeddingLibraryBinding> = {};
  for (const [libraryId, value] of Object.entries(input)) {
    if (!libraryId || libraryId.length > 255) continue;
    const binding = normalizeEmbeddingBinding(value);
    if (binding) bindings[libraryId] = binding;
  }
  return bindings;
}

export function normalizeEmbeddingBinding(value: unknown): EmbeddingLibraryBinding | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { selectionId?: unknown; enabled?: unknown };
  const selectionId = typeof record.selectionId === "string" && isEmbeddingSelectionId(record.selectionId)
    ? record.selectionId
    : null;
  return {
    selectionId,
    enabled: record.enabled === true && selectionId !== null,
  };
}

export function writeEmbeddingBinding(
  bindings: Record<string, EmbeddingLibraryBinding>,
  libraryId: string,
  selectionId: string | null,
): Record<string, EmbeddingLibraryBinding> {
  const next = { ...bindings };
  if (!libraryId || libraryId.length > 255) return bindings;
  if (!selectionId) {
    next[libraryId] = { selectionId: null, enabled: false };
    return next;
  }
  if (!isEmbeddingSelectionId(selectionId)) return bindings;
  next[libraryId] = { selectionId, enabled: true };
  return next;
}

export function embeddingBindingIssue(input: {
  binding: EmbeddingLibraryBinding | null;
  services: ReadonlyMap<string, EmbeddingBindingService>;
  runtimeInstalled: boolean;
  installedModelIds: ReadonlySet<SemanticSearchModelId>;
}): EmbeddingBindingIssue {
  const selectionId = input.binding?.enabled ? input.binding.selectionId : null;
  if (!selectionId) return "off";
  if (isSemanticSearchModelId(selectionId)) {
    return input.runtimeInstalled && input.installedModelIds.has(selectionId) ? "ready" : "install";
  }
  if (!isEmbeddingServiceSelectionId(selectionId)) return "missing";
  const service = input.services.get(selectionId);
  if (!service) return "missing";
  if (service.textStatus !== "verified" || service.dimensions == null) return "configure";
  return "ready";
}


export function clearEmbeddingBinding(
  bindings: Record<string, EmbeddingLibraryBinding>,
  libraryId: string,
): Record<string, EmbeddingLibraryBinding> {
  if (!libraryId || !(libraryId in bindings)) return bindings;
  const next = { ...bindings };
  delete next[libraryId];
  return next;
}

/**
 * Effective model for a library:
 * - global off → null
 * - library has an explicit selection → that id
 * - library explicitly off (binding present, enabled false) → null
 * - no library binding → Settings default model id
 */
export function resolveEffectiveEmbeddingSelection(input: {
  globalEnabled: boolean;
  defaultModelId: string;
  /** `undefined` means no per-library record (inherit default). */
  libraryBinding: EmbeddingLibraryBinding | undefined;
}): string | null {
  if (!input.globalEnabled) return null;
  if (input.libraryBinding === undefined) {
    return isEmbeddingSelectionId(input.defaultModelId) ? input.defaultModelId : null;
  }
  if (!input.libraryBinding.enabled || !input.libraryBinding.selectionId) return null;
  return input.libraryBinding.selectionId;
}
