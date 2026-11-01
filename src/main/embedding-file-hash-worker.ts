import { Worker } from 'node:worker_threads';

// Fixed host code only. File paths are messages, never interpolated JavaScript.
// One buffer serves every file in a verification session; no file bytes enter Main.
const hashWorkerSource = String.raw`
const { parentPort } = require('node:worker_threads');
const { open } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const buffer = Buffer.allocUnsafe(1024 * 1024);
parentPort.on('message', async ({ id, file }) => {
  try {
    const handle = await open(file, 'r');
    let sha256;
    try {
      const hash = createHash('sha256');
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      sha256 = hash.digest('hex');
    } finally { await handle.close(); }
    parentPort.postMessage({ id, sha256 });
  } catch (error) {
    parentPort.postMessage({ id, error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : 'File verification failed.',
      ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    } });
  }
});
`;

type PendingHash = { id: number; resolve: (sha256: string) => void; reject: (error: Error) => void };

/** Private, sequential integrity session. It stores no hashes between calls. */
export class EmbeddingFileHashSession {
  readonly #worker = new Worker(hashWorkerSource, { eval: true, name: 'WorldlineBox embedding integrity' });
  #pending: PendingHash | undefined;
  #sequence = 0;
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;

  constructor() {
    this.#worker.on('message', (message: unknown) => {
      const pending = this.#pending;
      if (!pending) { this.#fail(new Error('File verification returned an unexpected response.')); return; }
      if (typeof message !== 'object' || message === null || !('id' in message) || message.id !== pending.id) {
        this.#fail(new Error('File verification returned a mismatched response.')); return;
      }
      if ('sha256' in message && Object.keys(message).length === 2
        && typeof message.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(message.sha256)) {
        this.#pending = undefined;
        pending.resolve(message.sha256);
        return;
      }
      if ('error' in message && Object.keys(message).length === 2 && typeof message.error === 'object' && message.error !== null
        && 'name' in message.error && typeof message.error.name === 'string'
        && 'message' in message.error && typeof message.error.message === 'string'
        && Object.keys(message.error).every(key => ['name', 'message', 'code'].includes(key))
        && (!('code' in message.error) || typeof message.error.code === 'string')) {
        const error = new Error(message.error.message);
        error.name = message.error.name;
        if ('code' in message.error) Object.defineProperty(error, 'code', { value: message.error.code, enumerable: true });
        this.#pending = undefined;
        pending.reject(error);
        return;
      }
      this.#fail(new Error('File verification returned an invalid response.'));
    });
    this.#worker.on('error', error => { this.#fail(error instanceof Error ? error : new Error('File verification worker failed.')); });
    this.#worker.on('exit', code => {
      if (!this.#closing) this.#fail(new Error(`File verification worker exited before closure (${code}).`));
    });
  }

  hash(file: string): Promise<string> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closing) return Promise.reject(new Error('File verification session is closed.'));
    if (this.#pending) return Promise.reject(new Error('File verification session already has an active file.'));
    return new Promise<string>((resolve, reject) => {
      this.#pending = { id: ++this.#sequence, resolve, reject };
      try { this.#worker.postMessage({ id: this.#sequence, file }); }
      catch (error) { this.#fail(error instanceof Error ? error : new Error('File verification could not be dispatched.')); }
    });
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#pending?.reject(this.#failure);
    this.#pending = undefined;
    // A failed thread is never reused or automatically replayed.
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#pending?.reject(new Error('File verification session closed before completion.'));
    this.#pending = undefined;
    // terminate() resolves only once the actual thread has exited.
    this.#closing = this.#worker.terminate().then(() => undefined);
    return this.#closing;
  }
}
