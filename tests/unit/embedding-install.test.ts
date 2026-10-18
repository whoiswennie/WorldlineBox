import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  embeddingDownloadUrl,
  embeddingInstallBytes,
  embeddingModelsDirectory,
  inspectManagedEmbeddingInstall,
  installedSemanticModels,
  pinnedLlamaRuntimeUrl,
  resolveInstalledEmbeddingLayout,
  runtimeArchiveEntryAllowed,
  semanticModelPackageBytes,
  downloadEmbeddingFile,
  uninstallSemanticModelFiles,
} from "../../src/main/embedding-install";
import { EMBEDDING_GEMMA2_MODEL_REVISION } from "../../src/shared/embedding/profile";

describe("embedding install lookup", () => {
  it("treats a tier as installed only when both of its files are present", () => {
    expect(installedSemanticModels(new Set([
      "embeddinggemma-2-UD-Q4_K_XL.gguf",
      "mmproj-Q8_0.gguf",
    ]))).toEqual(["embeddinggemma-2-compact"]);
    expect(installedSemanticModels(new Set(["embeddinggemma-2-UD-Q4_K_XL.gguf"]))).toEqual([]);
  });

  it("reads managed weights and runtime without traversing unrelated caches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-embedding-"));
    const elsewhere = path.join(root, "embeddinggemma-cache", "models");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "");
    writeFileSync(path.join(elsewhere, "mmproj-Q8_0.gguf"), "");
    writeFileSync(path.join(elsewhere, "llama-server.exe"), "");
    const missing = inspectManagedEmbeddingInstall(root);
    expect(installedSemanticModels(new Set(missing.files.keys()))).toEqual([]);
    expect(missing.runtimeFound).toBe(false);

    const models = embeddingModelsDirectory(root);
    mkdirSync(models, { recursive: true });
    writeFileSync(path.join(models, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "");
    writeFileSync(path.join(models, "mmproj-Q8_0.gguf"), "");
    mkdirSync(path.join(models, "runtime", "build"), { recursive: true });
    writeFileSync(path.join(models, "runtime", "build", "llama-server.exe"), "");

    const found = inspectManagedEmbeddingInstall(root);
    expect(installedSemanticModels(new Set(found.files.keys()))).toContain("embeddinggemma-2-compact");
    expect(found.runtimeFound).toBe(true);
    expect(resolveInstalledEmbeddingLayout(found, "embeddinggemma-2-compact", "win32")?.modelDirectory).toBe(models);
    expect(resolveInstalledEmbeddingLayout(found, "embeddinggemma-2-quality", "win32")).toBeNull();
  });

  it("builds the pinned download address", () => {
    expect(embeddingDownloadUrl("embeddinggemma-2-UD-Q4_K_XL.gguf")).toBe(
      `https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/${EMBEDDING_GEMMA2_MODEL_REVISION}/embeddinggemma-2-UD-Q4_K_XL.gguf`,
    );
    expect(pinnedLlamaRuntimeUrl("llama-b11457-bin-macos-arm64.tar.gz")).toMatch(/^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\/b11457\//);
    expect(runtimeArchiveEntryAllowed("../llama-server")).toBe(false);
    expect(runtimeArchiveEntryAllowed("build/bin/llama-server")).toBe(true);
  });

  it("reserves space for a missing runtime and resolves the installed compact layout", () => {
    expect(embeddingInstallBytes({
      modelId: "embeddinggemma-2-compact",
      alreadyFound: new Set(["embeddinggemma-2-UD-Q4_K_XL.gguf", "mmproj-Q8_0.gguf"]),
      runtimeFound: false,
      platform: "darwin",
      arch: "arm64",
    })).toBeGreaterThan(0);
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-embedding-layout-"));
    const models = embeddingModelsDirectory(root);
    mkdirSync(path.join(models, "runtime"), { recursive: true });
    writeFileSync(path.join(models, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "");
    writeFileSync(path.join(models, "mmproj-Q8_0.gguf"), "");
    writeFileSync(path.join(models, "runtime", "llama-server"), "");
    const inspection = inspectManagedEmbeddingInstall(root);
    expect(resolveInstalledEmbeddingLayout(inspection, "embeddinggemma-2-compact", "darwin")?.modelDirectory).toBe(models);
    expect(resolveInstalledEmbeddingLayout(inspection, "embeddinggemma-2-quality", "darwin")).toBeNull();
  });
});


describe("embedding install download sizing", () => {
  it("quotes a compact package size for settings labels", () => {
    expect(semanticModelPackageBytes("embeddinggemma-2-compact")).toBeGreaterThan(600_000_000);
    expect(embeddingInstallBytes({
      modelId: "embeddinggemma-2-compact",
      alreadyFound: new Set(),
      runtimeFound: false,
      platform: "darwin",
      arch: "arm64",
    })).toBeGreaterThan(600_000_000);
  });

  it("falls back across github mirrors when the first candidate fails", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-embed-dl-"));
    const destination = path.join(root, "llama.tar.gz");
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      attempts += 1;
      const url = String(input);
      if (attempts === 1) {
        return new Response("nope", { status: 502 });
      }
      expect(url.includes("ghproxy")).toBe(true);
      return new Response(Uint8Array.from([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4" },
      });
    }) as typeof fetch;
    try {
      await downloadEmbeddingFile(
        "https://github.com/ggml-org/llama.cpp/releases/download/b11457/llama-b11457-bin-macos-arm64.tar.gz",
        destination,
        { stallTimeoutMs: 200 },
      );
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(readFileSync(destination).byteLength).toBe(4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe("embedding uninstall", () => {
  it("removes model files under userData/embedding-models and keeps shared projectors when needed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-embedding-uninstall-"));
    const models = path.join(root, "embedding-models");
    mkdirSync(models, { recursive: true });
    writeFileSync(path.join(models, "embeddinggemma-2-UD-Q4_K_XL.gguf"), "core");
    writeFileSync(path.join(models, "mmproj-Q8_0.gguf"), "proj");
    writeFileSync(path.join(models, "embeddinggemma-2-Q8_0.gguf"), "balanced");

    const removedCompact = uninstallSemanticModelFiles({
      modelId: "embeddinggemma-2-compact",
      userDataPath: root,
    });
    expect(removedCompact.removed.some((item) => item.endsWith("embeddinggemma-2-UD-Q4_K_XL.gguf"))).toBe(true);
    // Shared projector stays because balanced is still present.
    expect(removedCompact.removed.some((item) => item.endsWith("mmproj-Q8_0.gguf"))).toBe(false);
    expect(readFileSync(path.join(models, "mmproj-Q8_0.gguf"), "utf8")).toBe("proj");

    const removedBalanced = uninstallSemanticModelFiles({
      modelId: "embeddinggemma-2-balanced",
      userDataPath: root,
    });
    expect(removedBalanced.removed.some((item) => item.endsWith("embeddinggemma-2-Q8_0.gguf"))).toBe(true);
    expect(removedBalanced.removed.some((item) => item.endsWith("mmproj-Q8_0.gguf"))).toBe(true);
  });
});
