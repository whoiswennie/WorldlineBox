import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prepareManagedIngestionScheduler } = require('../../resources/vcp-memory/lib/ingestion-scheduler.cjs') as {
  prepareManagedIngestionScheduler(root: string): { sourceSha256: string; originalSnapshotChanged: boolean; timerOwner: string };
};
const cleanup: string[] = [];
afterEach(async () => {
  for (const root of cleanup.splice(0)) {
    for (const filename of Object.keys(require.cache)) if (filename.startsWith(root + path.sep)) delete require.cache[filename];
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('wlb-ingestion-adapter-')) throw Error('Invalid owned ingestion fixture');
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'wlb-ingestion-adapter-')); cleanup.push(root);
  const directory = path.join(root, 'modules', 'knowledgeBase'), filename = path.join(directory, 'ingestionPipeline.js');
  await mkdir(directory, { recursive: true });
  const original = await readFile(path.resolve('resources/vcp-memory/upstream/toolbox/modules/knowledgeBase/ingestionPipeline.js'));
  await writeFile(filename, original);
  // The compile/integrity test does not execute embeddings; native regression
  // separately runs the original provider, ingestion and Rust receipt path.
  await writeFile(path.join(root, 'EmbeddingUtils.js'), 'module.exports={getEmbeddingsBatch(){throw Error("No embedding in compile-only fixture")}};');
  return { root, filename, original };
}

it('compiles the pinned module once while keeping the captured runtime source bytes unchanged', async () => {
  const { root, filename, original } = await fixture();
  const proof = prepareManagedIngestionScheduler(root);
  expect(proof).toMatchObject({ originalSnapshotChanged: false, timerOwner: 'single-ingestion-batch' });
  expect(prepareManagedIngestionScheduler(root)).toBe(proof);
  expect(await readFile(filename)).toEqual(original);
  expect(typeof require(filename)).toBe('function');
});

it('rejects unknown source revisions and pipelines loaded before lifecycle adaptation', async () => {
  const changed = await fixture();
  await writeFile(changed.filename, Buffer.concat([changed.original, Buffer.from('\n// unknown source revision\n')]));
  expect(() => prepareManagedIngestionScheduler(changed.root)).toThrow('Unsupported ingestion pipeline revision');
  const unmanaged = await fixture(); require(unmanaged.filename);
  expect(() => prepareManagedIngestionScheduler(unmanaged.root)).toThrow('loaded before managed timer ownership');
});
