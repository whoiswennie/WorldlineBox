import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  EMBEDDING_AUDIO_SAMPLE_RATE,
  EMBEDDING_AUDIO_WINDOW_SECONDS,
} from "../shared/embedding/profile";

const TEMP_PREFIX = "worldlinebox-embedding-audio-";
const STALE_TEMP_MS = 60 * 60 * 1000;

export function embeddingAudioFfmpegArgs(input: {
  sourcePath: string;
  outputPattern: string;
  windowSeconds?: number;
}): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-i", input.sourcePath,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", String(EMBEDDING_AUDIO_SAMPLE_RATE),
    "-c:a", "pcm_s16le",
    "-f", "segment",
    "-segment_time", String(input.windowSeconds ?? EMBEDDING_AUDIO_WINDOW_SECONDS),
    "-reset_timestamps", "1",
    input.outputPattern,
  ];
}

export type PreparedEmbeddingAudio = {
  directory: string;
  wavPaths: readonly string[];
};

export async function discardPreparedEmbeddingAudio(prepared: PreparedEmbeddingAudio): Promise<void> {
  await rm(prepared.directory, { recursive: true, force: true });
}

export async function renderEmbeddingAudioWindows(input: {
  ffmpegPath: string;
  sourcePath: string;
  maxWindows: number;
}): Promise<PreparedEmbeddingAudio> {
  await discardStaleEmbeddingAudioTemps();
  const directory = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  try {
    await runFfmpeg(input.ffmpegPath, embeddingAudioFfmpegArgs({
      sourcePath: input.sourcePath,
      outputPattern: path.join(directory, "window-%03d.wav"),
    }));
    const names = (await readdir(directory)).filter((name) => name.endsWith(".wav")).sort();
    const kept = names.slice(0, input.maxWindows);
    await Promise.all(names.slice(input.maxWindows).map((name) => (
      rm(path.join(directory, name), { force: true })
    )));
    if (kept.length === 0) throw new Error("Audio produced no samples.");
    return {
      directory,
      wavPaths: kept.map((name) => path.join(directory, name)),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function discardStaleEmbeddingAudioTemps(now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(tmpdir());
  } catch {
    return;
  }
  await Promise.all(names.map(async (name) => {
    if (!name.startsWith(TEMP_PREFIX)) return;
    const directory = path.join(tmpdir(), name);
    try {
      const info = await stat(directory);
      if (!info.isDirectory() || info.mtimeMs > now - STALE_TEMP_MS) return;
      await rm(directory, { recursive: true, force: true });
    } catch {
      // A live conversion may still own this directory.
    }
  }));
}

function runFfmpeg(ffmpegPath: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Audio conversion timed out."));
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Audio conversion failed."));
    });
  });
}
