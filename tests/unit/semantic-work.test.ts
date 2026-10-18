import { describe, expect, it } from "vitest";

import {
  resolveLocalSimilarModelId,
  semanticBackgroundWorkActive,
  semanticToolbarReady,
} from "../../src/renderer/semantic-work";
import { embeddingIndexCopyKey, embeddingIndexJobsVisible } from "../../src/renderer/semantic-index-copy";
import {
  mergeKeywordAndSemanticRanks,
  semanticBrowseRegistration,
} from "../../src/renderer/semantic-browse";
import { embeddingServiceTextOnly } from "../../src/shared/embedding/modalities";
import { encodeModalitiesForAdapter } from "../../src/main/embedding-http-index";

describe("semantic readiness", () => {
  it("offers the toolbar only when the library model can search text", () => {
    expect(semanticToolbarReady({
      selectionId: "embeddinggemma-2-compact",
      runtimeInstalled: true,
      models: [{ modelId: "embeddinggemma-2-compact", installed: false }],
      service: null,
    })).toBe(false);
    expect(semanticToolbarReady({
      selectionId: "embeddinggemma-2-compact",
      runtimeInstalled: true,
      models: [{ modelId: "embeddinggemma-2-compact", installed: true }],
      service: null,
    })).toBe(true);
    expect(semanticToolbarReady({
      selectionId: "svc_readytext",
      runtimeInstalled: false,
      models: [],
      service: { modalities: ["image"], textStatus: "verified", dimensions: 1024 },
    })).toBe(false);
    expect(semanticToolbarReady({
      selectionId: "svc_readytext",
      runtimeInstalled: false,
      models: [],
      service: { modalities: ["text", "image"], textStatus: "verified", dimensions: 1024 },
    })).toBe(true);
  });

  it("keeps the jobs indicator quiet unless a download or index is running", () => {
    expect(semanticBackgroundWorkActive({ installing: false, enabled: true, phase: "ready" })).toBe(false);
    expect(semanticBackgroundWorkActive({ installing: false, enabled: false, phase: "starting" })).toBe(false);
    expect(semanticBackgroundWorkActive({ installing: true, enabled: false, phase: "unavailable" })).toBe(true);
    expect(semanticBackgroundWorkActive({ installing: false, enabled: true, phase: "indexing" })).toBe(true);
  });

  it("keeps the toolbar query when semantic results are registered", () => {
    const registration = semanticBrowseRegistration({
      libraryId: "library-1",
      query: { clauses: [] },
      showIgnored: false,
      rankedAssetIds: ["asset-1"],
      rankedPageSize: 50,
      items: [],
    });
    expect(registration.query).toEqual({ clauses: [] });
    expect(registration.total).toBe(1);
  });

});

describe("semantic index jobs copy", () => {
  it("keeps picture wording for local models and text wording for custom services", () => {
    expect(embeddingIndexCopyKey({ phase: "indexing", done: 1, total: 3, failedCount: 0 }))
      .toBe("dialog.mediaJobs.embeddingProgress");
    expect(embeddingIndexCopyKey(
      { phase: "indexing", done: 1, total: 3, failedCount: 0 },
      { textOnly: true },
    )).toBe("dialog.mediaJobs.embeddingProgressText");
    expect(embeddingIndexCopyKey(
      { phase: "ready", done: 0, total: 0, failedCount: 0 },
      { textOnly: true },
    )).toBe("dialog.mediaJobs.embeddingReadyEmptyText");
    expect(embeddingServiceTextOnly(["text"])).toBe(true);
    expect(embeddingServiceTextOnly(["text", "image"])).toBe(false);
    expect(embeddingServiceTextOnly(["text", "video"])).toBe(true);
    expect([...encodeModalitiesForAdapter("openai-embeddings-v1", ["text", "image"])]).toEqual(["text"]);
    expect([...encodeModalitiesForAdapter("llamacpp-multimodal-v1", ["text", "image", "video", "audio"])].sort())
      .toEqual(["image", "text"]);
    expect([...encodeModalitiesForAdapter("dashscope-multimodal-v1", ["text", "image", "video"])].sort())
      .toEqual(["image", "text"]);
  });

  it("keeps failed vector work visible in the background jobs panel after indexing ends", () => {
    expect(embeddingIndexJobsVisible({ phase: "starting", done: 0, total: 0, failedCount: 0 })).toBe(true);
    expect(embeddingIndexJobsVisible({ phase: "indexing", done: 1, total: 3, failedCount: 0 })).toBe(true);
    expect(embeddingIndexJobsVisible({ phase: "ready", done: 3, total: 3, failedCount: 0 })).toBe(false);
    expect(embeddingIndexJobsVisible({ phase: "ready", done: 3, total: 4, failedCount: 1 })).toBe(true);
  });
});

describe("local similar model and keyword blend", () => {
  it("picks an installed local model for find-similar fallback", () => {
    expect(resolveLocalSimilarModelId({
      runtimeInstalled: false,
      models: [{ modelId: "embeddinggemma-2-compact", installed: true }],
    })).toBeNull();
    expect(resolveLocalSimilarModelId({
      runtimeInstalled: true,
      models: [{ modelId: "embeddinggemma-2-compact", installed: true }],
      preferredModelId: "embeddinggemma-2-compact",
    })).toBe("embeddinggemma-2-compact");
  });

  it("keeps keyword hits ahead of semantic-only matches", () => {
    expect(mergeKeywordAndSemanticRanks({
      keywordAssetIds: ["k1", "shared"],
      semanticAssetIds: ["shared", "s1", "s2"],
    })).toEqual(["k1", "shared", "s1", "s2"]);
  });
});
