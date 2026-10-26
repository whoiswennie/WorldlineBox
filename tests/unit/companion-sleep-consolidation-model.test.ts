import { expect, it, vi } from 'vitest';
import { generateCompanionMemoryDream, generateCompanionMemoryMaintenance } from '../../src/main/companions/memory-model';
import type { CompanionJournalInput } from '../../src/main/companions/memory-model';
import type { CompanionMemory } from '../../src/shared/companions';

const at = '2026-10-23T00:00:00.000Z', room = 'private_alice';
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', baseUrl: 'https://test.invalid/v1', apiKey: 'synthetic' };
const messages = ['first', 'second'].map((id, index) => ({ id, conversationId: room, authorId: 'user', sequence: index + 1,
  kind: 'text' as const, status: 'sent' as const, attachments: [], createdAt: at, content: index ? '更正：钥匙编号是K-701，不是K-710；搬家日期仍未定。' : '钥匙先记成K-710，搬家日期还未确定。' }));
const notes: CompanionMemory[] = messages.map(source => ({ id: 'note_' + source.id, companionId: 'alice', scopeId: 'scope', sourceConversationId: room,
  content: source.content, tags: ['钥匙'], sourceMessageId: source.id, sourceSequence: source.sequence,
  sources: [{ messageId: source.id, conversationId: room, sequence: source.sequence, authorId: source.authorId, revision: 1, checksum: 'host', createdAt: at }],
  origin: 'user', status: 'indexed', version: 1, captureMethod: 'automatic', createdAt: at, updatedAt: at }));
const input: CompanionJournalInput = { companion: { id: 'alice', name: '林澄', description: '', persona: '核对实际来源。', model: '', avatar: 'sister',
  builtin: false, active: true, proactive: false, createdAt: at }, conversation: { id: room, kind: 'private', title: '合成测试', memberIds: ['alice'],
  pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: at }, messages, relevantMemories: notes, reflectionOnly: true, dreamAllowed: false };
const plan = () => ({ inputs: notes.map(note => ({ id: note.id, version: note.version })), candidate: {
  content: '玩家先把钥匙记成K-710，随后明确更正为K-701；搬家日期仍未定。', tags: ['钥匙'], sourceMessageIds: messages.map(source => source.id),
  relatedMemoryIds: notes.map(note => note.id), evidence: messages.map(source => ({ sourceMessageId: source.id, quote: source.content })) } });
const response = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

it('makes a required maintenance merge decision independently of an empty personal reflection', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    if (data.purpose === 'vcp_sleep_reflection') { expect(data.outputSchema.properties).not.toHaveProperty('consolidations'); return response({ notes: [], dream: null }); }
    expect(data.purpose).toBe('vcp_sleep_memory_maintenance');
    expect(data.outputSchema.required).toEqual(expect.arrayContaining(['decision', 'reason', 'consolidations']));
    return response({ decision: 'merge', reason: '同一钥匙的记录和更正应保留先后关系合并。', consolidations: [plan()] });
  });
  expect(await generateCompanionMemoryDream({ ...input, maintenanceSeparated: true }, config, undefined, { fetchFn })).toEqual({ notes: [], dream: null });
  expect(await generateCompanionMemoryMaintenance(input, config, undefined, { fetchFn })).toMatchObject({ decision: 'merge', consolidations: [plan()] });
  expect(fetchFn).toHaveBeenCalledTimes(2);
});
it('accepts a concrete no-value decision without forcing plans or another paid decision', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => response({ decision: 'defer', reason: '两条独立经历不重叠，原文各自保留比混合归档更有用。', consolidations: [] }));
  expect(await generateCompanionMemoryMaintenance(input, config, undefined, { fetchFn })).toMatchObject({ decision: 'defer', consolidations: [] });
  expect(fetchFn).toHaveBeenCalledOnce();
});
it.each([[], [notes[0]!], notes.map(note => ({ ...note, metadata: { consolidation: true, sleepReflection: true } })),
  notes.map(note => ({ ...note, metadata: { dream: true } }))].map(relevantMemories => ({ relevantMemories })))('skips paid maintenance when no eligible original seed group exists', async ({ relevantMemories }) => {
  const fetchFn = vi.fn<typeof fetch>();
  expect(await generateCompanionMemoryMaintenance({ ...input, relevantMemories }, config, undefined, { fetchFn })).toMatchObject({ decision: 'defer', consolidations: [] });
  expect(fetchFn).not.toHaveBeenCalled();
});
it.each([{ consolidations: [] }, { decision: 'merge', reason: 'merge', consolidations: [] }, { decision: 'defer', reason: 'keep', consolidations: [plan()] }])('rejects a missing or contradictory maintenance decision', async output => {
  await expect(generateCompanionMemoryMaintenance(input, config, undefined, { fetchFn: async () => response(output) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('automatically proposes an optional exact-seed same-domain consolidation during the existing sleep reflection call', async () => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), payload = JSON.parse(wire.messages[1].content);
    expect(payload.purpose).toBe('vcp_sleep_reflection'); expect(payload.relevantMemories.map((note: { id: string; version: number }) => [note.id, note.version])).toEqual([['note_first', 1], ['note_second', 1]]);
    expect(payload.outputSchema.properties).toHaveProperty('consolidations');
    expect(payload.outputSchema.required ?? []).not.toContain('consolidations');
    expect(payload.automaticConsolidationPolicy).toEqual({ originalJournalIds: notes.map(note => note.id), requiresNewOriginalSourceBeyondSelectedPriorMerges: true });
    return response({ notes: [], dream: null, consolidations: [plan()] });
  });
  const result = await generateCompanionMemoryDream(input, config, undefined, { fetchFn });
  expect(result.consolidations).toEqual([plan()]); expect(result.notes).toEqual([]); expect(fetchFn).toHaveBeenCalledOnce();
});

it('permits no consolidation and does not manufacture another model operation for a quiet sleep', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: [], dream: null }));
  expect(await generateCompanionMemoryDream(input, config, undefined, { fetchFn })).toEqual({ notes: [], dream: null });
  expect(fetchFn).toHaveBeenCalledOnce();
});

it('keeps a genuinely sourced reflection while discarding an automatic merge made only from prior derived notes', async () => {
  const derived = notes.map((note, index) => ({ ...note, metadata: index ? { sleepReflection: true, consolidation: true } : { automaticConsolidation: true, consolidation: 'source_version_graph' } }));
  const reflection = { content: '这次核对提醒我：编号仍需对照原始记录，搬家日期尚未确定。', tags: ['核对'],
    sourceMessageIds: [messages[1]!.id], relatedMemoryIds: [notes[1]!.id], evidence: [{ sourceMessageId: messages[1]!.id, quote: messages[1]!.content }] };
  const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: [reflection], dream: null, consolidations: [plan()] }));
  const result = await generateCompanionMemoryDream({ ...input, relevantMemories: derived }, config, undefined, { fetchFn });
  expect(result.notes).toEqual([reflection]); expect(result.consolidations).toBeUndefined();
});

it('returns a quiet merge plan when an original journal repeats only sources already covered by the selected prior merge', async () => {
  const prior = { ...notes[0]!, metadata: { automaticConsolidation: true, consolidation: 'source_version_graph' } };
  const duplicate = { ...notes[1]!, content: prior.content, sources: prior.sources };
  const proposal = plan(); proposal.candidate.sourceMessageIds = [messages[0]!.id]; proposal.candidate.evidence = [proposal.candidate.evidence[0]!];
  const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: [], dream: null, consolidations: [proposal] }));
  const result = await generateCompanionMemoryDream({ ...input, relevantMemories: [prior, duplicate] }, config, undefined, { fetchFn });
  expect(result.consolidations).toBeUndefined();
});

it('allows an exact prior automatic merge to absorb a new original journal with a genuinely new source', async () => {
  const prior = { ...notes[0]!, metadata: { automaticConsolidation: true, consolidation: 'source_version_graph' } };
  const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: [], dream: null, consolidations: [plan()] }));
  const result = await generateCompanionMemoryDream({ ...input, relevantMemories: [prior, notes[1]!] }, config, undefined, { fetchFn });
  expect(result.consolidations).toEqual([plan()]);
});

it.each(['version', 'source_subset', 'cross_domain', 'dream', 'overlap', 'single_input'] as const)('rejects an unsafe automatic merge before publication: %s', async kind => {
  const proposal = plan(), actualInput = structuredClone(input);
  if (kind === 'version') proposal.inputs[0]!.version++;
  if (kind === 'source_subset') { proposal.candidate.sourceMessageIds.pop(); proposal.candidate.evidence.pop(); }
  if (kind === 'single_input') proposal.inputs.pop();
  if (kind === 'cross_domain') actualInput.relevantMemories = [notes[0]!, { ...notes[1]!, sourceConversationId: 'foreign_group' }];
  if (kind === 'dream') actualInput.relevantMemories = [notes[0]!, { ...notes[1]!, metadata: { dream: true, simulation: true } }];
  const fetchFn = vi.fn<typeof fetch>(async () => response({ notes: [], dream: null, consolidations: kind === 'overlap' ? [proposal, proposal] : [proposal] }));
  await expect(generateCompanionMemoryDream(actualInput, config, undefined, { fetchFn })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

it('checks semantic prohibitions on the proposed merged text and leaves blocked originals unarchived', async () => {
  let calls = 0;
  const fetchFn = vi.fn<typeof fetch>(async () => response(++calls === 1 ? { notes: [], dream: null, consolidations: [plan()] }
    : { allowed: false, matchedPolicyIds: ['policy'] }));
  const result = await generateCompanionMemoryDream({ ...input, prohibitions: [{ id: 'policy', tags: ['钥匙'], persistent: true, conversationId: room }] }, config, undefined, { fetchFn });
  expect(result.consolidations).toBeUndefined(); expect(result.notes).toEqual([]); expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(notes.every(note => note.archivedAt === undefined)).toBe(true);
});
