import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { spawnOwnedEmbeddingRuntime, closeOwnedEmbeddingRuntime } from "./embedding-process-owner";
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_WAV_BYTES = 8 * 1024 * 1024;
const MIME_TYPES = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export type LlamaEmbeddingFiles = {
  corePath: string;
  projectorPath: string;
};

export type LlamaEmbeddingMediaBinaries = {
  ffmpegPath: string;
  ffprobePath: string;
};

export type LlamaEmbeddingSession = {
  embedText: (text: string) => Promise<number[]>;
  embedImage: (imagePath: string) => Promise<number[]>;
  embedImagePayload: (mimeType: string, bytesBase64: string) => Promise<number[]>;
  embedVideoPayload: (bytesBase64: string) => Promise<number[]>;
  embedAudio: (wavPath: string) => Promise<number[]>;
  embedAudioPayload: (bytesBase64: string) => Promise<number[]>;
  close: () => Promise<void>;
};

/** OpenAI-style audio block. The WAV is mono 16 kHz PCM, with no text prefix. */
export function embeddingAudioRequestBody(wavBase64: string): {
  model: string;
  input: Array<{ content: Array<{ type: "input_audio"; input_audio: { data: string; format: "wav" } }> }>;
} {
  return {
    model: "embeddinggemma-2",
    input: [{
      content: [{
        type: "input_audio",
        input_audio: { data: wavBase64, format: "wav" },
      }],
    }],
  };
}

/**
 * llama.cpp's typed video input carries the raw container bytes as base64.
 * This release's product index does not call it. Video semantics use the cover
 * image. Multi-frame / `input_video` may return later.
 */
export function embeddingVideoRequestBody(videoBase64: string): {
  model: string;
  input: Array<{ content: Array<{ type: "input_video"; input_video: { data: string } }> }>;
} {
  return {
    model: "embeddinggemma-2",
    input: [{
      content: [{
        type: "input_video",
        input_video: { data: videoBase64 },
      }],
    }],
  };
}

async function chooseLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local inference port.");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForHealth(input: {
  child: ChildProcess;
  baseUrl: string;
  spawnFailed: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < input.timeoutMs) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Semantic runtime startup was cancelled.");
    if (input.spawnFailed() || processHasExited(input.child)) {
      throw new Error("llama-server exited before it was ready.");
    }
    try {
      const timeout = AbortSignal.timeout(2_000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      const response = await fetch(`${input.baseUrl}/health`, { signal });
      if (response.ok) return;
    } catch {
      // Health stays down until the weights finish loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("llama-server did not become ready.");
}

async function postEmbedding(input: {
  baseUrl: string;
  body: unknown;
  timeoutMs: number;
}): Promise<number[]> {
  const response = await fetch(`${input.baseUrl}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`llama-server returned HTTP ${response.status}.`);
  }
  const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const embedding = payload.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
    throw new Error("llama-server did not return an embedding.");
  }
  return embedding as number[];
}

export async function startLlamaEmbeddingSession(input: {
  executable: string;
  files: LlamaEmbeddingFiles;
  mediaBinaries?: LlamaEmbeddingMediaBinaries;
  gpuLayers: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  /** Resolved by Main relative to the packaged app so the inline owner can load koffi. */
  koffiPath?: string;
}): Promise<LlamaEmbeddingSession> {
  if (input.signal?.aborted) throw input.signal.reason ?? new Error("Semantic runtime startup was cancelled.");
  const port = await chooseLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const startupTimeoutMs = input.startupTimeoutMs ?? 180_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 180_000;
  const videoRuntimeDirectory = input.mediaBinaries
    && path.dirname(path.resolve(input.mediaBinaries.ffmpegPath))
      === path.dirname(path.resolve(input.mediaBinaries.ffprobePath))
    ? path.dirname(path.resolve(input.mediaBinaries.ffmpegPath))
    : null;
  // `--video-fps` stays on the runtime so a later release can sample frames again.
  // The product index does not send `input_video` in this version.
  const videoRuntimeArgs = videoRuntimeDirectory
    ? ["--video-fps", "1", "--video-ffmpeg-dir", videoRuntimeDirectory]
    : [];
  const child = spawnOwnedEmbeddingRuntime(input.executable, [
    "--model", input.files.corePath,
    "--mmproj", input.files.projectorPath,
    "--embedding",
    "--pooling", "mean",
    "--ctx-size", "4096",
    "--batch-size", "4096",
    "--ubatch-size", "4096",
    "--n-gpu-layers", String(input.gpuLayers),
    input.gpuLayers > 0 ? "--mmproj-offload" : "--no-mmproj-offload",
    ...videoRuntimeArgs,
    "--host", "127.0.0.1",
    "--port", String(port),
  ], path.dirname(input.executable), { signal: input.signal, koffiPath: input.koffiPath });
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  try {
    await waitForHealth({
      child,
      baseUrl,
      spawnFailed: () => spawnFailed,
      timeoutMs: startupTimeoutMs,
      signal: input.signal,
    });
  } catch (error) {
    await closeOwnedEmbeddingRuntime(child).catch((cleanupError: unknown) => {
      throw new AggregateError([error, cleanupError], "Semantic runtime startup and cleanup both failed.");
    });
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    embedText: (text) => postEmbedding({
      baseUrl,
      timeoutMs: requestTimeoutMs,
      body: { model: "embeddinggemma-2", input: [text] },
    }),
    embedImage: async (imagePath) => {
      const fileInfo = await stat(imagePath);
      if (fileInfo.size > MAX_IMAGE_BYTES) throw new Error("Image is too large to embed.");
      const mimeType = MIME_TYPES.get(path.extname(imagePath).toLowerCase());
      if (!mimeType) throw new Error("Image format is not supported.");
      return embedImagePayload(mimeType, (await readFile(imagePath)).toString("base64"));
    },
    embedImagePayload: (mimeType, bytesBase64) => embedImagePayload(mimeType, bytesBase64),
    embedVideoPayload: (bytesBase64) => {
      if (!videoRuntimeDirectory) throw new Error("Video runtime is unavailable: FFmpeg and ffprobe were not resolved by the application.");
      if (!bytesBase64 || bytesBase64.length > Math.ceil(MAX_VIDEO_BYTES * 4 / 3) + 8) {
        throw new Error("Video payload is too large or unsupported.");
      }
      return postEmbedding({
        baseUrl,
        timeoutMs: requestTimeoutMs,
        body: embeddingVideoRequestBody(bytesBase64),
      });
    },
    embedAudio: async (wavPath) => {
      const fileInfo = await stat(wavPath);
      if (fileInfo.size <= 0 || fileInfo.size > MAX_AUDIO_WAV_BYTES) {
        throw new Error("Audio window is too large to embed.");
      }
      return embedAudioPayload((await readFile(wavPath)).toString("base64"));
    },
    embedAudioPayload: (bytesBase64) => embedAudioPayload(bytesBase64),
    close: () => closing ??= closeOwnedEmbeddingRuntime(child),
  };

  function embedImagePayload(mimeType: string, bytesBase64: string): Promise<number[]> {
    if (![...MIME_TYPES.values()].includes(mimeType) || bytesBase64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) {
      throw new Error("Image payload is too large or unsupported.");
    }
    const dataUrl = `data:${mimeType};base64,${bytesBase64}`;
      return postEmbedding({
        baseUrl,
        timeoutMs: requestTimeoutMs,
        body: {
          model: "embeddinggemma-2",
          input: [{
            content: [{ type: "image_url", image_url: { url: dataUrl } }],
          }],
        },
      });
  }

  function embedAudioPayload(bytesBase64: string): Promise<number[]> {
      if (!bytesBase64 || bytesBase64.length > Math.ceil(MAX_AUDIO_WAV_BYTES * 4 / 3) + 8) {
        throw new Error("Audio window is too large to embed.");
      }
      return postEmbedding({
        baseUrl,
        timeoutMs: requestTimeoutMs,
        body: embeddingAudioRequestBody(bytesBase64),
      });
  }
}
