import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  LibraryService,
  LibraryServiceError,
} from "../../src/worker/library-service";

const require = createRequire(import.meta.url);
const TestDatabase = require("better-sqlite3") as new (filename: string) => {
  close(): void;
  prepare(source: string): {
    all(...parameters: unknown[]): unknown[];
  };
};

const roots: string[] = [];
const services: LibraryService[] = [];

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-sequence-"));
  roots.push(root);
  const service = new LibraryService();
  services.push(service);
  const library = service.createLibrary({
    displayName: "Sequences",
    selectedParentPath: root,
  });
  return { library, root, service };
}

function writeFrames(directory: string, names: readonly string[]): string[] {
  mkdirSync(directory, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4kKBwIEGBAUIBACWOBQHzNCW5AAAAAElFTkSuQmCC",
    "base64",
  );
  return names.map((name) => {
    const filePath = path.join(directory, name);
    writeFileSync(filePath, png);
    return filePath;
  });
}

async function writePngFrames(
  directory: string,
  names: readonly string[],
  size: { width: number; height: number },
): Promise<string[]> {
  mkdirSync(directory, { recursive: true });
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(directory, name);
      await sharp({
        create: {
          background: { b: 32, g: 96, r: 192 },
          channels: 3,
          height: size.height,
          width: size.width,
        },
      })
        .png()
        .toFile(filePath);
      return filePath;
    }),
  );
}

/** Distinct-byte PNG frames, so separate imports are never duplicate suspects. */
async function writeDistinctFrames(
  directory: string,
  names: readonly string[],
  size: { width: number; height: number },
  seed = 0,
): Promise<string[]> {
  mkdirSync(directory, { recursive: true });
  return Promise.all(
    names.map(async (name, index) => {
      const filePath = path.join(directory, name);
      await sharp({
        create: {
          background: { b: 32, g: 96, r: 190 + seed + index },
          channels: 3,
          height: size.height,
          width: size.width,
        },
      })
        .png()
        .toFile(filePath);
      return filePath;
    }),
  );
}

afterEach(() => {
  for (const service of services.splice(0)) service.closeAll();
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("image sequence persistence", () => {
  it("offers a sequence only when every candidate frame has matching dimensions", async () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "source");
    const frames = await writePngFrames(
      source,
      ["shot_001.png", "shot_002.png", "shot_003.png"],
      { height: 2, width: 2 },
    );
    await sharp({
      create: {
        background: { b: 32, g: 96, r: 192 },
        channels: 3,
        height: 3,
        width: 2,
      },
    })
      .png()
      .toFile(frames[1]!);

    await expect(
      service.probeImageSequenceImportOffer({
        libraryId: library.libraryId,
        sourcePaths: [frames[0]!],
      }),
    ).resolves.toBeNull();

    await writePngFrames(source, ["shot_002.png"], { height: 2, width: 2 });
    const offer = await service.probeImageSequenceImportOffer({
      libraryId: library.libraryId,
      sourcePaths: [frames[0]!],
    });
    expect(offer?.sequences).toHaveLength(1);
    expect(offer?.sequences[0]).toMatchObject({
      frameCount: 3,
      height: 2,
      width: 2,
    });
  });

  it("does not auto-group a folder import when frame dimensions differ", async () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "mismatched");
    const frames = await writePngFrames(
      source,
      ["shot_001.png", "shot_002.png", "shot_003.png"],
      { height: 2, width: 2 },
    );
    await sharp({
      create: {
        background: { b: 32, g: 96, r: 192 },
        channels: 3,
        height: 3,
        width: 2,
      },
    })
      .png()
      .toFile(frames[1]!);

    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "folder",
      sourcePaths: [source],
    });
    expect("importId" in completion).toBe(false);
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(3);
    expect(assets.every((asset) => asset.sequence === null)).toBe(true);
  });

  it("keeps a normal file import as separate assets when sequence creation is disabled", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "still_001.png",
      "still_002.png",
      "still_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      createImageSequence: false,
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
    });
    expect("importId" in completion).toBe(false);
    expect(
      service.listAssets({ libraryId: library.libraryId, recursive: true }),
    ).toHaveLength(3);
  });

  it("imports a mixed multi-file and multi-folder selection", () => {
    const { library, root, service } = fixture();
    const selectedFolder = path.join(root, "selected-folder");
    const otherFolder = path.join(root, "other-folder");
    writeFrames(selectedFolder, ["inside.png"]);
    writeFrames(otherFolder, ["other.png"]);
    writeFileSync(path.join(selectedFolder, "inside.png"), "inside-bytes");
    writeFileSync(path.join(otherFolder, "other.png"), "other-bytes");
    const standalone = path.join(root, "standalone.txt");
    writeFileSync(standalone, "standalone");

    const completion = service.prepareOrExecuteImport({
      createImageSequence: false,
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: [selectedFolder, otherFolder, standalone],
    });

    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    expect(completion.importedCount).toBe(3);
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets.map((asset) => asset.displayName)).toEqual(
      expect.arrayContaining(["inside.png", "other.png", "standalone.txt"]),
    );
  });

  it("expands a single selected frame to its continuous sibling run", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "shot_001.png",
      "shot_002.png",
      "shot_003.png",
      "shot_005.png",
    ]);

    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: [frames[1]!],
      expandImageSequences: true,
      imageSequenceFps: 30,
    });

    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    expect(completion.importedCount).toBe(3);
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]!.displayName).toBe("shot_001~003");
    expect(assets[0]!.sequence).toMatchObject({
      fps: 30,
      frameCount: 3,
      frames: [
        {
          frameNumber: 1,
          displayName: "shot_001.png",
          previewKind: "source",
          previewRevisionId: expect.any(String),
        },
        {
          frameNumber: 2,
          displayName: "shot_002.png",
          previewKind: "source",
          previewRevisionId: expect.any(String),
        },
        {
          frameNumber: 3,
          displayName: "shot_003.png",
          previewKind: "source",
          previewRevisionId: expect.any(String),
        },
      ],
    });
  });

  it("does not flag identical-byte sequence frames as content duplicates", () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "source");
    mkdirSync(source, { recursive: true });
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4kKBwIEGBAUIBACWOBQHzNCW5AAAAAElFTkSuQmCC",
      "base64",
    );
    const frames = ["spark_000.png", "spark_001.png", "spark_002.png"].map(
      (name) => {
        const filePath = path.join(source, name);
        writeFileSync(filePath, bytes);
        return filePath;
      },
    );

    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    expect(completion.importedCount).toBe(3);
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(1);
    expect(assets[0]!.sequence?.frameCount).toBe(3);
  });

  it("trashes a sequence as one visible trash card and restores the group", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "clip_001.png",
      "clip_002.png",
      "clip_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    const [primary] = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(primary?.sequence?.frameCount).toBe(3);

    service.trashAssets({
      libraryId: library.libraryId,
      assetIds: [primary!.assetId],
    });
    expect(
      service
        .listAssets({ libraryId: library.libraryId, recursive: true })
        .filter((asset) => !asset.deletedAt),
    ).toHaveLength(0);
    const trash = service.listTrash(library.libraryId);
    expect(trash).toHaveLength(1);
    expect(trash[0]!.sequence?.frameCount).toBe(3);
    expect(trash[0]!.displayName).toBe("clip_001~003");

    service.restoreAssets({
      libraryId: library.libraryId,
      assetIds: [trash[0]!.assetId],
    });
    expect(service.listTrash(library.libraryId)).toHaveLength(0);
    const restored = service
      .listAssets({ libraryId: library.libraryId, recursive: true })
      .filter((asset) => !asset.deletedAt);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.sequence?.frameCount).toBe(3);
  });

  it("does not regroup dissolved frames when restoring them from trash", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "clip_001.png",
      "clip_002.png",
      "clip_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    const [primary] = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(primary?.sequence?.frameCount).toBe(3);
    service.dissolveImageSequence({
      libraryId: library.libraryId,
      sequenceId: primary!.sequence!.sequenceId,
    });
    const singles = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(singles).toHaveLength(3);

    service.trashAssets({
      libraryId: library.libraryId,
      assetIds: singles.map((asset) => asset.assetId),
    });
    const trash = service.listTrash(library.libraryId);
    expect(trash).toHaveLength(3);
    service.restoreAssets({
      libraryId: library.libraryId,
      assetIds: trash.map((asset) => asset.assetId),
    });

    const restored = service
      .listAssets({ libraryId: library.libraryId, recursive: true })
      .filter((asset) => !asset.deletedAt);
    expect(restored).toHaveLength(3);
    expect(restored.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("splits folder-import gaps into separate visible sequence cards", () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "source");
    writeFrames(source, [
      "img_1.png",
      "img_2.png",
      "img_3.png",
      "img_5.png",
      "img_6.png",
      "img_7.png",
    ]);

    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "folder",
      sourcePaths: [source],
    });
    expect("importId" in completion).toBe(false);
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(2);
    expect(assets.map((asset) =>
      asset.sequence?.frames.map((frame) => frame.frameNumber),
    )).toEqual([[1, 2, 3], [5, 6, 7]]);
  });

  it("leaves linked frames as separate files when the folder is imported", () => {
    const { library, root, service } = fixture();
    const linkedRoot = path.join(root, "linked-sequence");
    writeFrames(linkedRoot, ["capture_0.png", "capture_1.png", "capture_2.png"]);
    service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: linkedRoot,
    });

    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(3);
    expect(assets.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("does not auto-group linked frames that arrive after import", () => {
    const { library, root, service } = fixture();
    const linkedRoot = path.join(root, "linked-later");
    mkdirSync(linkedRoot, { recursive: true });
    service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: linkedRoot,
    });

    writeFrames(linkedRoot, ["capture_0.png", "capture_1.png", "capture_2.png"]);
    service.refreshManagedAssets(library.libraryId);

    const afterRefresh = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(afterRefresh).toHaveLength(3);
    expect(afterRefresh.every((asset) => asset.sequence == null)).toBe(true);

    const primary = service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: afterRefresh.map((asset) => asset.assetId),
      fps: 30,
    });
    expect(primary.sequence?.frameCount).toBe(3);
  });

  function importedThenDissolvedLinkedSequence(
    folderName: string,
    frames: readonly string[],
  ) {
    const { library, root, service } = fixture();
    const linkedRoot = path.join(root, folderName);
    writeFrames(linkedRoot, frames);
    service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: linkedRoot,
    });
    const imported = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(imported).toHaveLength(frames.length);
    const grouped = service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: imported.map((asset) => asset.assetId),
      fps: 30,
    });
    service.dissolveImageSequence({
      libraryId: library.libraryId,
      sequenceId: grouped.sequence!.sequenceId,
    });
    expect(service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    })).toHaveLength(frames.length);
    return { library, linkedRoot, service };
  }

  it("does not regroup dissolved frames when a linked folder later gains a file", () => {
    const { library, linkedRoot, service } = importedThenDissolvedLinkedSequence(
      "linked-sequence",
      ["capture_0.png", "capture_1.png", "capture_2.png"],
    );

    writeFrames(linkedRoot, ["sidecar.png"]);
    service.refreshManagedAssets(library.libraryId);

    const after = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(after).toHaveLength(4);
    expect(after.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("does not regroup dissolved frames after a disk content refresh", async () => {
    const { library, root, service } = fixture();
    const linkedRoot = path.join(root, "linked-content");
    await writePngFrames(
      linkedRoot,
      ["clip_0.png", "clip_1.png", "clip_2.png"],
      { height: 2, width: 2 },
    );
    service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: linkedRoot,
    });

    const imported = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(imported).toHaveLength(3);
    const grouped = service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: imported.map((asset) => asset.assetId),
      fps: 30,
    });
    service.dissolveImageSequence({
      libraryId: library.libraryId,
      sequenceId: grouped.sequence!.sequenceId,
    });

    await sharp({
      create: {
        background: { b: 8, g: 16, r: 240 },
        channels: 3,
        height: 2,
        width: 2,
      },
    })
      .png()
      .toFile(path.join(linkedRoot, "clip_0.png"));
    service.refreshManagedAssets(library.libraryId);

    const after = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(after).toHaveLength(3);
    expect(after.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("does not auto-group a new numbered run that appears after import", () => {
    const { library, linkedRoot, service } = importedThenDissolvedLinkedSequence(
      "linked-new-run",
      ["capture_0.png", "capture_1.png", "capture_2.png"],
    );

    writeFrames(linkedRoot, ["other_0.png", "other_1.png", "other_2.png"]);
    service.refreshManagedAssets(library.libraryId);

    const after = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(after).toHaveLength(6);
    expect(after.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("does not auto-group managed files discovered by a later refresh", () => {
    const { library, service } = fixture();
    writeFrames(path.join(library.libraryPath, "Assets"), [
      "shot_0.png",
      "shot_1.png",
      "shot_2.png",
    ]);
    service.refreshManagedAssets(library.libraryId);

    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(assets).toHaveLength(3);
    expect(assets.every((asset) => asset.sequence == null)).toBe(true);
  });

  it("creates and dissolves a manual sequence with a chosen fps", async () => {
    const { library, root, service } = fixture();
    const frames: string[] = [];
    for (const [index, name] of ["anim_10.png", "anim_11.png", "anim_12.png"].entries()) {
      mkdirSync(path.join(root, `source-${index}`), { recursive: true });
      const filePath = path.join(root, `source-${index}`, name);
      await sharp({
        create: {
          background: { b: 32, g: 96, r: 192 + index },
          channels: 3,
          height: 2,
          width: 2,
        },
      })
        .png()
        .toFile(filePath);
      frames.push(filePath);
    }
    for (const frame of frames) {
      const result = service.prepareOrExecuteImport({
        libraryId: library.libraryId,
        sourceKind: "files",
        sourcePaths: [frame],
      });
      expect("importId" in result).toBe(false);
    }
    const automaticallyDetected = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(automaticallyDetected).toHaveLength(1);
    service.dissolveImageSequence({
      libraryId: library.libraryId,
      sequenceId: automaticallyDetected[0]!.sequence!.sequenceId,
    });
    const before = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(before).toHaveLength(3);

    const primary = service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: before.map((asset) => asset.assetId),
      fps: 12,
    });
    expect(primary.sequence).toMatchObject({ fps: 12, frameCount: 3 });
    expect(service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    })).toHaveLength(1);

    service.dissolveImageSequence({
      libraryId: library.libraryId,
      sequenceId: primary.sequence!.sequenceId,
    });
    expect(service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    })).toHaveLength(3);
  });

  it("dissolves multiple sequence groups in one mutation", async () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "batch");
    await writePngFrames(
      source,
      ["a_001.png", "a_002.png", "a_003.png", "b_001.png", "b_002.png", "b_003.png"],
      { height: 2, width: 2 },
    );
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "folder",
      sourcePaths: [source],
    });
    expect("importId" in completion).toBe(false);
    const sequences = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(sequences).toHaveLength(2);
    const sequenceIds = sequences.map((asset) => asset.sequence!.sequenceId);

    expect(service.dissolveImageSequences({
      libraryId: library.libraryId,
      sequenceIds,
    })).toEqual({ sequenceIds });
    expect(service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    })).toHaveLength(6);
  });

  it("reports total sequence bytes and updates playback FPS", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "clip_001.png",
      "clip_002.png",
      "clip_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;

    const [primary] = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(primary).toBeDefined();
    expect(primary!.byteSize).toBe(
      frames.reduce((total, frame) => total + statSync(frame).size, 0),
    );

    expect(
      service.setImageSequenceFps({
        libraryId: library.libraryId,
        sequenceId: primary!.sequence!.sequenceId,
        fps: 13,
      }),
    ).toEqual({ sequenceId: primary!.sequence!.sequenceId, fps: 13 });
    expect(
      service.listAssets({ libraryId: library.libraryId, recursive: true })[0]!
        .sequence!.fps,
    ).toBe(13);
  });

  it("rejects manual non-consecutive selections", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "anim_1.png",
      "anim_3.png",
      "anim_5.png",
    ]);
    for (const frame of frames) {
      service.prepareOrExecuteImport({
        libraryId: library.libraryId,
        sourceKind: "files",
        sourcePaths: [frame],
      });
    }
    const assets = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(() => service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: assets.map((asset) => asset.assetId),
      fps: 24,
    })).toThrowError(LibraryServiceError);
  });

  it("disk-deletes an entire sequence without leaking remaining frames", () => {
    const { library, root, service } = fixture();
    const frames = writeFrames(path.join(root, "source"), [
      "shot_001.png",
      "shot_002.png",
      "shot_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;
    const [primary] = service.listAssets({
      libraryId: library.libraryId,
      recursive: true,
    });
    expect(primary?.sequence?.frameCount).toBe(3);

    const result = service.deleteAssetsFromDisk({
      libraryId: library.libraryId,
      assetIds: [primary!.assetId],
    });
    expect(result.deletedCount).toBe(1);
    expect(
      service.listAssets({ libraryId: library.libraryId, recursive: true }),
    ).toHaveLength(0);
  });

  it("counts a trashed sequence as one toast unit and folder badge as one", () => {
    const { library, root, service } = fixture();
    const folder = service.createManagedFolder({
      libraryId: library.libraryId,
      name: "seq-folder",
    });
    const frames = writeFrames(path.join(root, "source"), [
      "clip_001.png",
      "clip_002.png",
      "clip_003.png",
    ]);
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      targetFolderId: folder.folderId,
      expandImageSequences: false,
      imageSequenceFps: 30,
    });
    expect("importId" in completion).toBe(false);
    if ("importId" in completion) return;

    const folders = service.listManagedFolders(library.libraryId);
    const seqFolder = folders.find((entry) => entry.folderId === folder.folderId);
    expect(seqFolder?.directAssetCount).toBe(1);

    const [primary] = service.listAssets({
      libraryId: library.libraryId,
      folderId: folder.folderId,
      recursive: false,
    });
    const { trashedCount } = service.trashAssets({
      libraryId: library.libraryId,
      assetIds: [primary!.assetId],
    });
    expect(trashedCount).toBe(1);
    const trash = service.listTrash(library.libraryId);
    expect(trash).toHaveLength(1);
    expect(trash[0]!.sequence?.frameCount).toBe(3);
  });

  // WorldlineBox-50c466 audit §5.2/§5.3: the sequence guards used to report an
  // "invalid import decision"; they are selection/state problems, not imports.
  it("reports a selection error when the frames span folders", async () => {
    const { library, root, service } = fixture();
    const folderA = service.createManagedFolder({ libraryId: library.libraryId, name: "A" });
    const folderB = service.createManagedFolder({ libraryId: library.libraryId, name: "B" });
    const plan: Array<{ file: string; targetFolderId: string }> = [];
    for (const [index, name] of ["alpha.png", "beta.png"].entries()) {
      const directory = path.join(root, `spread-a-${index}`);
      const [file] = await writeDistinctFrames(directory, [name], { width: 2, height: 2 }, index);
      plan.push({ file: file!, targetFolderId: folderA.folderId });
    }
    {
      const directory = path.join(root, "spread-b");
      const [file] = await writeDistinctFrames(directory, ["gamma.png"], { width: 2, height: 2 }, 9);
      plan.push({ file: file!, targetFolderId: folderB.folderId });
    }
    for (const entry of plan) {
      const result = service.prepareOrExecuteImport({
        libraryId: library.libraryId,
        sourceKind: "files",
        sourcePaths: [entry.file],
        targetFolderId: entry.targetFolderId,
        // Keep them ungrouped so the manual create path runs its own checks.
        expandImageSequences: false,
      });
      expect("importId" in result).toBe(false);
    }
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(assets).toHaveLength(3);

    let caught: unknown;
    try {
      service.createImageSequence({
        libraryId: library.libraryId,
        assetIds: assets.map((asset) => asset.assetId),
        fps: 12,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LibraryServiceError);
    expect(caught).toMatchObject({
      code: "INVALID_SELECTION",
      reason: "IMAGE_SEQUENCE_SELECTION",
    });
  });

  it("reports an asset state conflict when a selected frame is in the trash", async () => {
    const { library, root, service } = fixture();
    const frames = await writeDistinctFrames(path.join(root, "state"), [
      // Non-series names: they stay three separate assets so the manual create
      // path runs its own state check (a numbered run would group on import).
      "one.png",
      "two.png",
      "three.png",
    ], { width: 2, height: 2 });
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "files",
      sourcePaths: frames,
      expandImageSequences: false,
    });
    expect("importId" in completion).toBe(false);
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(assets).toHaveLength(3);

    service.trashAssets({
      libraryId: library.libraryId,
      assetIds: [assets[0]!.assetId],
    });

    let caught: unknown;
    try {
      service.createImageSequence({
        libraryId: library.libraryId,
        assetIds: assets.map((asset) => asset.assetId),
        fps: 12,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "ASSET_STATE_CONFLICT" });
  });

  it("does not keep thumbnail jobs for hidden sequence frames", () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "seq-thumbs");
    mkdirSync(source, { recursive: true });
    const requiredPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAACAEAAAABCAIAAAAqtLKbAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAOklEQVRYhe3YQQ0AAAgDMeRMImInBh+kySno8yZbESBAgAABAgQIECBAgAABAgQIECBAgAABAnk3zA9mXOIiDxU7WQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const [index, name] of ["clip_001.png", "clip_002.png", "clip_003.png"].entries()) {
      writeFileSync(path.join(source, name), Buffer.concat([requiredPng, Buffer.from([index])]));
    }
    const completion = service.prepareOrExecuteImport({
      createImageSequence: false,
      expandImageSequences: false,
      libraryId: library.libraryId,
      sourceKind: "folder",
      sourcePaths: [source],
    });
    expect("importId" in completion).toBe(false);
    const before = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(before).toHaveLength(3);
    expect(service.enqueueThumbnailJobs(library.libraryId, {
      assetIds: before.map((asset) => asset.assetId),
    })).toBe(3);

    const primary = service.createImageSequence({
      libraryId: library.libraryId,
      assetIds: before.map((asset) => asset.assetId),
      fps: 12,
    });
    expect(primary.sequence?.frameCount).toBe(3);
    const hiddenIds = new Set(
      primary.sequence!.frames.slice(1).map((frame) => frame.assetId),
    );
    expect(hiddenIds.size).toBe(2);

    expect(service.enqueueThumbnailJobs(library.libraryId)).toBe(0);
    const jobs = service.listMediaJobs(library.libraryId).jobs
      .filter((job) => job.kind === "generate_thumbnail");
    expect(jobs.filter((job) => (
      hiddenIds.has(job.assetId) && (job.status === "queued" || job.status === "running")
    ))).toEqual([]);
    const primaryJobs = jobs.filter((job) => job.assetId === primary.assetId);
    expect(primaryJobs.some((job) => job.status === "queued" || job.status === "running")).toBe(true);
  });

  it("does not enqueue a thumbnail job per frame of a 30-frame imported sequence", () => {
    const { library, root, service } = fixture();
    const source = path.join(root, "seq-30");
    mkdirSync(source, { recursive: true });
    const requiredPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAACAEAAAABCAIAAAAqtLKbAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAOklEQVRYhe3YQQ0AAAgDMeRMImInBh+kySno8yZbESBAgAABAgQIECBAgAABAgQIECBAgAABAnk3zA9mXOIiDxU7WQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (let index = 1; index <= 30; index += 1) {
      writeFileSync(
        path.join(source, `clip_${String(index).padStart(3, "0")}.png`),
        Buffer.concat([requiredPng, Buffer.from([index])]),
      );
    }
    const completion = service.prepareOrExecuteImport({
      libraryId: library.libraryId,
      sourceKind: "folder",
      sourcePaths: [source],
      imageSequenceFps: 12,
    });
    expect("importId" in completion).toBe(false);
    const assets = service.listAssets({ libraryId: library.libraryId, recursive: true });
    expect(assets).toHaveLength(1);
    expect(assets[0]!.sequence?.frameCount).toBe(30);
    const hiddenIds = new Set(
      assets[0]!.sequence!.frames.slice(1).map((frame) => frame.assetId),
    );
    expect(hiddenIds.size).toBe(29);

    const frameIds = assets[0]!.sequence!.frames.map((frame) => frame.assetId);
    expect(service.enqueueThumbnailJobs(library.libraryId, {
      assetIds: frameIds,
      limit: 500,
    })).toBeLessThanOrEqual(1);

    const db = new TestDatabase(path.join(library.libraryPath, ".worldlinebox", "library.db"));
    const thumbs = db.prepare(
      "SELECT asset_id, status, error_code FROM jobs WHERE kind = 'generate_thumbnail'",
    ).all() as Array<{ asset_id: string; status: string; error_code: string | null }>;
    db.close();
    expect(thumbs.length).toBeLessThanOrEqual(1);
    expect(thumbs.every((job) => job.asset_id === assets[0]!.assetId)).toBe(true);
    expect(thumbs.some((job) => hiddenIds.has(job.asset_id))).toBe(false);
  });
});
