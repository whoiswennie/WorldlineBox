import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ColdKnowledgeService } from '../../src/main/vcp-memory/cold-service';
import type { VcpMemoryTransport } from '../../src/main/vcp-memory/client';
import type { ColdKnowledgeDocument } from '../../src/main/vcp-memory/cold-contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function launch(file: string): VcpMemoryTransport {
  const child = fork(file, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr?.on('data', () => undefined);
  return { postMessage: value => { child.send(value as object); }, on: child.on.bind(child), kill: () => { child.kill(); } };
}
async function fixture(paths?: { vendorRoot: string; workerPath: string }) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-cold-'));
  const current = new Map<string, string>();
  const requests: string[][] = [];
  const controls = { partial: false, skippedChunk: false, hold: undefined as (() => void) | undefined, queryStarted: undefined as (() => void) | undefined };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { input: string[] };
    requests.push(body.input);
    if (request.url?.startsWith('/query/') && controls.queryStarted) { controls.queryStarted(); await new Promise<void>(resolve => { controls.hold = resolve; }); }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: body.input.map((input, index) => {
      const skip = controls.partial && !controls.skippedChunk && input.length > 10000;
      if (skip) controls.skippedChunk = true;
      return { index, embedding: skip ? null : /beta/u.test(input) ? [0,1,0,0] : [1,0,0,0] };
    }) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const options = { dataRoot: root, vendorRoot: paths?.vendorRoot ?? path.resolve('vendor/vcp-memory'), workerPath: paths?.workerPath ?? path.resolve('src/main/vcp-memory/cold-worker.cjs'),
    embedding: { baseUrl: `http://127.0.0.1:${port}/document`, queryBaseUrl: `http://127.0.0.1:${port}/query`, model: 'fixture-cold', modelSignature: 'fixture-1', apiKey: 'synthetic', dimension: 4 },
    authorize: async (owner: string, id: string, hash: string) => current.get(owner + ':' + id) === hash, launch };
  let service = new ColdKnowledgeService(options);
  const document = (id: string, text: string, owner = 'alice'): ColdKnowledgeDocument => {
    const sourceDigest = digest(text); current.set(owner + ':' + id, sourceDigest);
    return { id, sourceId: id, sourceDigest, text, sourceType: 'memory', sourceVersion: sourceDigest };
  };
  return { root, service: () => service, current, controls, requests, document,
    restart: async () => { await service.close(); service = new ColdKnowledgeService(options); },
    close: async () => { controls.hold?.(); await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await removeOwnedDirectory(root); } };
}
it('publishes native two-store generations, isolates owners/source filters, and expands immutable versions across restart', async () => {
  const test = await fixture();
  try {
    const a = test.document('alpha', '# alpha\nThe verified source total is 475.');
    const first = await test.service().ingest('alice', a); expect(first).toMatchObject({ indexed: true, chunks: 1 });
    await test.service().ingest('alice', test.document('beta', '# beta\nThe other source total is 955.'));
    await test.service().ingest('bob', test.document('private', '# alpha\nBOB_PRIVATE_SENTINEL', 'bob'));
    const filtered = await test.service().search('alice', 'alpha', { sourceIds: ['beta'], expand: true });
    expect(filtered.results).toHaveLength(1); expect(filtered.results[0]).toMatchObject({ sourceId: 'beta', text: '# beta\nThe other source total is 955.' });
    expect(JSON.stringify(await test.service().search('alice', 'alpha'))).not.toContain('BOB_PRIVATE');
    expect(await test.service().read('alice', 'alpha', first.version)).toMatchObject({ text: a.text, sourceDigest: a.sourceDigest });
    await test.restart(); expect((await test.service().search('alice', 'alpha')).results.some(hit => hit.sourceId === 'alpha')).toBe(true);
    const newer = test.document('alpha', '# alpha\nThe corrected total is 830.');
    await test.service().ingest('alice', newer);
    await expect(test.service().read('alice', 'alpha', first.version)).rejects.toThrow('unavailable');
    const expanded = await test.service().search('alice', 'alpha', { sourceIds: ['alpha'], expand: true });
    expect(expanded.results[0]?.text).toContain('830'); expect(JSON.stringify(expanded)).not.toContain('475');
  } finally { await test.close(); }
}, 120000);
const packagedVendor = path.resolve('.tools/vcp-memory-release/vcp-memory');
const packagedWorker = path.resolve('.tools/vcp-memory-release/vcp-memory-host/cold-worker.cjs');
it.skipIf(!existsSync(packagedWorker))('loads the staged physical cold worker, native dependency and tokenizer closure outside ASAR', async () => {
  const test = await fixture({ vendorRoot: packagedVendor, workerPath: packagedWorker });
  try {
    const source = test.document('packaged', 'STAGED_COLD_NATIVE_CANARY actual immutable body.');
    expect((await test.service().ingest('alice', source)).indexed).toBe(true);
    expect((await test.service().search('alice', 'STAGED_COLD_NATIVE_CANARY', { expand: true })).results[0]?.text).toBe(source.text);
    await test.restart(); expect((await test.service().read('alice', 'packaged')).text).toBe(source.text);
  } finally { await test.close(); }
}, 120000);
it('withdraws sources while query I/O is running and rejects incomplete chunk generations', async () => {
  const test = await fixture();
  try {
    await test.service().ingest('alice', test.document('alpha', '# alpha\nWITHDRAW_SENTINEL'));
    let started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; }); test.controls.queryStarted = started;
    const pending = test.service().search('alice', 'alpha'); await reached;
    await test.service().revoke('alice', 'alpha'); test.controls.hold!(); test.controls.queryStarted = undefined;
    expect((await pending).results).toEqual([]); await test.restart(); expect((await test.service().search('alice', 'alpha')).results).toEqual([]);
    const long = test.document('long', ('alpha factual sentence with a sufficiently long sequence of words.\n').repeat(4000));
    test.controls.partial = true;
    await expect(test.service().ingest('alice', long)).rejects.toThrow(/incomplete chunk/iu);
    expect((await test.service().status('alice')).documents.find(item => item.id === 'long')?.status).toBe('pending');
    expect((await test.service().search('alice', 'alpha', { sourceIds: ['long'] })).results).toEqual([]);
    test.controls.partial = false;
    const retry = await test.service().ingest('alice', long); expect(retry.indexed).toBe(true); expect(retry.chunks).toBeGreaterThan(1);
    test.current.delete('alice:long'); expect((await test.service().search('alice', 'alpha')).results).toEqual([]);
  } finally { await test.close(); }
}, 120000);
it('needs no dependency junction across normal shutdown and cancellation during blocked query I/O', async () => {
  const test = await fixture(), dependency = path.resolve('node_modules/@dqbd/tiktoken/package.json'), original = await readFile(dependency);
  try {
    await test.service().ingest('alice', test.document('shutdown-proof', 'alpha shutdown source'));
    const link = path.join(test.root, 'runtime/node_modules');
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    await test.restart(); await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    let start!: () => void; const started = new Promise<void>(resolve => { start = resolve; }); test.controls.queryStarted = start;
    const pending = test.service().search('alice', 'alpha shutdown'); await started;
    const rejected = expect(pending).rejects.toThrow(/closed|stopped|worker/iu);
    await test.service().close(); await rejected;
    await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(dependency)).toEqual(original);
  } finally { await test.close(); }
}, 30000);
