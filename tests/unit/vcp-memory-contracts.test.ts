import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { companionMemoryScoreDetailsSchema } from '../../src/shared/companion-memory';
import type { VcpMemoryScoreDetails } from '../../src/main/vcp-memory/contracts';

const require = createRequire(import.meta.url);
const { embeddingConfiguration, normalizeNote, projectNativeScoreDetails, VcpMemoryRuntime } = require(path.resolve('src/main/vcp-memory/runtime.cjs')) as {
  embeddingConfiguration(input: unknown): { apiUrl: string; queryApiUrl?: string; modelSignature: string };
  normalizeNote(input: unknown): unknown;
  projectNativeScoreDetails(hit: object, result: object, rank: number): VcpMemoryScoreDetails;
  VcpMemoryRuntime: { prototype: { search(input: { text: string }): Promise<{ results: Array<{ id: string; score?: number; scoreDetails: VcpMemoryScoreDetails }> }> } };
};

describe('VCP memory host input boundaries', () => {
  it('normalizes OpenAI compatible document and query roots without changing semantic input', () => {
    expect(embeddingConfiguration({ baseUrl: 'https://host.invalid/document/v1/', queryBaseUrl: 'https://host.invalid/query/v1',
      model: 'embedding-model', dimension: 768 })).toMatchObject({ apiUrl: 'https://host.invalid/document', queryApiUrl: 'https://host.invalid/query', modelSignature: 'embedding-model' });
  });
  it('rejects unsupported dimensions and injected tag metadata before mutation', () => {
    expect(() => embeddingConfiguration({ baseUrl: 'https://host.invalid', model: 'model', dimension: 4097 })).toThrow(/dimension/iu);
    expect(() => normalizeNote({ id: 'note', content: 'fact', tags: ['safe\nTag: injected'] })).toThrow(/Tags/u);
    expect(() => normalizeNote({ id: 'note', content: 'fact', tags: [], occurredAt: 'not-a-date' })).toThrow(/date/u);
  });
  it('accepts the full public diary length and rejects only text beyond that contract', () => {
    for (const length of [4096, 4097, 16000, 65536]) {
      expect(normalizeNote({ id: 'long', content: 'x'.repeat(length), tags: [] })).toMatchObject({ content: 'x'.repeat(length) });
    }
    expect(() => normalizeNote({ id: 'long', content: 'x'.repeat(65537), tags: [] })).toThrow(/content/iu);
    expect(() => normalizeNote({ id: 'x'.repeat(4097), content: 'valid', tags: [] })).toThrow(/ID/u);
  });
  it('accepts 16000-character queries without truncation and rejects 16001 before embedding', async () => {
    const queryEmbedding = async (text: string) => { expect(text).toHaveLength(16000); return [1, 0]; };
    const runtime = Object.assign(Object.create(VcpMemoryRuntime.prototype), {
      requireReady() {}, peripherals: { async validateExistingTimelines() {} }, queryEmbedding, async ensureArtifacts() {},
      kb: { async listDistinctDiaries() { return ['memories']; }, withMemoObservationScope: (callback: () => unknown) => callback(),
        async executeNativeRiverQuery(query: { text: string }) { expect(query.text).toHaveLength(16000); return { results: [], diagnostics: {} }; } },
    });
    for (const length of [4096, 4097, 16000]) {
      runtime.queryEmbedding = async (text: string) => { expect(text).toHaveLength(length); return [1, 0]; };
      runtime.kb.executeNativeRiverQuery = async (query: { text: string }) => { expect(query.text).toHaveLength(length); return { results: [], diagnostics: {} }; };
      await expect(runtime.search({ text: 'q'.repeat(length) })).resolves.toMatchObject({ results: [] });
    }
    await expect(runtime.search({ text: 'q'.repeat(16001) })).rejects.toThrow(/query/iu);
  });
  it('copies real native ranking components without normalization and leaves missing components absent', () => {
    const raw = { score: .7324, rank: 3, originalScore: -.18, vectorScore: .41, baseScore: .63, topologyBonus: .06,
      anchorBonus: 0, omega: .51, role: 'direct_fact_anchor', riverRegime: 'mesoscopic', matchedTags: ['海边', '约定'], coreTagsMatched: ['约定'],
      candidateSources: [{ source: 'ann' }, 'bm25'], topologyV3: { privateNativeTrace: true } };
    const projected = projectNativeScoreDetails(raw, { algorithmVersion: 'rivermemo.topology-v3.1', diagnostics: { queryProfile: { mode: 'narrative' } } }, 2);
    expect(companionMemoryScoreDetailsSchema.parse(projected)).toEqual({ engine: 'river', rank: 2, nativeRank: 3, finalScore: .7324,
      originalScore: -.18, vectorScore: .41, baseScore: .63, topologyBonus: .06, anchorBonus: 0, omega: .51,
      role: raw.role, riverRegime: raw.riverRegime, matchedTags: raw.matchedTags, coreTagsMatched: raw.coreTagsMatched, candidateSources: ['ann', 'bm25'],
      algorithmVersion: 'rivermemo.topology-v3.1', queryMode: 'narrative' });
    expect(projectNativeScoreDetails({ retrievalEngine: 'knn', score: 0, vectorScore: -.4 }, {}, 1)).toEqual({ engine: 'knn', rank: 1, finalScore: 0, vectorScore: -.4 });
    expect(projectNativeScoreDetails({ score: undefined, baseScore: NaN, anchorBonus: Infinity, rank: 0 }, {}, 4)).toEqual({ engine: 'river', rank: 4 });
  });
  it('keeps upstream chunk order and original ranks while deduplicating notes, even when their scores differ', async () => {
    const native = [
      { fullPath: 'memories/second.md', score: .3, rank: 1, baseScore: .2 },
      { fullPath: 'memories/first.md', score: .9, rank: 2, baseScore: .8 },
      { fullPath: 'memories/second.md', score: .2, rank: 3 },
      { fullPath: 'memories/unknown-score.md' },
    ];
    const runtime = Object.assign(Object.create(VcpMemoryRuntime.prototype), {
      paths(id: string) { return { note: path.resolve('fixture-notes', id + '.md') }; },
      requireReady() {}, peripherals: { async validateExistingTimelines() {} }, async queryEmbedding() { return [1, 0]; }, async ensureArtifacts() {},
      async read(id: string) { return normalizeNote(this.records.get(id)); },
      records: new Map(['first', 'second', 'unknown-score'].map(id => [id, { id, content: id + ' fact', tags: [] }])),
      fileIds: new Map(['first', 'second', 'unknown-score'].map(id => [id + '.md', id])),
      kb: { async listDistinctDiaries() { return ['memories']; }, withMemoObservationScope: (callback: () => unknown) => callback(),
        async executeNativeRiverQuery() { return { results: native, diagnostics: { nativeTopologyV3: { jointUsed: true } } }; } },
    });
    const result = await runtime.search({ text: 'actual upstream order' });
    expect(result.results.map((hit: { id: string }) => hit.id)).toEqual(['second', 'first', 'unknown-score']);
    expect(result.results.map((hit: { scoreDetails: VcpMemoryScoreDetails }) => hit.scoreDetails.rank)).toEqual([1, 2, 4]);
    expect(result.results[0].scoreDetails).toMatchObject({ nativeRank: 1, finalScore: .3, baseScore: .2 });
    expect(result.results[2]).not.toHaveProperty('score'); expect(result.results[2].scoreDetails).not.toHaveProperty('finalScore');
  });
});
