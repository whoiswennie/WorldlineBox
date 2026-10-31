import { expect, it, vi } from 'vitest';
import { generateCompanionDreamNarrative } from '../../src/main/companions/dream-wave-model';
import type { Companion } from '../../src/shared/companions';
import type { VcpMemoryDreamWaveResult } from '../../src/main/vcp-memory/dream-contracts';

const companion: Companion = { id: 'alice', name: '林澄', description: '', persona: '分清虚构与实际来源', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: '2026-10-28T00:00:00Z' };
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'synthetic', baseUrl: 'https://fixture.invalid' };
const wave: VcpMemoryDreamWaveResult = { schema: 'worldlinebox.vcp-dream-wave', owner: { version: 2, companionId: 'alice', name: '林澄', agentName: 'alice' },
  sourceRevision: 'fixed-wave', now: '2026-10-28T00:00:00Z', clockDomain: 'real', boundaries: { recentDays: 7, midDays: 30 },
  stages: { recent: { seeds: [{ id: 'actual-note', version: 1, eventTime: '2026-10-28T00:00:00Z', clockDomain: 'real', text: '实际有来源的日记' }], resonanceL1: [], cascadeL2: [] },
    mid: { seeds: [], cascadeL1: [] }, deep: { recalls: [] } },
  diagnostics: { algorithm: 'upstream-DreamWaveEngine', sourceCount: 1, indexedCount: 1, queries: [] } };
const proposal = { text: '这是有明确边界的私人虚构联想。', relatedMemoryIds: ['actual-note'],
  investigations: [{ question: '后续获准材料是否写了这个条件？', hypothesis: '这是待核查假设，不能当事实。', relatedMemoryIds: ['actual-note'], test: { kind: 'authorized_source_contains', quote: '需要逐字核查的条件' } }] };
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

it.each(['null', 'empty_investigations', 'changed_test'] as const)('never repairs an existing dream proposal into %s', async kind => {
  const altered = kind === 'null' ? null : { ...proposal, investigations: kind === 'empty_investigations' ? []
    : [{ ...proposal.investigations[0]!, test: { kind: 'authorized_source_contains', quote: '换成容易通过的另一句' } }] };
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...proposal, obsoleteField: true })).mockImplementation(async () => response(altered));
  await expect(generateCompanionDreamNarrative({ companion, wave }, config, undefined, { fetchFn })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
  expect(fetchFn).toHaveBeenCalledTimes(3);
  const last = JSON.parse(JSON.parse(String(fetchFn.mock.calls[2]?.[1]?.body)).messages[1].content);
  expect(last.originalOutput).toBe(JSON.stringify({ ...proposal, obsoleteField: true })); expect(last.validationErrors[0].code).toBe('repair_content_loss');
});

it('can remove an obsolete structural field without changing the actual fiction or pending question', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ ...proposal, obsoleteField: true })).mockResolvedValueOnce(response(proposal));
  expect(await generateCompanionDreamNarrative({ companion, wave }, config, undefined, { fetchFn })).toEqual(proposal);
  expect(fetchFn).toHaveBeenCalledTimes(2);
});

it('keeps a legal original no-dream outcome and never asks repair to change a well-shaped unauthorized reference', async () => {
  const empty = vi.fn<typeof fetch>().mockResolvedValue(response(null));
  expect(await generateCompanionDreamNarrative({ companion, wave }, config, undefined, { fetchFn: empty })).toBeNull(); expect(empty).toHaveBeenCalledOnce();
  const invalid = vi.fn<typeof fetch>().mockResolvedValue(response({ ...proposal, relatedMemoryIds: ['not-actually-read'] }));
  await expect(generateCompanionDreamNarrative({ companion, wave }, config, undefined, { fetchFn: invalid })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(invalid).toHaveBeenCalledOnce();
});
