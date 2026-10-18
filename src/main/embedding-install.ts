import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, createWriteStream, unlinkSync, rmSync, chmodSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import { open as openZip, type Entry } from "yauzl";

import {
  EMBEDDING_GEMMA2_MODEL_REVISION,
  EMBEDDING_GEMMA2_TIER_FILES,
  SEMANTIC_SEARCH_MODELS,
  type SemanticSearchModelId,
} from "../shared/embedding/profile";

const TARGET_NAMES = new Set([
  "embeddinggemma-2-UD-Q4_K_XL.gguf",
  "embeddinggemma-2-Q8_0.gguf",
  "embeddinggemma-2-BF16.gguf",
  "mmproj-Q8_0.gguf",
  "mmproj-BF16.gguf",
  "llama-server.exe",
  "llama-server",
]);

const SKIP_DIRECTORIES = new Set([
  "$recycle.bin",
  ".git",
  "appdata",
  "node_modules",
  "program files",
  "program files (x86)",
  "system volume information",
  "windows",
]);

const INTERESTING_DIRECTORY = /embed|gemma|gguf|llama|unsloth|huggingface/i;

export type EmbeddingSearchRoot = {
  readonly path: string;
  /** Drive roots only enter folders whose names look like a model cache. */
  readonly restrictNames: boolean;
};

export type EmbeddingInstallInspection = {
  readonly files: ReadonlyMap<string, string>;
  readonly runtimeFound: boolean;
};

export function installedSemanticModels(fileNames: ReadonlySet<string>): SemanticSearchModelId[] {
  return SEMANTIC_SEARCH_MODELS.filter((model) => {
    const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
    return fileNames.has(files.coreFile) && fileNames.has(files.projectorFile);
  }).map((model) => model.id);
}

export function inspectEmbeddingTree(
  roots: readonly EmbeddingSearchRoot[],
  maxEntries = 8_000,
): EmbeddingInstallInspection {
  const files = new Map<string, string>();
  let seen = 0;
  let runtimeFound = false;

  const visit = (directory: string, depth: number, restrictNames: boolean): void => {
    if (depth < 0 || seen >= maxEntries) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      seen += 1;
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && TARGET_NAMES.has(entry.name)) {
        if (!files.has(entry.name)) files.set(entry.name, fullPath);
        if (entry.name === "llama-server.exe" || entry.name === "llama-server") runtimeFound = true;
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const interesting = INTERESTING_DIRECTORY.test(entry.name);
      if (restrictNames && !interesting) continue;
      visit(fullPath, interesting ? Math.max(depth, 4) : depth - 1, false);
    }
  };

  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    visit(root.path, root.restrictNames ? 1 : 6, root.restrictNames);
  }
  return { files, runtimeFound };
}

export function listExistingDriveRoots(): string[] {
  const roots: string[] = [];
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

export function embeddingSearchRoots(input: { userData: string; home: string }): EmbeddingSearchRoot[] {
  return [
    { path: path.join(input.userData, "embedding-models"), restrictNames: false },
    { path: path.join(input.home, ".cache", "huggingface"), restrictNames: false },
    ...listExistingDriveRoots().map((root) => ({ path: root, restrictNames: true })),
  ];
}

/** Remove on-disk files for one Settings-installed model under userData/embedding-models.
 * Shared projector files stay if another installed tier still needs them. Runtime is never removed.
 */
export function uninstallSemanticModelFiles(input: {
  modelId: SemanticSearchModelId;
  userDataPath: string;
  homePath: string;
}): { removed: string[] } {
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === input.modelId);
  if (!model) return { removed: [] };
  const inspection = inspectEmbeddingTree(embeddingSearchRoots({
    userData: input.userDataPath,
    home: input.homePath,
  }));
  const installed = new Set(installedSemanticModels(new Set(inspection.files.keys())));
  if (!installed.has(input.modelId)) return { removed: [] };

  const stillNeeded = new Set<string>();
  for (const otherId of installed) {
    if (otherId === input.modelId) continue;
    const other = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === otherId);
    if (!other) continue;
    const otherFiles = EMBEDDING_GEMMA2_TIER_FILES[other.tier];
    stillNeeded.add(otherFiles.coreFile);
    stillNeeded.add(otherFiles.projectorFile);
  }

  const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
  const allowedRoot = path.resolve(path.join(input.userDataPath, "embedding-models"));
  const removed: string[] = [];
  for (const fileName of [files.coreFile, files.projectorFile]) {
    if (stillNeeded.has(fileName)) continue;
    const filePath = inspection.files.get(fileName);
    if (!filePath) continue;
    const resolved = path.resolve(filePath);
    const relative = path.relative(allowedRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      unlinkSync(resolved);
      removed.push(resolved);
    } catch {
      // File may already be gone.
    }
  }
  return { removed };
}

export function embeddingDownloadUrl(fileName: string): string {
  return `https://huggingface.co/unsloth/embeddinggemma-2-GGUF/resolve/${EMBEDDING_GEMMA2_MODEL_REVISION}/${fileName}`;
}

export async function downloadEmbeddingFile(
  url: string,
  destination: string,
  options?: {
    onProgress?: (progress: { bytesDownloaded: number; totalBytes?: number }) => void;
    signal?: AbortSignal;
    stallTimeoutMs?: number;
  },
): Promise<void> {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  const candidates = candidateDownloadUrls(url);
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    try {
      await downloadEmbeddingFileOnce(candidate, temporary, destination, options);
      return;
    } catch (error) {
      lastError = error;
      try {
        unlinkSync(temporary);
      } catch {
        // Partial file may already be gone.
      }
      if (options?.signal?.aborted) break;
      if (index + 1 < candidates.length) await sleep(400);
    }
  }
  if (lastError instanceof EmbeddingInstallError) throw lastError;
  throw new EmbeddingInstallError(
    "network",
    lastError instanceof Error ? lastError.message : "Download failed.",
  );
}

async function downloadEmbeddingFileOnce(
  url: string,
  temporary: string,
  destination: string,
  options?: {
    onProgress?: (progress: { bytesDownloaded: number; totalBytes?: number }) => void;
    signal?: AbortSignal;
    stallTimeoutMs?: number;
  },
): Promise<void> {
  const stallTimeoutMs = options?.stallTimeoutMs ?? 45_000;
  const response = await fetch(url, { redirect: "follow", signal: options?.signal });
  if (!response.ok || !response.body) {
    throw new EmbeddingInstallError("network", `Download failed with status ${response.status}.`);
  }
  const totalHeader = response.headers.get("content-length");
  const parsedTotal = totalHeader ? Number(totalHeader) : Number.NaN;
  const knownTotal = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : undefined;
  let bytesDownloaded = 0;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const stallController = new AbortController();
  const reader = response.body.getReader();
  const refreshStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallController.abort();
      void reader.cancel("stall").catch(() => undefined);
    }, stallTimeoutMs);
  };
  const onOuterAbort = (): void => {
    stallController.abort();
    void reader.cancel("abort").catch(() => undefined);
  };
  options?.signal?.addEventListener("abort", onOuterAbort, { once: true });
  refreshStall();
  options?.onProgress?.({
    bytesDownloaded: 0,
    ...(knownTotal === undefined ? {} : { totalBytes: knownTotal }),
  });

  const output = createWriteStream(temporary);
  try {
    while (true) {
      if (stallController.signal.aborted || options?.signal?.aborted) {
        throw new EmbeddingInstallError("network", "Download stalled.");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const buffer = Buffer.from(value);
      await new Promise<void>((resolve, reject) => {
        output.write(buffer, (error) => (error ? reject(error) : resolve()));
      });
      bytesDownloaded += buffer.byteLength;
      refreshStall();
      options?.onProgress?.({
        bytesDownloaded,
        ...(knownTotal === undefined ? {} : { totalBytes: knownTotal }),
      });
    }
    await new Promise<void>((resolve, reject) => {
      output.end((error: Error | null | undefined) => (error ? reject(error) : resolve()));
    });
    renameSync(temporary, destination);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancel errors.
    }
    try {
      output.destroy();
    } catch {
      // Stream already closed.
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Partial file may already be gone.
    }
    if (error instanceof EmbeddingInstallError) throw error;
    if (stallController.signal.aborted) {
      throw new EmbeddingInstallError("network", "Download stalled.");
    }
    throw error;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    options?.signal?.removeEventListener("abort", onOuterAbort);
  }
}

export type EmbeddingFileDownloader = (
  url: string,
  destination: string,
  options?: {
    onProgress?: (progress: { bytesDownloaded: number; totalBytes?: number }) => void;
    signal?: AbortSignal;
    stallTimeoutMs?: number;
  },
) => Promise<void>;

export async function downloadMissingTierFiles(
  modelId: SemanticSearchModelId,
  destinationDir: string,
  alreadyFound: ReadonlySet<string>,
  downloadFile: EmbeddingFileDownloader = downloadEmbeddingFile,
  onProgress?: (progress: EmbeddingDownloadProgress) => void,
): Promise<void> {
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
  if (!model) throw new Error("Unknown semantic model.");
  const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
  for (const fileName of [files.coreFile, files.projectorFile]) {
    if (alreadyFound.has(fileName)) continue;
    await downloadFile(
      embeddingDownloadUrl(fileName),
      path.join(destinationDir, fileName),
      {
        onProgress: (progress) => {
          onProgress?.({
            phase: "downloading-model",
            fileName,
            bytesDownloaded: progress.bytesDownloaded,
            ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
          });
        },
      },
    );
  }
}

/** Pinned llama.cpp build that passed the EmbeddingGemma image canary. Not shipped in the app package. */
export const LLAMA_CPP_RELEASE = "b11457";

/** Approximate download sizes used for free-space checks and UI labels. */
const TIER_CORE_BYTES = {
  Q4_K_XL: 176_000_000,
  Q8_0: 330_000_000,
  BF16: 620_000_000,
} as const;

const TIER_PROJECTOR_BYTES = {
  Q4_K_XL: 530_000_000,
  Q8_0: 530_000_000,
  BF16: 1_050_000_000,
} as const;

const RUNTIME_DOWNLOAD_BYTES: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 80_000_000,
  win32: 900_000_000,
};

export function pinnedLlamaRuntimeAsset(
  platform: NodeJS.Platform,
  arch: string,
): { fileName: string } | null {
  if (platform === "darwin" && arch === "arm64") return { fileName: "llama-b11457-bin-macos-arm64.tar.gz" };
  if (platform === "darwin" && arch === "x64") return { fileName: "llama-b11457-bin-macos-x64.tar.gz" };
  if (platform === "win32" && arch === "x64") return { fileName: "llama-b11457-bin-win-cuda-12.4-x64.zip" };
  if (platform === "win32" && arch === "arm64") return { fileName: "llama-b11457-bin-win-cpu-arm64.zip" };
  return null;
}

export function pinnedLlamaRuntimeUrl(fileName: string): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE}/${fileName}`;
}

export function runtimeArchiveEntryAllowed(entryName: string): boolean {
  const normalized = entryName.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  return normalized.split("/").every((part) => part !== "..");
}

export function embeddingInstallBytes(input: {
  modelId: SemanticSearchModelId;
  alreadyFound: ReadonlySet<string>;
  runtimeFound: boolean;
  platform: NodeJS.Platform;
  arch: string;
}): number {
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === input.modelId);
  if (!model) return 0;
  const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
  let bytes = 0;
  if (!input.alreadyFound.has(files.coreFile)) bytes += TIER_CORE_BYTES[model.tier];
  if (!input.alreadyFound.has(files.projectorFile)) bytes += TIER_PROJECTOR_BYTES[model.tier];
  if (!input.runtimeFound && pinnedLlamaRuntimeAsset(input.platform, input.arch)) {
    bytes += RUNTIME_DOWNLOAD_BYTES[input.platform] ?? 80_000_000;
  }
  return bytes;
}

export function resolveInstalledEmbeddingLayout(
  inspection: EmbeddingInstallInspection,
  modelId: SemanticSearchModelId,
  platform: NodeJS.Platform = process.platform,
): { modelDirectory: string; runtimePath: string } | null {
  const runtimeName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const runtimePath = inspection.files.get(runtimeName)
    ?? inspection.files.get("llama-server")
    ?? inspection.files.get("llama-server.exe");
  if (!runtimePath) return null;
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
  if (!model) return null;
  const files = EMBEDDING_GEMMA2_TIER_FILES[model.tier];
  const core = inspection.files.get(files.coreFile);
  const projector = inspection.files.get(files.projectorFile);
  if (!core || !projector) return null;
  if (path.dirname(core) !== path.dirname(projector)) return null;
  return { modelDirectory: path.dirname(core), runtimePath };
}

export class EmbeddingInstallError extends Error {
  readonly kind: "space" | "network" | "extract" | "failed";

  constructor(kind: EmbeddingInstallError["kind"], detail?: string) {
    super(detail ?? kind);
    this.name = "EmbeddingInstallError";
    this.kind = kind;
  }
}

export type EmbeddingDownloadProgress = {
  readonly bytesDownloaded: number;
  readonly totalBytes?: number;
  readonly fileName?: string;
  readonly phase: "downloading-model" | "downloading-runtime" | "extracting";
};

const GITHUB_DOWNLOAD_MIRRORS: ReadonlyArray<(url: string) => string> = [
  (url) => url,
  (url) => `https://ghproxy.net/${url}`,
  (url) => `https://mirror.ghproxy.com/${url}`,
];

function candidateDownloadUrls(url: string): string[] {
  if (!url.includes("://github.com/") && !url.includes("://objects.githubusercontent.com/")) {
    return [url];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mirror of GITHUB_DOWNLOAD_MIRRORS) {
    const next = mirror(url);
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const execFileAsync = promisify(execFile);

export async function installEmbeddingFiles(input: {
  modelId: SemanticSearchModelId;
  destinationDir: string;
  alreadyFound: ReadonlySet<string>;
  runtimeFound: boolean;
  platform: NodeJS.Platform;
  arch: string;
  freeBytes?: number;
  downloadFile?: EmbeddingFileDownloader;
  extractArchive?: (archivePath: string, destinationDir: string) => Promise<void>;
  onProgress?: (progress: EmbeddingDownloadProgress) => void;
}): Promise<void> {
  const needed = embeddingInstallBytes({
    modelId: input.modelId,
    alreadyFound: input.alreadyFound,
    runtimeFound: input.runtimeFound,
    platform: input.platform,
    arch: input.arch,
  });
  if (input.freeBytes !== undefined && needed > 0 && input.freeBytes < needed) {
    throw new EmbeddingInstallError("space");
  }
  const downloadFile = input.downloadFile ?? downloadEmbeddingFile;
  await downloadMissingTierFiles(
    input.modelId,
    input.destinationDir,
    input.alreadyFound,
    downloadFile,
    input.onProgress,
  );
  if (input.runtimeFound) return;
  const asset = pinnedLlamaRuntimeAsset(input.platform, input.arch);
  if (!asset) return;
  const runtimeDir = path.join(input.destinationDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const archivePath = path.join(runtimeDir, asset.fileName);
  try {
    await downloadFile(pinnedLlamaRuntimeUrl(asset.fileName), archivePath, {
      onProgress: (progress) => {
        input.onProgress?.({
          phase: "downloading-runtime",
          fileName: asset.fileName,
          bytesDownloaded: progress.bytesDownloaded,
          ...(progress.totalBytes === undefined ? {} : { totalBytes: progress.totalBytes }),
        });
      },
    });
    input.onProgress?.({
      phase: "extracting",
      fileName: asset.fileName,
      bytesDownloaded: 0,
    });
    await (input.extractArchive ?? extractRuntimeArchive)(archivePath, runtimeDir);
  } catch (error) {
    rmSync(archivePath, { force: true });
    if (error instanceof EmbeddingInstallError) throw error;
    throw new EmbeddingInstallError(
      "extract",
      error instanceof Error ? error.message : "Runtime install failed.",
    );
  }
  rmSync(archivePath, { force: true });
  markRuntimeExecutable(runtimeDir);
}

/** Compact (lowest quant) package size for Settings labels — models + runtime archive. */
export function semanticModelPackageBytes(modelId: SemanticSearchModelId): number {
  const model = SEMANTIC_SEARCH_MODELS.find((entry) => entry.id === modelId);
  if (!model) return 0;
  return TIER_CORE_BYTES[model.tier] + TIER_PROJECTOR_BYTES[model.tier] + (RUNTIME_DOWNLOAD_BYTES.darwin ?? 12_000_000);
}

function markRuntimeExecutable(directory: string): void {
  if (process.platform === "win32") return;
  const visit = (current: string, depth: number): void => {
    if (depth < 0 || !existsSync(current)) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(fullPath, depth - 1);
      else if (entry.name === "llama-server") chmodSync(fullPath, 0o755);
    }
  };
  visit(directory, 4);
}

export async function extractRuntimeArchive(archivePath: string, destinationDir: string): Promise<void> {
  mkdirSync(destinationDir, { recursive: true });
  if (archivePath.endsWith(".zip")) {
    await extractZipArchive(archivePath, destinationDir);
    return;
  }
  await extractTarArchive(archivePath, destinationDir);
}

async function extractTarArchive(archivePath: string, destinationDir: string): Promise<void> {
  const listed = await execFileAsync("tar", ["-tzf", archivePath], { timeout: 60_000, maxBuffer: 8_000_000 });
  const names = listed.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (names.length === 0 || names.some((name) => !runtimeArchiveEntryAllowed(name))) {
    throw new EmbeddingInstallError("extract", "Runtime archive looks invalid.");
  }
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destinationDir], { timeout: 120_000 });
}

function extractZipArchive(archivePath: string, destinationDir: string): Promise<void> {
  const root = path.resolve(destinationDir);
  return new Promise((resolve, reject) => {
    openZip(archivePath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new EmbeddingInstallError("failed"));
        return;
      }
      const fail = (cause: unknown) => {
        zip.close();
        reject(cause instanceof Error ? cause : new EmbeddingInstallError("failed"));
      };
      zip.on("error", fail);
      zip.on("entry", (entry: Entry) => {
        if (!runtimeArchiveEntryAllowed(entry.fileName)) {
          fail(new EmbeddingInstallError("failed"));
          return;
        }
        const target = path.resolve(root, entry.fileName);
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
          fail(new EmbeddingInstallError("failed"));
          return;
        }
        if (entry.fileName.endsWith("/")) {
          mkdirSync(target, { recursive: true });
          zip.readEntry();
          return;
        }
        mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new EmbeddingInstallError("failed"));
            return;
          }
          const output = createWriteStream(target);
          stream.on("error", fail);
          output.on("error", fail);
          output.on("finish", () => zip.readEntry());
          stream.pipe(output);
        });
      });
      zip.on("end", () => resolve());
      zip.readEntry();
    });
  });
}
