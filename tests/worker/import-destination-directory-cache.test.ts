import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ImportDestinationDirectoryCache } from '../../src/worker/import-destination-directory-cache';
import { portablePathSegmentIdentity } from '../../src/worker/library-rules';

describe('ImportDestinationDirectoryCache', () => {
  it('reads each directory once and indexes names by portable identity', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-import-directory-cache-'));
    try {
      writeFileSync(path.join(root, 'Café.png'), 'first');
      writeFileSync(path.join(root, 'second.png'), 'second');
      let reads = 0;
      const cache = new ImportDestinationDirectoryCache((directory) => {
        reads += 1;
        return readdirSync(directory, { withFileTypes: true });
      });

      expect(cache.matches(root, portablePathSegmentIdentity('Café.png')).map((entry) => entry.name))
        .toEqual(['Café.png']);
      expect(cache.matches(root, portablePathSegmentIdentity('SECOND.PNG')).map((entry) => entry.name))
        .toEqual(['second.png']);
      expect(reads).toBe(1);

      const child = path.join(root, 'child');
      mkdirSync(child);
      expect(cache.matches(child, portablePathSegmentIdentity('missing.png'))).toEqual([]);
      expect(reads).toBe(2);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
