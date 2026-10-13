import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedSettingsCoordinator } from '../../src/main/dsh/shared-settings';
import type { NativeSettingsTransport } from '../../src/main/dsh/shared-settings-rpc';

let server: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  if (root && path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-settings-close-')) await rm(root, { recursive: true, force: true });
});

it('does not resurrect a transport or timer when authentication finishes after disposal', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-settings-close-'));
  let finish!: (transport: NativeSettingsTransport) => void;
  const connecting = new Promise<NativeSettingsTransport>(resolve => { finish = resolve; });
  const close = vi.fn(), onChanged = vi.fn(() => () => undefined), describe = vi.fn(async () => []);
  const coordinator = new SharedSettingsCoordinator({ storePath: path.join(root, 'shared', 'models.json'), connect: async () => connecting });
  const attached = coordinator.attach('instance-a', 'fixture-ready', path.join(root, 'home'));
  const rejected = expect(attached).rejects.toThrow('cancelled');
  await coordinator.dispose();
  finish({ describe, mutate: async () => { throw new Error('Unexpected mutation.'); }, onChanged, close });
  await rejected;
  expect(close).toHaveBeenCalledTimes(1);
  expect(onChanged).not.toHaveBeenCalled();
  expect(describe).not.toHaveBeenCalled();
  await expect(coordinator.attach('instance-a', 'fixture-ready', path.join(root, 'home'))).rejects.toThrow('closed');
});

it('aborts an in-flight native settings read before awaiting the coordinator shutdown queue', async () => {
  root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-settings-close-'));
  let entered!: () => void;
  const pendingRead = new Promise<void>(resolve => { entered = resolve; });
  server = createServer((request, response) => {
    request.on('error', () => undefined);
    if (request.method === 'GET') { response.writeHead(303, { location: './', 'set-cookie': 'fixtureAuth=private; HttpOnly' }).end(); return; }
    // Deliberately never return the settings response. Shutdown must cancel the
    // client before it waits for the serialized sync job containing that read.
    request.resume(); entered();
  });
  server.on('connection', socket => { socket.on('error', () => undefined); });
  server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener.');
  const coordinator = new SharedSettingsCoordinator({ storePath: path.join(root, 'shared', 'models.json') });
  const attached = coordinator.attach('instance-a', `http://127.0.0.1:${address.port}/?private-fixture`, path.join(root, 'home'));
  await pendingRead;
  const start = performance.now();
  await coordinator.dispose(); await attached;
  expect(performance.now() - start).toBeLessThan(1_000);
});
