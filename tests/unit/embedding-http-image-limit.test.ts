import { describe, expect, it, vi } from "vitest";

const { fitSemanticImage } = vi.hoisted(() => ({
  fitSemanticImage: vi.fn(async (input: { bytes: Buffer; mimeType: string }) => ({
    bytes: input.bytes,
    mimeType: input.mimeType,
  })),
}));

vi.mock("../../src/main/embedding-image-fit", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../src/main/embedding-image-fit");
  return { ...actual, fitSemanticImage };
});

import { EmbeddingHttpIndex, type EmbeddingHttpServiceView } from "../../src/main/embedding-http-index";
import { SemanticImageLimitError } from "../../src/main/embedding-image-fit";
import type { WorkerCommand } from "../../src/shared/protocol/requests";
import type { WorkerResult } from "../../src/shared/protocol/responses";
import { SEMANTIC_IMAGE_DECODE_MAX_BYTES } from "../../src/shared/embedding/image-limits";

const service: EmbeddingHttpServiceView = {
  id: "svc_abcdefgh",
  adapter: "llamacpp-multimodal-v1",
  destination: "loopback",
  baseUrl: "http://127.0.0.1:8080",
  modelName: "test-model",
  textStatus: "verified",
  dimensions: 3,
  grantedLibraryIds: ["library-one"],
  modalities: ["text", "image"],
  maxImageEdgePx: 1024,
  maxImageBytes: 2 * 1024 * 1024,
};

function imageWorker(options: { failPrepare?: boolean } = {}) {
  const commands: WorkerCommand[] = [];
  const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
    commands.push(command);
    if (command.type === "semantic.index.begin") {
      return { ok: true, type: "semantic.index.started", profileId: "0".repeat(64), nativeCosineAvailable: false };
    }
    if (command.type === "semantic.index.import-legacy") {
      return { ok: true, type: "semantic.index.legacy-imported", attempted: false, acceptedRows: 0, rejectedRows: 0 };
    }
    if (command.type === "semantic.index.targets") {
      return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: "still", sourceRevision: "rev-still", kind: "image", modality: "image", alreadyIndexed: false }],
      };
    }
    if (command.type === "semantic.index.job") {
      return { ok: true, type: "semantic.index.job-updated", updated: true };
    }
    if (command.type === "semantic.index.prepare") {
      if (options.failPrepare) throw new Error("Source file is unavailable.");
      return {
        ok: true, type: "semantic.index.prepared", assetId: "still", sourceRevision: "rev-still",
        kind: "image", mimeType: "image/png", bytesBase64: Buffer.from("original-png").toString("base64"),
      };
    }
    if (command.type === "semantic.index.write") {
      return { ok: true, type: "semantic.index.written", accepted: ["still"], rejected: [] };
    }
    if (command.type === "semantic.index.similar") {
      return {
        ok: true, type: "semantic.index.ranked", cancelled: false, candidateCount: 0,
        sourceStatus: "failed", assetIds: [], scores: [],
      };
    }
    return { ok: true, type: "semantic.index.closed" };
  });
  return { commands, requestWorker };
}

async function untilReady(index: EmbeddingHttpIndex): Promise<void> {
  index.handleStatus({ libraryId: "library-one", modelId: service.id, run: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = index.handleStatus({ libraryId: "library-one", modelId: service.id, run: false });
    if ("type" in status && status.type === "embedding.index.status" && status.phase === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Semantic HTTP index did not become ready.");
}

describe("HTTP semantic image limits", () => {
  it("fits a picture to the service limits before posting it", async () => {
    fitSemanticImage.mockImplementation(async () => ({
      bytes: Buffer.from("fitted-jpeg"),
      mimeType: "image/jpeg",
    }));
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({
        data: [{ embedding: [1, 0, 0], index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { commands, requestWorker } = imageWorker();
    const index = new EmbeddingHttpIndex({
      requestWorker,
      loadService: () => service,
      readKey: () => null,
      isLibraryEnabled: () => true,
    });
    try {
      await untilReady(index);
      expect(fitSemanticImage).toHaveBeenCalledWith(expect.objectContaining({
        mimeType: "image/png",
        maxEdgePx: 1024,
        maxBytes: 2 * 1024 * 1024,
      }));
      expect(commands.find((command) => command.type === "semantic.index.prepare")).toMatchObject({
        maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
      });
      expect(bodies.join("\n")).toContain(Buffer.from("fitted-jpeg").toString("base64"));
      expect(bodies.join("\n")).not.toContain(Buffer.from("original-png").toString("base64"));
    } finally {
      await index.close();
      vi.unstubAllGlobals();
      fitSemanticImage.mockReset();
    }
  });

  it("returns a user-facing limit error instead of posting an image that cannot be fitted", async () => {
    fitSemanticImage.mockRejectedValue(new SemanticImageLimitError());
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const { requestWorker } = imageWorker();
    const index = new EmbeddingHttpIndex({
      requestWorker,
      loadService: () => service,
      readKey: () => null,
      isLibraryEnabled: () => true,
    });
    try {
      await untilReady(index);
      expect(index.handleStatus({ libraryId: "library-one", modelId: service.id, run: false }))
        .toMatchObject({ type: "embedding.index.status", phase: "ready", failedCount: 1 });
      const similar = await index.handleSimilar({
        libraryId: "library-one",
        modelId: service.id,
        assetId: "still",
      });
      expect(similar).toMatchObject({ ok: false, error: { code: "SEMANTIC_IMAGE_TOO_LARGE" } });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      await index.close();
      vi.unstubAllGlobals();
      fitSemanticImage.mockReset();
    }
  });
});
