import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DSH_OFFICIAL_WINDOWS_URL, type DshRuntime } from '../../src/shared/dsh-launcher';
import { fetchHttpsDownload, type HttpsDownloadFetch } from '../../src/main/dsh/https-download';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import type { OperationContext } from '../../src/main/dsh/operations';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

async function service(fetch: HttpsDownloadFetch) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-download-')); roots.push(root);
  const manager = new RuntimeService({ rootPath: root, sevenZipPath: 'unused', onChanged: () => undefined, fetch });
  await manager.init();
  const controller = new AbortController();
  const operation: OperationContext = { id: 'download-fixture', signal: controller.signal, update: async () => undefined, log: async () => undefined };
  const imported = vi.spyOn(manager, 'import').mockResolvedValue({ id: 'fixture' } as DshRuntime);
  return { root, manager, operation, controller, imported };
}

describe('DSH HTTPS download routing', () => {
  it('tracks HTTPS redirects without relying on the empty Electron Response.url', async () => {
    const responses = [new Response('', { status: 302, headers: { location: '/releases/fixed.exe' } }), new Response('installer')];
    const fetch = vi.fn<HttpsDownloadFetch>(async () => responses.shift()!);
    const signal = new AbortController().signal;
    const response = await fetchHttpsDownload(DSH_OFFICIAL_WINDOWS_URL, fetch, signal);
    expect(response.url).toBe('');
    expect(await response.text()).toBe('installer');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([DSH_OFFICIAL_WINDOWS_URL, 'https://download.deepseek.com/releases/fixed.exe']);
    expect(fetch.mock.calls.every(([, init]) => init.redirect === 'manual' && init.signal === signal)).toBe(true);
  });

  it('rejects insecure requests, downgraded redirects, credentials and redirect loops before continuing', async () => {
    const fetch = vi.fn<HttpsDownloadFetch>(async () => new Response('', { status: 302, headers: { location: 'http://example.com/payload' } }));
    const signal = new AbortController().signal;
    await expect(fetchHttpsDownload('http://example.com/payload', fetch, signal)).rejects.toThrow('HTTPS');
    expect(fetch).not.toHaveBeenCalled();
    await expect(fetchHttpsDownload(DSH_OFFICIAL_WINDOWS_URL, fetch, signal)).rejects.toThrow('HTTPS');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(fetchHttpsDownload('https://user:password@example.com/file', fetch, signal)).rejects.toThrow('credentials');
    const loop = vi.fn<HttpsDownloadFetch>(async () => new Response('', { status: 302, headers: { location: '/loop' } }));
    await expect(fetchHttpsDownload(DSH_OFFICIAL_WINDOWS_URL, loop, signal)).rejects.toThrow('too many');
    expect(loop).toHaveBeenCalledTimes(6);
  });
});

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('DSH streamed installer download', () => {
  it('caches and imports the verified payload when transport responses have an empty URL', async () => {
    const { root, manager, operation, imported } = await service(async () => new Response('installer', { headers: { 'content-length': '9' } }));
    await manager.download(operation, sha256('installer'));
    const cache = path.join(root, 'cache', `${sha256('installer')}.exe`);
    expect(await readFile(cache, 'utf8')).toBe('installer');
    expect(imported).toHaveBeenCalledWith(cache, 'installer', DSH_OFFICIAL_WINDOWS_URL, operation, sha256('installer'));
    expect(await readdir(path.join(root, 'cache'))).toEqual([`${sha256('installer')}.exe`]);
  });

  it('rejects failed responses and oversized advertised bodies and cancels their stream', async () => {
    for (const response of [{ status: 503, length: '1', error: 'HTTP 503' }, { status: 200, length: String(2 * 1024 ** 3 + 1), error: '2 GiB' }]) {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const { root, manager, operation, imported } = await service(async () => new Response(body, { status: response.status, headers: { 'content-length': response.length } }));
      await expect(manager.download(operation)).rejects.toThrow(response.error);
      expect(cancel).toHaveBeenCalledOnce();
      expect(imported).not.toHaveBeenCalled();
      expect(await readdir(path.join(root, 'cache'))).toEqual([]);
    }
  });

  it('handles decoded compressed bodies without comparing their size to the encoded Content-Length', async () => {
    const { root, manager, operation } = await service(async () => new Response('installer', { headers: { 'content-length': '20', 'content-encoding': 'gzip' } }));
    await manager.download(operation, sha256('installer'));
    expect(await readFile(path.join(root, 'cache', `${sha256('installer')}.exe`), 'utf8')).toBe('installer');
  });

  it('never imports truncated or SHA-256 mismatched bytes and removes partial files', async () => {
    for (const response of [{ length: '100', digest: undefined, error: 'incomplete' }, { length: '9', digest: sha256('different'), error: 'SHA-256' }]) {
      const { root, manager, operation, imported } = await service(async () => new Response('installer', { headers: { 'content-length': response.length } }));
      await expect(manager.download(operation, response.digest)).rejects.toThrow(response.error);
      expect(imported).not.toHaveBeenCalled();
      expect(await readdir(path.join(root, 'cache'))).toEqual([]);
    }
  });

  it('aborts the body transfer, cancels its producer and removes incomplete bytes', async () => {
    const cancel = vi.fn();
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); }, cancel });
    const { root, manager, operation, controller, imported } = await service(async (_url, init) => { signal = init.signal; return new Response(body); });
    const result = manager.download(operation);
    const assertion = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort(new Error('Cancelled by user'));
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(imported).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, 'cache'))).toEqual([]);
  });
});
