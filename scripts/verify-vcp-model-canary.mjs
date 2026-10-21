import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { removeOwnedDirectory } = createRequire(import.meta.url)(path.join(projectRoot, 'src/main/vcp-memory/runtime.cjs'));
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseUrl = new URL(argument('base-url') || 'http://127.0.0.1:50202');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) throw new Error('This fixture only calls a local model server.');
const dimension = Number(argument('dimension') || 768);
const fixture = JSON.parse(await readFile(path.join(projectRoot, 'tests/fixtures/embedding-memory-retrieval.json'), 'utf8'));
const models = await (await fetch(new URL('/v1/models', baseUrl))).json();
const model = models.data[0].id;
const requests = { document: 0, query: 0 };
const gateway = createServer(async (request, response) => {
  try {
    let text = '';
    for await (const part of request) text += part.toString();
    const body = JSON.parse(text);
    const purpose = request.url.startsWith('/query/') ? 'query' : 'document';
    requests[purpose]++;
    const prefix = purpose === 'query' ? 'task: search result | query: ' : 'title: none | text: ';
    const upstream = await fetch(new URL('/v1/embeddings', baseUrl), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model,
        input: body.input.map(input => prefix + input), encoding_format: 'float' }) });
    response.writeHead(upstream.status, { 'Content-Type': 'application/json' }); response.end(await upstream.text());
  } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: String(error) })); }
});
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
const address = gateway.address();
const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-model-canary-'));
if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-model-canary-')) throw new Error('Unsafe canary root.');
const child = fork(path.join(projectRoot, 'src/main/vcp-memory/worker.cjs'), [], { execPath: process.execPath,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
child.stderr.resume();
const pending = new Map();
child.on('message', message => {
  const request = pending.get(message.requestId);
  if (!request) return;
  clearTimeout(request.timer); pending.delete(message.requestId);
  if (message.ok) request.resolve(message.value); else request.reject(new Error(JSON.stringify(message.error)));
});
child.on('exit', code => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Canary worker exited: ${code}`)); } pending.clear(); });
function request(command) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Canary worker request timed out.')); }, 120000);
    pending.set(requestId, { resolve, reject, timer }); child.send({ requestId, command });
  });
}
let report;
try {
  const started = performance.now();
  await request({ type: 'initialize', configuration: { dataRoot: root, vendorRoot: path.join(projectRoot, 'vendor/vcp-memory'),
    scope: { scopeId: 'actual-model-wrapped-canary' }, embedding: { baseUrl: `http://127.0.0.1:${address.port}/document`,
      queryBaseUrl: `http://127.0.0.1:${address.port}/query`, model, modelSignature: 'gemma2-official-text-purpose', apiKey: 'local-fixture', dimension } } });
  const initializedMs = performance.now() - started;
  for (const document of fixture.documents) await request({ type: 'remember', note: { id: document.id, content: document.text,
    tags: [document.id], author: 'WorldlineBox', occurredAt: '2026-10-21T01:02:03Z' } });
  const ingestionMs = performance.now() - started - initializedMs;
  const results = [];
  for (const query of fixture.queries) {
    const queryStarted = performance.now();
    const result = await request({ type: 'search', text: query.text, topK: 5 });
    results.push({ id: query.id, expected: query.expected, top1: result.results[0]?.id,
      rank: result.results.findIndex(note => note.id === query.expected) + 1, elapsedMs: performance.now() - queryStarted,
      nativeJointUsed: result.diagnostics.nativeTopologyV3?.jointUsed === true, degraded: result.degraded });
  }
  report = { generatedAt: new Date().toISOString(), model, dimension, documents: fixture.documents.length, queries: results.length,
    top1Correct: results.filter(result => result.top1 === result.expected).length, recallAt5: results.filter(result => result.rank > 0).length,
    initializedMs, ingestionMs, totalMs: performance.now() - started, embeddingRequests: requests, results,
    limitations: ['Small synthetic fixture, not representative quality evidence.', 'Calls a previously started CPU-only local llama server; this script does not own or stop that model process.',
      'Uses original DailyNote.create, real document and ordered tag embeddings, host ID comments, original ingestion, Rust geometry/graph publication and native River queries.',
      'Official query and document prefixes are applied by the test loopback gateway, matching the global embedding adapter; no fabricated vectors.'] };
  await request({ type: 'close' });
} finally {
  child.kill();
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); });
  await removeOwnedDirectory(root);
}
const output = argument('output');
if (output) await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
