import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { digestLegacySemanticCache, parseLegacySemanticCache } from '../../src/worker/legacy-semantic-cache';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('legacy semantic cache parser', () => {
  it('streams profile metadata and vector rows, including escaped strings and chunk boundaries', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'semantic-legacy-cache-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'old-cache.json');
    writeFileSync(filePath, JSON.stringify({ version: 1, profileKey: 'legacy-profile', entries: [
      { assetId: 'asset-one', revisionId: 'revision-one', vector: [1, 0] },
      { assetId: 'asset-two', revisionId: 'revision-two', vector: [0, 1], title: 'escaped \\" quote' },
    ] }));
    const headers: Array<{ version: number; profileKey: string }> = [];
    const entries: Array<{ assetId: string; revisionId: string; vector: number[] }> = [];
    const count = await parseLegacySemanticCache(filePath, (header) => headers.push(header), async (entry) => {
      if (entry) entries.push(entry);
    });
    const digest = await digestLegacySemanticCache(filePath);
    expect(headers).toEqual([{ version: 1, profileKey: 'legacy-profile' }]);
    expect(entries).toEqual([
      { assetId: 'asset-one', revisionId: 'revision-one', vector: [1, 0] },
      { assetId: 'asset-two', revisionId: 'revision-two', vector: [0, 1] },
    ]);
    expect(count).toBe(2);
    expect(digest.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest.bytes).toBeGreaterThan(0);
  });

  it('rejects malformed headers rather than accepting a partial cache', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'semantic-legacy-cache-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'bad-cache.json');
    writeFileSync(filePath, '{"version":1,"entries":[]}');
    await expect(parseLegacySemanticCache(filePath, () => undefined, async () => undefined)).rejects.toThrow();
  });

  it('rejects an unclosed root or trailing bytes after the entries array', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'semantic-legacy-cache-'));
    temporaryDirectories.push(directory);
    const malformed: Array<[string, string]> = [
      ['trailing', '{"version":1,"profileKey":"legacy-profile","entries":[]} garbage'],
      ['unclosed', '{"version":1,"profileKey":"legacy-profile","entries":[]'],
    ];
    for (const [name, contents] of malformed) {
      const filePath = path.join(directory, `${name}.json`);
      writeFileSync(filePath, contents);
      await expect(parseLegacySemanticCache(filePath, () => undefined, async () => undefined)).rejects.toThrow();
    }
  });
});
