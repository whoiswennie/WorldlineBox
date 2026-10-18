import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  deleteEmbeddingModel,
  emptyEmbeddingModelCatalog,
  parseEmbeddingModelCatalog,
  setDefaultEmbeddingModel,
  summarizeEmbeddingModels,
  upsertEmbeddingModel,
  type EmbeddingModelCatalog,
} from "../../src/main/embedding-model-catalog";
import { tryHandleEmbeddingModelRequest } from "../../src/main/library-request/embedding-models";
import {
  channelEnabled,
  embeddingProfileKey,
  formatEmbeddingSearchQuery,
  fuseRanks,
  normalizeEmbedding,
} from "../../src/shared/embedding/profile";
import { rendererRequestSchema } from "../../src/shared/protocol/requests";
import { rendererResultSchema } from "../../src/shared/protocol/responses";

const sample = {
  id: "model-1",
  name: "Local Q4",
  tier: "Q4_K_XL" as const,
  modelDirectory: "model-dir",
  runtimePath: "runtime-bin",
};

describe("embedding profile", () => {
  it("keeps the profile key independent of the device path", () => {
    expect(embeddingProfileKey("Q4_K_XL")).toBe(embeddingProfileKey("Q4_K_XL"));
    expect(embeddingProfileKey("Q4_K_XL")).not.toBe(embeddingProfileKey("BF16"));
  });

  it("prefixes text queries and rejects unverified image search", () => {
    expect(formatEmbeddingSearchQuery("red square")).toBe("task: search result | query: red square");
    expect(channelEnabled([], "image")).toBe(false);
    expect(channelEnabled(["image"], "image")).toBe(true);
  });

  it("normalizes a finite vector and fuses ranks without mixing raw scores", () => {
    expect(normalizeEmbedding([3, 4, ...Array.from({ length: 766 }, () => 0)])[0]).toBeCloseTo(0.6);
    expect(() => normalizeEmbedding([Number.NaN])).toThrow(/non-finite|length/);
    expect(fuseRanks([["a", "b"], ["b", "a"]], 60)).toEqual([
      { id: "a", score: 1 / 61 + 1 / 62 },
      { id: "b", score: 1 / 62 + 1 / 61 },
    ]);
  });
});

describe("embedding model catalog", () => {
  it("checks installation and uninstalls without inspecting home or mapped-drive roots", async () => {
    const userData = mkdtempSync(path.join(tmpdir(), "worldlinebox-managed-embedding-"));
    const models = path.join(userData, "embedding-models");
    mkdirSync(path.join(models, "runtime"), { recursive: true });
    writeFileSync(path.join(models, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "core");
    writeFileSync(path.join(models, "mmproj-Q8_0.gguf"), "projector");
    writeFileSync(path.join(models, "runtime", "llama-server.exe"), "runtime");
    const homePath = vi.fn(() => { throw new Error("Unavailable mapped home drive must not be probed."); });
    const runtime = {
      readCatalog: () => null, writeCatalog: () => undefined,
      userDataPath: () => userData, homePath,
    };
    try {
      const status = await tryHandleEmbeddingModelRequest({ type: "embedding.install.status.request" }, runtime);
      expect(status).toMatchObject({ ok: true, type: "embedding.install.status", runtimeInstalled: true });
      if (!status?.ok || status.type !== "embedding.install.status") throw new Error("status failed");
      expect(status.models.find((model) => model.modelId === "embeddinggemma-2-compact")?.installed).toBe(true);
      // An already installed tier must also resolve without a discovery scan or download.
      expect(await tryHandleEmbeddingModelRequest({
        type: "embedding.install.start.request", modelId: "embeddinggemma-2-compact",
      }, runtime)).toEqual(status);
      const removed = await tryHandleEmbeddingModelRequest({
        type: "embedding.install.delete.request", modelId: "embeddinggemma-2-compact",
      }, runtime);
      expect(removed).toMatchObject({ ok: true, type: "embedding.install.status", runtimeInstalled: true });
      if (!removed?.ok || removed.type !== "embedding.install.status") throw new Error("uninstall failed");
      expect(removed.models.find((model) => model.modelId === "embeddinggemma-2-compact")?.installed).toBe(false);
      expect(homePath).not.toHaveBeenCalled();
    } finally {
      rmSync(userData, { recursive: true, force: true });
    }
  });

  it("stores a local registration and clears verification when the files change", () => {
    const saved = upsertEmbeddingModel(emptyEmbeddingModelCatalog(), sample);
    const verified = {
      ...saved,
      models: saved.models.map((model) => ({ ...model, verifiedChannels: ["image" as const] })),
    };
    const renamed = upsertEmbeddingModel(verified, { ...sample, name: "Renamed" });
    expect(renamed.models[0]?.verifiedChannels).toEqual(["image"]);
    const moved = upsertEmbeddingModel(verified, { ...sample, modelDirectory: "other-dir" });
    expect(moved.models[0]?.verifiedChannels).toEqual([]);
    expect(summarizeEmbeddingModels(renamed)[0]).toMatchObject({
      declaredChannels: ["text", "image"],
      isDefault: false,
      profileKey: embeddingProfileKey("Q4_K_XL"),
    });
  });

  it("drops a corrupt catalog and refuses an unknown default", () => {
    expect(parseEmbeddingModelCatalog({ models: [{ id: "bad" }] }).models).toEqual([]);
    expect(() => setDefaultEmbeddingModel(emptyEmbeddingModelCatalog(), "missing")).toThrow(/missing-model/);
    const saved = upsertEmbeddingModel(emptyEmbeddingModelCatalog(), sample);
    const withDefault = setDefaultEmbeddingModel(saved, sample.id);
    expect(deleteEmbeddingModel(withDefault, sample.id).defaultModelId).toBeNull();
  });

  it("round-trips list, save, default, and delete without a library database", async () => {
    let stored: unknown = null;
    const runtime = {
      readCatalog: () => stored,
      writeCatalog: (catalog: EmbeddingModelCatalog) => {
        stored = catalog;
      },
      userDataPath: () => "user-data",
      homePath: () => "home",
    };
    const saved = await tryHandleEmbeddingModelRequest({
      type: "embedding.models.upsert.request",
      ...sample,
    }, runtime);
    expect(saved).toMatchObject({ ok: true, type: "embedding.model.saved", id: sample.id });
    const listed = await tryHandleEmbeddingModelRequest({ type: "embedding.models.list.request" }, runtime);
    expect(listed).toMatchObject({ ok: true, type: "embedding.models.listed" });
    if (!listed?.ok || listed.type !== "embedding.models.listed") throw new Error("list failed");
    expect(listed.models[0]?.verifiedChannels).toEqual([]);
    expect(JSON.stringify(stored)).not.toContain("library.db");

    const invalid = await tryHandleEmbeddingModelRequest({
      type: "embedding.models.upsert.request",
      ...sample,
      name: " ",
    }, runtime);
    expect(rendererRequestSchema.safeParse({
      type: "embedding.models.upsert.request",
      ...sample,
      name: " ",
    }).success).toBe(false);
    expect(invalid?.ok).toBe(false);

    const chosen = await tryHandleEmbeddingModelRequest({
      type: "embedding.models.set-default.request",
      id: sample.id,
    }, runtime);
    expect(rendererResultSchema.safeParse(chosen).success).toBe(true);
    const removed = await tryHandleEmbeddingModelRequest({
      type: "embedding.models.delete.request",
      id: sample.id,
    }, runtime);
    expect(removed).toMatchObject({ ok: true, type: "embedding.model.deleted" });
    expect(parseEmbeddingModelCatalog(stored).models).toEqual([]);
  });

  it("stops both library indexes explicitly without creating an index or returning before cleanup", async () => {
    let finishLocal: (() => void) | undefined;
    let finishRemote: (() => void) | undefined;
    const stopGemmaIndex = vi.fn(() => new Promise<void>((resolve) => { finishLocal = resolve; }));
    const stopHttpIndex = vi.fn(() => new Promise<void>((resolve) => { finishRemote = resolve; }));
    const runtime = {
      readCatalog: () => null, writeCatalog: () => undefined,
      userDataPath: () => "user-data", homePath: () => "home",
      stopGemmaIndex, stopHttpIndex,
      get embeddingIndex(): never { throw new Error("Stop must not create a local index."); },
      get embeddingHttpIndex(): never { throw new Error("Stop must not create a remote index."); },
    };
    let completed = false;
    const stopping = tryHandleEmbeddingModelRequest({
      type: "embedding.index.status.request", libraryId: "library-one",
      modelId: "embeddinggemma-2-compact", run: true, restart: false, stop: true,
    }, runtime).then((result) => { completed = true; return result; });
    expect(stopGemmaIndex).toHaveBeenCalledWith("library-one");
    expect(stopHttpIndex).toHaveBeenCalledWith("library-one");
    finishLocal?.();
    await Promise.resolve();
    expect(completed).toBe(false);
    finishRemote?.();
    expect(await stopping).toMatchObject({ type: "embedding.index.status", phase: "unavailable" });
  });

  it("awaits local and remote cleanup for the changed library binding", async () => {
    let releaseLocal: (() => void) | undefined;
    const stopGemmaIndex = vi.fn(() => new Promise<void>((resolve) => { releaseLocal = resolve; }));
    const stopHttpIndex = vi.fn(async () => undefined);
    const writeBindings = vi.fn();
    const runtime = {
      readCatalog: () => null, writeCatalog: () => undefined,
      userDataPath: () => "user-data", homePath: () => "home",
      readBindings: () => ({}), writeBindings, stopGemmaIndex, stopHttpIndex,
    };
    let completed = false;
    const saving = tryHandleEmbeddingModelRequest({
      type: "embedding.binding.save.request", libraryId: "library-one", selectionId: null,
    }, runtime).then((result) => { completed = true; return result; });
    expect(writeBindings).toHaveBeenCalledWith({ "library-one": { selectionId: null, enabled: false } });
    expect(stopGemmaIndex).toHaveBeenCalledWith("library-one");
    expect(stopHttpIndex).toHaveBeenCalledWith("library-one");
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseLocal?.();
    expect(await saving).toMatchObject({ type: "embedding.binding", enabled: false });
  });

  it("returns an index snapshot for run:false without stopping either index", async () => {
    const stops: string[] = [];
    const httpStatus = {
      ok: true as const,
      type: "embedding.index.status" as const,
      phase: "ready" as const,
      done: 3,
      total: 3,
      failedCount: 0,
    };
    const gemmaStatus = {
      ok: true as const,
      type: "embedding.index.status" as const,
      phase: "indexing" as const,
      done: 1,
      total: 4,
      failedCount: 0,
    };
    const runtime = {
      readCatalog: () => null,
      writeCatalog: () => undefined,
      userDataPath: () => "user-data",
      homePath: () => "home",
      stopGemmaIndex: () => { stops.push("gemma"); },
      stopHttpIndex: () => { stops.push("http"); },
      embeddingHttpIndex: {
        handleStatus: () => httpStatus,
      },
      embeddingIndex: {
        handleStatus: () => gemmaStatus,
      },
    };
    const http = await tryHandleEmbeddingModelRequest({
      type: "embedding.index.status.request",
      libraryId: "lib-1",
      modelId: "svc_textonly1",
      run: false,
      restart: false,
    }, runtime as never);
    expect(http).toEqual(httpStatus);
    expect(stops).toEqual([]);

    const gemma = await tryHandleEmbeddingModelRequest({
      type: "embedding.index.status.request",
      libraryId: "lib-1",
      modelId: "embeddinggemma-2-compact",
      run: false,
      restart: false,
    }, runtime as never);
    expect(gemma).toEqual(gemmaStatus);
    expect(stops).toEqual([]);
  });
});
