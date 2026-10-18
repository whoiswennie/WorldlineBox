import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

export const EMBEDDING_DIMENSIONS = 768;
export const MIN_CORPUS_IMAGES = 2;
export const RECOMMENDED_CORPUS_IMAGES = 20;
export const MAX_CORPUS_IMAGES = 100;
export const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
export const TEXT_QUERY_PREFIX = 'task: search result | query: ';
export const IMAGE_CANARY_TEXT = `${TEXT_QUERY_PREFIX}image modality canary control`;

export const MODEL_REVISION = '412430755667d84b1ac64fe1fe2693aa6219f1d9';
export const PROFILES = Object.freeze([
  Object.freeze({
    id: 'Q4_K_XL',
    label: 'Q4_K_XL core + Q8_0 mmproj',
    coreFile: 'embeddinggemma-2-UD-Q4_K_XL.gguf',
    projectorFile: 'mmproj-Q8_0.gguf',
  }),
  Object.freeze({
    id: 'Q8_0',
    label: 'Q8_0 core + Q8_0 mmproj',
    coreFile: 'embeddinggemma-2-Q8_0.gguf',
    projectorFile: 'mmproj-Q8_0.gguf',
  }),
  Object.freeze({
    id: 'BF16',
    label: 'BF16 core + BF16 mmproj',
    coreFile: 'embeddinggemma-2-BF16.gguf',
    projectorFile: 'mmproj-BF16.gguf',
  }),
]);

const HASH_CHUNK_SIZE = 1024 * 1024;
const CANARY_REPEAT_COSINE_MIN = 0.9999;
const CANARY_DISTINCT_DELTA_MIN = 1e-7;

export class ExperimentError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ExperimentError';
    this.code = code;
  }
}

export async function discoverCorpusImages(directory) {
  const resolvedDirectory = await realpath(directory).catch((cause) => {
    throw new ExperimentError('invalid-image-directory', 'The selected image directory is unavailable.', { cause });
  });
  const directoryStat = await stat(resolvedDirectory);
  if (!directoryStat.isDirectory()) {
    throw new ExperimentError('invalid-image-directory', 'The selected image path is not a directory.');
  }

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(resolvedDirectory, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'en'));

  if (images.length < MIN_CORPUS_IMAGES || images.length > MAX_CORPUS_IMAGES) {
    throw new ExperimentError(
      'invalid-image-count',
      `The selected directory has ${images.length} supported images; choose ${MIN_CORPUS_IMAGES}–${MAX_CORPUS_IMAGES}.`,
    );
  }

  return images;
}

export async function resolveProfileFiles(modelDirectory, profile) {
  const modelRoot = await realpath(modelDirectory).catch((cause) => {
    throw new ExperimentError('invalid-model-directory', 'The selected model directory is unavailable.', { cause });
  });
  const files = {};

  for (const [key, filename] of [['core', profile.coreFile], ['projector', profile.projectorFile]]) {
    const filePath = path.join(modelRoot, filename);
    const fileStat = await stat(filePath).catch((cause) => {
      throw new ExperimentError(
        'missing-model-file',
        `Missing ${key === 'core' ? 'core model' : 'multimodal projector'} file for ${profile.id}: ${filename}`,
        { cause },
      );
    });
    if (!fileStat.isFile()) {
      throw new ExperimentError('invalid-model-file', `Expected a file for ${profile.id}: ${filename}`);
    }
    files[key] = { path: filePath, sizeBytes: fileStat.size };
  }

  return files;
}

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath, { highWaterMark: HASH_CHUNK_SIZE })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export function normalizeEmbedding(vector, label = 'embedding') {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new ExperimentError(
      'invalid-embedding-dimensions',
      `${label} must contain exactly ${EMBEDDING_DIMENSIONS} values.`,
    );
  }

  let normSquared = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ExperimentError('invalid-embedding-value', `${label} contains a non-finite value.`);
    }
    normSquared += value * value;
  }
  if (!Number.isFinite(normSquared) || normSquared <= 0) {
    throw new ExperimentError('zero-embedding', `${label} has zero or invalid magnitude.`);
  }

  const inverseNorm = 1 / Math.sqrt(normSquared);
  return vector.map((value) => value * inverseNorm);
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length) {
    throw new ExperimentError('incompatible-embeddings', 'Cannot compare embeddings with different dimensions.');
  }
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) dot += left[index] * right[index];
  return Math.max(-1, Math.min(1, dot));
}

export function rankTopK(queryEmbedding, corpus, topK = 10) {
  return corpus
    .map((item) => ({
      filename: item.filename,
      score: cosineSimilarity(queryEmbedding, item.embedding),
    }))
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename, 'en'))
    .slice(0, Math.max(1, Math.min(topK, corpus.length)));
}

function assertSessionReady(metadata, profile) {
  if (!metadata || metadata.modelLoaded !== true) {
    throw new ExperimentError('runtime-not-ready', `${profile.id} runtime did not confirm that the model loaded.`);
  }
  if (metadata.imageCapability !== 'verified' && metadata.imageCapability !== 'pending-canary') {
    throw new ExperimentError(
      'image-runtime-unverified',
      `${profile.id} runtime has not verified image input; image retrieval is disabled.`,
    );
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makeCanaryPng(pixelAt) {
  const width = 96;
  const height = 96;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (1 + width * 4);
    rows[rowOffset] = 0; // PNG filter: None
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixelAt(x, y);
      const pixelOffset = rowOffset + 1 + x * 4;
      rows[pixelOffset] = red;
      rows[pixelOffset + 1] = green;
      rows[pixelOffset + 2] = blue;
      rows[pixelOffset + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

export function makeVisualCanaryImages() {
  return {
    red: makeCanaryPng(() => [240, 24, 24]),
    blue: makeCanaryPng(() => [24, 48, 240]),
    checkerboard: makeCanaryPng((x, y) => ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0 ? [245, 245, 245] : [24, 24, 24])),
  };
}

function maxEmbeddingDelta(left, right) {
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) {
    maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  }
  return maximum;
}

async function runImageCapabilityCanary(session, profile) {
  if (typeof session.embedImageDataUrl !== 'function') {
    throw new ExperimentError('image-canary-unavailable', `${profile.id} runtime adapter cannot submit synthetic image inputs.`);
  }
  const startedAt = performance.now();
  const canaryImages = makeVisualCanaryImages();
  const red = normalizeEmbedding(await session.embedImageDataUrl(canaryImages.red), `${profile.id} red canary image`);
  const blue = normalizeEmbedding(await session.embedImageDataUrl(canaryImages.blue), `${profile.id} blue canary image`);
  const checkerboard = normalizeEmbedding(await session.embedImageDataUrl(canaryImages.checkerboard), `${profile.id} checkerboard canary image`);
  const redRepeat = normalizeEmbedding(await session.embedImageDataUrl(canaryImages.red), `${profile.id} repeated red canary image`);
  const textControl = normalizeEmbedding(await session.embedText(IMAGE_CANARY_TEXT), `${profile.id} canary text control`);
  const distinctDeltas = {
    redBlue: maxEmbeddingDelta(red, blue),
    redCheckerboard: maxEmbeddingDelta(red, checkerboard),
    blueCheckerboard: maxEmbeddingDelta(blue, checkerboard),
    imageTextControl: maxEmbeddingDelta(red, textControl),
  };
  const repeatCosine = cosineSimilarity(red, redRepeat);
  const distinctOutputs = Object.values(distinctDeltas).every((delta) => delta > CANARY_DISTINCT_DELTA_MIN);
  const deterministic = repeatCosine >= CANARY_REPEAT_COSINE_MIN;
  return {
    verified: distinctOutputs && deterministic,
    method: 'generated red, blue, and checkerboard PNGs; compare distinct contents, same-image repeat, and a text-only control',
    distinctDeltas,
    repeatCosine,
    repeatSimilarityMinimum: CANARY_REPEAT_COSINE_MIN,
    distinctVectorDeltaMinimum: CANARY_DISTINCT_DELTA_MIN,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

async function runOneProfile({ profile, files, imagePaths, textQueries, queryImagePath, topK, createSession, onProgress }) {
  const profileResult = {
    id: profile.id,
    label: profile.label,
    modelRevision: MODEL_REVISION,
    core: { filename: path.basename(files.core.path), sizeBytes: files.core.sizeBytes, sha256: files.core.sha256 ?? null },
    projector: { filename: path.basename(files.projector.path), sizeBytes: files.projector.sizeBytes, sha256: files.projector.sha256 ?? null },
    status: 'running',
    errors: [],
    skippedImages: [],
    corpus: [],
    queries: [],
    timingsMs: { startup: null, imageEncodingTotal: 0, queryEncodingTotal: 0, canary: null, total: null },
    canary: null,
    runtimeCommit: null,
    processPeakMemoryBytes: null,
    memoryNote: 'Runtime child-process peak memory is unavailable in this CLI experiment.',
  };
  const profileStartedAt = performance.now();
  let session;

  try {
    const startupStartedAt = performance.now();
    session = await createSession(profile, files);
    profileResult.timingsMs.startup = session.startupMs ?? Math.round(performance.now() - startupStartedAt);
    assertSessionReady(session.metadata, profile);
    profileResult.runtimeCommit = session.metadata.runtimeCommit ?? null;

    profileResult.canary = await runImageCapabilityCanary(session, profile);
    profileResult.timingsMs.canary = profileResult.canary.elapsedMs;
    if (!profileResult.canary.verified) {
      throw new ExperimentError(
        'image-canary-failed',
        `${profile.id} image canary failed; refusing to report image retrieval results.`,
      );
    }
    profileResult.imageCapability = 'verified-by-this-run-canary';

    const corpusByPath = new Map();
    for (const imagePath of imagePaths) {
      const filename = path.basename(imagePath);
      const startedAt = performance.now();
      try {
        const rawEmbedding = await session.embedImage(imagePath);
        const embedding = normalizeEmbedding(rawEmbedding, `${profile.id} image ${filename}`);
        const item = { filename, embedding, encodingMs: Math.round(performance.now() - startedAt) };
        corpusByPath.set(imagePath, item);
        profileResult.corpus.push({ filename, encodingMs: item.encodingMs });
        profileResult.timingsMs.imageEncodingTotal += item.encodingMs;
      } catch (error) {
        if (error instanceof ExperimentError && error.code.startsWith('invalid-embedding')) throw error;
        if (error instanceof ExperimentError && error.code === 'zero-embedding') throw error;
        profileResult.skippedImages.push({ filename, reason: reportErrorCode(error) });
      }
      onProgress?.({ type: 'image', profileId: profile.id, completed: profileResult.corpus.length + profileResult.skippedImages.length, total: imagePaths.length });
    }

    if (profileResult.corpus.length < MIN_CORPUS_IMAGES) {
      throw new ExperimentError(
        'too-few-images-encoded',
        `${profile.id} encoded ${profileResult.corpus.length} images successfully; at least ${MIN_CORPUS_IMAGES} are required.`,
      );
    }

    const embeddedCorpus = [...corpusByPath.values()].map(({ filename, embedding }) => ({ filename, embedding }));
    for (const query of textQueries) {
      const startedAt = performance.now();
      const rawEmbedding = await session.embedText(`${TEXT_QUERY_PREFIX}${query.text}`);
      const embedding = normalizeEmbedding(rawEmbedding, `${profile.id} text query`);
      const encodingMs = Math.round(performance.now() - startedAt);
      profileResult.timingsMs.queryEncodingTotal += encodingMs;
      profileResult.queries.push({
        type: 'text',
        queryId: query.id,
        text: query.text,
        encodingMs,
        results: rankTopK(embedding, embeddedCorpus, topK),
      });
    }

    if (queryImagePath) {
      const startedAt = performance.now();
      const rawEmbedding = await session.embedImage(queryImagePath);
      const embedding = normalizeEmbedding(rawEmbedding, `${profile.id} image query`);
      const encodingMs = Math.round(performance.now() - startedAt);
      profileResult.timingsMs.queryEncodingTotal += encodingMs;
      profileResult.queries.push({
        type: 'image',
        queryId: 'query-image',
        filename: path.basename(queryImagePath),
        encodingMs,
        results: rankTopK(embedding, embeddedCorpus, topK),
      });
    }

    profileResult.status = profileResult.skippedImages.length > 0 ? 'partial' : 'completed';
  } catch (error) {
    profileResult.status = 'failed';
    profileResult.error = {
      code: reportErrorCode(error),
      message: reportErrorMessage(error),
    };
  } finally {
    profileResult.timingsMs.total = Math.round(performance.now() - profileStartedAt);
    try {
      await session?.close();
    } catch {
      profileResult.errors.push('Could not stop the local runtime cleanly.');
      profileResult.status = 'failed';
      profileResult.error ??= { code: 'runtime-shutdown-failed', message: 'Runtime did not stop cleanly.' };
    }
  }

  return profileResult;
}

export function safeErrorMessage(error) {
  if (error && typeof error.message === 'string') return error.message.slice(0, 500);
  return 'Unknown error.';
}

function reportErrorCode(error) {
  if (error instanceof ExperimentError) return error.code;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'request-timeout';
  return 'runtime-error';
}

function reportErrorMessage(error) {
  if (error instanceof ExperimentError) return error.message.split(' Runtime diagnostics:')[0] ?? error.message;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'Inference request timed out.';
  return 'Inference failed; see the terminal for diagnostics.';
}

export async function runExperiment({
  runId = randomUUID(),
  profiles = PROFILES,
  profileFiles,
  imagePaths,
  textQueries = [],
  queryImagePath = null,
  topK = 10,
  createSession,
  onProgress,
}) {
  if (!Array.isArray(textQueries) || textQueries.length === 0) {
    if (!queryImagePath) throw new ExperimentError('missing-queries', 'Provide at least one text query or a query image.');
  }
  if (typeof createSession !== 'function') throw new TypeError('createSession must be a function.');
  const results = [];

  for (const profile of profiles) {
    const files = profileFiles[profile.id];
    if (!files) {
      results.push({ id: profile.id, label: profile.label, status: 'failed', error: { code: 'missing-profile-files', message: `No model files were prepared for ${profile.id}.` } });
      onProgress?.({ type: 'profile-complete', profileId: profile.id, status: 'failed' });
      continue;
    }
    const result = await runOneProfile({ profile, files, imagePaths, textQueries, queryImagePath, topK, createSession, onProgress });
    results.push(result);
    onProgress?.({ type: 'profile-complete', profileId: profile.id, status: result.status });
  }

  return {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    modelSource: `unsloth/embeddinggemma-2-GGUF@${MODEL_REVISION}`,
    dimensions: EMBEDDING_DIMENSIONS,
    normalization: 'L2 unit vectors; cosine is normalized dot product.',
    textQueryPrefix: TEXT_QUERY_PREFIX,
    imageInputPrefix: null,
    topK,
    corpusFiles: imagePaths.map((imagePath) => path.basename(imagePath)),
    queryImage: queryImagePath ? path.basename(queryImagePath) : null,
    textQueries: textQueries.map((query) => query.text),
    status: results.length !== profiles.length || results.some((result) => result.status === 'failed')
      ? 'incomplete'
      : results.some((result) => result.status === 'partial') ? 'partial' : 'completed',
    profiles: results,
  };
}
