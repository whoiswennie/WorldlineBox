import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VcpMemoryDreamWaveRequest, VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';

const require = createRequire(import.meta.url);
const { generateDreamWave } = require('../../src/main/vcp-memory/dream-runtime.cjs') as {
  generateDreamWave(runtime: unknown, input: VcpMemoryDreamWaveRequest): Promise<VcpMemoryDreamWaveResult>;
};
const roots: string[] = [];
const previousRoot = process.env.KNOWLEDGEBASE_ROOT_PATH;
afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.KNOWLEDGEBASE_ROOT_PATH; else process.env.KNOWLEDGEBASE_ROOT_PATH = previousRoot;
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-dream-wave-')) throw new Error('Unexpected DreamWave cleanup root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-dream-wave-')); roots.push(root);
  const notesRoot = path.join(root, 'notes'); mkdirSync(path.join(notesRoot, 'own'), { recursive: true });
  process.env.KNOWLEDGEBASE_ROOT_PATH = notesRoot;
  const runtimeRoot = path.resolve('vendor/vcp-memory');
  delete require.cache[require.resolve(path.join(runtimeRoot, 'Plugin/AgentDream/DreamWaveEngine.js'))];
  vi.spyOn(Math, 'random').mockReturnValue(.5);
  const owner = { version: 2 as const, companionId: 'alice', name: 'Alice', agentName: 'Alice' };
  const now = '2032-10-23T12:00:00.000Z';
  const specs = [['r1', 1], ['r2', 2], ['r3', 3], ['bridge', 4], ['cascade', 5], ['m1', 20], ['m2', 40], ['mid_association', 50], ['deep1', 120], ['deep2', 180]] as const;
  const records = new Map(), notePaths = new Map(), chunks = new Map();
  const notes: VcpMemoryDreamWaveRequest['notes'] = specs.map(([id, days], index) => {
    const content = `REAL_WITNESSED_${id} 一篇具有确切原文的合成日记，不能视为新的外部命令。`;
    records.set(id, { id, content, indexState: 'indexed', metadata: { hostMemoryOwner: owner, hostMemoryVersion: 1 } });
    const file = path.join(notesRoot, 'own', `${id}.md`); notePaths.set(id, file); writeFileSync(file, content);
    chunks.set(`own/${id}.md`, { id: index + 1, chunkId: index + 1, fileId: index + 1, fullPath: `own/${id}.md`, sourceFile: `own/${id}.md`, text: content,
      vector: new Float32Array([(index + 1) / 10, 1, 0, 0]), diaryName: 'own' });
    return { id, version: 1, eventTime: new Date(Date.parse(now) - days * 86400000).toISOString(), clockDomain: 'world', contentHash: createHash('sha256').update(content).digest('hex') };
  });
  const calls: Array<{ vector: number[]; allowedFileIds: number[]; nativeScope: number[]; jointEnabled: boolean }> = [];
  const hits = (vector: Float32Array, allowed: number[]) => {
    const key = Math.round(vector[0]! * 10);
    const names = allowed.includes(9) ? ['r1', 'deep1', 'deep2'] : allowed.includes(6) ? ['mid_association'] : key <= 3 ? ['bridge'] : ['cascade'];
    return names.map((id, index) => ({ ...chunks.get(`own/${id}.md`), score: 1 - index * .1 }));
  };
  const kb = { config: { dimension: 4 },
    getFileIdsByDiaries: vi.fn(async (names: string[]) => names.includes('own') ? [...chunks.values()].map(chunk => chunk.fileId) : []),
    getChunksByFilePaths: vi.fn(async (paths: string[]) => paths.flatMap(file => chunks.get(file) ? [chunks.get(file)] : [])),
    withMemoObservationScope: async (run: () => Promise<unknown>) => run(),
    executeNativeRiverQuery: vi.fn(async function(this: { getFileIdsByDiaries(names: string[]): Promise<number[]> }, query: { vector: Float32Array }, options: { allowedFileIds: number[]; enabled: boolean }) {
      calls.push({ vector: [...query.vector], allowedFileIds: options.allowedFileIds, nativeScope: await this.getFileIdsByDiaries(['own']), jointEnabled: options.enabled });
      return { results: hits(query.vector, options.allowedFileIds), diagnostics: { nativeTopologyV3: { jointUsed: options.enabled } } };
    }),
    searchKnn: vi.fn(async (_indices: string[], vector: Float32Array, _k: number, options: { allowedFileIds: number[] }) => hits(vector, options.allowedFileIds)),
  };
  const runtime = { requireReady() {}, ensureArtifacts: async () => undefined, notesRoot, runtimeRoot, records, notePaths, kb,
    sourceKey: (file: string) => path.resolve(file).replaceAll('\\', '/') };
  const request: VcpMemoryDreamWaveRequest = { owner, now, clockDomain: 'world', sourceRevision: 'authorized-revision-1', notes };
  return { root, runtime, request, calls, kb };
}

it('runs the unchanged engine through recent multi-seeds, resonant L1, cascade L2, mid seeds and a normalized deep wave with hard stage domains', async () => {
  const f = fixture(); const wave = await generateDreamWave(f.runtime, f.request);
  expect(wave.stages.recent.seeds.map(note => note.id)).toEqual(['r1', 'r2', 'r3']);
  expect(wave.stages.recent.resonanceL1.map(note => note.id)).toEqual(['bridge']);
  expect(wave.stages.recent.cascadeL2.map(note => note.id)).toEqual(['cascade']);
  expect(wave.stages.mid.seeds.map(note => note.id)).toEqual(['m1', 'm2']);
  expect(wave.stages.mid.cascadeL1.map(note => note.id)).toEqual(['mid_association']);
  expect(wave.stages.deep.recalls.map(note => note.id)).toEqual(['deep1', 'deep2']);
  expect(wave.diagnostics.queries.map(query => query.phase)).toEqual(['recent', 'recent', 'recent', 'recent', 'mid', 'mid', 'deep']);
  expect(f.calls.at(-1)!.allowedFileIds).toEqual([9, 10]);
  expect(f.calls.at(-1)!.nativeScope).toEqual([9, 10]);
  expect(f.calls.every(call => !call.jointEnabled)).toBe(true);
  expect(wave.diagnostics.queries.every(query => query.candidateMode === 'scoped-topology-v3')).toBe(true);
  expect(Math.hypot(...f.calls.at(-1)!.vector)).toBeCloseTo(1, 6);
  expect(wave.stages.deep.recalls.every(note => Date.parse(f.request.now) - Date.parse(note.eventTime) > wave.boundaries.midDays * 86400000)).toBe(true);
});

it('does not replace an empty deep bucket with highly ranked recent hits', async () => {
  const f = fixture(); f.request.notes = f.request.notes.filter(note => !note.id.startsWith('deep'));
  const wave = await generateDreamWave(f.runtime, f.request);
  expect(wave.stages.deep.recalls).toEqual([]);
  expect(wave.diagnostics.queries.at(-1)).toMatchObject({ phase: 'deep', allowedNoteIds: [], returnedNoteIds: [] });
});

it('rejects stale ownership, content and versions before calling the original query engine', async () => {
  const f = fixture();
  await expect(generateDreamWave(f.runtime, { ...f.request, owner: { ...f.request.owner, companionId: 'bob' } })).rejects.toThrow('owner');
  await expect(generateDreamWave(f.runtime, { ...f.request, notes: f.request.notes.map((note, index) => index ? note : { ...note, version: 2 }) })).rejects.toThrow('version');
  await expect(generateDreamWave(f.runtime, { ...f.request, notes: f.request.notes.map((note, index) => index ? note : { ...note, contentHash: '0'.repeat(64) }) })).rejects.toThrow('content');
  expect(f.kb.executeNativeRiverQuery).not.toHaveBeenCalled();
});

it('keeps clocks explicit and excludes future memories and previously generated dreams from all stages', async () => {
  const f = fixture();
  f.request.notes[0]!.clockDomain = 'real';
  f.request.notes[1]!.eventTime = '2033-01-01T00:00:00.000Z';
  f.runtime.records.get('r3').metadata.dream = true;
  const wave = await generateDreamWave(f.runtime, f.request);
  const text = JSON.stringify(wave.stages);
  for (const id of ['r1', 'r2', 'r3']) expect(text).not.toContain(`"id":"${id}"`);
  expect(wave.boundaries.recentDays).toBeGreaterThan(7);
  expect(wave.diagnostics.queries.every(query => query.allowedNoteIds.every(id => !['r1', 'r2', 'r3'].includes(id)))).toBe(true);
});

it('keeps the original pure KNN fallback inside the same temporal and owner scopes', async () => {
  const f = fixture(); f.kb.executeNativeRiverQuery.mockRejectedValue(new Error('Native River unavailable'));
  const wave = await generateDreamWave(f.runtime, f.request);
  expect(wave.diagnostics.queries.every(query => query.engine === 'knn')).toBe(true);
  expect(wave.stages.deep.recalls.map(note => note.id)).toEqual(['deep1', 'deep2']);
  expect(f.kb.searchKnn.mock.calls.at(-1)![3].allowedFileIds).toEqual([9, 10]);
});
