import { createHash } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import bundledManifest from '../../resources/embedding-models/manifest.json';
import {
  LOCAL_TEXT_EMBEDDING_MODEL,
  LOCAL_TEXT_EMBEDDING_MODEL_ID,
  type LocalTextEmbeddingInstallStatus,
} from '../shared/embedding/global-profile';
import { downloadEmbeddingFile, extractRuntimeArchive, LLAMA_CPP_RELEASE, pinnedLlamaRuntimeUrl, type EmbeddingFileDownloader } from './embedding-install';

const RUNTIME_ARCHIVE_SHA256 = 'ed20ed40e10c04d0853d8acf8700f0e6c1bb8212f0cc70c3a0da13dcbbc1b802';

export function localTextEmbeddingDirectory(userDataPath: string): string {
  return path.join(userDataPath, 'embedding-models');
}

export function localTextEmbeddingDownloadUrl(fileName: string = LOCAL_TEXT_EMBEDDING_MODEL.fileName): string {
  const model = LOCAL_TEXT_EMBEDDING_MODEL;
  return `https://huggingface.co/${model.repository}/resolve/${model.revision}/${fileName}`;
}

function modelFiles(): Array<{ fileName: string; bytes: number; sha256: string }> {
  const model = LOCAL_TEXT_EMBEDDING_MODEL;
  return [{ fileName: model.fileName, bytes: model.bytes, sha256: model.sha256 },
    { fileName: model.projectorFileName, bytes: model.projectorBytes, sha256: model.projectorSha256 }];
}

/** This Windows package has no CUDA dependency. CPU is also selected with --n-gpu-layers 0. */
export function pinnedCpuEmbeddingRuntimeAsset(platform: NodeJS.Platform, arch: string): { fileName: string; sha256?: string } | null {
  if (platform === 'win32' && arch === 'x64') return {
    fileName: `llama-${LLAMA_CPP_RELEASE}-bin-win-cpu-x64.zip`, sha256: RUNTIME_ARCHIVE_SHA256,
  };
  if (platform === 'win32' && arch === 'arm64') return { fileName: `llama-${LLAMA_CPP_RELEASE}-bin-win-cpu-arm64.zip` };
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return { fileName: `llama-${LLAMA_CPP_RELEASE}-bin-macos-${arch}.tar.gz` };
  return null;
}

function runtimePath(userDataPath: string, platform: NodeJS.Platform = process.platform): string {
  const root = path.join(userDataPath, 'embedding-models', 'runtime-cpu');
  const name = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const visit = (directory: string, depth: number): string | null => {
    if (!existsSync(directory) || depth < 0) return null;
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === name)) return path.join(directory, name);
    for (const entry of entries) if (entry.isDirectory()) {
      const found = visit(path.join(directory, entry.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return visit(root, 4) ?? path.join(root, name);
}

function receiptPath(userDataPath: string): string {
  return path.join(localTextEmbeddingDirectory(userDataPath), `${LOCAL_TEXT_EMBEDDING_MODEL_ID}.installed.json`);
}

function removalPath(userDataPath: string): string {
  return path.join(localTextEmbeddingDirectory(userDataPath), `${LOCAL_TEXT_EMBEDDING_MODEL_ID}.removed.json`);
}

function readReceipt(userDataPath: string): { revision?: string; sha256?: string; projectorSha256?: string } | null {
  try { return JSON.parse(readFileSync(receiptPath(userDataPath), 'utf8')) as { revision?: string; sha256?: string; projectorSha256?: string }; }
  catch { return null; }
}

export function inspectLocalTextEmbeddingInstall(userDataPath: string, platform: NodeJS.Platform = process.platform, bundleDirectory?: string): LocalTextEmbeddingInstallStatus {
  const model = LOCAL_TEXT_EMBEDDING_MODEL;
  const receipt = readReceipt(userDataPath);
  const fileReady = modelFiles().every(file => {
    try { const stat = statSync(path.join(bundleDirectory ?? localTextEmbeddingDirectory(userDataPath), file.fileName)); return stat.isFile() && stat.size === file.bytes; }
    catch { return false; }
  });
  const installed = fileReady && (Boolean(bundleDirectory) || receipt?.revision === model.revision && receipt.sha256 === model.sha256
    && receipt.projectorSha256 === model.projectorSha256);
  const runtimeInstalled = bundleDirectory
    ? existsSync(path.join(bundleDirectory, 'runtime-cpu', platform === 'win32' ? 'llama-server.exe' : 'llama-server'))
    : existsSync(runtimePath(userDataPath, platform));
  return {
    modelId: LOCAL_TEXT_EMBEDDING_MODEL_ID, phase: installed && runtimeInstalled ? 'ready' : 'missing',
    installed, runtimeInstalled, revision: model.revision, installedRevision: receipt?.revision ?? null,
    updateAvailable: Boolean(receipt?.revision && receipt.revision !== model.revision),
    bytesDownloaded: installed ? model.packageBytes : 0, totalBytes: model.packageBytes, error: null,
  };
}

export function resolveLocalTextEmbeddingLayout(userDataPath: string, bundleDirectory?: string): { corePath: string; runtimePath: string; cpuRuntimePath?: string } | null {
  const status = inspectLocalTextEmbeddingInstall(userDataPath, process.platform, bundleDirectory);
  const root = bundleDirectory ?? localTextEmbeddingDirectory(userDataPath);
  const runtimeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const cpuRuntimePath = bundleDirectory ? path.join(root, 'runtime-cpu', runtimeName) : runtimePath(userDataPath);
  const vulkanRuntimePath = path.join(root, 'runtime-vulkan', runtimeName);
  return status.installed && status.runtimeInstalled ? {
    corePath: path.join(root, LOCAL_TEXT_EMBEDDING_MODEL.fileName),
    runtimePath: existsSync(vulkanRuntimePath) ? vulkanRuntimePath : cpuRuntimePath, cpuRuntimePath,
  } : null;
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

/** Managed model lifecycle; replacement bytes are verified before the installed weights are touched. */
export class LocalTextEmbeddingInstaller {
  #active: Promise<LocalTextEmbeddingInstallStatus> | null = null;
  #progress: LocalTextEmbeddingInstallStatus | null = null;
  #bundleDirectory: string | undefined;
  constructor(private readonly options: {
    userDataPath: string;
    platform?: NodeJS.Platform;
    arch?: string;
    /** Shipped immutable package. Repair restores locally and never contacts the network. */
    bundleDirectory?: string;
    downloadFile?: EmbeddingFileDownloader;
    extractArchive?: typeof extractRuntimeArchive;
    onStatus?: (status: LocalTextEmbeddingInstallStatus) => void;
  }) { this.#bundleDirectory = options.bundleDirectory; }

  status(): LocalTextEmbeddingInstallStatus {
    return this.#progress ? { ...this.#progress } : inspectLocalTextEmbeddingInstall(this.options.userDataPath, this.options.platform, this.#bundleDirectory);
  }

  install(input: { update?: boolean; signal?: AbortSignal } = {}): Promise<LocalTextEmbeddingInstallStatus> {
    if (this.#active) return this.#active;
    const task = this.#install(input).catch(error => {
      this.#publish({ ...inspectLocalTextEmbeddingInstall(this.options.userDataPath, this.options.platform, this.#bundleDirectory), phase: 'failed',
        error: error instanceof Error ? error.message : 'Embedding model installation failed.' });
      throw error;
    }).finally(() => { this.#active = null; });
    this.#active = task;
    return task;
  }

  uninstall(): LocalTextEmbeddingInstallStatus {
    if (this.#active) throw new Error('Wait for the model download to finish before deleting it.');
    // Exact fixed files only. The shared runtime and other model packages remain installed.
    const root = path.resolve(localTextEmbeddingDirectory(this.options.userDataPath));
    const model = LOCAL_TEXT_EMBEDDING_MODEL;
    const otherTierNeedsProjector = existsSync(path.join(root, 'embeddinggemma-2-Q8_0.gguf'));
    for (const name of [model.fileName, ...(otherTierNeedsProjector ? [] : [model.projectorFileName]), path.basename(receiptPath(this.options.userDataPath))]) {
      const target = path.resolve(root, name);
      if (path.dirname(target) !== root) throw new Error('Invalid managed model path.');
      try { unlinkSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    mkdirSync(root, { recursive: true });
    writeFileSync(removalPath(this.options.userDataPath), JSON.stringify({ removedAt: new Date().toISOString() }), 'utf8');
    const status = inspectLocalTextEmbeddingInstall(this.options.userDataPath, this.options.platform, this.#bundleDirectory);
    this.#publish(status);
    return status;
  }

  /** Verify the immutable shipped package in place; never duplicate its large weights under userData. */
  seedBundledPackage(bundleDirectory: string): Promise<LocalTextEmbeddingInstallStatus> {
    if (this.#active) return this.#active;
    this.#bundleDirectory = bundleDirectory;
    const task = this.#seed(bundleDirectory).finally(() => { this.#active = null; });
    this.#active = task;
    return task;
  }

  async #seed(bundleDirectory: string, allowRemoved = false, force = false): Promise<LocalTextEmbeddingInstallStatus> {
    void allowRemoved; void force;
    const platform = `${this.options.platform ?? process.platform}-${this.options.arch ?? process.arch}`;
    type FilePin = { path: string; bytes: number; sha256: string };
    const runtime = (bundledManifest.runtime.platforms as Record<string, { files: FilePin[]; accelerators?: Record<string, { files: FilePin[] }> }>)[platform];
    if (!runtime) throw new Error('The bundled embedding runtime is unavailable on this platform.');
    const files = [...bundledManifest.files, ...runtime.files, ...Object.values(runtime.accelerators ?? {}).flatMap(item => item.files)];
    for (const file of files) {
      const target = path.resolve(bundleDirectory, file.path);
      const relative = path.relative(path.resolve(bundleDirectory), target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(target) || statSync(target).size !== file.bytes
        || await fileSha256(target) !== file.sha256) throw new Error('The bundled embedding package is incomplete or failed its checksum. Repair the application installation.');
    }
    mkdirSync(localTextEmbeddingDirectory(this.options.userDataPath), { recursive: true });
    writeFileSync(receiptPath(this.options.userDataPath), JSON.stringify({ revision: LOCAL_TEXT_EMBEDDING_MODEL.revision,
      sha256: LOCAL_TEXT_EMBEDDING_MODEL.sha256, projectorSha256: LOCAL_TEXT_EMBEDDING_MODEL.projectorSha256,
      verifiedAt: new Date().toISOString(), origin: 'bundled-readonly' }), 'utf8');
    const ready = inspectLocalTextEmbeddingInstall(this.options.userDataPath, this.options.platform, bundleDirectory);
    this.#publish(ready);
    return ready;
  }

  async #install(input: { update?: boolean; signal?: AbortSignal }): Promise<LocalTextEmbeddingInstallStatus> {
    const status = inspectLocalTextEmbeddingInstall(this.options.userDataPath, this.options.platform, this.#bundleDirectory);
    if (status.phase === 'ready' && !input.update && !this.#bundleDirectory) { this.#publish(status); return status; }
    input.signal?.throwIfAborted();
    if (this.#bundleDirectory) {
      const ready = await this.#seed(this.#bundleDirectory, true, input.update === true);
      if (ready.phase !== 'ready') throw new Error('The bundled EmbeddingGemma package is incomplete. Repair the application installation.');
      const removed = removalPath(this.options.userDataPath);
      if (existsSync(removed)) unlinkSync(removed);
      return ready;
    }
    const download = this.options.downloadFile ?? downloadEmbeddingFile;
    const platform = this.options.platform ?? process.platform;
    if (!status.runtimeInstalled) {
      const asset = pinnedCpuEmbeddingRuntimeAsset(platform, this.options.arch ?? process.arch);
      if (!asset) throw new Error('No managed CPU inference runtime is available for this platform.');
      const directory = path.dirname(runtimePath(this.options.userDataPath, platform));
      mkdirSync(directory, { recursive: true });
      const archive = path.join(directory, asset.fileName);
      this.#publish({ ...status, phase: 'downloading', bytesDownloaded: 0 });
      try {
        await download(pinnedLlamaRuntimeUrl(asset.fileName), archive, { signal: input.signal,
          onProgress: progress => this.#publish({ ...status, phase: 'downloading', ...progress, totalBytes: progress.totalBytes ?? 0 }) });
        if (asset.sha256 && await fileSha256(archive) !== asset.sha256) throw new Error('CPU runtime checksum does not match the pinned release.');
        await (this.options.extractArchive ?? extractRuntimeArchive)(archive, directory);
        if (!existsSync(runtimePath(this.options.userDataPath, platform))) throw new Error('CPU inference runtime was not extracted correctly.');
        if (platform !== 'win32') chmodSync(runtimePath(this.options.userDataPath, platform), 0o755);
      } finally { if (existsSync(archive)) unlinkSync(archive); }
    }
    const model = LOCAL_TEXT_EMBEDDING_MODEL;
    const directory = localTextEmbeddingDirectory(this.options.userDataPath);
    mkdirSync(directory, { recursive: true });
    const staged = modelFiles().map(file => ({ ...file, path: path.join(directory, `${file.fileName}.download`) }));
    try {
      if (!status.installed || input.update) {
        this.#publish({ ...status, runtimeInstalled: true, phase: 'downloading', bytesDownloaded: 0 });
        let previousBytes = 0;
        for (const file of staged) {
          await download(localTextEmbeddingDownloadUrl(file.fileName), file.path, { signal: input.signal,
            onProgress: progress => this.#publish({ ...status, runtimeInstalled: true, phase: 'downloading',
              bytesDownloaded: previousBytes + progress.bytesDownloaded, totalBytes: model.packageBytes }) });
          this.#publish({ ...status, runtimeInstalled: true, phase: 'verifying', bytesDownloaded: previousBytes + file.bytes });
          input.signal?.throwIfAborted();
          if (statSync(file.path).size !== file.bytes || await fileSha256(file.path) !== file.sha256) throw new Error('Embedding model checksum does not match the pinned weights.');
          previousBytes += file.bytes;
        }
        input.signal?.throwIfAborted();
        for (const file of staged) renameSync(file.path, path.join(directory, file.fileName));
        const receipt = `${receiptPath(this.options.userDataPath)}.tmp`;
        writeFileSync(receipt, JSON.stringify({ revision: model.revision, sha256: model.sha256,
          projectorSha256: model.projectorSha256, installedAt: new Date().toISOString() }), 'utf8');
        renameSync(receipt, receiptPath(this.options.userDataPath));
      }
    } finally { for (const file of staged) if (existsSync(file.path)) unlinkSync(file.path); }
    const ready = inspectLocalTextEmbeddingInstall(this.options.userDataPath, platform);
    const removed = removalPath(this.options.userDataPath);
    if (existsSync(removed)) unlinkSync(removed);
    this.#publish(ready);
    return ready;
  }

  #publish(status: LocalTextEmbeddingInstallStatus): void {
    this.#progress = status;
    this.options.onStatus?.({ ...status });
  }
}
