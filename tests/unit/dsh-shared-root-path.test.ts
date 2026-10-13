import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SharedInstanceData } from '../../src/main/dsh/shared-instance-data';
import { realpath } from '../../src/main/dsh/disk';

let temporary: string | undefined;
const managers: SharedInstanceData[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
  if (temporary && path.dirname(path.resolve(temporary)) === path.resolve(tmpdir()) && path.basename(temporary).startsWith('worldlinebox-shared-root-')) await rm(temporary, { recursive: true, force: true });
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
