import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import * as disk from '../../src/main/dsh/disk';
import { copyTree, inventoryTree, removeManaged } from '../../src/main/dsh/files';

it('copies a nested runtime with bounded parallel file operations and identical sealed bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'worldlinebox-bounded-copy-'));
  const source = path.join(root,'source'); await mkdir(source);
  for(let group=0;group<4;group++) {
    const directory = path.join(source,`group-${group}`); await mkdir(directory);
    await Promise.all(Array.from({length:40},(_,i)=>writeFile(path.join(directory,`${i}.txt`),`file ${group}/${i}`)));
  }
  let active=0;let peak=0;
  const copy = disk.copyFile;
  const spy = vi.spyOn(disk,'copyFile').mockImplementation(async (...args) => {
    active++; peak=Math.max(peak,active);
    try { await new Promise(resolve=>setTimeout(resolve,2)); await copy(...args); } finally { active--; }
  });
  try {
    await copyTree(source,path.join(root,'parallel'),{concurrency:16});
    expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(16);expect(active).toBe(0);
    expect(await inventoryTree(path.join(root,'parallel'))).toEqual(await inventoryTree(source));
    const stopped = new AbortController();stopped.abort();
    await expect(copyTree(source,path.join(root,'cancelled'),{concurrency:16,signal:stopped.signal})).rejects.toThrow();
  } finally { spy.mockRestore(); await removeManaged(tmpdir(),root); }
});
