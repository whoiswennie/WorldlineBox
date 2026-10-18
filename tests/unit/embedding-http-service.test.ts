import { describe, expect, it, vi } from "vitest";

import {
  DASHSCOPE_VISUAL_SEARCH_INSTRUCT,
  embeddingRequestBody,
  embeddingServiceEndpoint,
  embeddingsDiffer,
  embeddingHttpEndpoint,
  readEmbeddingHttpBatch,
  readEmbeddingResponse,
  embeddingHttpProfileKey,
  validateEmbeddingServiceDraft,
} from "../../src/shared/embedding/http-service";
import {
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
  CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
} from "../../src/shared/embedding/image-limits";
import {
  markEmbeddingServiceProbe,
  parseEmbeddingServiceCatalog,
  saveEmbeddingService,
  summarizeEmbeddingServices,
  EmbeddingServiceRegistryError,
  type EmbeddingServiceCredentialStore,
} from "../../src/main/embedding-service-registry";
import { loadSemanticSearchPreferences } from "../../src/renderer/semantic-search-preferences";
import { postEmbeddingHttp } from "../../src/main/embedding-http";
import { parseRendererRequest } from "../../src/shared/protocol/requests";
import { parseRendererResult } from "../../src/shared/protocol/responses";

function memoryCredentials(): EmbeddingServiceCredentialStore & { keys: Map<string, string> } {
  const keys = new Map<string, string>();
  return {
    keys,
    has: (id) => keys.has(id),
    read: (id) => keys.get(id) ?? null,
    write: (id, apiKey) => { keys.set(id, apiKey); },
    delete: (id) => { keys.delete(id); },
  };
}

describe("embedding http services", () => {
  it("uses llama.cpp content objects for separate image assets and plain strings for text", () => {
    expect(embeddingServiceEndpoint("llamacpp-multimodal-v1", "http://127.0.0.1:8080/v1"))
      .toBe("http://127.0.0.1:8080/v1/embeddings");
    expect(embeddingRequestBody({
      adapter: "llamacpp-multimodal-v1",
      modelName: "synthetic-vision-model",
      inputs: [{ image: "data:image/png;base64,aaa" }, { image: "data:image/png;base64,bbb" }, { text: "a bicycle" }],
      dimensions: null,
    })).toEqual({
      model: "synthetic-vision-model",
      input: [
        { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aaa" } }] },
        { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,bbb" } }] },
        "a bicycle",
      ],
    });
    expect(embeddingRequestBody({
      adapter: "llamacpp-multimodal-v1", modelName: "synthetic-model", inputs: ["query"], dimensions: 1024,
    })).toEqual({ model: "synthetic-model", input: ["query"], dimensions: 1024 });
  });

  it("rejects mismatched response formats instead of detecting a different adapter", async () => {
    const openai = { data: [{ index: 0, embedding: [1, 0] }] };
    const dashscope = { output: { embeddings: [{ index: 0, embedding: [1, 0] }] } };
    expect(readEmbeddingResponse(openai, 1, 2, "dashscope-multimodal-v1")).toBeNull();
    for (const adapter of ["openai-embeddings-v1", "llamacpp-multimodal-v1"] as const) {
      expect(readEmbeddingResponse(dashscope, 1, 2, adapter)).toBeNull();
      expect(readEmbeddingResponse(openai, 1, 2, adapter)).toEqual([[1, 0]]);
    }
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(dashscope));
    await expect(postEmbeddingHttp({
      adapter: "llamacpp-multimodal-v1", baseUrl: "http://127.0.0.1:8080", modelName: "synthetic-model",
      inputs: ["query"], apiKey: null, fetchImpl,
    })).rejects.toMatchObject({ kind: "format" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("posts llama.cpp images through the shared transport and restores input order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }));
    const result = await postEmbeddingHttp({
      adapter: "llamacpp-multimodal-v1", baseUrl: "http://127.0.0.1:8080/v1", modelName: "synthetic-model",
      inputs: [{ image: "data:image/png;base64,aaa" }, { image: "data:image/png;base64,bbb" }],
      apiKey: null, dimensions: 2, fetchImpl,
    });
    expect(result).toEqual([[1, 0], [0, 1]]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:8080/v1/embeddings");
    const options = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(options.body as string)).toMatchObject({ input: [
      { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aaa" } }] },
      { content: [{ type: "image_url", image_url: { url: "data:image/png;base64,bbb" } }] },
    ] });
    expect(options.redirect).toBe("error");
    expect(options.headers).not.toHaveProperty("authorization");
  });

  it("rejects unsupported media before sending a request", async () => {
    const fetchImpl = vi.fn();
    for (const adapter of ["openai-embeddings-v1", "llamacpp-multimodal-v1"] as const) {
      await expect(postEmbeddingHttp({
        adapter, baseUrl: "http://127.0.0.1:8080", modelName: "synthetic-model",
        inputs: [{ video: "https://example.com/fixture.mp4" }], apiKey: null, fetchImpl,
      })).rejects.toMatchObject({ kind: "format" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists the explicit llama.cpp format through the bridge and clears the previous profile on format changes", () => {
    const credentials = memoryCredentials();
    const input = {
      name: "Synthetic service", baseUrl: "http://127.0.0.1:8080", modelName: "synthetic-model",
      destination: "loopback" as const, modalities: ["text", "image"] as const,
    };
    const saved = saveEmbeddingService({ version: 1, services: [] }, credentials, { ...input, modalities: [...input.modalities] });
    const id = saved.services[0]!.id;
    const verified = markEmbeddingServiceProbe(saved, id, { ok: true, dimensions: 2 });
    const request = { type: "embedding.services.save.request", ...input, id, adapter: "llamacpp-multimodal-v1" as const, modalities: [...input.modalities] };
    expect(parseRendererRequest(request)).toMatchObject({ adapter: "llamacpp-multimodal-v1" });
    const changed = saveEmbeddingService(verified, credentials, request);
    const restored = parseEmbeddingServiceCatalog(changed);
    expect(restored.services[0]).toMatchObject({ adapter: "llamacpp-multimodal-v1", textStatus: "declared", dimensions: null });
    const services = summarizeEmbeddingServices(restored, credentials);
    expect(parseRendererResult({ ok: true, type: "embedding.services.listed", services }))
      .toMatchObject({ services: [{ adapter: "llamacpp-multimodal-v1" }] });
    expect(() => parseRendererRequest({ ...request, adapter: "guess-from-model" })).toThrow();
  });

  it("validates by URL only and requires https for cloud hosts", () => {
    expect(validateEmbeddingServiceDraft({
      name: "Local",
      modelName: "bge",
      baseUrl: "http://127.0.0.1:8080",
    })).toBeNull();
    // Destination picker is gone — a LAN URL is fine without a place selector.
    expect(validateEmbeddingServiceDraft({
      name: "Lan",
      modelName: "bge",
      baseUrl: "http://192.168.1.8:8080",
    })).toBeNull();
    expect(validateEmbeddingServiceDraft({
      name: "Cloud",
      modelName: "text-embedding-3-small",
      baseUrl: "http://example.com/v1",
    })).toBe("https");
    expect(validateEmbeddingServiceDraft({
      name: "Cloud",
      modelName: "text-embedding-3-small",
      baseUrl: "https://user:secret@example.com/v1",
    })).toBe("url");
  });

  it("builds the embeddings endpoint and maps vectors by index", () => {
    expect(embeddingHttpEndpoint("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080/v1/embeddings");
    expect(embeddingHttpEndpoint("https://example.com/v1")).toBe("https://example.com/v1/embeddings");
    const batch = readEmbeddingHttpBatch({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    }, 2);
    expect(batch?.[0]).toEqual([1, 0]);
    expect(batch?.[1]).toEqual([0, 1]);
    expect(readEmbeddingHttpBatch({ data: [{ index: 0, embedding: [Number.NaN] }] }, 1)).toBeNull();
    expect(embeddingsDiffer([1, 0], [0, 1])).toBe(true);
  });

  it("keeps the api key out of the saved catalog", () => {
    const credentials = memoryCredentials();
    const catalog = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Cloud",
      destination: "internet",
      baseUrl: "https://example.com/v1",
      modelName: "text-embedding-3-small",
      apiKey: "secret-key",
    });
    expect(JSON.stringify(catalog)).not.toContain("secret-key");
    expect(credentials.keys.values().next().value).toBe("secret-key");
    const [summary] = summarizeEmbeddingServices(parseEmbeddingServiceCatalog(catalog), credentials);
    expect(summary?.hasCredential).toBe(true);
    expect(summary?.textStatus).toBe("declared");
    expect(JSON.stringify(summary)).not.toContain("secret-key");
  });

  it("remembers a tested custom service id", () => {
    const storage = {
      value: JSON.stringify({
        version: 1,
        enabled: true,
        modelId: "svc_abc12345",
      }),
      getItem: () => storage.value,
      setItem: (key: string, item: string) => { void key; storage.value = item; },
    };
    expect(loadSemanticSearchPreferences(storage).modelId).toBe("svc_abc12345");
  });

  it("stores declared modalities and dimensions, and rejects an empty modality list", () => {
    const credentials = memoryCredentials();
    const catalog = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Cloud",
      adapter: "openai-embeddings-v1",
      destination: "internet",
      baseUrl: "https://example.com/compatible-mode/v1",
      modelName: "text-embedding-v4",
      modalities: ["text"],
      dimensions: 1024,
    });
    expect(catalog.services[0]).toMatchObject({
      adapter: "openai-embeddings-v1",
      modalities: ["text"],
      dimensions: 1024,
      textStatus: "declared",
    });
    expect(() => saveEmbeddingService(catalog, credentials, {
      name: "Cloud",
      destination: "internet",
      baseUrl: "https://example.com/compatible-mode/v1",
      modelName: "text-embedding-v4",
      modalities: [],
    })).toThrow(EmbeddingServiceRegistryError);
    expect(validateEmbeddingServiceDraft({
      name: "Cloud",
      modelName: "text-embedding-v4",
      destination: "internet",
      baseUrl: "https://example.com/v1",
      dimensions: 0,
    })).toBe("dimensions");
  });

  it("keeps a user-entered length when the probe vector does not match", () => {
    const credentials = memoryCredentials();
    const saved = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Dash",
      adapter: "dashscope-multimodal-v1",
      destination: "internet",
      baseUrl: "https://dashscope.aliyuncs.com",
      modelName: "qwen3-vl-embedding",
      modalities: ["text", "image", "video"],
      dimensions: 1024,
    });
    const id = saved.services[0]?.id ?? "";
    const failed = markEmbeddingServiceProbe(saved, id, { ok: true, dimensions: 2560 });
    expect(failed.services[0]).toMatchObject({ textStatus: "failed", dimensions: 1024, probeFailure: "dimensions" });
    const verified = markEmbeddingServiceProbe(saved, id, { ok: true, dimensions: 1024 });
    expect(verified.services[0]).toMatchObject({ textStatus: "verified", dimensions: 1024, probeFailure: null });
    const network = markEmbeddingServiceProbe(saved, id, { ok: false, failure: "network" });
    expect(network.services[0]).toMatchObject({ textStatus: "failed", probeFailure: "network" });
  });

  it("keeps the user-chosen adapter even when the model id looks multimodal", () => {
    const credentials = memoryCredentials();
    const openaiStyle = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Compat",
      adapter: "openai-embeddings-v1",
      destination: "internet",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelName: "qwen3-vl-embedding",
      modalities: ["text"],
      dimensions: 1024,
    });
    expect(openaiStyle.services[0]?.adapter).toBe("openai-embeddings-v1");

    const dash = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Dash",
      adapter: "dashscope-multimodal-v1",
      destination: "internet",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      modelName: "custom-multimodal",
      modalities: ["text", "image", "video"],
      dimensions: 1024,
    });
    expect(dash.services[0]?.adapter).toBe("dashscope-multimodal-v1");
  });

  it("defaults missing adapter to OpenAI-compatible and preserves a stored adapter on load", () => {
    const credentials = memoryCredentials();
    const saved = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Home",
      destination: "loopback",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelName: "nomic-embed-text",
    });
    expect(saved.services[0]?.adapter).toBe("openai-embeddings-v1");

    const legacy = parseEmbeddingServiceCatalog({
      version: 1,
      services: [{
        id: "svc_abcdefghij1234567890",
        name: "LegacyDash",
        adapter: "dashscope-multimodal-v1",
        destination: "internet",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        modelName: "anything",
        textStatus: "declared",
        dimensions: null,
        grantedLibraryIds: [],
        modalities: ["text", "image"],
      }],
    });
    expect(legacy.services[0]?.adapter).toBe("dashscope-multimodal-v1");
  });

  it("stores an optional model description on custom services", () => {
    const credentials = memoryCredentials();
    const saved = saveEmbeddingService({ version: 1, services: [] }, credentials, {
      name: "Home",
      description: "家里的向量模型",
      destination: "loopback",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelName: "nomic-embed-text",
    });
    expect(saved.services[0]).toMatchObject({
      name: "Home",
      description: "家里的向量模型",
    });
    const cleared = saveEmbeddingService(saved, credentials, {
      id: saved.services[0]?.id,
      name: "Home",
      description: "",
      destination: "loopback",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelName: "nomic-embed-text",
    });
    expect(cleared.services[0]?.description).toBe("");
    const legacy = parseEmbeddingServiceCatalog({
      version: 1,
      services: [{
        id: "svc_abcdefghij1234567890",
        name: "Legacy",
        adapter: "openai-embeddings-v1",
        destination: "loopback",
        baseUrl: "http://127.0.0.1:8080",
        modelName: "bge",
        textStatus: "declared",
        dimensions: null,
        grantedLibraryIds: [],
        modalities: ["text"],
      }],
    });
    expect(legacy.services[0]?.description).toBe("");
  });

  it("sends OpenAI dimensions and DashScope dimension, and rejects the wrong length", () => {
    expect(embeddingRequestBody({
      adapter: "openai-embeddings-v1",
      modelName: "text-embedding-v4",
      inputs: ["a"],
      dimensions: 1024,
    })).toEqual({ model: "text-embedding-v4", input: ["a"], dimensions: 1024 });
    expect(embeddingRequestBody({
      adapter: "dashscope-multimodal-v1",
      modelName: "qwen3-vl-embedding",
      inputs: ["a"],
      dimensions: 1024,
    })).toEqual({
      model: "qwen3-vl-embedding",
      input: { contents: [{ text: "a" }] },
      parameters: { dimension: 1024 },
    });
    expect(embeddingRequestBody({
      adapter: "dashscope-multimodal-v1",
      modelName: "qwen3-vl-embedding",
      inputs: [{ image: "data:image/png;base64,aaa" }],
      dimensions: 1024,
    })).toEqual({
      model: "qwen3-vl-embedding",
      input: { contents: [{ image: "data:image/png;base64,aaa" }] },
      parameters: { dimension: 1024 },
    });
    expect(embeddingServiceEndpoint("dashscope-multimodal-v1", "https://dashscope.aliyuncs.com"))
      .toBe("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding");
    expect(embeddingServiceEndpoint(
      "dashscope-multimodal-v1",
      "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
    )).toBe("https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding");
    const dashscope = readEmbeddingResponse({
      output: { embeddings: [{ embedding: [1, 0], type: "text" }] },
    }, 1, 2, "dashscope-multimodal-v1");
    expect(dashscope).toEqual([[1, 0]]);
    expect(readEmbeddingResponse({
      output: { embeddings: [{ embedding: [1, 0, 0] }] },
    }, 1, 2, "dashscope-multimodal-v1")).toBeNull();
    expect(readEmbeddingHttpBatch({
      data: [{ index: 0, embedding: [1, 0, 0] }],
    }, 1, 2)).toBeNull();
  });

  it("sends DashScope search instruct for visual retrieval bias mitigation", () => {
    expect(embeddingRequestBody({
      adapter: "dashscope-multimodal-v1",
      modelName: "qwen3-vl-embedding",
      inputs: ["red fruit"],
      dimensions: 1024,
      instruct: DASHSCOPE_VISUAL_SEARCH_INSTRUCT,
    })).toEqual({
      model: "qwen3-vl-embedding",
      input: { contents: [{ text: "red fruit" }] },
      parameters: {
        dimension: 1024,
        instruct: DASHSCOPE_VISUAL_SEARCH_INSTRUCT,
      },
    });
    expect(embeddingRequestBody({
      adapter: "openai-embeddings-v1",
      modelName: "text-embedding-3-small",
      inputs: ["red fruit"],
      dimensions: 1024,
      instruct: DASHSCOPE_VISUAL_SEARCH_INSTRUCT,
    })).toEqual({
      model: "text-embedding-3-small",
      input: ["red fruit"],
      dimensions: 1024,
    });
  });

  it("defaults image limits for older catalogs and keeps a verified probe when only those limits change", () => {
    const credentials = memoryCredentials();
    const legacy = parseEmbeddingServiceCatalog({
      version: 1,
      services: [{
        id: "svc_abcdefghij1234567890",
        name: "Legacy",
        adapter: "llamacpp-multimodal-v1",
        destination: "loopback",
        baseUrl: "http://127.0.0.1:8080",
        modelName: "embeddinggemma",
        textStatus: "verified",
        dimensions: 768,
        grantedLibraryIds: ["library-one"],
        modalities: ["text", "image"],
      }],
    });
    expect(legacy.services[0]).toMatchObject({
      maxImageEdgePx: CUSTOM_SEMANTIC_IMAGE_DEFAULT_EDGE_PX,
      maxImageBytes: CUSTOM_SEMANTIC_IMAGE_DEFAULT_BYTES,
      textStatus: "verified",
    });
    const updated = saveEmbeddingService(legacy, credentials, {
      id: legacy.services[0]?.id,
      name: "Legacy",
      adapter: "llamacpp-multimodal-v1",
      destination: "loopback",
      baseUrl: "http://127.0.0.1:8080",
      modelName: "embeddinggemma",
      modalities: ["text", "image"],
      dimensions: 768,
      maxImageEdgePx: 1024,
      maxImageBytes: 2 * 1024 * 1024,
    });
    expect(updated.services[0]).toMatchObject({
      textStatus: "verified",
      dimensions: 768,
      maxImageEdgePx: 1024,
      maxImageBytes: 2 * 1024 * 1024,
      grantedLibraryIds: ["library-one"],
    });
    const [summary] = summarizeEmbeddingServices(updated, credentials);
    expect(summary?.profileKey).toBe(embeddingHttpProfileKey({
      adapter: "llamacpp-multimodal-v1",
      baseUrl: "http://127.0.0.1:8080",
      modelName: "embeddinggemma",
      dimensions: 768,
      maxImageEdgePx: 1024,
      maxImageBytes: 2 * 1024 * 1024,
    }));
    expect(validateEmbeddingServiceDraft({
      name: "Legacy",
      modelName: "embeddinggemma",
      baseUrl: "http://127.0.0.1:8080",
      maxImageEdgePx: 100,
    })).toBe("imageEdge");
    expect(validateEmbeddingServiceDraft({
      name: "Legacy",
      modelName: "embeddinggemma",
      baseUrl: "http://127.0.0.1:8080",
      maxImageBytes: 100,
    })).toBe("imageBytes");
  });
});
