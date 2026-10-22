import { readdirSync, type Dirent } from 'node:fs';

import { portablePathSegmentIdentity } from './library-rules';

type DirectoryReader = (directory: string) => Dirent[];

/**
 * A short-lived snapshot of directory entries used while classifying one
 * import phase. Callers create a new instance after staging and again when
 * resolving a user decision so external filesystem changes are visible.
 */
export class ImportDestinationDirectoryCache {
  private readonly entriesByDirectory = new Map<string, Map<string, Dirent[]>>();

  constructor(
    private readonly readDirectory: DirectoryReader = (directory) =>
      readdirSync(directory, { withFileTypes: true }),
  ) {}

  matches(directory: string, segmentIdentity: string): readonly Dirent[] {
    let entriesByIdentity = this.entriesByDirectory.get(directory);
    if (entriesByIdentity === undefined) {
      entriesByIdentity = new Map();
      for (const entry of this.readDirectory(directory)) {
        const identity = portablePathSegmentIdentity(entry.name);
        const matches = entriesByIdentity.get(identity);
        if (matches) matches.push(entry);
        else entriesByIdentity.set(identity, [entry]);
      }
      this.entriesByDirectory.set(directory, entriesByIdentity);
    }
    return entriesByIdentity.get(segmentIdentity) ?? [];
  }
}
