import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTextEmbeddingInstaller, inspectLocalTextEmbeddingInstall, localTextEmbeddingDirectory, pinnedCpuEmbeddingRuntimeAsset } from '../../src/main/embedding-text-model-install';
import { LOCAL_TEXT_EMBEDDING_MODEL, LOCAL_TEXT_EMBEDDING_MODEL_ID } from '../../src/shared/embedding/global-profile';

const directories: string[] = [];
function temporary(): string { const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-text-embedding-install-')); directories.push(directory); return directory; }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('managed CPU text model installation', () => {
  it('pins a Windows CPU-only archive and verifies failed downloads before replacement', async () => {
    expect(pinnedCpuEmbeddingRuntimeAsset('win32', 'x64')?.fileName).toContain('win-cpu-x64');
    const root = temporary();
    const runtime = path.join(root, 'embedding-models', 'runtime-cpu');
    mkdirSync(runtime, { recursive: true }); writeFileSync(path.join(runtime, 'llama-server.exe'), 'runtime');
    const models = localTextEmbeddingDirectory(root); mkdirSync(models, { recursive: true });
    const installed = path.join(models, LOCAL_TEXT_EMBEDDING_MODEL.fileName); writeFileSync(installed, 'previous installed bytes');
    const phases: string[] = [];
    const installer = new LocalTextEmbeddingInstaller({ userDataPath: root, platform: 'win32', arch: 'x64',
      downloadFile: async (_url, destination) => { writeFileSync(destination, 'corrupt or truncated download'); },
      onStatus: status => phases.push(status.phase) });
    await expect(installer.install({ update: true })).rejects.toThrow(/checksum/i);
    expect(readFileSync(installed, 'utf8')).toBe('previous installed bytes');
    expect(existsSync(`${installed}.download`)).toBe(false);
    expect(installer.status().phase).toBe('failed');
    expect(phases).toContain('verifying');
    expect(existsSync(path.join(models, `${LOCAL_TEXT_EMBEDDING_MODEL_ID}.installed.json`))).toBe(false);
  });

  it('deletes only its fixed weights and receipt, retaining the shared runtime and other models', () => {
    const root = temporary(); const modelRoot = localTextEmbeddingDirectory(root); mkdirSync(modelRoot, { recursive: true });
    const runtime = path.join(root, 'embedding-models', 'runtime-cpu'); mkdirSync(runtime, { recursive: true });
    const runtimeFile = path.join(runtime, 'llama-server.exe'); writeFileSync(runtimeFile, 'runtime');
    writeFileSync(path.join(modelRoot, LOCAL_TEXT_EMBEDDING_MODEL.fileName), 'weights');
    writeFileSync(path.join(modelRoot, `${LOCAL_TEXT_EMBEDDING_MODEL_ID}.installed.json`), JSON.stringify({ revision: 'old-revision' }));
    writeFileSync(path.join(root, 'embedding-models', 'other-model.gguf'), 'other');
    expect(inspectLocalTextEmbeddingInstall(root, 'win32').updateAvailable).toBe(true);
    new LocalTextEmbeddingInstaller({ userDataPath: root, platform: 'win32' }).uninstall();
    expect(existsSync(runtimeFile)).toBe(true);
    expect(existsSync(path.join(root, 'embedding-models', 'other-model.gguf'))).toBe(true);
    expect(existsSync(path.join(modelRoot, LOCAL_TEXT_EMBEDDING_MODEL.fileName))).toBe(false);
  });

  it('does not copy damaged immutable bundle files into userData during verification', async () => {
    const root = temporary(); const bundle = temporary();
    const installer = new LocalTextEmbeddingInstaller({ userDataPath: root, platform: 'win32' });
    installer.uninstall();
    writeFileSync(path.join(bundle, LOCAL_TEXT_EMBEDDING_MODEL.fileName), 'should never be read or installed');
    await expect(installer.seedBundledPackage(bundle)).rejects.toThrow(/checksum|incomplete/i);
    expect(existsSync(path.join(localTextEmbeddingDirectory(root), LOCAL_TEXT_EMBEDDING_MODEL.fileName))).toBe(false);
  });

  it('reports an incomplete shipped package instead of downloading a repair from the network', async () => {
    let networkCalled = false;
    const installer = new LocalTextEmbeddingInstaller({ userDataPath: temporary(), bundleDirectory: temporary(),
      downloadFile: async () => { networkCalled = true; } });
    await expect(installer.install({ update: true })).rejects.toThrow(/bundled.*incomplete/i);
    expect(networkCalled).toBe(false);
  });
});
