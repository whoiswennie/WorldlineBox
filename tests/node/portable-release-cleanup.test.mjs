import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { cleanupPortableRelease } from '../../scripts/portable-release-cleanup.mjs';

async function fixture(t) {
  const temporaryParent = await realpath(tmpdir());
  const root = await mkdtemp(path.join(temporaryParent, 'worldlinebox-release-cleanup-'));
  const project = path.join(root, 'project');
  const stage = path.join(project, '.tools', 'portable-release', randomUUID());
  const resources = path.join(stage, 'resources');
  const links = [];
  t.after(async () => {
    // Remove only known link entries, then the checked test-owned directory.
    for (const link of links.reverse()) await unlink(link).catch(error => { if (error.code !== 'ENOENT') throw error; });
    assert.equal(path.dirname(await realpath(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith('worldlinebox-release-cleanup-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(resources, { recursive: true });
  const link = async (target, destination) => {
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(destination);
  };
  return { root, project, stage, resources, link };
}

test('reclaims only the completed build while preserving another build, downloads and source resources', async t => {
  const f = await fixture(t);
  const sibling = path.join(path.dirname(f.stage), randomUUID(), 'resources');
  const source = path.join(f.project, 'resources');
  const downloads = path.join(f.project, '.tools', 'portable-downloads');
  for (const directory of [f.resources, sibling, source, downloads]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'keep.txt'), 'original bytes');
  }
  assert.equal(await cleanupPortableRelease(f.project, f.resources), true);
  await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
  for (const directory of [sibling, source, downloads]) assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'original bytes');
  assert.equal(await cleanupPortableRelease(f.project, f.resources), false);
});

test('rejects root, ancestor, traversal, other-project and non-UUID targets without changing the export', async t => {
  const f = await fixture(t);
  const invalid = [f.project, path.dirname(f.stage), f.stage, path.join(f.resources, 'nested'),
    path.join(f.project, '.tools', 'portable-release', 'reviewed', 'resources'),
    path.join(f.project, '.tools', 'portable-release', '..', randomUUID(), 'resources'),
    path.join(f.root, 'another-project', '.tools', 'portable-release', randomUUID(), 'resources')];
  for (const target of invalid) await assert.rejects(cleanupPortableRelease(f.project, target), /UUID\/resources path/);
  assert.equal((await lstat(f.resources)).isDirectory(), true);
});

for (const level of ['project', 'tools', 'release-parent', 'stage', 'resources']) {
  test(`rejects a linked ${level} root and preserves its external target`, async t => {
    const f = await fixture(t);
    const external = path.join(f.root, 'external');
    await mkdir(external);
    const protectedFile = path.join(external, 'protected.txt');
    await writeFile(protectedFile, 'external data');
    const directory = { project: f.project, tools: path.join(f.project, '.tools'),
      'release-parent': path.dirname(f.stage), stage: f.stage, resources: f.resources }[level];
    // This fixture was just created and has no links or non-test content.
    assert.ok(directory.startsWith(f.root + path.sep));
    await rm(directory, { recursive: true, force: true });
    await f.link(external, directory);
    await assert.rejects(cleanupPortableRelease(f.project, f.resources), /Unsafe portable release cleanup directory/);
    assert.equal(await readFile(protectedFile, 'utf8'), 'external data');
    assert.equal((await lstat(directory)).isSymbolicLink(), true);
  });
}

test('deletes a nested junction entry without traversing or deleting its external target', async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external');
  await mkdir(external);
  const protectedFile = path.join(external, 'protected.txt');
  await writeFile(protectedFile, 'external data');
  await f.link(external, path.join(f.resources, 'linked-directory'));
  assert.equal(await cleanupPortableRelease(f.project, f.resources), true);
  await assert.rejects(lstat(f.stage), { code: 'ENOENT' });
  assert.equal(await readFile(protectedFile, 'utf8'), 'external data');
});

test('refuses a non-directory export root and leaves it untouched', async t => {
  const f = await fixture(t);
  await rm(f.resources, { recursive: true });
  await writeFile(f.resources, 'diagnostic bytes');
  await assert.rejects(cleanupPortableRelease(f.project, f.resources), /Unsafe portable release cleanup directory/);
  assert.equal(await readFile(f.resources, 'utf8'), 'diagnostic bytes');
});
