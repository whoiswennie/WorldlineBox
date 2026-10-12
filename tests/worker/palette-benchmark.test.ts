import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

import { afterAll, describe, expect, it } from 'vitest';

import { LibraryService } from '../../src/worker/library-service';
import { extractRepresentativePalette } from '../../src/worker/palette-extractor';
import { referenceExtractRepresentativePalette } from '../helpers/palette-extractor-reference';

/**
 * Operator-run palette benchmark. Never part of CI.
 *
 * The image directory is supplied at runtime so no local path is stored in the
 * repository:
 *
 *   npm run test:perf:palette -- <image-directory>
 *
 * Knobs:
 *   WORLDLINEBOX_PALETTE_BENCH_LIMIT        images to measure (default 200, max 1000)
 *   WORLDLINEBOX_PALETTE_BENCH_TMP          temp root for the disposable library
 *   WORLDLINEBOX_PALETTE_BENCH_FULL_DECODE  '1' also times a full-size decode
 *   WORLDLINEBOX_PALETTE_BENCH_JSON         write machine-readable results here
 *
 * The benchmark reports two stages:
 *   stageA  production decode (64x64 preview) + `extractRepresentativePalette`
 *           straight from the source files, i.e. the source-direct worst case;
 *   stageB  the real queue: disposable library, import, thumbnails first, then
 *           the palette jobs the worker itself enqueues, plus a comparison of
 *           decoding the finished thumbnail against decoding the original.
 */
const benchDirectory = process.env.WORLDLINEBOX_PALETTE_BENCH_DIR;
const enabled = process.env.WORLDLINEBOX_PALETTE_BENCH === '1' && Boolean(benchDirectory);
const requestedImageCount = Math.max(
  1,
  Math.min(1000, Math.trunc(Number(process.env.WORLDLINEBOX_PALETTE_BENCH_LIMIT ?? 200))),
);
const benchTempRoot = process.env.WORLDLINEBOX_PALETTE_BENCH_TMP ?? tmpdir();
const fullDecodeEnabled = process.env.WORLDLINEBOX_PALETTE_BENCH_FULL_DECODE === '1';
const pumpEnabled = process.env.WORLDLINEBOX_PALETTE_BENCH_PUMP !== '0';
const resultPath = process.env.WORLDLINEBOX_PALETTE_BENCH_JSON;
const PREVIEW_EDGE = 64;
const FULL_DECODE_SAMPLE_LIMIT = 20;
const FULL_DECODE_MAX_BYTE_SIZE = 40 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.avif']);

const require = createRequire(import.meta.url);
const TestDatabase = require('better-sqlite3') as new (filename: string) => {
  close(): void;
  prepare(source: string): {
    all(...parameters: unknown[]): unknown[];
    run(...parameters: unknown[]): { changes: number };
  };
};

interface PumpPolicy {
  label: string;
  /** Jobs claimed per `processThumbnailQueue` call (its `maxJobs`). */
  batchSize: number;
  /** Sequential claims per turn before the pump sleeps. */
  burstSize: number;
  gapMs: number;
}

type SharpLike = (input: string) => {
  rotate(): SharpLikeInstance;
  toColourspace(colourspace: 'srgb'): SharpLikeInstance;
  resize(options: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): SharpLikeInstance;
  ensureAlpha(): SharpLikeInstance;
  raw(): SharpLikeInstance;
  toBuffer(options: { resolveWithObject: true }): Promise<{ data: Uint8Array; info: { channels: number; width: number; height: number } }>;
};

type SharpLikeInstance = ReturnType<SharpLike>;

interface StageSample {
  extension: string;
  byteSize: number;
  decodeMs: number;
  extractMs: number;
  paletteSize: number;
}

interface DecodeSourceSample {
  byteSize: number;
  thumbnailMs: number;
  originalMs: number;
}

interface TimingSummary {
  count: number;
  totalMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

let temporaryRoot = '';
let service: LibraryService | undefined;

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(fraction * sortedValues.length) - 1));
  return sortedValues[index]!;
}

function summarize(values: readonly number[]): TimingSummary {
  if (values.length === 0) {
    return { count: 0, totalMs: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    totalMs: Number(totalMs.toFixed(2)),
    meanMs: Number((totalMs / values.length).toFixed(2)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(2)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(2)),
  };
}

function round(valueMs: number): number {
  return Number(valueMs.toFixed(3));
}

/**
 * Deterministic high-entropy RGBA frame. Used to compare the current extractor
 * with the reference implementation at a size the product no longer decodes
 * (extraction always runs on a 64x64 preview), which is where the histogram
 * shape actually matters.
 */
function buildSyntheticFrame(pixelCount: number): Uint8Array {
  const pixels = new Uint8Array(pixelCount * 4);
  let state = 0x1234abcd;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const offset = pixel * 4;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

function collectImageFiles(directory: string, limit: number): string[] {
  const pending = [directory];
  const files: string[] = [];
  while (pending.length > 0 && files.length < limit * 4) {
    const current = pending.shift()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files.push(absolute);
    }
  }
  // Directory order: sorting by size would quietly bias the sample toward the
  // cheapest images. Per-extension and p95/max reporting exposes outliers.
  return files.slice(0, limit);
}

function decodePreview(sharp: SharpLike, sourcePath: string): Promise<{ data: Uint8Array; info: { channels: number; width: number; height: number } }> {
  // Exactly the pipeline `generateQueuedPaletteArtifact` uses in production.
  return sharp(sourcePath)
    .rotate()
    .toColourspace('srgb')
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** The pre-WorldlineBox-3a9f1c chain, kept to attribute the `ensureAlpha` removal. */
function decodePreviewWithAlpha(sharp: SharpLike, sourcePath: string): Promise<{ data: Uint8Array; info: { channels: number; width: number; height: number } }> {
  return sharp(sourcePath)
    .rotate()
    .toColourspace('srgb')
    .resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Drops the extracted palettes of the disposable library and lets the product
 * re-queue them the way it repairs a library after an upgrade, so a pacing
 * policy can be measured more than once.
 */
function requeuePaletteJobs(
  libraryService: LibraryService,
  libraryId: string,
  libraryPath: string,
  limit: number,
): number {
  const database = new TestDatabase(path.join(libraryPath, '.worldlinebox', 'library.db'));
  try {
    const rows = database.prepare(
      "SELECT file_path FROM revision_artifacts WHERE kind = 'extracted_palette'",
    ).all() as Array<{ file_path: string }>;
    for (const row of rows) {
      try {
        rmSync(path.join(libraryPath, '.worldlinebox', 'artifacts', row.file_path), { force: true });
      } catch {
        // The whole library is disposable scratch space.
      }
    }
    database.prepare("DELETE FROM revision_artifacts WHERE kind = 'extracted_palette'").run();
  } finally {
    database.close();
  }
  // `enqueueThumbnailJobs` reports only the primary thumbnail jobs it created,
  // so count the palette jobs it fanned out instead.
  libraryService.enqueueThumbnailJobs(libraryId, { limit, skipStaleRepair: true, retryFailed: true });
  return libraryService.listMediaJobs(libraryId).jobs
    .filter((job) => job.kind === 'extract_palette' && job.status === 'queued').length;
}

afterAll(async () => {
  service?.closeAll();
  if (!temporaryRoot) return;
  // Windows keeps short-lived handles on freshly written artifact files, so a
  // single aggressive rm can lose the race; retry briefly and never fail the
  // benchmark over its own scratch directory.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(temporaryRoot, { force: true, recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

describe.skipIf(!enabled || !benchDirectory)('palette extraction benchmark (manual, not CI)', () => {
  it('measures decode and extraction cost against real images', async () => {
    if (!benchDirectory || !existsSync(benchDirectory)) {
      throw new Error('WORLDLINEBOX_PALETTE_BENCH_DIR must point at an existing image directory.');
    }
    const sharp = (await import('sharp')).default as unknown as SharpLike;
    const files = collectImageFiles(benchDirectory, requestedImageCount);
    expect(files.length).toBeGreaterThan(0);

    // ---------------------------------------------------------------- stage A
    const samples: StageSample[] = [];
    const referenceExtractMs: number[] = [];
    const fullDecodeSamples: Array<{ extension: string; byteSize: number; decodeMs: number }> = [];
    const alphaDecodeSamples: Array<{ withAlphaMs: number; withoutAlphaMs: number }> = [];
    let fullDecodeAttempts = 0;
    let alphaDecodeAttempts = 0;
    for (const file of files) {
      const byteSize = statSync(file).size;
      const extension = path.extname(file).toLowerCase();
      const decodeStart = performance.now();
      const decoded = await decodePreview(sharp, file);
      const decodeMs = performance.now() - decodeStart;
      const extractStart = performance.now();
      const palette = extractRepresentativePalette(decoded.data, decoded.info.channels, 6);
      const extractMs = performance.now() - extractStart;
      expect(palette.length).toBeGreaterThan(0);
      // Same buffer, same request: the reference implementation keeps the
      // equivalence claim honest on real decoded pixels and attributes the
      // algorithm change without machine-to-machine noise.
      const referenceStart = performance.now();
      const referencePalette = referenceExtractRepresentativePalette(decoded.data, decoded.info.channels, 6);
      referenceExtractMs.push(round(performance.now() - referenceStart));
      expect(referencePalette).toEqual(palette);
      samples.push({
        extension,
        byteSize,
        decodeMs: round(decodeMs),
        extractMs: round(extractMs),
        paletteSize: palette.length,
      });
      if (
        fullDecodeEnabled
        && fullDecodeAttempts < FULL_DECODE_SAMPLE_LIMIT
        && byteSize <= FULL_DECODE_MAX_BYTE_SIZE
      ) {
        fullDecodeAttempts += 1;
        const fullStart = performance.now();
        await sharp(file).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        fullDecodeSamples.push({ extension, byteSize, decodeMs: round(performance.now() - fullStart) });
      }
      if (alphaDecodeAttempts < FULL_DECODE_SAMPLE_LIMIT && byteSize <= FULL_DECODE_MAX_BYTE_SIZE) {
        alphaDecodeAttempts += 1;
        const withAlphaStart = performance.now();
        await decodePreviewWithAlpha(sharp, file);
        const withAlphaMs = performance.now() - withAlphaStart;
        const withoutAlphaStart = performance.now();
        await decodePreview(sharp, file);
        alphaDecodeSamples.push({
          withAlphaMs: round(withAlphaMs),
          withoutAlphaMs: round(performance.now() - withoutAlphaStart),
        });
      }
    }

    const extensions = [...new Set(samples.map((sample) => sample.extension))].sort();
    const byExtension = extensions.map((extension) => {
      const group = samples.filter((sample) => sample.extension === extension);
      return {
        extension,
        files: group.length,
        totalMB: Number((group.reduce((sum, sample) => sum + sample.byteSize, 0) / (1024 * 1024)).toFixed(2)),
        previewDecodeMs: summarize(group.map((sample) => sample.decodeMs)),
        extractMs: summarize(group.map((sample) => sample.extractMs)),
      };
    });

    const decodeTotalMs = samples.reduce((sum, sample) => sum + sample.decodeMs, 0);
    const extractTotalMs = samples.reduce((sum, sample) => sum + sample.extractMs, 0);
    const largeFrame = buildSyntheticFrame(2_000_000);
    const largeFrameCurrentStart = performance.now();
    const largeFramePalette = extractRepresentativePalette(largeFrame, 4, 6);
    const largeFrameCurrentMs = performance.now() - largeFrameCurrentStart;
    const largeFrameReferenceStart = performance.now();
    const largeFrameReferencePalette = referenceExtractRepresentativePalette(largeFrame, 4, 6);
    const largeFrameReferenceMs = performance.now() - largeFrameReferenceStart;
    expect(largeFramePalette).toEqual(largeFrameReferencePalette);
    const slowest = [...samples]
      .sort((left, right) => right.decodeMs - left.decodeMs)
      .slice(0, 10)
      .map((sample, index) => ({
        rank: index + 1,
        extension: sample.extension,
        megabyteSize: Number((sample.byteSize / (1024 * 1024)).toFixed(2)),
        decodeMs: sample.decodeMs,
        extractMs: sample.extractMs,
      }));

    // ---------------------------------------------------------------- stage B
    temporaryRoot = mkdtempSync(path.join(benchTempRoot, 'worldlinebox-palette-bench-'));
    const sourceDirectory = path.join(temporaryRoot, 'source');
    mkdirSync(sourceDirectory, { recursive: true });
    const copiedFiles: string[] = [];
    files.forEach((file, index) => {
      const destination = path.join(sourceDirectory, `sample-${String(index).padStart(4, '0')}${path.extname(file).toLowerCase()}`);
      copyFileSync(file, destination);
      copiedFiles.push(destination);
    });

    service = new LibraryService({ observerFactory: () => ({ close() {} }) });
    const library = service.createLibrary({
      displayName: 'Palette benchmark',
      selectedParentPath: temporaryRoot,
    });
    const libraryId = library.libraryId;
    const prepared = service.prepareOrExecuteImport({
      libraryId,
      sourceKind: 'folder',
      sourcePaths: [sourceDirectory],
    });
    if ('importId' in prepared) {
      service.resolveImport({ importId: prepared.importId, suspectedDuplicate: 'create-copy', nameConflict: 'keep-both' });
    }

    const thumbnailStart = performance.now();
    service.enqueueThumbnailJobs(libraryId, { limit: copiedFiles.length, skipStaleRepair: true });
    let thumbnailsProcessed = 0;
    for (let turn = 0; turn < 64; turn += 1) {
      const processed = await service.processThumbnailQueue(libraryId, {
        maxJobs: copiedFiles.length,
        jobKinds: ['generate_thumbnail'],
      });
      thumbnailsProcessed += processed;
      if (processed === 0) break;
    }
    const thumbnailMs = performance.now() - thumbnailStart;

    // Production enqueues palette work once the primary preview exists.
    service.enqueueThumbnailJobs(libraryId, { limit: copiedFiles.length, skipStaleRepair: true });
    const queuedPaletteJobs = service.listMediaJobs(libraryId).jobs
      .filter((job) => job.kind === 'extract_palette' && job.status === 'queued').length;
    const paletteStart = performance.now();
    let palettesProcessed = 0;
    for (let turn = 0; turn < 4096; turn += 1) {
      const processed = await service.processThumbnailQueue(libraryId, {
        maxJobs: copiedFiles.length,
        jobKinds: ['extract_palette'],
      });
      palettesProcessed += processed;
      // Every runnable palette job was claimed this turn; the rest are waiting
      // for a primary preview that this benchmark never generates (for example
      // a poster-only asset), so another turn cannot make progress.
      if (processed < copiedFiles.length) break;
    }
    const paletteMs = performance.now() - paletteStart;
    const paletteArtifacts = service.listAssets({ libraryId, recursive: true })
      .filter((asset) => service?.getCurrentArtifact(libraryId, asset.assetId, 'extracted_palette')?.status === 'ready')
      .length;

    // Does the palette decode the finished thumbnail or the original file?
    const decodeSourceSamples: DecodeSourceSample[] = [];
    for (const asset of service.listAssets({ libraryId, recursive: true }).slice(0, 10)) {
      const thumbnail = service.getCurrentArtifact(libraryId, asset.assetId, 'thumbnail');
      if (!thumbnail || thumbnail.status !== 'ready') continue;
      const thumbnailPath = service.getArtifactAbsolutePath(libraryId, thumbnail.artifactId);
      const originalPath = service.resolveAssetPath(libraryId, asset.assetId);
      if (!existsSync(thumbnailPath) || !existsSync(originalPath)) continue;
      const thumbnailStart2 = performance.now();
      await decodePreview(sharp, thumbnailPath);
      const thumbnailDecodeMs = performance.now() - thumbnailStart2;
      const originalStart = performance.now();
      await decodePreview(sharp, originalPath);
      const originalDecodeMs = performance.now() - originalStart;
      decodeSourceSamples.push({
        byteSize: statSync(originalPath).size,
        thumbnailMs: round(thumbnailDecodeMs),
        originalMs: round(originalDecodeMs),
      });
    }

    // ---------------------------------------------------------------- stage C
    // Per-job cost is not what a user waits for: the Worker's secondary media
    // pump claims work and then pauses, so the pacing policy sets the wall
    // clock. Simulate the documented shapes — the worker claims `maxJobs` per
    // call, repeats that `burstSize` times per turn, then sleeps `gapMs` — and
    // project each onto a 20 000-asset library. Burst rows keep `maxJobs: 1`
    // and were measured, not assumed: a single-job claim pays ~8 ms of
    // per-call overhead that a larger claim amortizes, so they lose to the
    // shipped wave despite the same pause.
    const pumpPolicies: PumpPolicy[] = [
      { label: 'wave=1 gap=50ms (pre-WorldlineBox-3a9f1c)', batchSize: 1, burstSize: 1, gapMs: 50 },
      { label: 'burst=8 wave=1 gap=10ms (rejected: per-call overhead)', batchSize: 1, burstSize: 8, gapMs: 10 },
      { label: 'wave=2 gap=50ms', batchSize: 2, burstSize: 1, gapMs: 50 },
      { label: 'wave=4 gap=50ms', batchSize: 4, burstSize: 1, gapMs: 50 },
      { label: 'wave=4 gap=10ms (shipping)', batchSize: 4, burstSize: 1, gapMs: 10 },
      { label: 'wave=8 gap=10ms', batchSize: 8, burstSize: 1, gapMs: 10 },
    ];
    const pumpResults: Array<Record<string, unknown>> = [];
    if (pumpEnabled) {
      for (const policy of pumpPolicies) {
        const requeued = requeuePaletteJobs(service, libraryId, library.libraryPath, copiedFiles.length);
        const pumpStart = performance.now();
        let jobs = 0;
        for (let turn = 0; turn < 100_000; turn += 1) {
          let claimedThisTurn = 0;
          for (let claim = 0; claim < policy.burstSize; claim += 1) {
            const processed = await service.processThumbnailQueue(libraryId, {
              maxJobs: policy.batchSize,
              jobKinds: ['extract_palette'],
            });
            claimedThisTurn += processed;
            jobs += processed;
            if (processed === 0) break;
          }
          if (claimedThisTurn === 0) break;
          await sleep(policy.gapMs);
        }
        const wallMs = performance.now() - pumpStart;
        const jobsPerSecond = jobs / Math.max(0.001, wallMs / 1000);
        pumpResults.push({
          policy: policy.label,
          batchSize: policy.batchSize,
          burstSize: policy.burstSize,
          gapMs: policy.gapMs,
          requeued,
          jobs,
          wallMs: Number(wallMs.toFixed(1)),
          jobsPerSecond: Number(jobsPerSecond.toFixed(2)),
          projectedMinutesFor20kAssets: Number((20_000 / Math.max(0.001, jobsPerSecond) / 60).toFixed(1)),
        });
      }
    }

    // ---------------------------------------------------------------- report
    const result = {
      suite: 'palette-extraction-benchmark',
      requestedImages: requestedImageCount,
      measuredImages: samples.length,
      previewEdge: PREVIEW_EDGE,
      stageA: {
        totalMB: Number((samples.reduce((sum, sample) => sum + sample.byteSize, 0) / (1024 * 1024)).toFixed(2)),
        previewDecode: summarize(samples.map((sample) => sample.decodeMs)),
        extract: summarize(samples.map((sample) => sample.extractMs)),
        extractShareOfDecodePercent: Number(((extractTotalMs / Math.max(0.001, decodeTotalMs)) * 100).toFixed(2)),
        extractComparison: {
          sampled: referenceExtractMs.length,
          currentMs: summarize(samples.map((sample) => sample.extractMs)),
          referenceMs: summarize(referenceExtractMs),
        },
        largeFrameExtractComparison: {
          pixels: largeFrame.length / 4,
          currentMs: round(largeFrameCurrentMs),
          referenceMs: round(largeFrameReferenceMs),
          speedup: Number((largeFrameReferenceMs / Math.max(0.001, largeFrameCurrentMs)).toFixed(2)),
        },
        fullDecode: fullDecodeSamples.length > 0 ? summarize(fullDecodeSamples.map((sample) => sample.decodeMs)) : null,
        alphaDecodeComparison: alphaDecodeSamples.length > 0
          ? {
              sampled: alphaDecodeSamples.length,
              withEnsureAlphaMs: summarize(alphaDecodeSamples.map((sample) => sample.withAlphaMs)),
              withoutEnsureAlphaMs: summarize(alphaDecodeSamples.map((sample) => sample.withoutAlphaMs)),
            }
          : null,
        byExtension,
        slowest,
      },
      stageB: {
        importedFiles: copiedFiles.length,
        thumbnailsProcessed,
        thumbnailWaveMs: Number(thumbnailMs.toFixed(1)),
        paletteJobsQueued: queuedPaletteJobs,
        palettesProcessed,
        paletteArtifacts,
        paletteWaveMs: Number(paletteMs.toFixed(1)),
        paletteMsPerAsset: Number((paletteMs / Math.max(1, palettesProcessed)).toFixed(2)),
        palettePerSecond: Number((palettesProcessed / Math.max(0.001, paletteMs / 1000)).toFixed(2)),
        decodeSourceComparison: {
          sampled: decodeSourceSamples.length,
          thumbnailDecodeMs: summarize(decodeSourceSamples.map((sample) => sample.thumbnailMs)),
          originalDecodeMs: summarize(decodeSourceSamples.map((sample) => sample.originalMs)),
        },
      },
      stageC: pumpResults,
    };

    if (resultPath) writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.info(`PALETTE_BENCH_JSON ${JSON.stringify(result)}`);
  }, 3_600_000);
});
