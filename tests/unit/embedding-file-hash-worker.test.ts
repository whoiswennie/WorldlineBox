import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingFileHashSession } from '../../src/main/embedding-file-hash-worker';
import { fileSha256, LocalTextEmbeddingInstaller, localTextEmbeddingDirectory } from '../../src/main/embedding-text-model-install';
import { LOCAL_TEXT_EMBEDDING_MODEL_ID } from '../../src/shared/embedding/global-profile';

const manifest = vi.hoisted(() => ({
  files: [] as Array<{ path: string; bytes: number; sha256: string }>,
  runtime: { platforms: { 'win32-x64': { files: [] } } },
}));
vi.mock('../../resources/embedding-models/manifest.json', () => ({ default: manifest }));

const directories: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-hash-thread-'));
  directories.push(root);
  return root;
}
const sha = (bytes: Buffer | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
afterEach(() => {
  vi.restoreAllMocks();
  manifest.files = [];
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('embedding integrity hashing off Main', () => {
  it('hashes every byte including empty files and a partial final buffer in a real thread', async () => {
    const root = temporary(), file = path.join(root, "weights' data.bin");
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x7b);
    bytes[bytes.length - 1] = 0x33;
    const expected = sha(bytes);
    writeFileSync(file, bytes);
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    const mainHash = vi.spyOn(crypto, 'createHash').mockImplementation(() => { throw new Error('Hashing must not execute in Main.'); });
    await expect(fileSha256(file)).resolves.toBe(expected);
    expect(mainHash).not.toHaveBeenCalled();
    const worker = post.mock.contexts[0];
    expect(worker).toBeInstanceOf(Worker);
    if (!(worker instanceof Worker)) throw new Error('Expected the actual hash thread.');
    expect(worker.threadId).toBe(-1);
    mainHash.mockRestore();
    writeFileSync(file, '');
    await expect(fileSha256(file)).resolves.toBe(sha(''));
  });

  it('reads changed bytes again within one session and preserves I/O errors without poisoning a later file', async () => {
    const root = temporary(), file = path.join(root, 'weights.bin'), session = new EmbeddingFileHashSession();
    try {
      await expect(session.hash(file)).rejects.toMatchObject({ code: 'ENOENT' });
      writeFileSync(file, 'original');
      await expect(session.hash(file)).resolves.toBe(sha('original'));
      writeFileSync(file, 'modified');
      await expect(session.hash(file)).resolves.toBe(sha('modified'));
    } finally { await session.close(); }
  });

  it('rejects an unfinished hash and waits for the actual thread exit on idempotent close', async () => {
    const file = path.join(temporary(), 'weights.bin');
    writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 0x2a));
    const post = vi.spyOn(Worker.prototype, 'postMessage'), session = new EmbeddingFileHashSession();
    const pending = expect(session.hash(file)).rejects.toThrow(/closed before completion/);
    const worker = post.mock.contexts[0];
    if (!(worker instanceof Worker)) throw new Error('Expected the actual hash thread.');
    expect(worker.threadId).toBeGreaterThan(0);
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await closing;
    await pending;
    expect(worker.threadId).toBe(-1);
    await expect(session.hash(file)).rejects.toThrow(/closed/);
  });

  it('rejects a real unexpected thread exit instead of returning a digest or replaying work', async () => {
    const file = path.join(temporary(), 'weights.bin');
    writeFileSync(file, 'real bytes');
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementationOnce(function (this: Worker) {
      void this.terminate();
    });
    await expect(fileSha256(file)).rejects.toThrow(/worker exited/);
    expect(post).toHaveBeenCalledTimes(1);
    post.mockRestore();
    await expect(fileSha256(file)).resolves.toBe(sha('real bytes'));
  });

  it('verifies all 105 fixture pins through one thread, then rejects a same-size late-file corruption without replacing the receipt', async () => {
    const root = temporary(), bundle = temporary();
    manifest.files = Array.from({ length: 105 }, (_, index) => {
      const bytes = Buffer.alloc(index + 1, index);
      const name = `pinned-${index}.bin`;
      writeFileSync(path.join(bundle, name), bytes);
      return { path: name, bytes: bytes.length, sha256: sha(bytes) };
    });
    const post = vi.spyOn(Worker.prototype, 'postMessage'), onVerification = vi.fn();
    const installer = new LocalTextEmbeddingInstaller({ userDataPath: root, platform: 'win32', arch: 'x64', onVerification });
    await installer.seedBundledPackage(bundle);
    expect(post).toHaveBeenCalledTimes(105);
    expect(new Set(post.mock.contexts).size).toBe(1);
    const worker = post.mock.contexts[0];
    if (!(worker instanceof Worker)) throw new Error('Expected the actual hash thread.');
    expect(worker.threadId).toBe(-1);
    expect(onVerification.mock.calls[0]?.[0]).toMatchObject({ fileCount: 105, verifiedFiles: 105, outcome: 'verified' });
    const receipt = path.join(localTextEmbeddingDirectory(root), `${LOCAL_TEXT_EMBEDDING_MODEL_ID}.installed.json`);
    const receiptBefore = readFileSync(receipt);
    const last = manifest.files[104]!;
    writeFileSync(path.join(bundle, last.path), Buffer.alloc(last.bytes, 0x7f));
    await expect(installer.seedBundledPackage(bundle)).rejects.toThrow(/checksum/);
    expect(onVerification.mock.calls[1]?.[0]).toMatchObject({ fileCount: 105, verifiedFiles: 104, outcome: 'failed' });
    expect(readFileSync(receipt)).toEqual(receiptBefore);
  });
});
