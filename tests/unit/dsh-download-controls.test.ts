import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { OperationStore } from '../../src/main/dsh/operations';
import { removeManaged } from '../../src/main/dsh/files';

describe('independent operation downloads', () => {
  it('pauses one stream while a second advances, resumes then cancels a paused task, and retains restart retry intents', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-download-controls-'));
    try {
      const operations = new OperationStore(root, () => undefined); await operations.init();
      const gates = new Map<string, () => void>();
      const first = await operations.run('runtime.install','A',undefined, async op => {
        await op.download!.begin(1000); op.download!.report(200);
        await new Promise<void>(resolve => gates.set(op.id, resolve));
        await op.download!.wait(); op.download!.report(900); op.signal.throwIfAborted();
      }, {type:'runtime.install',version:'0.2.0-rc.2'});
      const second = await operations.run('runtime.install','B',undefined, async op => {
        await op.download!.begin(5000); op.download!.report(1200);
        await new Promise<void>(resolve => gates.set(op.id, resolve));
        await op.download!.wait(); op.download!.report(5000);
      }, {type:'runtime.install',version:'0.2.1-alpha.2'});
      await vi.waitFor(() => expect(gates.size).toBe(2));
      await operations.pause(first); gates.get(second)!();
      await vi.waitFor(() => expect(operations.list().find(op => op.id === second)?.status).toBe('succeeded'));
      const paused = operations.list().find(op => op.id === first)!;
      expect(paused.download).toMatchObject({ paused:true,transferredBytes:200,totalBytes:1000,speedBytesPerSecond:0 });
      paused.download!.transferredBytes = 123456; // Consumers cannot mutate the journal.
      expect(operations.list().find(op => op.id === first)!.download!.transferredBytes).toBe(200);
      await operations.resume(first); await operations.pause(first); gates.get(first)!(); operations.cancel(first);
      await operations.settle();
      expect(operations.list().find(op => op.id === first)!.status).toBe('cancelled');
      expect(operations.retryRequest(first)).toEqual({type:'runtime.install',version:'0.2.0-rc.2'});
      expect(JSON.parse(await readFile(path.join(root,'operations.json'),'utf8')).length).toBe(2);
      const reloaded = new OperationStore(root, () => undefined); await reloaded.init();
      expect(reloaded.retryRequest(first)).toEqual({type:'runtime.install',version:'0.2.0-rc.2'});
    } finally { await removeManaged(tmpdir(), root); }
  });
});
