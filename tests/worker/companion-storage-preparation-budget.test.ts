import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';
import { withCompanionStorageBackgroundPoll, withCompanionStorageOperation } from '../../src/main/companions/storage-operation-context';
import { emptyCompanionStorageTimingSegments } from '../../src/shared/companion-storage-timing';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: transport.fork } }));
function removeFixture(root: string): void {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('storage-preparation-budget-')) throw Error('Unexpected fixture root.');
  rmSync(root, { recursive: true, force: true });
}

it('continues real committed world ticks during a preparation scope without pausing background domains', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'storage-preparation-budget-'));
  const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, [{ id: 'alice', name: 'alice', description: '', persona: '认真', model: '', avatar: 'sister', active: true, proactive: false }]);
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    postMessage: vi.fn(), kill: vi.fn() });
  let closed = false, executedTicks = 0;
  child.postMessage.mockImplementation((message: { type?: string; requestId?: string; command?: CompanionStorageCommand }) => {
    if (message.type === 'storage.initialize') child.emit('message', { type: 'storage.ready' });
    else if (message.type === 'storage.close') {
      store.close(); closed = true; child.emit('message', { type: 'storage.closed' }); queueMicrotask(() => child.emit('exit', 0));
    } else if (message.command) {
      setImmediate(() => {
        const receivedEpochMs = performance.timeOrigin + performance.now(), response = store.request(message.command!);
        const respondedEpochMs = performance.timeOrigin + performance.now();
        if (message.command!.type === 'world.tick') executedTicks++;
        child.emit('message', { requestId: message.requestId, response, timing: { receivedEpochMs, respondedEpochMs,
          parseMs: 0, runMs: respondedEpochMs - receivedEpochMs, segments: emptyCompanionStorageTimingSegments() } });
      });
    }
  });
  transport.fork.mockImplementation(() => { queueMicrotask(() => child.emit('message', { type: 'storage.booted' })); return child; });
  const client = new CompanionStorageClient('fixture-worker.js', filename), release = client.acquireForegroundPreparation();
  try {
    await client.start();
    const before = db.prepare('SELECT json_extract(data,\'$.cursor\') AS cursor FROM companion_world WHERE id=1').get() as { cursor: number };
    const until = Math.max(Date.now(), before.cursor) + 2000;
    const ticks = Array.from({ length: 20 }, (_, index) => withCompanionStorageOperation({ priority: 'background' }, () =>
      withCompanionStorageBackgroundPoll(() => client.request({ type: 'world.tick', now: new Date(until - 1900 + index * 100).toISOString() }))));
    const results = await Promise.all(ticks);
    expect(results.every(result => result.ok)).toBe(true); expect(executedTicks).toBe(20); expect(closed).toBe(false);
    const after = db.prepare('SELECT json_extract(data,\'$.cursor\') AS cursor FROM companion_world WHERE id=1').get() as { cursor: number };
    expect(after.cursor).toBeGreaterThan(before.cursor);
    expect(child.kill).not.toHaveBeenCalled();
    // Only after all real background transactions have completed do we end
    // the preparation scope. No domain pause/configuration command is used.
    release(); await client.close(); expect(closed).toBe(true);
  } finally {
    release(); if (!closed) { child.emit('exit', 0); await client.close().catch(() => undefined); store.close(); }
    db.close(); vi.restoreAllMocks();
    removeFixture(root);
  }
});
