import { expect, it } from 'vitest';
import { projectCompanionMemoryRetrieval } from '../../src/main/companions/memory-retrieval';
import { companionMemoryRetrievalSchema } from '../../src/shared/companion-memory-retrieval';
import type { CompanionMemoryPage } from '../../src/shared/companion-memory';
import type { VcpMemorySearchResult } from '../../src/main/vcp-memory/contracts';

const hits: CompanionMemoryPage['items'] = [{ memory: { id: 'owned_note', companionId: 'alice', scopeId: 'owner', content: '原始整篇文档正文', tags: ['约定'],
  sourceConversationId: 'private_alice', sources: [], sourceSequence: 0, createdAt: '2026-10-22T01:00:00Z', updatedAt: '2026-10-22T01:00:00Z',
  origin: 'companion', status: 'indexed', version: 1, captureMethod: 'automatic' }, reasons: ['VCP river'], path: ['owned_note'],
  scoreDetails: { engine: 'river', rank: 2, nativeRank: 2, finalScore: .81, baseScore: .71, topologyBonus: .06, anchorBonus: .04, matchedTags: ['海边', '约定'], coreTagsMatched: ['约定'] } }];
const result: VcpMemorySearchResult = { results: [], diagnostics: {}, degraded: false, retrieval: {
  embeddingDimension: 768, diaryCount: 2, matchedTags: ['约定'], coreTagsMatched: ['约定'],
  counts: { offeredCandidates: 35, projectedCandidates: 30, selectedCandidates: 24, rankedCandidates: 24, returnedCandidates: 8, artifactNodes: 100, artifactEdges: 150 },
  hits: [{ id: 'owned_note', rank: 2, text: '引擎本次实际命中的文档片段。'.repeat(40), matchedTags: ['海边', '约定'], coreTagsMatched: ['约定'], anchor: { contactedSeeds: 2, exactContacts: 1, semanticContacts: 1, anchorReliability: .9 } },
    { id: 'not_in_authorized_page', rank: 1, text: 'MUST_NOT_LEAK', matchedTags: ['私有'], coreTagsMatched: ['私有'] }],
} };

it('shows actual stages, counters and authorized exact-note links without inventing the rejected candidate pool or focused citations', () => {
  const receipt = projectCompanionMemoryRetrieval({ mode: 'passive', observedAt: '2026-10-22T01:00:01Z', documentCount: 17, result, hits, contextText: '真正的聚焦正文' });
  expect(companionMemoryRetrievalSchema.safeParse(receipt).success).toBe(true);
  expect(receipt.stages.map(stage => [stage.id, stage.state])).toEqual(['scope', 'embedding', 'sensing', 'candidates', 'ranking', 'context'].map(id => [id, 'completed']));
  expect(receipt.stages.find(stage => stage.id === 'candidates')!.facts).toContainEqual({ label: '进入原生候选池', value: '35' });
  expect(receipt.stages.find(stage => stage.id === 'candidates')!.matches).toEqual([]);
  const matched = receipt.stages.find(stage => stage.id === 'ranking')!.matches[0]!;
  expect(matched).toMatchObject({ memoryId: 'owned_note', rank: 2, tags: ['约定'] });
  expect(matched.excerpt).toHaveLength(300); expect(matched.facts).toContainEqual({ label: '精确接触数', value: '1' });
  expect(receipt.stages.find(stage => stage.id === 'sensing')!.matches[0]).not.toHaveProperty('excerpt');
  expect(receipt.stages.find(stage => stage.id === 'context')!.matches).toEqual([]);
  expect(receipt.candidateQuerySeparateFromContext).toBe(true); expect(JSON.stringify(receipt)).not.toContain('MUST_NOT_LEAK');
});

it('marks unexposed diagnostics as unobserved and never fabricates zero counters', () => {
  const receipt = projectCompanionMemoryRetrieval({ mode: 'active', observedAt: '', documentCount: 2,
    result: { results: [], diagnostics: {}, degraded: false }, hits: [], contextText: '' });
  for (const id of ['embedding', 'sensing', 'candidates']) {
    const stage = receipt.stages.find(stage => stage.id === id)!; expect(stage.state).toBe('not_observed'); expect(stage.facts).toEqual([]);
  }
  expect(receipt.stages.find(stage => stage.id === 'context')!.facts).toContainEqual({ label: '实际返回正文字符', value: '0' });
});

it('keeps the empty-corpus path honest without claiming inference or retrieval happened', () => {
  const receipt = projectCompanionMemoryRetrieval({ mode: 'passive', observedAt: '', documentCount: 0, hits: [], contextText: '' });
  expect(receipt.engine).toBe('none'); expect(receipt.stages[0]!.state).toBe('completed');
  expect(receipt.stages.slice(1).every(stage => stage.state === 'skipped' && stage.matches.length === 0)).toBe(true);
});
