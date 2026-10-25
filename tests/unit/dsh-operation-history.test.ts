import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dshLauncherRequestSchema, type DshOperation } from '../../src/shared/dsh-launcher';
import { OperationStore, type OperationContext } from '../../src/main/dsh/operations';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

function waitForCancellation(operation: OperationContext): Promise<void> {
  if (operation.signal.aborted) return Promise.reject(operation.signal.reason);
  return new Promise((_resolve, reject) => {
    operation.signal.addEventListener('abort', () => reject(operation.signal.reason), { once: true });
  });
}

describe('DSH operation history cleanup', () => {
  it('deletes terminal records and their own logs while keeping queued/running work and managed data', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-history-')); roots.push(root);
    const directory = path.join(root, 'operations'); await mkdir(directory);
    await writeFile(path.join(directory, 'operations.json'), JSON.stringify([{ id: 'interrupted', kind: 'runtime.import', label: 'old interrupted task', status: 'running', phase: 'preparing', startedAt: '2026-10-12T00:00:00Z' }]));
    await writeFile(path.join(directory, 'interrupted.log'), 'previous session');
    for (const area of ['runtimes', 'cache', 'instances', 'packs', 'snapshots']) { await mkdir(path.join(root, area)); await writeFile(path.join(root, area, 'marker'), area); }
    const operations = new OperationStore(directory, () => undefined); await operations.init();
    const succeeded = await operations.run('runtime.verify', 'verified', undefined, async op => { await op.log('verified'); });
    const failed = await operations.run('runtime.download', 'failed', undefined, async op => { await op.log('failed'); throw new Error('Invalid URL'); });
    await operations.settle();
    const cancelled = await operations.run('runtime.download', 'cancelled', undefined, async op => { await op.log('cancelled'); await waitForCancellation(op); });
    operations.cancel(cancelled); await operations.settle();
    const queued = await operations.run('runtime.download', 'queued', undefined, async op => { await op.log('queued'); await waitForCancellation(op); });
    const running = await operations.run('instance.start', 'running', 'instance-a', async op => { await op.update('starting'); await op.log('running'); await waitForCancellation(op); });
    expect(await operations.clearFinished()).toBe(4);
    expect(operations.list().map(item => item.id).sort()).toEqual([queued, running].sort());
    expect((JSON.parse(await readFile(path.join(directory, 'operations.json'), 'utf8')) as DshOperation[]).map(item => item.id).sort()).toEqual([queued, running].sort());
    expect(await readdir(directory)).not.toEqual(expect.arrayContaining([`${succeeded}.log`, `${failed}.log`, `${cancelled}.log`, 'interrupted.log']));
    expect(await readFile(path.join(directory, `${queued}.log`), 'utf8')).toContain('queued');
    expect(await readFile(path.join(directory, `${running}.log`), 'utf8')).toContain('running');
    for (const area of ['runtimes', 'cache', 'instances', 'packs', 'snapshots']) expect(await readFile(path.join(root, area, 'marker'), 'utf8')).toBe(area);
    expect(await operations.clearFinished()).toBe(0);
    await operations.shutdown();
    expect(operations.list().every(item => item.status === 'cancelled')).toBe(true);
  });

  it('accepts only the typed terminal cleanup command, never arbitrary ids, paths or running-status selectors', () => {
    expect(dshLauncherRequestSchema.safeParse({ type: 'runtime.download' }).success).toBe(false);
    expect(dshLauncherRequestSchema.safeParse({ type: 'instance.switch-start', instanceId: 'native' }).success).toBe(false);
    expect(dshLauncherRequestSchema.safeParse({ type: 'operation.clear-finished' }).success).toBe(true);
    for (const extra of [{ operationId: 'running' }, { path: '../instances' }, { status: 'running' }]) {
      expect(dshLauncherRequestSchema.safeParse({ type: 'operation.clear-finished', ...extra }).success).toBe(false);
    }
  });
});
