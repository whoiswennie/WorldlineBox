import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error Build utility is directly exercised against real source fixtures.
import { prepareSourceLfs } from '../../scripts/prepare-source-lfs.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('wlb-lfs-source-')) throw Error('Unexpected fixture cleanup');
  await rm(root, { recursive: true, force: true });
} });
async function fixture(pointer = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-lfs-source-')); roots.push(root);
  const directory = path.join(root, 'public/companion-call/deepseek'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'call.model3.json'), JSON.stringify({ FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'] } }));
  await writeFile(path.join(directory, 'model.moc3'), pointer ? 'version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 2048\n' : 'MOC3fixture');
  await writeFile(path.join(directory, 'texture.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { root, directory };
}
it('uses a materialized checkout without requiring Git or downloading anything', async () => {
  const { root } = await fixture(); const git = vi.fn();
  expect(await prepareSourceLfs(root, git)).toEqual({ verified: 2, hydrated: false }); expect(git).not.toHaveBeenCalled();
});
it('repairs a skipped LFS checkout and verifies the files again', async () => {
  const { root, directory } = await fixture(true);
  const git = vi.fn((args: string[]) => {
    if (args[1] === 'pull') writeFileSync(path.join(directory, 'model.moc3'), 'MOC3materialized');
    return { status: 0 };
  });
  expect(await prepareSourceLfs(root, git)).toEqual({ verified: 2, hydrated: true });
  expect(git.mock.calls.map(call => call[0])).toEqual([['lfs', 'version'], ['lfs', 'pull', '--include=public/companion-call/deepseek/**', '--exclude=']]);
});
it('rejects a successful Git exit that left pointers behind', async () => {
  const { root } = await fixture(true);
  await expect(prepareSourceLfs(root, () => ({ status: 0 }))).rejects.toThrow('could not materialize');
});
it('provides an actionable error when LFS is unavailable and preserves the source', async () => {
  const { root, directory } = await fixture(true); const file = path.join(directory, 'model.moc3'); const before = await readFile(file);
  await expect(prepareSourceLfs(root, () => ({ status: 1 }))).rejects.toThrow('Install Git LFS');
  expect(await readFile(file)).toEqual(before);
});
it('rejects an escaping asset reference before invoking Git', async () => {
  const { root, directory } = await fixture(); const git = vi.fn();
  await writeFile(path.join(directory, 'call.model3.json'), JSON.stringify({ FileReferences: { Moc: '../outside.moc3', Textures: [] } }));
  await expect(prepareSourceLfs(root, git)).rejects.toThrow('Unsafe'); expect(git).not.toHaveBeenCalled();
});
