import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedInstanceData } from '../../src/main/dsh/shared-instance-data';
import { realpath } from '../../src/main/dsh/disk';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import type { OperationContext } from '../../src/main/dsh/operations';

let temporary: string | undefined;
const managers: SharedInstanceData[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(tmpdir()) && path.basename(temporary).startsWith('worldlinebox-shared-root-')) await rm(temporary, { recursive: true, force: true });
});

it('passes cancellation into compatibility admission before touching shared saves or starting a Host', async () => {
  const abort = new AbortController(); let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const manager = new SharedInstanceData({ rootPath: 'unused', plan: () => { throw Error('Cancelled admission must not prepare a Host'); },
    assertCompatible: async (_id, signal) => {
      expect(signal).toBe(abort.signal); entered();
      await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
    } });
  managers.push(manager);
  const operation: OperationContext = { id: 'cancel-admission', signal: abort.signal, update: async () => undefined, log: async () => undefined };
  const prepared = manager.prepare({ runtimeId: 'test' } as DshInstance, '0.2.0', operation);
  await waiting; abort.abort(Error('Caller cancelled admission'));
  await expect(prepared).rejects.toThrow('Caller cancelled admission');
});

it.skipIf(process.platform !== 'win32')('uses the physical shared cwd for upper/lower Windows aliases of one profile root', async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'worldlinebox-shared-root-'));
  const actualRoot = path.join(temporary, 'worldlinebox', 'dsh-launcher');
  await mkdir(actualRoot, { recursive: true });
  const aliasRoot = path.join(temporary, 'WorldlineBox', 'dsh-launcher');
  const make = (rootPath: string) => {
    const manager = new SharedInstanceData({ rootPath, plan: () => { throw new Error('Path initialization must not load or execute a DSH runtime.'); } });
    managers.push(manager); return manager;
  };
  const upper = make(aliasRoot); await upper.init();
  const physicalShared = await realpath(path.join(actualRoot, 'shared'));
  expect(upper.state().rootPath).toBe(physicalShared);
  expect(upper.state().workspacePath).toBe(await realpath(path.join(physicalShared, 'documents', 'deepseek-harness', 'default-workspace')));
  for (const value of Object.values(upper.state())) expect(value.startsWith(physicalShared)).toBe(true);
  const lower = make(actualRoot); await lower.init();
  expect(lower.state()).toEqual(upper.state());
});
