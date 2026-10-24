import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { VcpMemoryClient, type VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import type { VcpMemoryCommand } from '../../src/main/vcp-memory/contracts';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

describe('VCP worker transport serialization', () => {
  it('detaches dependencies after an idle worker exits unexpectedly and preserves their external target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-idle-exit-'));
    const source = path.join(root, 'external-source'), dataRoot = path.join(root, 'owned'), scope = { scopeId: 'idle-worker-crash' };
    const runtime = path.join(dataRoot, createHash('sha256').update(scope.scopeId).digest('hex'), 'runtime'), link = path.join(runtime, 'node_modules');
    await mkdir(source); await mkdir(runtime, { recursive: true }); await writeFile(path.join(source, 'SENTINEL'), 'external source survives');
    await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    const events = new EventEmitter(), transport: VcpMemoryTransport = { on: events.on.bind(events), kill: () => { events.emit('exit', 0); },
      postMessage(message) { const request = message as { requestId: string }; events.emit('message', { requestId: request.requestId, ok: true, value: {} }); } };
    const client = new VcpMemoryClient({ dataRoot, vendorRoot: 'unused', workerPath: 'unused',
      embedding: { baseUrl: 'http://127.0.0.1/internal', apiKey: 'fixture', model: 'fixture', dimension: 4 }, launch: () => transport });
    try {
      await client.replace(scope, []); events.emit('exit', 7); await client.close();
      await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(path.join(source, 'SENTINEL'), 'utf8')).toBe('external source survives');
    } finally { await client.close(); await removeOwnedDirectory(root); }
  });
  it('sends a plain scope selector when a permission view also contains host functions', async () => {
    const events = new EventEmitter(), sent: VcpMemoryCommand[] = [];
    const transport: VcpMemoryTransport = {
      on: events.on.bind(events), kill: () => { events.emit('exit', 0); },
      postMessage(message) {
        // Unlike Node fork's JSON mode, the production utility process rejects functions.
        const envelope = structuredClone(message) as { requestId: string; command: VcpMemoryCommand };
        sent.push(envelope.command);
        const value = envelope.command.type === 'replace' ? { replaced: true, count: envelope.command.notes.length }
          : envelope.command.type === 'search' ? { results: [], diagnostics: {}, degraded: false } : {};
        events.emit('message', { requestId: envelope.requestId, ok: true, value });
        if (envelope.command.type === 'close') events.emit('exit', 0);
      },
    };
    const client = new VcpMemoryClient({ dataRoot: 'unused-data', vendorRoot: 'unused-vendor', workerPath: 'unused-worker',
      embedding: { baseUrl: 'http://127.0.0.1/internal', apiKey: 'fixture', model: 'fixture', dimension: 4 }, launch: () => transport });
    const view = { scopeId: 'authorized-view', revision: 'host-only-revision', commit: vi.fn(), internal: { task: () => undefined } };
    try {
      await expect(client.replace(view, [{ id: 'note', content: 'alpha', tags: [] }])).resolves.toEqual({ replaced: true, count: 1 });
      await client.search(view, { text: 'alpha', topK: 4, hostCallback: () => undefined } as { text: string; topK: number });
      expect(sent[0]).toMatchObject({ type: 'initialize', configuration: { scope: { scopeId: view.scopeId } } });
      expect(sent[0]!.type === 'initialize' && Object.keys(sent[0]!.configuration.scope)).toEqual(['scopeId']);
      expect(JSON.stringify(sent)).not.toContain('host-only-revision');
      expect(sent.find(command => command.type === 'search')).toEqual({ type: 'search', text: 'alpha', topK: 4 });
      expect(view.commit).not.toHaveBeenCalled();
    } finally { await client.close(); }
  });
});
