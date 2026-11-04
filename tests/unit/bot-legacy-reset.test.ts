import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetLegacyBotData } from '../../src/main/companion-bot/legacy-reset';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('clears only the exact legacy-owned directories and preserves shared assets and the new runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-reset-')); roots.push(root);
  const userData = path.join(root, 'profile'), library = path.join(root, 'library'), newRoot = path.join(userData, 'companion-bot-v2');
  for (const dir of [userData, path.join(library, '.worldlinebox', 'companions'), path.join(library, '伙伴记忆'), path.join(library, 'assets'), newRoot]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(userData, 'companion-library.json'), JSON.stringify({ libraryPath: library }));
  await writeFile(path.join(library, '.worldlinebox', 'library.db'), 'asset database');
  await writeFile(path.join(library, 'assets', 'keep.txt'), 'keep');
  await writeFile(path.join(newRoot, 'keep.txt'), 'new state');
  const result = await resetLegacyBotData(userData, newRoot);
  expect(result.completed).toBe(true); expect(result.removed).toHaveLength(2);
  expect(await readFile(path.join(library, 'assets', 'keep.txt'), 'utf8')).toBe('keep');
  expect(await readFile(path.join(newRoot, 'keep.txt'), 'utf8')).toBe('new state');
  expect((await resetLegacyBotData(userData, newRoot)).removed).toEqual(result.removed);
});
it('refuses a new runtime nested in a deletion target before deleting any directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-reset-')); roots.push(root);
  const profile = path.join(root, 'profile'), library = path.join(root, 'library');
  await mkdir(profile); await mkdir(path.join(library, '.worldlinebox', 'companions'), { recursive: true });
  await writeFile(path.join(library, '.worldlinebox', 'library.db'), 'keep');
  await writeFile(path.join(profile, 'companion-library.json'), JSON.stringify({ libraryPath: library }));
  await expect(resetLegacyBotData(profile, path.join(library, '.worldlinebox', 'companions', 'v2'))).rejects.toThrow('拒绝清理');
  expect(await readFile(path.join(library, '.worldlinebox', 'library.db'), 'utf8')).toBe('keep');
});

async function resetFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-bot-reset-')); roots.push(root);
  const userData = path.join(root, 'profile'), library = path.join(root, 'library'), newRoot = path.join(userData, 'companion-bot-v2');
  for (const dir of [userData, path.join(library, '.worldlinebox', 'companions'), path.join(library, '伙伴记忆')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(library, '.worldlinebox', 'library.db'), 'shared database');
  const locator = JSON.stringify({ libraryPath: library });
  await writeFile(path.join(userData, 'companion-library.json'), locator);
  return { root, userData, library, newRoot, hash: createHash('sha256').update(locator).digest('hex') };
}
it('keeps all files on index failure and resumes only after the durable pre-delete barrier succeeds', async () => {
  const f = await resetFixture(), old = path.join(f.library, '伙伴记忆');
  await writeFile(path.join(old, 'original.txt'), 'old diary');
  await expect(resetLegacyBotData(f.userData, f.newRoot, { beforeDelete: async () => { throw new Error('index unavailable'); } })).rejects.toThrow('index unavailable');
  expect(await readFile(path.join(old, 'original.txt'), 'utf8')).toBe('old diary');
  const interrupted = JSON.parse(await readFile(path.join(f.newRoot, 'legacy-reset.json'), 'utf8'));
  expect(interrupted).toMatchObject({ completed: false, phase: 'preparing', beforeDeleteCompleted: false, removed: [] });
  let calls = 0;
  const done = await resetLegacyBotData(f.userData, f.newRoot, { expectedLibrary: f.library, expectedLocatorSha256: f.hash, removeLocator: true, beforeDelete: async manifest => {
    calls++; expect(manifest.oldMemoryRoot).toBe(old); expect(await readFile(path.join(old, 'original.txt'), 'utf8')).toBe('old diary');
  } });
  expect(calls).toBe(1); expect(done).toMatchObject({ completed: true, beforeDeleteCompleted: true, locatorRemoved: true });
  await expect(lstat(old)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(path.join(f.userData, 'companion-library.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('replays a recorded index receipt without running the barrier twice and limits recovery to owned paths', async () => {
  const f = await resetFixture(), old = path.join(f.library, '伙伴记忆'), keep = path.join(f.root, 'must-keep.txt');
  await writeFile(keep, 'unrelated'); await mkdir(f.newRoot, { recursive: true });
  await writeFile(path.join(f.newRoot, 'legacy-reset.json'), JSON.stringify({ version: 3, completed: false, phase: 'deleting', beforeDeleteCompleted: true,
    libraryPath: f.library, locatorSha256: f.hash, targets: [old, keep], removed: [] }));
  const done = await resetLegacyBotData(f.userData, f.newRoot, { beforeDelete: async () => { throw new Error('must not repeat acknowledged index mutation'); } });
  expect(done.completed).toBe(true); expect(done.targets).not.toContain(keep); expect(await readFile(keep, 'utf8')).toBe('unrelated');
});
it('rejects locator changes and a different library before any index or file mutation', async () => {
  const f = await resetFixture(); let calls = 0;
  const beforeDelete = async () => { calls++; };
  await expect(resetLegacyBotData(f.userData, f.newRoot, { expectedLocatorSha256: '0'.repeat(64), beforeDelete })).rejects.toThrow('定位文件已变化');
  const other = path.join(f.root, 'other'); await mkdir(other);
  await expect(resetLegacyBotData(f.userData, f.newRoot, { expectedLibrary: other, beforeDelete })).rejects.toThrow('审核清单不一致');
  expect(calls).toBe(0); expect((await lstat(path.join(f.library, '伙伴记忆'))).isDirectory()).toBe(true);
});
it('rejects nested junctions before index mutation and preserves the external target', async () => {
  const f = await resetFixture(), outside = path.join(f.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'external');
  await symlink(outside, path.join(f.library, '伙伴记忆', 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  await expect(resetLegacyBotData(f.userData, f.newRoot, { beforeDelete: async () => { calls++; } })).rejects.toThrow('含链接');
  expect(calls).toBe(0); expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('external');
});
it('clears exact retired recovery files while retaining the shared database', async () => {
  const f = await resetFixture();
  for (const name of ['companions-recovery-authority.sqlite', 'companions-recovery-authority.sqlite-wal', 'companions-recovery-authority.sqlite-shm', 'companions-recovery-enrollment.json']) {
    await writeFile(path.join(f.library, '.worldlinebox', name), 'old recovery');
  }
  const done = await resetLegacyBotData(f.userData, f.newRoot);
  expect(done.removed).toHaveLength(6); expect(await readFile(path.join(f.library, '.worldlinebox', 'library.db'), 'utf8')).toBe('shared database');
});
it('recovers a crash after locator removal from the acknowledged journal without another index mutation', async () => {
  const f = await resetFixture(), old = path.join(f.library, '伙伴记忆');
  await mkdir(f.newRoot, { recursive: true });
  await writeFile(path.join(f.newRoot, 'legacy-reset.json'), JSON.stringify({ version: 3, completed: false, phase: 'deleting', beforeDeleteCompleted: true,
    libraryPath: f.library, locatorSha256: f.hash, targets: [old], removed: [old], locatorRemoved: true }));
  await rm(old, { recursive: true }); await rm(path.join(f.userData, 'companion-library.json'));
  const done = await resetLegacyBotData(f.userData, f.newRoot, { expectedLibrary: f.library, expectedLocatorSha256: f.hash, removeLocator: true,
    beforeDelete: async () => { throw new Error('must not repeat completed barrier'); } });
  expect(done).toMatchObject({ completed: true, phase: 'done', beforeDeleteCompleted: true });
  expect(await readFile(path.join(f.library, '.worldlinebox', 'library.db'), 'utf8')).toBe('shared database');
});
