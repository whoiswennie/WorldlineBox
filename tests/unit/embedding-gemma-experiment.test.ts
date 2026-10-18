import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import sharp from 'sharp';

import {
  EMBEDDING_DIMENSIONS,
  PROFILES,
  discoverCorpusImages,
  makeVisualCanaryImages,
  normalizeEmbedding,
  rankTopK,
  runExperiment,
} from '../../scripts/embedding-gemma/experiment/core.mjs';
import { postImageDataUrl } from '../../scripts/embedding-gemma/experiment/llama-http-session.mjs';
import { renderReportHtml } from '../../scripts/embedding-gemma/experiment/report-html.mjs';
import { makePrivacySafeReport } from '../../scripts/embedding-gemma/experiment/report-data.mjs';

const temporaryDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-embedding-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function unitVector(index: number): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  vector[index % EMBEDDING_DIMENSIONS] = 1;
  return vector;
}

function stableIndex(seed: string): number {
  let value = 0;
  for (const character of seed) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return value % EMBEDDING_DIMENSIONS;
}

describe('EmbeddingGemma experiment vector handling', () => {
  it('normalizes only finite, nonzero 768-dimensional embeddings', () => {
    const normalized = normalizeEmbedding(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 1));
    expect(normalized).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...normalized)).toBeCloseTo(1, 10);
    expect(() => normalizeEmbedding([1, 2])).toThrow(/768 values/u);
    expect(() => normalizeEmbedding([...(unitVector(0).slice(0, -1)), Number.NaN])).toThrow(/non-finite/u);
    expect(() => normalizeEmbedding(Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0))).toThrow(/zero/u);
  });

  it('ranks cosine matches in descending order', () => {
    const results = rankTopK(unitVector(1), [
      { filename: 'far', embedding: unitVector(2) },
      { filename: 'match', embedding: unitVector(1) },
    ], 2);
    expect(results.map((result) => result.filename)).toEqual(['match', 'far']);
    expect(results[0]?.score).toBeCloseTo(1, 10);
  });

  it('scans only direct supported files and enforces a 2–100 image sample', async () => {
    const directory = await makeTempDirectory();
    for (let index = 0; index < 20; index += 1) {
      await writeFile(path.join(directory, `sample-${String(index).padStart(2, '0')}.png`), Buffer.from([index]));
    }
    await writeFile(path.join(directory, 'ignore.txt'), 'not an image');
    const nested = path.join(directory, 'nested');
    await mkdir(nested);
    await writeFile(path.join(nested, 'not-scanned.png'), Buffer.from([0]));

    expect(await discoverCorpusImages(directory)).toHaveLength(20);

    const twoImages = await makeTempDirectory();
    await writeFile(path.join(twoImages, 'sample-a.jpg'), Buffer.from([0]));
    await writeFile(path.join(twoImages, 'sample-b.jpg'), Buffer.from([1]));
    expect(await discoverCorpusImages(twoImages)).toHaveLength(2);

    const tooSmall = await makeTempDirectory();
    await writeFile(path.join(tooSmall, 'sample.jpg'), Buffer.from([0]));
    await expect(discoverCorpusImages(tooSmall)).rejects.toMatchObject({ code: 'invalid-image-count' });
  });

  it('builds distinct deterministic PNG canaries without touching user files', () => {
    const images = makeVisualCanaryImages();
    const decoded = Object.values(images).map((dataUrl) => Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'));
    expect(decoded.every((png) => png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))).toBe(true);
    expect(new Set(decoded.map((png) => png.toString('base64'))).size).toBe(3);
    expect(images.red).toBe(makeVisualCanaryImages().red);
  });

  it('generates PNG bytes that a real image decoder can read', async () => {
    const canary = makeVisualCanaryImages().checkerboard;
    const png = Buffer.from(canary.split(',')[1] ?? '', 'base64');
    await expect(sharp(png).metadata()).resolves.toMatchObject({ format: 'png', width: 96, height: 96 });
  });

  it('sends image data through the nested multimodal endpoint shape', async () => {
    let requestBody: unknown;
    const fetcher = async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [{ embedding: unitVector(3) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const dataUrl = 'data:image/png;base64,dGVzdA==';
    const embedding = await postImageDataUrl({ baseUrl: 'http://127.0.0.1:1', model: 'embeddinggemma-2', dataUrl, fetcher });
    expect(requestBody).toEqual({
      model: 'embeddinggemma-2',
      input: [{ content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
    });
    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe('EmbeddingGemma experiment orchestration', () => {
  it('runs profiles sequentially, gates each one on synthetic image canaries, and closes each runtime', async () => {
    const imagePaths = Array.from({ length: 20 }, (_, index) => `sample-${String(index).padStart(2, '0')}.png`);
    const profiles = [PROFILES[0]!, PROFILES[1]!];
    const profileFiles = Object.fromEntries(profiles.map((profile) => [profile.id, {
      core: { path: `${profile.id}-core.gguf`, sizeBytes: 100, sha256: 'a'.repeat(64) },
      projector: { path: 'projector.gguf', sizeBytes: 200, sha256: 'b'.repeat(64) },
    }]));
    const loadedProfiles: string[] = [];
    let activeProfiles = 0;
    const report = await runExperiment({
      profiles,
      profileFiles,
      imagePaths,
      textQueries: [{ text: 'red car', id: 'q1' }],
      queryImagePath: 'outside-query.png',
      createSession: async (profile: { id: string }) => {
        activeProfiles += 1;
        expect(activeProfiles).toBe(1);
        loadedProfiles.push(profile.id);
        return {
          startupMs: 17,
          metadata: { modelLoaded: true, imageCapability: 'pending-canary', runtimeCommit: 'a'.repeat(40) },
          embedImageDataUrl: async (dataUrl: string) => unitVector(stableIndex(dataUrl)),
          embedImage: async (imagePath: string) => unitVector(stableIndex(imagePath)),
          embedText: async (text: string) => unitVector(stableIndex(text)),
          close: async () => { activeProfiles -= 1; },
        };
      },
    });

    expect(loadedProfiles).toEqual(['Q4_K_XL', 'Q8_0']);
    expect(activeProfiles).toBe(0);
    expect(report.status).toBe('completed');
    expect(report.profiles).toHaveLength(2);
    expect(report.profiles.every((profile) => profile.canary?.verified)).toBe(true);
    expect(report.profiles.every((profile) => profile.queries.length === 2)).toBe(true);
  });

  it('refuses an unverified image runtime before generating any user-image result', async () => {
    let imageCalls = 0;
    let closed = false;
    const profile = PROFILES[0]!;
    const report = await runExperiment({
      profiles: [profile],
      profileFiles: { [profile.id]: { core: { path: 'core.gguf' }, projector: { path: 'mmproj.gguf' } } },
      imagePaths: Array.from({ length: 20 }, (_, index) => `image-${index}.jpg`),
      textQueries: [{ text: 'a query' }],
      createSession: async () => ({
        metadata: { modelLoaded: true, imageCapability: 'unverified' },
        embedImage: async () => { imageCalls += 1; return unitVector(0); },
        embedImageDataUrl: async () => { imageCalls += 1; return unitVector(0); },
        embedText: async () => unitVector(0),
        close: async () => { closed = true; },
      }),
    });

    expect(report.status).toBe('incomplete');
    expect(report.profiles[0]?.error?.code).toBe('image-runtime-unverified');
    expect(report.profiles[0]?.corpus).toHaveLength(0);
    expect(imageCalls).toBe(0);
    expect(closed).toBe(true);
  });

  it('continues with later quantization profiles after an earlier profile fails its image canary', async () => {
    const profiles = [PROFILES[0]!, PROFILES[1]!];
    const profileFiles = Object.fromEntries(profiles.map((profile) => [profile.id, {
      core: { path: `${profile.id}-core.gguf` },
      projector: { path: `${profile.id}-projector.gguf` },
    }]));
    const loadedProfiles: string[] = [];
    const report = await runExperiment({
      profiles,
      profileFiles,
      imagePaths: ['image-a.jpg', 'image-b.jpg'],
      textQueries: [{ text: 'a query' }],
      createSession: async (profile: { id: string }) => {
        loadedProfiles.push(profile.id);
        return {
          metadata: { modelLoaded: true, imageCapability: 'pending-canary' },
          embedImage: async (imagePath: string) => unitVector(stableIndex(imagePath)),
          embedImageDataUrl: async (dataUrl: string) => unitVector(
            profile.id === profiles[0]?.id ? 0 : stableIndex(dataUrl),
          ),
          embedText: async (text: string) => unitVector(stableIndex(text)),
          close: async () => undefined,
        };
      },
    });

    expect(loadedProfiles).toEqual(['Q4_K_XL', 'Q8_0']);
    expect(report.status).toBe('incomplete');
    expect(report.profiles.map((profile) => profile.status)).toEqual(['failed', 'completed']);
  });

  it('marks a profile and the overall run partial when some sample images are skipped', async () => {
    const profile = PROFILES[0]!;
    const report = await runExperiment({
      profiles: [profile],
      profileFiles: { [profile.id]: { core: { path: 'core.gguf' }, projector: { path: 'projector.gguf' } } },
      imagePaths: ['image-a.jpg', 'image-b.jpg', 'image-c.jpg'],
      textQueries: [{ text: 'a query' }],
      createSession: async () => ({
        metadata: { modelLoaded: true, imageCapability: 'pending-canary' },
        embedImage: async (imagePath: string) => {
          if (imagePath === 'image-a.jpg') throw new Error('A local file error with implementation details.');
          return unitVector(stableIndex(imagePath));
        },
        embedImageDataUrl: async (dataUrl: string) => unitVector(stableIndex(dataUrl)),
        embedText: async (text: string) => unitVector(stableIndex(text)),
        close: async () => undefined,
      }),
    });

    expect(report.status).toBe('partial');
    expect(report.profiles[0]?.status).toBe('partial');
    expect(report.profiles[0]?.skippedImages).toEqual([{ filename: 'image-a.jpg', reason: 'runtime-error' }]);
    expect(report.profiles[0]?.queries[0]?.results).toHaveLength(2);
  });

  it('supports image-to-image queries without requiring a text query', async () => {
    const profile = PROFILES[0]!;
    const report = await runExperiment({
      profiles: [profile],
      profileFiles: { [profile.id]: { core: { path: 'core.gguf' }, projector: { path: 'mmproj.gguf' } } },
      imagePaths: ['image-a.jpg', 'image-b.jpg'],
      textQueries: [],
      queryImagePath: 'query.jpg',
      createSession: async () => ({
        metadata: { modelLoaded: true, imageCapability: 'pending-canary' },
        embedImage: async (imagePath: string) => unitVector(stableIndex(imagePath)),
        embedImageDataUrl: async (dataUrl: string) => unitVector(stableIndex(dataUrl)),
        embedText: async (text: string) => unitVector(stableIndex(text)),
        close: async () => undefined,
      }),
    });

    expect(report.status).toBe('completed');
    expect(report.profiles[0]?.queries.map((query) => query.type)).toEqual(['image']);
  });

  it('renders a local side-by-side ranking page without embedding source filenames or network links', () => {
    const html = renderReportHtml({
      runId: 'test-run',
      status: 'completed',
      dimensions: EMBEDDING_DIMENSIONS,
      profiles: [{
        id: 'Q4_K_XL',
        label: 'Q4_K_XL core + Q8_0 mmproj',
        status: 'completed',
        queries: [{
          type: 'text',
          queryId: 'text-query-01',
          results: [{ filename: 'image-001', score: 0.9 }],
        }],
      }],
    });

    expect(html).toContain('Choose the original sample folder');
    expect(html).toContain('sample-map.json');
    expect(html).toContain('image-001');
    expect(html).not.toContain('original-filename.png');
    expect(html).not.toMatch(/https?:\/\//u);
    const inlineScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)].at(-1)?.[1];
    expect(inlineScript).toBeDefined();
    expect(() => new Script(inlineScript ?? '')).not.toThrow();
  });

  it('removes sample names, query text, and dynamic local paths from saved reports', async () => {
    const directory = await makeTempDirectory();
    const samplePath = path.join(directory, 'private-sample-name.png');
    const queryPath = path.join(directory, 'private-query-name.png');
    const report = {
      runId: 'test-run',
      status: 'partial',
      corpusFiles: [path.basename(samplePath)],
      queryImage: path.basename(queryPath),
      textQueries: ['secret project description'],
      profiles: [{
        id: 'Q4_K_XL',
        status: 'partial',
        corpus: [{ filename: path.basename(samplePath), encodingMs: 2 }],
        skippedImages: [],
        queries: [{
          type: 'text',
          queryId: 'text-1',
          text: 'secret project description',
          results: [{ filename: path.basename(samplePath), score: 0.9 }],
        }],
        errors: [`Runtime failed while reading ${samplePath}`],
      }],
    };

    const output = JSON.stringify(makePrivacySafeReport(report, [samplePath], queryPath));
    expect(output).toContain('image-001');
    expect(output).not.toContain('private-sample-name.png');
    expect(output).not.toContain('private-query-name.png');
    expect(output).not.toContain('secret project description');
    expect(output).not.toContain(directory);
  });
});
