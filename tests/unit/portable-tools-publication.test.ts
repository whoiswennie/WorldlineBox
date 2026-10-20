import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type * as FsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises');
const { publishPortableTools } = await import(path.resolve('scripts/publish-portable-tools.mjs')) as {
  publishPortableTools(project: string, staging: string, replace?: boolean): Promise<{ target: string; backup?: string }>;
};

describe('verified portable tool publication', () => {
  let root: string;
  let staging: string;
  let target: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'worldlinebox-portable-publish-')));
    staging = path.join(root, '.tools/portable-tool-staging/bundle-new');
    target = path.join(root, 'resources/portable-tools/win32-x64');
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, 'new.txt'), 'verified replacement');
  });
  afterEach(async () => {
    vi.mocked(rename).mockReset().mockImplementation(actualFs.rename);
    if (path.dirname(root) !== await realpath(tmpdir()) || !path.basename(root).startsWith('worldlinebox-portable-publish-')) throw new Error('Unexpected cleanup target');
    await rm(root, { recursive: true, force: true });
  });
  const previous = async () => {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'old.txt'), 'original tools');
  };

  it('publishes a first bundle without a backup', async () => {
    const result = await publishPortableTools(root, staging);
    expect(result.backup).toBeUndefined();
    expect(await readFile(path.join(target, 'new.txt'), 'utf8')).toBe('verified replacement');
  });

  it('preserves the previous payload in an application-owned backup when repairing', async () => {
    await previous();
    const result = await publishPortableTools(root, staging, true);
    expect(result.backup?.startsWith(path.join(root, '.tools/portable-tool-backups/bundle-'))).toBe(true);
    expect(await readFile(path.join(result.backup!, 'old.txt'), 'utf8')).toBe('original tools');
    expect(await readFile(path.join(target, 'new.txt'), 'utf8')).toBe('verified replacement');
    expect(await readdir(path.dirname(staging))).toEqual([]);
  });

  it('refuses implicit replacement', async () => {
    await previous();
    await expect(publishPortableTools(root, staging)).rejects.toThrow('--repair');
    expect(await readFile(path.join(target, 'old.txt'), 'utf8')).toBe('original tools');
  });

  it('restores the previous payload if publishing the verified replacement fails', async () => {
    await previous();
    vi.mocked(rename).mockImplementationOnce(actualFs.rename).mockRejectedValueOnce(Object.assign(new Error('fixture disk failure'), { code: 'EIO' }));
    await expect(publishPortableTools(root, staging, true)).rejects.toThrow('fixture disk failure');
    expect(await readFile(path.join(target, 'old.txt'), 'utf8')).toBe('original tools');
    expect(await readFile(path.join(staging, 'new.txt'), 'utf8')).toBe('verified replacement');
    expect(await readdir(path.dirname(staging))).toEqual(['bundle-new']);
  });

  it('refuses linked payload directories without moving their contents', async () => {
    const other = path.join(root, 'other');
    await mkdir(other); await writeFile(path.join(other, 'keep.txt'), 'keep');
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(other, target, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(publishPortableTools(root, staging, true)).rejects.toThrow('linked or invalid');
    expect(await readFile(path.join(other, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
