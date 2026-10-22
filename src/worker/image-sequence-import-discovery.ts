import * as fs from 'node:fs';
import path from 'node:path';

import {
  detectImageSequences,
  indexImageSequenceFramesByValue,
  type IndexedImageSequenceFrame,
} from '../shared/image-sequence';

/**
 * Resolve selected absolute paths against image sequences discovered beside
 * them. Each parent directory is enumerated and detected once per call.
 */
export function discoverSelectedImageSequenceFrames(
  selectedPaths: readonly string[],
): ReadonlyMap<string, IndexedImageSequenceFrame> {
  const indexesByDirectory = new Map<
    string,
    ReadonlyMap<string, IndexedImageSequenceFrame>
  >();

  for (const selectedPath of selectedPaths) {
    const directory = path.dirname(selectedPath);
    if (indexesByDirectory.has(directory)) continue;

    let siblingPaths: string[] | undefined;
    try {
      siblingPaths = fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
        .map((entry) => path.join(directory, entry.name));
    } catch {
      // A missing or unreadable parent simply has no discoverable sequence.
    }
    const index = siblingPaths
      ? indexImageSequenceFramesByValue(detectImageSequences(siblingPaths))
      : new Map<string, IndexedImageSequenceFrame>();
    indexesByDirectory.set(directory, index);
  }

  const selectedFrames = new Map<string, IndexedImageSequenceFrame>();
  for (const selectedPath of selectedPaths) {
    if (selectedFrames.has(selectedPath)) continue;
    const frame = indexesByDirectory
      .get(path.dirname(selectedPath))
      ?.get(selectedPath);
    if (frame) selectedFrames.set(selectedPath, frame);
  }
  return selectedFrames;
}
