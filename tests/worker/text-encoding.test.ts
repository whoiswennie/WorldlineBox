import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LibraryService } from "../../src/worker/library-service";
import {
  bytesFromHex,
  GBK_ZH_README_HEX,
} from "../fixtures/text-encoding/legacy-text-samples";
import { importNoConflict } from "./import-no-conflict";

const temporaryRoots: string[] = [];
const services: LibraryService[] = [];

function newService(): LibraryService {
  const service = new LibraryService();
  services.push(service);
  return service;
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "worldlinebox-text-encoding-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const service of services.splice(0)) {
    service.closeAll();
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 8 });
  }
});

describe("readTextAsset encoding", () => {
  it("decodes a GBK Windows readme as Chinese text", () => {
    const root = temporaryRoot();
    const service = newService();
    const created = service.createLibrary({
      displayName: "Text Encoding",
      selectedParentPath: root,
    });
    const source = path.join(root, "readme.txt");
    writeFileSync(source, bytesFromHex(GBK_ZH_README_HEX));
    const assetId = importNoConflict(service, created.libraryId, source).assets[0]!
      .assetId;
    const read = service.readTextAsset({
      libraryId: created.libraryId,
      assetId,
      maxBytes: 2048,
    });
    expect(read.content).toContain("简体中文");
    expect(read.content).not.toMatch(/[\uac00-\ud7af]/);
  });
});
