import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { rendererResultSchema } from "../../src/shared/protocol/responses";
import type { WorkerCommand } from "../../src/shared/protocol/requests";
import type { WorkerResult } from "../../src/shared/protocol/responses";
import type { startLlamaEmbeddingSession } from "../../src/main/embedding-llama-session";

import {
  localEmbeddingFilesReady,
  readLocalEmbeddingTestConfig,
} from "../../src/main/embedding-local-config";
import {
  embeddingSkipKey,
  EmbeddingTestIndex,
  embeddingTargetsToEncode,
  rankEmbeddings,
  resolveContainedPath,
  scoreEmbeddings,
} from "../../src/main/embedding-test-index";
import { SemanticImageLimitError } from "../../src/main/embedding-image-fit";
import {
  GEMMA_SEMANTIC_IMAGE_MAX_BYTES,
  GEMMA_SEMANTIC_IMAGE_MAX_EDGE_PX,
  SEMANTIC_IMAGE_DECODE_MAX_BYTES,
} from "../../src/shared/embedding/image-limits";
import { EMBEDDING_GEMMA2_TIER_FILES } from "../../src/shared/embedding/profile";

const temporaryRoots: string[] = [];

beforeEach(() => {
  fitSemanticImage.mockImplementation(async (input: { bytes: Buffer; mimeType: string }) => ({
    bytes: input.bytes,
    mimeType: input.mimeType,
  }));
});

function compactLayout(prefix: string): { modelDirectory: string; runtimePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const modelDirectory = path.join(root, "models");
  mkdirSync(modelDirectory, { recursive: true });
  const files = EMBEDDING_GEMMA2_TIER_FILES.Q4_K_XL;
  writeFileSync(path.join(modelDirectory, files.coreFile), "synthetic core weights");
  writeFileSync(path.join(modelDirectory, files.projectorFile), "synthetic projector weights");
  const runtimePath = path.join(root, "llama-server");
  writeFileSync(runtimePath, "synthetic runtime");
  return { modelDirectory, runtimePath };
}

function sessionDouble() {
  const vector = new Array(768).fill(0);
  vector[0] = 1;
  return {
    embedText: vi.fn(async () => vector),
    embedImage: vi.fn(async () => vector),
    embedImagePayload: vi.fn(async () => vector),
    embedVideoPayload: vi.fn(async () => vector),
    embedAudio: vi.fn(async () => vector),
    embedAudioPayload: vi.fn(async () => vector),
    close: vi.fn(async (): Promise<void> => undefined),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("embedding test index", () => {
  it("reports an unstarted or closed encoder as unavailable without launching it", async () => {
    const requestWorker = vi.fn(), installedLayout = vi.fn(), startSession = vi.fn();
    const index = new EmbeddingTestIndex({ configDirectories: [], requestWorker, installedLayout, startSession });
    const request = { libraryId: "library-one", modelId: "embeddinggemma-2-compact" as const, run: false, restart: false };
    expect(index.handleStatus(request)).toMatchObject({ phase: "unavailable", done: 0, total: 0, failedCount: 0 });
    await index.close();
    expect(index.handleStatus(request)).toMatchObject({ phase: "unavailable" });
    expect(installedLayout).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(requestWorker).not.toHaveBeenCalled();
  });

  it("closes the active library model without interrupting it for another library stop", async () => {
    const layout = compactLayout("worldlinebox-semantic-scoped-stop-");
    const session = sessionDouble();
    let finishClose: (() => void) | undefined;
    session.close.mockImplementation(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: false, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.targets") return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 0, nextOffset: null, targets: [],
      };
      return { ok: true, type: "semantic.index.closed" };
    });
    const index = new EmbeddingTestIndex({ configDirectories: [], installedLayout: () => layout,
      requestWorker, startSession: vi.fn(async () => session) });
    index.handleStatus({ libraryId: "library-one", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => expect(index.handleStatus({ libraryId: "library-one",
      modelId: "embeddinggemma-2-compact", run: false, restart: false })).toMatchObject({ phase: "ready" }));
    await index.close("library-other");
    expect(session.close).not.toHaveBeenCalled();
    const stopping = index.close("library-one");
    expect(session.close).toHaveBeenCalledOnce();
    expect(index.close("library-one")).toBe(stopping);
    finishClose?.();
    await stopping;
    expect(requestWorker).toHaveBeenCalledWith(expect.objectContaining({
      type: "semantic.index.close", libraryId: "library-one",
    }));
  });

  it("encodes only pictures that are missing or replaced", () => {
    const encoded = new Map([
      ["kept", { revisionId: "1" }],
      ["replaced", { revisionId: "1" }],
    ]);
    const pending = embeddingTargetsToEncode([
      { assetId: "kept", revisionId: "1" },
      { assetId: "replaced", revisionId: "2" },
      { assetId: "new", revisionId: "1" },
      { assetId: "failed", revisionId: "1" },
    ], encoded, new Set([embeddingSkipKey("failed", "1")]));
    expect(pending.map((target) => target.assetId)).toEqual(["replaced", "new"]);
  });

  it("ranks the closer vector first", () => {
    const query = [1, 0];
    const ids = rankEmbeddings(query, [
      { assetId: "far", vector: [0, 1] },
      { assetId: "near", vector: [0.9, 0.1] },
    ], 1);
    expect(ids).toEqual(["near"]);
  });

  it("keeps the complete cosine ranking even when adjacent scores differ by over 0.02", () => {
    const entries = [
      { assetId: "tail", vector: [0.4, Math.sqrt(0.84)] },
      { assetId: "reflection", vector: [0.66, Math.sqrt(1 - 0.66 ** 2)] },
      { assetId: "text-screenshot", vector: [0.7, Math.sqrt(1 - 0.7 ** 2)] },
    ];
    const ids = rankEmbeddings([1, 0], entries, entries.length);
    expect(ids).toEqual(["text-screenshot", "reflection", "tail"]);
    expect(ids.slice(0, 2)).toEqual(["text-screenshot", "reflection"]);
  });

  it("ranks mixed text and image rows by raw cosine without a type penalty", () => {
    const ranked = scoreEmbeddings([1, 0], [
      { assetId: "text-doc", revisionId: "r\ntext:v1:2500", vector: [0.95, Math.sqrt(1 - 0.95 ** 2)] },
      { assetId: "photo", revisionId: "r", vector: [0.88, Math.sqrt(1 - 0.88 ** 2)] },
    ]);
    expect(ranked.map(({ assetId }) => assetId)).toEqual(["text-doc", "photo"]);
    expect(ranked[0]?.score).toBeCloseTo(0.95);
    expect(ranked[1]?.score).toBeCloseTo(0.88);
  });

  it("exposes raw cosine scores and uses a stable ID tie-break", () => {
    const ranked = scoreEmbeddings([1, 0], [
      { assetId: "z", vector: [0.7, Math.sqrt(1 - 0.7 ** 2)] },
      { assetId: "a", vector: [0.7, Math.sqrt(1 - 0.7 ** 2)] },
      { assetId: "lower", vector: [0.66, Math.sqrt(1 - 0.66 ** 2)] },
    ]);
    expect(ranked.map(({ assetId }) => assetId)).toEqual(["a", "z", "lower"]);
    expect(ranked[0]?.score).toBeCloseTo(0.7);
    expect(ranked[2]?.score).toBeCloseTo(0.66);
  });

  it("accepts complete ranked ID snapshots within the library asset cap", () => {
    const result = (count: number) => ({
      ok: true,
      type: "embedding.search",
      phase: "ready",
      done: count,
      total: count,
      failedCount: 0,
      assetIds: Array.from({ length: count }, (_, index) => `asset-${index}`),
      scores: [],
    });
    expect(rendererResultSchema.safeParse(result(101)).success).toBe(true);
    expect(rendererResultSchema.safeParse(result(100_001)).success).toBe(false);
  });

  it("validates finite raw cosine scores without rejecting negatives or values above one", () => {
    const base = {
      ok: true as const,
      type: "embedding.search" as const,
      phase: "ready" as const,
      done: 3,
      total: 3,
      failedCount: 0,
      assetIds: ["negative", "zero", "above-one"],
    };
    expect(rendererResultSchema.safeParse({
      ...base,
      scores: [
        { assetId: "negative", score: -0.2 },
        { assetId: "zero", score: 0 },
        { assetId: "above-one", score: 1.2 },
      ],
    }).success).toBe(true);
    expect(rendererResultSchema.safeParse({
      ...base,
      scores: [{ assetId: "negative", score: Number.NaN }],
    }).success).toBe(false);
    expect(rendererResultSchema.safeParse({
      ...base,
      scores: [{ assetId: "negative", score: Number.POSITIVE_INFINITY }],
    }).success).toBe(false);
    expect(rendererResultSchema.safeParse({
      ...base,
      scores: [{ assetId: "unknown", score: 0.5 }],
    }).success).toBe(false);
    expect(rendererResultSchema.safeParse({
      ...base,
      scores: [
        { assetId: "negative", score: 0.2 },
        { assetId: "negative", score: 0.1 },
      ],
    }).success).toBe(false);
    // The new field remains optional for older Main processes.
    expect(rendererResultSchema.safeParse(base).success).toBe(true);
  });

  it("keeps a relative file inside its root", () => {
    const root = path.join(tmpdir(), "worldlinebox-embedding-root");
    expect(resolveContainedPath(root, "folder/picture.png")).toBe(path.resolve(root, "folder", "picture.png"));
    expect(resolveContainedPath(root, "../picture.png")).toBeNull();
    expect(resolveContainedPath(root, "")).toBeNull();
  });

  it("uses only the named local config and does not discover nearby weights", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-embedding-config-"));
    try {
      const models = path.join(root, "models");
      mkdirSync(models, { recursive: true });
      writeFileSync(path.join(models, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "");
      writeFileSync(path.join(models, "mmproj-Q8_0.gguf"), "");
      const runtime = path.join(root, "llama-server.exe");
      writeFileSync(runtime, "");

      expect(readLocalEmbeddingTestConfig([root])).toBeNull();

      writeFileSync(path.join(root, "embedding-gemma.local.json"), JSON.stringify({
        modelDirectory: models,
        runtimePath: runtime,
      }));
      const config = readLocalEmbeddingTestConfig([root]);
      expect(config).toEqual({ modelDirectory: models, runtimePath: runtime });
      expect(localEmbeddingFilesReady(config!, "embeddinggemma-2-compact")).toBe(true);
      expect(localEmbeddingFilesReady(config!, "embeddinggemma-2-quality")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still accepts an image target while advertising native video as a separate supported source", async () => {
    const { modelDirectory, runtimePath } = compactLayout("worldlinebox-semantic-video-cover-");
    const poster = Buffer.from("synthetic-cover").toString("base64");
    const session = sessionDouble();
    const commands: WorkerCommand[] = [];
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      commands.push(command);
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: true, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.targets") return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{
          assetId: "video-asset",
          sourceRevision: "video-revision\nthumb:poster",
          kind: "image",
          modality: "image",
          alreadyIndexed: false,
        }],
      };
      if (command.type === "semantic.index.job" && command.action === "claim") return {
        ok: true, type: "semantic.index.job-updated", updated: true,
      };
      if (command.type === "semantic.index.prepare") return {
        ok: true, type: "semantic.index.prepared", assetId: "video-asset",
        sourceRevision: "video-revision\nthumb:poster", kind: "image", mimeType: "image/jpeg", bytesBase64: poster,
      };
      if (command.type === "semantic.index.write") return {
        ok: true, type: "semantic.index.written", accepted: ["video-asset"], rejected: [],
      };
      if (command.type === "semantic.index.close") return { ok: true, type: "semantic.index.closed" };
      throw new Error(`Unexpected Worker command: ${command.type}`);
    });
    const index = new EmbeddingTestIndex({
      configDirectories: [],
      installedLayout: () => ({ modelDirectory, runtimePath }),
      requestWorker,
      startSession: vi.fn(async () => session),
      resolveMediaBinaries: () => undefined,
    });

    index.handleStatus({ libraryId: "library-cover", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => {
      expect(index.handleStatus({ libraryId: "library-cover", modelId: "embeddinggemma-2-compact", run: false, restart: false }))
        .toMatchObject({ ok: true, type: "embedding.index.status", phase: "ready", total: 1, failedCount: 0 });
    });
    expect(commands.find((command) => command.type === "semantic.index.begin")).toMatchObject({
      modalities: ["image", "video", "audio", "text"],
      maxInputBytes: SEMANTIC_IMAGE_DECODE_MAX_BYTES,
    });
    expect(commands.find((command) => command.type === "semantic.index.targets")).toMatchObject({
      modalities: ["image", "video", "audio", "text"],
    });
    expect(fitSemanticImage).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/jpeg",
      maxEdgePx: GEMMA_SEMANTIC_IMAGE_MAX_EDGE_PX,
      maxBytes: GEMMA_SEMANTIC_IMAGE_MAX_BYTES,
    }));
    expect(session.embedImagePayload).toHaveBeenCalledWith("image/jpeg", poster);
    expect(session.embedVideoPayload).not.toHaveBeenCalled();
    await index.close();
  });

  it("rejects missing video windows rather than silently indexing a cover", async () => {
    const { modelDirectory, runtimePath } = compactLayout("worldlinebox-semantic-video-disabled-");
    const session = sessionDouble();
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: true, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.targets") return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: "video-asset", sourceRevision: "video-revision", kind: "video", modality: "video", alreadyIndexed: false }],
      };
      if (command.type === "semantic.index.job") return { ok: true, type: "semantic.index.job-updated", updated: true };
      if (command.type === "semantic.index.prepare") return {
        ok: true, type: "semantic.index.prepared", assetId: "video-asset", sourceRevision: "video-revision",
        kind: "video", mimeType: "video/mp4", bytesBase64: Buffer.from("synthetic mp4").toString("base64"),
      };
      if (command.type === "semantic.index.close") return { ok: true, type: "semantic.index.closed" };
      throw new Error(`Unexpected Worker command: ${command.type}`);
    });
    const index = new EmbeddingTestIndex({
      configDirectories: [],
      installedLayout: () => ({ modelDirectory, runtimePath }),
      requestWorker,
      startSession: vi.fn(async () => session),
      resolveMediaBinaries: () => undefined,
    });
    index.handleStatus({ libraryId: "library-video", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => {
      expect(index.handleStatus({ libraryId: "library-video", modelId: "embeddinggemma-2-compact", run: false, restart: false }))
        .toMatchObject({ ok: true, type: "embedding.index.status", phase: "ready", failedCount: 1 });
    });
    expect(session.embedVideoPayload).not.toHaveBeenCalled();
    expect(session.embedImagePayload).not.toHaveBeenCalled();
    const failed = requestWorker.mock.calls.map(([command]) => command).find((command) => (
      command.type === "semantic.index.job" && command.action === "fail"
    ));
    expect(failed).toMatchObject({ errorCategory: "preparation" });
    await index.close();
  });

  it('encodes actual video windows with synchronized audio and pools every window in the shared space', async () => {
    const { modelDirectory, runtimePath } = compactLayout('worldlinebox-semantic-native-video-');
    const session = sessionDouble();
    let written: WorkerCommand | undefined;
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === 'semantic.index.begin') return { ok: true, type: 'semantic.index.started', profileId: 'a'.repeat(64), nativeCosineAvailable: false };
      if (command.type === 'semantic.index.import-legacy') return { ok: true, type: 'semantic.index.legacy-imported', attempted: true, acceptedRows: 0, rejectedRows: 0 };
      if (command.type === 'semantic.index.targets') return { ok: true, type: 'semantic.index.targets', revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: 'video', sourceRevision: 'video:v1', kind: 'video', modality: 'video', alreadyIndexed: false }] };
      if (command.type === 'semantic.index.job') return { ok: true, type: 'semantic.index.job-updated', updated: true };
      if (command.type === 'semantic.index.prepare') return { ok: true, type: 'semantic.index.prepared', assetId: 'video', sourceRevision: 'video:v1', kind: 'video',
        videoWindows: [{ bytesBase64: 'first-frames', audioBase64: 'first-speech' }, { bytesBase64: 'later-frames' }] };
      if (command.type === 'semantic.index.write') { written = command; return { ok: true, type: 'semantic.index.written', accepted: ['video'], rejected: [] }; }
      if (command.type === 'semantic.index.close') return { ok: true, type: 'semantic.index.closed' };
      throw new Error(`Unexpected ${command.type}`);
    });
    const index = new EmbeddingTestIndex({ configDirectories: [], installedLayout: () => ({ modelDirectory, runtimePath }), requestWorker, startSession: async () => session });
    index.handleStatus({ libraryId: 'library-video', modelId: 'embeddinggemma-2-compact', run: true, restart: false });
    await vi.waitFor(() => expect(written?.type).toBe('semantic.index.write'));
    expect(session.embedVideoPayload).toHaveBeenNthCalledWith(1, 'first-frames', 'first-speech');
    expect(session.embedVideoPayload).toHaveBeenNthCalledWith(2, 'later-frames', undefined);
    expect(session.embedImagePayload).not.toHaveBeenCalled(); await index.close();
  });

  it("reports a picture that cannot be fitted as a semantic image limit", async () => {
    const { modelDirectory, runtimePath } = compactLayout("worldlinebox-semantic-image-limit-");
    fitSemanticImage.mockRejectedValue(new SemanticImageLimitError());
    const session = sessionDouble();
    let similarCalls = 0;
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: true, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.targets") return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 1, nextOffset: null,
        targets: [{ assetId: "still", sourceRevision: "rev-still", kind: "image", modality: "image", alreadyIndexed: false }],
      };
      if (command.type === "semantic.index.job") return { ok: true, type: "semantic.index.job-updated", updated: true };
      if (command.type === "semantic.index.prepare") return {
        ok: true, type: "semantic.index.prepared", assetId: "still", sourceRevision: "rev-still",
        kind: "image", mimeType: "image/jpeg", bytesBase64: Buffer.from("too-big").toString("base64"),
      };
      if (command.type === "semantic.index.similar") {
        similarCalls += 1;
        return {
          ok: true, type: "semantic.index.ranked", cancelled: false, candidateCount: 0,
          sourceStatus: "failed", assetIds: [], scores: [],
        };
      }
      if (command.type === "semantic.index.close" || command.type === "semantic.index.cancel-search") {
        return { ok: true, type: "semantic.index.closed" };
      }
      throw new Error(`Unexpected Worker command: ${command.type}`);
    });
    const index = new EmbeddingTestIndex({
      configDirectories: [],
      installedLayout: () => ({ modelDirectory, runtimePath }),
      requestWorker,
      startSession: vi.fn(async () => session),
      resolveMediaBinaries: () => undefined,
    });
    index.handleStatus({ libraryId: "library-limit", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => {
      expect(index.handleStatus({ libraryId: "library-limit", modelId: "embeddinggemma-2-compact", run: false, restart: false }))
        .toMatchObject({ ok: true, type: "embedding.index.status", phase: "ready", failedCount: 1 });
    });
    const similar = await index.handleSimilar({
      libraryId: "library-limit",
      modelId: "embeddinggemma-2-compact",
      assetId: "still",
    });
    expect(similar).toMatchObject({ ok: false, error: { code: "SEMANTIC_IMAGE_TOO_LARGE" } });
    expect(session.embedImagePayload).not.toHaveBeenCalled();
    expect(similarCalls).toBeGreaterThan(0);
    await index.close();
  });

  it("cancels an opening session when switching models without failing the replacement", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-semantic-session-switch-"));
    temporaryRoots.push(root);
    const files = Object.values(EMBEDDING_GEMMA2_TIER_FILES).flatMap((entry) => [entry.coreFile, entry.projectorFile]);
    const modelDirectory = path.join(root, "models");
    mkdirSync(modelDirectory, { recursive: true });
    for (const file of files) writeFileSync(path.join(modelDirectory, file), "fixture");
    const runtimePath = path.join(root, "fake-runtime");
    writeFileSync(runtimePath, "fixture runtime");
    const session = {
      embedText: vi.fn(async () => [1]),
      embedImage: vi.fn(async () => [1]),
      embedImagePayload: vi.fn(async () => [1]),
      embedVideoPayload: vi.fn(async () => [1]),
      embedAudio: vi.fn(async () => [1]),
      embedAudioPayload: vi.fn(async () => [1]),
      close: vi.fn(async () => undefined),
    };
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: true, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.targets") return {
        ok: true, type: "semantic.index.targets", revisionSnapshot: 1, total: 0, nextOffset: null, targets: [],
      };
      if (command.type === "semantic.index.close") return { ok: true, type: "semantic.index.closed" };
      throw new Error(`Unexpected Worker command: ${command.type}`);
    });
    let firstSignal: AbortSignal | undefined;
    const startSession = vi.fn(async (options: Parameters<typeof startLlamaEmbeddingSession>[0]) => {
      if (options.files.corePath.endsWith(EMBEDDING_GEMMA2_TIER_FILES.Q4_K_XL.coreFile)) {
        firstSignal = options.signal;
        return new Promise<typeof session>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        });
      }
      return session;
    });
    const index = new EmbeddingTestIndex({
      configDirectories: [],
      installedLayout: () => ({ modelDirectory, runtimePath }),
      requestWorker,
      startSession,
    });

    index.handleStatus({ libraryId: "library-switch", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledTimes(1));
    index.handleStatus({ libraryId: "library-switch", modelId: "embeddinggemma-2-balanced", run: true, restart: false });
    expect(firstSignal?.aborted).toBe(true);
    await vi.waitFor(() => {
      expect(index.handleStatus({ libraryId: "library-switch", modelId: "embeddinggemma-2-balanced", run: false, restart: false }))
        .toMatchObject({ ok: true, type: "embedding.index.status", phase: "ready" });
    });
    expect(startSession).toHaveBeenCalledTimes(2);
    await Promise.all([index.close(), index.close()]);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("does not start a CPU fallback when GPU runtime cleanup failed", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-semantic-start-cleanup-"));
    temporaryRoots.push(root);
    const modelDirectory = path.join(root, "models");
    mkdirSync(modelDirectory, { recursive: true });
    const files = EMBEDDING_GEMMA2_TIER_FILES.Q4_K_XL;
    writeFileSync(path.join(modelDirectory, files.coreFile), "fixture");
    writeFileSync(path.join(modelDirectory, files.projectorFile), "fixture");
    const runtimePath = path.join(root, "fake-runtime");
    writeFileSync(runtimePath, "fixture runtime");
    const cleanupFailure = new AggregateError([new Error("fixture cleanup failed")]);
    const requestWorker = vi.fn(async (command: WorkerCommand): Promise<WorkerResult> => {
      if (command.type === "semantic.index.begin") return {
        ok: true, type: "semantic.index.started", profileId: "a".repeat(64), nativeCosineAvailable: false,
      };
      if (command.type === "semantic.index.import-legacy") return {
        ok: true, type: "semantic.index.legacy-imported", attempted: true, acceptedRows: 0, rejectedRows: 0,
      };
      if (command.type === "semantic.index.close") return { ok: true, type: "semantic.index.closed" };
      throw new Error(`Unexpected Worker command: ${command.type}`);
    });
    const startSession = vi.fn<(options: Parameters<typeof startLlamaEmbeddingSession>[0]) => Promise<never>>(async () => {
      throw cleanupFailure;
    });
    const index = new EmbeddingTestIndex({
      configDirectories: [],
      installedLayout: () => ({ modelDirectory, runtimePath }),
      requestWorker,
      startSession,
    });

    index.handleStatus({ libraryId: "library-cleanup", modelId: "embeddinggemma-2-compact", run: true, restart: false });
    await vi.waitFor(() => {
      expect(index.handleStatus({ libraryId: "library-cleanup", modelId: "embeddinggemma-2-compact", run: false, restart: false }))
        .toMatchObject({ ok: true, type: "embedding.index.status", phase: "failed" });
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession.mock.calls[0]?.[0]).toMatchObject({ gpuLayers: 99 });
    await expect(index.close()).rejects.toBe(cleanupFailure);
  });
});
