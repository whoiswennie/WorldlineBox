import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeHostClient } from '../../src/main/dsh/native-host-client';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('bounds Host requests even with an existing task signal while honoring the operation deadline', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ready":true}'); } }, 60);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No protocol fixture port.');
  const client = new NativeHostClient(address.port, 'f'.repeat(64), 1);
  try {
    const caller = new AbortController();
    await expect(client.request('/bounded', {}, caller.signal, 10)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(caller.signal.aborted).toBe(false);
    await expect(client.request('/longer-operation', {}, caller.signal, 1000)).resolves.toEqual({ ready: true });
    const stopped = new AbortController();
    const request = client.request('/cancelled', {}, stopped.signal, 1000);
    const reason = new Error('User stopped this operation.'); stopped.abort(reason);
    await expect(request).rejects.toBe(reason);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
