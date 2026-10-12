import { describe, expect, it, vi } from "vitest";

import type { WorldlineBoxLibraryApi } from "../../src/shared/library-api";
import { createTrackedLibraryApi } from "../../src/renderer/tracked-library-api";

describe("createTrackedLibraryApi", () => {
  it("tracks mutating requests until their promise settles", async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const api = {
      trashAssets: vi.fn(async () => ({ ok: true, value: { trashedCount: 1 } })),
      listAssets: vi.fn(async () => ({ ok: true, value: [] })),
    } as unknown as WorldlineBoxLibraryApi;
    const tracked = createTrackedLibraryApi(
      api,
      () => starts.push("start"),
      () => ends.push("end"),
    );

    const result = await tracked.trashAssets({ libraryId: "library", assetIds: ["asset"] });
    await tracked.listAssets({ libraryId: "library", recursive: true });

    expect(result.ok).toBe(true);
    expect(starts).toEqual(["start"]);
    expect(ends).toEqual(["end"]);
    expect(api.trashAssets).toHaveBeenCalledTimes(1);
    expect(api.listAssets).toHaveBeenCalledTimes(1);
  });

  it("does not queue cancelLibraryImport behind an in-flight import write", async () => {
    let releaseImport: (() => void) | undefined;
    let resolveImportStarted: (() => void) | undefined;
    const importStarted = new Promise<void>((resolve) => {
      resolveImportStarted = resolve;
    });
    const order: string[] = [];
    const api = {
      importFiles: vi.fn(async () => {
        resolveImportStarted?.();
        await new Promise<void>((resolve) => {
          releaseImport = resolve;
        });
        order.push("import");
        return { ok: true, value: { importId: "import-1" } };
      }),
      cancelLibraryImport: vi.fn(async () => {
        order.push("cancel");
        return { ok: true, value: { importId: "import-1" } };
      }),
    } as unknown as WorldlineBoxLibraryApi;

    let writeChain = Promise.resolve();
    const runWrite = <T,>(operation: () => Promise<T>): Promise<T> => {
      const run = writeChain.then(operation, operation);
      writeChain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    const tracked = createTrackedLibraryApi(api, vi.fn(), vi.fn(), runWrite);

    const importPromise = tracked.importFiles({
      libraryId: "library",
    });
    await importStarted;
    await tracked.cancelLibraryImport({ importId: "import-1", mode: "stop" });

    expect(order).toEqual(["cancel"]);
    expect(api.cancelLibraryImport).toHaveBeenCalledTimes(1);
    releaseImport?.();
    await importPromise;
    expect(order).toEqual(["cancel", "import"]);
  });

  it("can wrap the frozen preload bridge without violating Proxy invariants", async () => {
    const onWriteStart = vi.fn();
    const onWriteEnd = vi.fn();
    const api = Object.freeze({
      trashAssets: async () => ({ ok: true, value: { trashedCount: 1 } }),
    }) as unknown as WorldlineBoxLibraryApi;
    const tracked = createTrackedLibraryApi(api, onWriteStart, onWriteEnd);

    await expect(
      tracked.trashAssets({ libraryId: "library", assetIds: ["asset"] }),
    ).resolves.toMatchObject({ ok: true });
    expect(onWriteStart).toHaveBeenCalledTimes(1);
    expect(onWriteEnd).toHaveBeenCalledTimes(1);
  });

  it("releases the write lease when a mutating request throws synchronously", () => {
    const onWriteStart = vi.fn();
    const onWriteEnd = vi.fn();
    const api = {
      trashAssets: () => {
        throw new Error("bridge unavailable");
      },
    } as unknown as WorldlineBoxLibraryApi;
    const tracked = createTrackedLibraryApi(api, onWriteStart, onWriteEnd);

    expect(() => tracked.trashAssets({ libraryId: "library", assetIds: [] })).toThrow(
      "bridge unavailable",
    );
    expect(onWriteStart).toHaveBeenCalledTimes(1);
    expect(onWriteEnd).toHaveBeenCalledTimes(1);
  });
});
