import { describe, expect, it } from "vitest";

import {
  clearEmbeddingBinding,
  embeddingBindingIssue,
  parseEmbeddingBindings,
  resolveEffectiveEmbeddingSelection,
  writeEmbeddingBinding,
} from "../../src/shared/embedding/library-binding";

describe("embedding library binding", () => {
  it("turns a library on for one selection and off when cleared", () => {
    const saved = writeEmbeddingBinding({}, "library-1", "embeddinggemma-2-compact");
    expect(saved["library-1"]).toEqual({ selectionId: "embeddinggemma-2-compact", enabled: true });
    expect(writeEmbeddingBinding(saved, "library-1", null)["library-1"]).toEqual({
      selectionId: null,
      enabled: false,
    });
    expect(writeEmbeddingBinding(saved, "library-1", "not-a-model")).toBe(saved);
  });

  it("reports install, missing, and configure instead of treating every saved id as ready", () => {
    const services = new Map([
      ["svc_readytext", { textStatus: "verified", dimensions: 1024 }],
      ["svc_needstest", { textStatus: "declared", dimensions: 1024 }],
    ]);
    expect(embeddingBindingIssue({
      binding: { selectionId: "embeddinggemma-2-compact", enabled: true },
      services,
      runtimeInstalled: false,
      installedModelIds: new Set(),
    })).toBe("install");
    expect(embeddingBindingIssue({
      binding: { selectionId: "svc_missing1", enabled: true },
      services,
      runtimeInstalled: true,
      installedModelIds: new Set(["embeddinggemma-2-compact"]),
    })).toBe("missing");
    expect(embeddingBindingIssue({
      binding: { selectionId: "svc_needstest", enabled: true },
      services,
      runtimeInstalled: true,
      installedModelIds: new Set(),
    })).toBe("configure");
    expect(embeddingBindingIssue({
      binding: { selectionId: "svc_readytext", enabled: true },
      services,
      runtimeInstalled: true,
      installedModelIds: new Set(),
    })).toBe("ready");
    expect(parseEmbeddingBindings({ "library-1": { selectionId: "nope", enabled: true } })["library-1"])
      .toEqual({ selectionId: null, enabled: false });
  });
});


describe("effective embedding selection", () => {
  it("stays off when the global switch is off", () => {
    expect(resolveEffectiveEmbeddingSelection({
      globalEnabled: false,
      defaultModelId: "embeddinggemma-2-compact",
      libraryBinding: undefined,
    })).toBeNull();
    expect(resolveEffectiveEmbeddingSelection({
      globalEnabled: false,
      defaultModelId: "embeddinggemma-2-compact",
      libraryBinding: { selectionId: "embeddinggemma-2-compact", enabled: true },
    })).toBeNull();
  });

  it("uses the settings default when the library has no override", () => {
    expect(resolveEffectiveEmbeddingSelection({
      globalEnabled: true,
      defaultModelId: "embeddinggemma-2-compact",
      libraryBinding: undefined,
    })).toBe("embeddinggemma-2-compact");
  });

  it("uses the library selection when set, and respects an explicit off", () => {
    expect(resolveEffectiveEmbeddingSelection({
      globalEnabled: true,
      defaultModelId: "embeddinggemma-2-compact",
      libraryBinding: { selectionId: "svc_readytext", enabled: true },
    })).toBe("svc_readytext");
    expect(resolveEffectiveEmbeddingSelection({
      globalEnabled: true,
      defaultModelId: "embeddinggemma-2-compact",
      libraryBinding: { selectionId: null, enabled: false },
    })).toBeNull();
  });

  it("clears a library override so it can inherit again", () => {
    const saved = writeEmbeddingBinding({}, "library-1", "embeddinggemma-2-compact");
    expect(clearEmbeddingBinding(saved, "library-1")).toEqual({});
  });
});
