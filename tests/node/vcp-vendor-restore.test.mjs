import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { restoreMissingVcpFiles, VCP_COMMIT, VCP_REPOSITORY } from '../../scripts/vcp-memory-vendor-restore.mjs';

const { AbortSignal, Response } = globalThis;

const prefix = 'worldline-vcp-vendor-restore-';
const entryFor = (file, bytes) => ({ path: file, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const destination = path.join(root, 'vendor');
  await mkdir(destination);
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), path.resolve(tmpdir()), 'cleanup must remain directly under the temp directory');
    assert.ok(path.basename(target).startsWith(prefix), 'cleanup must have the test-owned prefix');
    await rm(target, { recursive: true, force: true });
  });
  const restore = (entries, fetchFn, overrides = {}) => restoreMissingVcpFiles({ destination, entries,
    repository: VCP_REPOSITORY, commit: VCP_COMMIT, fetchFn, ...overrides });
  return { root, destination, restore };
}

test('restores only missing allowlisted files using their exact pinned URL and verified bytes', async t => {
  const f = await fixture(t), existing = Buffer.from('already verified'), missing = Buffer.from('pinned missing bytes');
  const entries = [entryFor('existing.js', existing), entryFor('Plugin/Memory file.txt', missing)];
  await writeFile(path.join(f.destination, 'existing.js'), existing);
  const calls = [];
  const restored = await f.restore(entries, async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(missing);
  });
  assert.equal(restored, 1);
  assert.deepEqual(calls, [`https://raw.githubusercontent.com/lioensky/VCPToolBox/${VCP_COMMIT}/Plugin/Memory%20file.txt`]);
  assert.deepEqual(await readFile(path.join(f.destination, 'existing.js')), existing);
  assert.deepEqual(await readFile(path.join(f.destination, 'Plugin/Memory file.txt')), missing);
  assert.deepEqual(await readdir(path.join(f.destination, 'Plugin')), ['Memory file.txt']);
  const second = await f.restore(entries, () => { throw new Error('verified files must not cause a network request'); });
  assert.equal(second, 0);
});

test('rejects an unpinned repository or commit before filesystem changes or fetching', async t => {
  const f = await fixture(t), entry = entryFor('file.txt', Buffer.from('data'));
  for (const overrides of [{ repository: 'https://github.com/other/project' }, { commit: '0'.repeat(40) }]) {
    await assert.rejects(f.restore([entry], () => { throw new Error('must not fetch'); }, overrides), /audited repository and commit/);
  }
  assert.deepEqual(await readdir(f.destination), []);
});

test('preflights existing tamper and refuses to overwrite it or fetch another missing file', async t => {
  const f = await fixture(t), valid = Buffer.from('valid'), tampered = Buffer.from('local tamper');
  await writeFile(path.join(f.destination, 'tampered.js'), tampered);
  let fetched = false;
  await assert.rejects(f.restore([entryFor('missing.js', valid), entryFor('tampered.js', valid)], async () => {
    fetched = true; return new Response(valid);
  }), /checksum mismatch: tampered\.js/);
  assert.equal(fetched, false);
  assert.deepEqual(await readFile(path.join(f.destination, 'tampered.js')), tampered);
  await assert.rejects(readFile(path.join(f.destination, 'missing.js')), { code: 'ENOENT' });
});

test('rejects malformed or escaping allowlist entries before a download', async t => {
  const f = await fixture(t), valid = entryFor('file.txt', Buffer.from('data'));
  const entries = [
    { ...valid, path: '../outside.txt' }, { ...valid, path: 'nested/../outside.txt' },
    { ...valid, path: 'nested\\..\\outside.txt' }, { ...valid, path: path.join(f.root, 'outside.txt') },
    { ...valid, path: 'C:outside.txt' }, { ...valid, path: 'nested//file.txt' },
    { ...valid, bytes: -1 }, { ...valid, bytes: 1.5 }, { ...valid, sha256: 'invalid' },
  ];
  for (const entry of entries) await assert.rejects(f.restore([entry], () => { throw new Error('must not fetch'); }), /Invalid VCP restore allowlist/);
  await assert.rejects(f.restore([valid, valid], () => { throw new Error('must not fetch'); }), /Duplicate VCP restore entry/);
  assert.deepEqual(await readdir(f.destination), []);
});

test('rejects oversized, truncated, or hash-mismatched responses without publishing partial bytes', async t => {
  const f = await fixture(t), good = Buffer.from('good'), entry = entryFor('file.txt', good);
  for (const body of [Buffer.from('oversized'), Buffer.from('bad'), Buffer.from('evil')]) {
    await assert.rejects(f.restore([entry], async () => new Response(body)), /allowed size|checksum mismatch/);
    assert.deepEqual(await readdir(f.destination), []);
  }
  await assert.rejects(f.restore([entry], async () => new Response('not found', { status: 404 })), /HTTP 404/);
  assert.deepEqual(await readdir(f.destination), []);
});

test('does not overwrite a tampered file created while a verified download is in flight', async t => {
  const f = await fixture(t), good = Buffer.from('verified bytes'), raced = Buffer.from('racing local content');
  const entry = entryFor('race.txt', good);
  await assert.rejects(f.restore([entry], async () => {
    await writeFile(path.join(f.destination, entry.path), raced);
    return new Response(good);
  }), /checksum mismatch: race\.txt/);
  assert.deepEqual(await readFile(path.join(f.destination, entry.path)), raced);
  assert.deepEqual(await readdir(f.destination), ['race.txt'], 'failed publication must remove its temporary file');
});

test('accepts a racing writer only when it already published the exact pinned bytes', async t => {
  const f = await fixture(t), good = Buffer.from('verified bytes'), entry = entryFor('race.txt', good);
  assert.equal(await f.restore([entry], async () => {
    await writeFile(path.join(f.destination, entry.path), good);
    return new Response(good);
  }), 1);
  assert.deepEqual(await readFile(path.join(f.destination, entry.path)), good);
  assert.deepEqual(await readdir(f.destination), ['race.txt']);
});

test('refuses a pre-existing directory junction before fetching or writing its target', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(f.destination, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.restore([entryFor('linked/file.txt', Buffer.from('data'))], () => { throw new Error('must not fetch'); }), /unsafe link/);
  assert.deepEqual(await readdir(outside), []);
});
