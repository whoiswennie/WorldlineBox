import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/companions/owned-directory-cleanup';
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), 'companion-owned-cleanup-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-owned-cleanup-')) throw Error('Unexpected cleanup'); await rm(root, { recursive: true, force: true }); } });
it('cleans only the selected owner and resumes an interrupted quarantine idempotently', async () => {
  const root = await fixture();
  for (const owner of ['alice', 'bob']) { await mkdir(path.join(root, owner)); await writeFile(path.join(root, owner, 'notes.txt'), owner); }
  await rename(path.join(root, 'alice'), path.join(root, '.reset-alice-job1'));
  await removeOwnedDirectory(root, 'alice', 'job1'); await removeOwnedDirectory(root, 'alice', 'job1');
  expect(await readFile(path.join(root, 'bob', 'notes.txt'), 'utf8')).toBe('bob');
  await expect(readFile(path.join(root, '.reset-alice-job1', 'notes.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects traversal and junction targets while preserving external files', async () => {
  const root = await fixture(), outside = await fixture(); await writeFile(path.join(outside, 'keep.txt'), 'keep');
  await symlink(outside, path.join(root, 'alice'), 'junction');
  await expect(removeOwnedDirectory(root, '../outside', 'job1')).rejects.toThrow('归属');
  await expect(removeOwnedDirectory(root, 'alice', 'job1')).rejects.toThrow('普通归属目录');
  expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('keep');
});
