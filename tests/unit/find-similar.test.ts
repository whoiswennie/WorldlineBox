import { describe, expect, it } from "vitest";

import {
  resolveFindSimilar,
  canFindSimilarForAsset,
} from "../../src/renderer/find-similar";
import {
  rankSimilarAssetIds,
  takeNextEmbeddingTarget,
} from "../../src/main/embedding-test-index";
import { embeddingInputModalitiesForAdapter, LOCAL_GEMMA_INPUT_MODALITIES, LOCAL_SEMANTIC_ENCODE_MODALITIES } from "../../src/shared/embedding/modalities";
import { embeddingAudioRevision, embeddingSourceForModalities, isDamagedEmbeddingAsset } from "../../src/shared/embedding/profile";
import { rendererResultSchema } from "../../src/shared/protocol/responses";

describe("find similar", () => {
  it("uses supported original inputs and falls back to a ready image preview", () => {
    expect(embeddingSourceForModalities({
      mediaType: "audio",
      relativeFilePath: "take.wav",
      currentRevisionId: "rev-1",
    }, ["audio"])).toEqual({ kind: "audio", revision: embeddingAudioRevision("rev-1") });
    expect(canFindSimilarForAsset({
      mediaType: "image",
      relativeFilePath: "refs/hero.PNG",
    })).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "video",
      relativeFilePath: "clip.mov",
    })).toBe(false);
    expect(embeddingSourceForModalities({
      mediaType: "video",
      relativeFilePath: "clip.mp4",
      currentRevisionId: "rev-video",
    }, ["video", "image"])).toEqual({ kind: "video", revision: "rev-video" });
    expect(embeddingSourceForModalities({
      mediaType: "video",
      relativeFilePath: "clip.mp4",
      currentRevisionId: "rev-video",
      thumbnailStatus: "ready",
      thumbnailArtifactId: "poster-1",
    }, ["image"])).toEqual({ kind: "image", revision: "rev-video\nthumb:poster-1" });
    expect(embeddingSourceForModalities({
      mediaType: "video",
      relativeFilePath: "clip.mp4",
      currentRevisionId: "rev-video",
      thumbnailStatus: null,
    }, LOCAL_SEMANTIC_ENCODE_MODALITIES)).toBeNull();
    expect(LOCAL_SEMANTIC_ENCODE_MODALITIES).toEqual(["image", "audio", "text"]);
    expect(canFindSimilarForAsset({
      mediaType: "video",
      relativeFilePath: "clip.mov",
      thumbnailStatus: "ready",
      thumbnailArtifactId: "thumb-1",
    })).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "audio",
      relativeFilePath: "take.wav",
    })).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "audio",
      relativeFilePath: "take.wav",
      thumbnailStatus: "failed",
    })).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "text",
      relativeFilePath: "notes.md",
    })).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "audio",
      relativeFilePath: "broken.wav",
      currentRevisionId: "corrupt:asset-1",
    })).toBe(false);
    expect(canFindSimilarForAsset({
      mediaType: "image",
      relativeFilePath: "broken.jpg",
      currentRevisionId: "rev-1",
      thumbnailStatus: "failed",
      thumbnailArtifactId: "thumb-4",
    })).toBe(false);
    expect(canFindSimilarForAsset({
      mediaType: "audio",
      relativeFilePath: "take.wav",
      currentRevisionId: "rev-1",
      thumbnailStatus: "ready",
      thumbnailArtifactId: "audio-preview",
    }, ["image"])).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "audio",
      relativeFilePath: "take.wav",
      currentRevisionId: "rev-1",
    }, ["image"])).toBe(false);
    expect(canFindSimilarForAsset({
      mediaType: "text",
      relativeFilePath: "notes.md",
      currentRevisionId: "rev-1",
      thumbnailStatus: "ready",
      thumbnailArtifactId: "text-preview",
    }, ["image"])).toBe(true);
    expect(canFindSimilarForAsset({
      mediaType: "video",
      relativeFilePath: "clip.mp4",
      currentRevisionId: "rev-1",
      thumbnailStatus: "ready",
      thumbnailArtifactId: "video-preview",
    }, ["text"])).toBe(false);
    expect([...LOCAL_GEMMA_INPUT_MODALITIES].sort()).toEqual(["audio", "image", "text", "video"]);
    expect([...embeddingInputModalitiesForAdapter("openai-embeddings-v1", ["text", "image", "audio", "video"])])
      .toEqual(["text"]);
    expect([...embeddingInputModalitiesForAdapter("llamacpp-multimodal-v1", ["text", "image", "audio", "video"])].sort())
      .toEqual(["image", "text"]);
  });

  it("treats a failed preview or a missing revision as damaged", () => {
    expect(isDamagedEmbeddingAsset({
      currentRevisionId: "rev-1",
      thumbnailStatus: "failed",
    })).toBe(true);
    expect(isDamagedEmbeddingAsset({
      currentRevisionId: "corrupt:asset-1",
      thumbnailStatus: null,
    })).toBe(true);
    expect(isDamagedEmbeddingAsset({
      currentRevisionId: "rev-1",
      thumbnailStatus: "pending",
    })).toBe(false);
    expect(isDamagedEmbeddingAsset({
      currentRevisionId: "rev-1",
      thumbnailStatus: "ready",
    })).toBe(false);
  });

  it("ranks other images and leaves the source out", () => {
    const ids = rankSimilarAssetIds("source", [
      { assetId: "source", vector: [1, 0] },
      { assetId: "far", vector: [0, 1] },
      { assetId: "near", vector: [0.9, 0.1] },
    ]);
    expect(ids).toEqual(["near", "far"]);
  });

  it("encodes a requested picture before the rest of the queue", () => {
    const next = takeNextEmbeddingTarget(
      [{ assetId: "a" }, { assetId: "needed" }, { assetId: "c" }],
      "needed",
    );
    expect(next?.target.assetId).toBe("needed");
    expect(next?.rest.map((item) => item.assetId)).toEqual(["a", "c"]);
    expect(takeNextEmbeddingTarget([], "needed")).toBeNull();
  });

  it("waits through preparing, then returns the ranked page", async () => {
    const statuses = ["preparing", "preparing", "ready"] as const;
    let calls = 0;
    let preparing = 0;
    const page = await resolveFindSimilar({
      query: async () => {
        const status = statuses[calls] ?? "ready";
        calls += 1;
        return { status, assetIds: status === "ready" ? ["other"] : [] };
      },
      shouldContinue: () => true,
      delay: async () => undefined,
      onPreparing: () => {
        preparing += 1;
      },
    });
    expect(page).toEqual({ status: "ready", assetIds: ["other"] });
    expect(preparing).toBe(1);
    expect(calls).toBe(3);
  });

  it("returns a terminal encoding failure instead of continuing to poll", async () => {
    let calls = 0;
    const page = await resolveFindSimilar({
      query: async () => {
        calls += 1;
        return { status: "failed", assetIds: [] };
      },
      shouldContinue: () => true,
      delay: async () => undefined,
    });
    expect(page).toEqual({ status: "failed", assetIds: [] });
    expect(calls).toBe(1);
  });

  it("stops polling when the caller cancels", async () => {
    let continuePolling = true;
    const page = await resolveFindSimilar({
      query: async () => {
        continuePolling = false;
        return { status: "preparing", assetIds: [] };
      },
      shouldContinue: () => continuePolling,
      delay: async () => undefined,
    });
    expect(page).toBeNull();
  });

  it("accepts a similar-result payload without scores", () => {
    const parsed = rendererResultSchema.safeParse({
      ok: true,
      type: "embedding.similar",
      phase: "indexing",
      done: 2,
      total: 4,
      failedCount: 0,
      status: "ready",
      sourceAssetId: "source",
      assetIds: ["near", "far"],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an explicit failed similar-source status", () => {
    const parsed = rendererResultSchema.safeParse({
      ok: true,
      type: "embedding.similar",
      phase: "ready",
      done: 2,
      total: 4,
      failedCount: 1,
      status: "failed",
      sourceAssetId: "source",
      assetIds: [],
    });
    expect(parsed.success).toBe(true);
  });
});
