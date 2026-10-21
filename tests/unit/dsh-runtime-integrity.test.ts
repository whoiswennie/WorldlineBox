import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeIntegrity } from '../../src/main/dsh/runtime-integrity';
import { CliAdmission } from '../../src/main/dsh/cli-admission';
import { connect } from 'node:net';
import { inventoryTree, type TreeHashCacheEntry, type TreeInventoryProgress } from '../../src/main/dsh/files';

const roots: string[] = []; const gates: RuntimeIntegrity[] = [];
afterEach(async () => { for (const gate of gates.splice(0)) gate.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-integrity-')); roots.push(root);
  const directory = path.join(root, 'artifact'); await mkdir(directory); const file = path.join(directory, 'module.js'); await writeFile(file, 'sealed');
  const gate = new RuntimeIntegrity(); gates.push(gate); let checks = 0;
  const check = async () => { checks++; if (await readFile(file, 'utf8') !== 'sealed') throw Error('changed'); };
  return { root, directory, file, gate, check, checks: () => checks };
}
test('concurrent CLI admissions share a full verification and unchanged warm admissions do not rescan', async () => {
  const f = await fixture(); await Promise.all(Array.from({ length: 8 }, () => f.gate.verify(f.directory, f.check)));
  const cold = f.checks(); expect(cold).toBe(1);
  await f.gate.verify(f.directory, f.check); expect(f.checks()).toBe(cold);
  await f.gate.verify(f.directory, f.check, undefined, true); expect(f.checks()).toBe(cold + 1);
});
test('a changed file and replacement artifact invalidate the live proof', async () => {
  const f = await fixture(); await f.gate.verify(f.directory, f.check);
  await writeFile(f.file, 'edited'); await new Promise(resolve => setTimeout(resolve, 50));
  await expect(f.gate.verify(f.directory, f.check)).rejects.toThrow('changed');
  await rename(f.directory, path.join(f.root, 'old')); await mkdir(f.directory); await writeFile(f.file, 'sealed'); await new Promise(resolve => setTimeout(resolve, 50));
  await f.gate.verify(f.directory, f.check); const prior = f.checks();
  await writeFile(f.file, 'edited'); await expect(f.gate.verify(f.directory, f.check)).rejects.toThrow('changed'); expect(f.checks()).toBeGreaterThan(prior);
});
test('a forced verification queued during an incremental check still runs its own full check', async () => {
  const f = await fixture(); let finish!: () => void; let fullChecks = 0;
  const pending = f.gate.verify(f.directory, () => new Promise<void>(resolve => { finish = resolve; }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const forced = f.gate.verify(f.directory, async () => { fullChecks++; }, undefined, true);
  finish(); await Promise.all([pending, forced]); expect(fullChecks).toBe(1);
});
test('cancelling one waiter does not cancel another caller verification', async () => {
  const f = await fixture(); const abort = new AbortController(); let finish!: () => void;
  const checking = async () => { await new Promise<void>(resolve => { finish = resolve; }); await f.check(); };
  const first = f.gate.verify(f.directory, checking, abort.signal); const second = f.gate.verify(f.directory, checking);
  await new Promise(resolve => setTimeout(resolve, 20)); abort.abort(Error('caller stopped')); await expect(first).rejects.toThrow('caller stopped');
  finish(); await second; expect(f.checks()).toBe(1);
});
test('incremental inventories detect same-size edits even when the old modification time is restored', async () => {
  const f = await fixture(); const cache = new Map<string, TreeHashCacheEntry>();
  const sealed = await inventoryTree(f.directory, undefined, undefined, cache); const before = await stat(f.file);
  expect((await inventoryTree(f.directory, undefined, undefined, cache)).contentSha256).toBe(sealed.contentSha256);
  await writeFile(f.file, 'edited'); await utimes(f.file, before.atime, before.mtime);
  expect((await inventoryTree(f.directory, undefined, undefined, cache)).contentSha256).not.toBe(sealed.contentSha256);
});

test('inventory progress reports completed work and cache reuse without changing the seal', async () => {
  const f = await fixture(), cache = new Map<string, TreeHashCacheEntry>(), events: TreeInventoryProgress[] = [];
  const cold = await inventoryTree(f.directory, undefined, undefined, cache, value => events.push(value));
  expect(events[0]).toMatchObject({ phase: 'scanning', verifiedFiles: 0 });
  expect(events.at(-1)).toMatchObject({ phase: 'complete', fileCount: 1, verifiedFiles: 1, cacheHits: 0, verifiedBytes: 6 });
  events.length = 0;
  const warm = await inventoryTree(f.directory, undefined, undefined, cache, value => events.push(value));
  expect(warm).toEqual(cold);
  expect(events.at(-1)).toMatchObject({ phase: 'complete', verifiedFiles: 1, cacheHits: 1, verifiedBytes: 6 });
  const cancelled = new AbortController();
  await expect(inventoryTree(f.directory, cancelled.signal, undefined, cache, value => {
    if (value.phase === 'hashing') cancelled.abort(Error('cancel cached verification'));
  })).rejects.toThrow('cancel cached verification');
});
test('local CLI admission waits for verification, rejects invalid identities and shuts down without a Host', async () => {
  const f = await fixture(); await mkdir(path.join(f.root, 'cli'));
  const digest = 'a'.repeat(64); const runtimeId = 'runtime-' + digest.slice(0, 24); let checks = 0;
  const service = new CliAdmission(f.root, async (id, hash) => { if (id !== runtimeId || hash !== digest) throw Error('changed'); await new Promise(resolve => setTimeout(resolve, 20)); checks++; });
  await service.start();
  const endpoint = JSON.parse(await readFile(path.join(f.root, 'cli/admission.json'), 'utf8'));
  const request = (token: string) => new Promise<{ ok: boolean }>((resolve, reject) => {
    let text = ''; const socket = connect(endpoint.port, '127.0.0.1', () => socket.write(JSON.stringify({ token, runtimeId, digest }) + '\n'));
    socket.on('data', bytes => { text += String(bytes); }); socket.once('end', () => resolve(JSON.parse(text))); socket.once('error', reject);
  });
  try { expect(await request(endpoint.token)).toEqual({ ok: true }); expect(checks).toBe(1); expect(await request('wrong')).toEqual({ ok: false }); expect(checks).toBe(1); }
  finally { await service.close(); }
  await expect(readFile(path.join(f.root, 'cli/admission.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
