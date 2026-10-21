import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const vectorsPath = argument('vectors');
if (!vectorsPath) throw new Error('Pass --vectors=<JSON with corpus[].vector and queries[].vector>.');
const fixture = JSON.parse(await readFile(path.resolve(vectorsPath), 'utf8'));
const dimension = fixture.corpus[0]?.vector?.length;
if (!dimension || fixture.queries.some(query => query.vector?.length !== dimension)) throw new Error('All document and query vectors must have the same dimension.');
Object.assign(process.env, { VECTORDB_DIMENSION: String(dimension), WhitelistEmbeddingModel: 'real-vector-fixture',
  EmbeddingModelSig: fixture.report?.model?.sha256 || 'real-vector-fixture', EMBEDDING_AUDIT_LOG_ENABLED: 'false' });
const require = createRequire(import.meta.url);
const { removeOwnedDirectory } = require(path.join(projectRoot, 'src/main/vcp-memory/runtime.cjs'));
const singleton = require(path.join(projectRoot, 'vendor/vcp-memory/KnowledgeBaseManager.js'));
const root = await mkdtemp(path.join(tmpdir(), 'worldline-vcp-real-vectors-'));
if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-vcp-real-vectors-')) throw new Error('Unsafe fixture cleanup path.');
const notesRoot = path.join(root, 'notes');
await mkdir(path.join(notesRoot, 'fixture'), { recursive: true });
const kb = new singleton.constructor({ rootPath: notesRoot, storePath: path.join(root, 'store'), dimension,
  modelSig: fixture.report?.model?.sha256 || 'real-vector-fixture', fullScanOnStartup: false });
// This measures supplied real vectors through native persistence and retrieval.
// Watchers and automatic training are outside this isolated ranking comparison.
kb._startWatcher = () => undefined; kb._startRagParamsWatcher = () => undefined;
kb._startIdleSweep = () => undefined; kb._startEventLoopWatchdog = () => undefined;
const started = performance.now();
let report;
try {
  await kb.initialize();
  clearTimeout(kb.tagMemoEngine._postStartupDerivedRefreshTimer);
  const files = [];
  for (const [index, document] of fixture.corpus.entries()) {
    if (!/^[a-z0-9_-]+$/iu.test(document.id)) throw new Error('Unsafe fixture ID.');
    const relative = `fixture/${document.id}.md`;
    await writeFile(path.join(notesRoot, relative), document.text, 'utf8');
    files.push({ path: relative, diaryName: 'fixture', checksum: `real-fixture-${index}`, mtime: 1,
      size: Buffer.byteLength(document.text), expectedVersion: 0, chunkStart: index, chunkCount: 1, tagStart: 0, tagCount: 0 });
  }
  await kb.commitIngestionBatch({ operationId: 'real-vectors', batchId: 'real-vectors', dimension, files,
    chunks: fixture.corpus.map((document, index) => ({ content: document.text, chunkIndex: 0, vectorSlot: index })), tags: [] },
  new Float32Array(fixture.corpus.flatMap(document => document.vector)), new Float32Array());
  const published = await kb.tagMemoEngine.doMatrixRebuild({ reason: 'real-vector-fixture' });
  const results = [];
  const id = result => result ? path.posix.basename(String(result.fullPath || result.sourceFile || '').replaceAll('\\', '/'), '.md') : null;
  for (const query of fixture.queries) {
    const vector = new Float32Array(query.vector);
    const knn = await kb.searchKnn(['fixture'], vector, fixture.corpus.length);
    const river = await kb.executeNativeRiverQuery({ text: query.text, vector }, { diaryNames: ['fixture'], topK: fixture.corpus.length, fallbackToLegacy: false });
    results.push({ id: query.id, expected: query.expected, knnTop1: id(knn[0]), knnRank: knn.findIndex(row => id(row) === query.expected) + 1,
      riverTop1: id(river.results[0]), riverRank: river.results.findIndex(row => id(row) === query.expected) + 1,
      riverEngine: river.results[0]?.retrievalEngine, nativeJointUsed: river.diagnostics?.nativeTopologyV3?.jointUsed === true,
      degraded: river.diagnostics?.degraded === true });
  }
  report = { generatedAt: new Date().toISOString(), model: fixture.report?.model, dimension, documents: fixture.corpus.length,
    queries: results.length, artifactPublished: published,
    knnTop1Correct: results.filter(result => result.knnTop1 === result.expected).length,
    riverTop1Correct: results.filter(result => result.riverTop1 === result.expected).length,
    elapsedMs: performance.now() - started, results,
    limitations: ['Uses actual supplied embedding vectors and original Rust/KBM storage and query code.',
      'Documents are intentionally untagged because the fixture has no genuine tag embeddings; this does not evaluate graph or tagged RiverMemo quality.',
      'Small synthetic Chinese/English fixture; no real user data or external API calls; not a representative benchmark.',
      'OS watchers and automatic background training were disabled only for this isolated comparison.'] };
} finally {
  await kb.shutdown();
  await removeOwnedDirectory(root);
}
const output = argument('output');
if (output) await writeFile(path.resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
