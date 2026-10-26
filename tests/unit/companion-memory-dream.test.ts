import { describe, expect, it, vi } from 'vitest';
import { generateCompanionMemoryDream } from '../../src/main/companions/memory-model';
import type { CompanionMemory, CompanionMessage, Companion } from '../../src/shared/companions';

const at = '2026-10-14T00:00:00Z';
const companion: Companion = { id: 'sister', name: '姐姐', description: '', persona: '温柔沉稳，喜欢安静听歌。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: at };
const source: CompanionMessage = { id: 'actual_result', sequence: 2, conversationId: 'private_sister', authorId: 'sister', kind: 'text', content: '这次先备份再修改，实际修复了聊天保存问题。', status: 'sent', createdAt: at, attachments: [] };
const journal: CompanionMemory = { id: 'actual_journal', companionId: 'sister', scopeId: 'scope_private_sister',
  sourceMessageId: source.id, sourceConversationId: source.conversationId, sourceSequence: source.sequence,
  sources: [{ messageId: source.id, conversationId: source.conversationId, sequence: source.sequence, authorId: source.authorId, revision: 1, checksum: 'host-owned-checksum', createdAt: at }],
  content: source.content, tags: ['聊天保存', '备份'], status: 'indexed', origin: 'companion', captureMethod: 'automatic', version: 1, createdAt: at, updatedAt: at };
const input = { companion, conversation: { id: source.conversationId, kind: 'private' as const, title: '姐姐', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' }, messages: [source], relevantMemories: [journal] };
const config = { apiFormat: 'openai_chat' as const, model: 'selected-model', apiKey: 'private-key', baseUrl: 'https://provider.invalid' };
const dream = { text: '梦里，我把散乱的聊天纸片慢慢整理好；这是对实际修复经历的主观联想。', sourceMessageIds: [source.id], relatedMemoryIds: [journal.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
const reflection = { content: '这次聊天保存修复中，我先备份再修改，实际修复了保存问题。这次经历支持保留可恢复副本；还不能证明同样做法适用于所有故障。',
  tags: ['聊天保存', '备份', '修复经验'], sourceMessageIds: [source.id], evidence: dream.evidence, relatedMemoryIds: [journal.id] };
function fetchFor(value: unknown) { return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))); }
function request(fetchFn: ReturnType<typeof fetchFor>) {
  const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
  return { body, payload: JSON.parse(body.messages[1].content), system: String(body.messages[0].content) };
}

describe('source-based VCP sleep reflection', () => {
  it('proposes only an unvalidated procedure from real reflection and never from fictional dream text', async () => {
    const procedure = { applicability: '此次约定的备份文件检查', steps: ['先形成backup.txt。', '核对备份文件。'], limitations: ['后续仍需真实实践'],
      verification: { kind: 'artifact_delivery', artifactRequirements: [{ path: 'backup.txt', minBytes: 1 }] } };
    const fetchFn = fetchFor({ notes: [{ ...reflection, procedure }], dream: null });
    const result = await generateCompanionMemoryDream({ ...input, maintenanceMode: 'background', reflectionOnly: true }, config, undefined, { fetchFn });
    expect(result.notes[0]?.procedure).toEqual(procedure); expect(result.dream).toBeNull();
    expect(request(fetchFn).payload.maintenanceMode).toBe('background'); expect(request(fetchFn).system).toContain('procedure不会增加工具权限');
  });
  it('keeps a missed host admission dreamless without preventing source-based insight', async () => {
    const fetchFn = fetchFor({ notes: [reflection], dream: null });
    expect((await generateCompanionMemoryDream({ ...input, dreamAllowed: false }, config, undefined, { fetchFn })).notes).toEqual([reflection]);
    expect(request(fetchFn).payload.dreamAdmission.allowed).toBe(false);
    await expect(generateCompanionMemoryDream({ ...input, dreamAllowed: false }, config, undefined,
      { fetchFn: fetchFor({ notes: [], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('keeps a virtual dream separate from a qualified journal and preserves actual source dependencies', async () => {
    const fetchFn = fetchFor({ notes: [reflection], dream });
    const result = await generateCompanionMemoryDream(input, config, undefined, { fetchFn });
    expect(result.dream).toEqual(dream); expect(result.notes[0]).toEqual(reflection);
    const { body, payload, system } = request(fetchFn);
    expect(payload.purpose).toBe('vcp_sleep_reflection'); expect(payload.companion.persona).toBe(companion.persona);
    expect(payload.relevantMemories).toEqual([journal]);
    expect(body.tools).toBeUndefined(); expect(body.stream).toBe(false); expect(body.model).toBe(config.model);
    expect(system).toContain('梦中虚构画面只能出现在 dream'); expect(system).toContain('不改变稳定人格');
  });
  it('permits neither a reflection nor a dream when sources add no new understanding', async () => {
    expect(await generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [], dream: null }) }))
      .toEqual({ notes: [], dream: null });
  });
  it('revisits an observed group experience in private sleep only when a retrieved journal supplies its source', async () => {
    const groupSource = { ...source, conversationId: 'group_actual' };
    const groupJournal = { ...journal, sourceConversationId: groupSource.conversationId,
      sources: [{ ...journal.sources[0]!, conversationId: groupSource.conversationId }] };
    const unrelated = { ...source, id: 'not_retrieved', conversationId: 'group_other', content: 'OTHER_GROUP_PRIVATE' };
    const fetchFn = fetchFor({ notes: [reflection], dream });
    expect((await generateCompanionMemoryDream({ ...input, messages: [groupSource, unrelated], relevantMemories: [groupJournal] }, config, undefined, { fetchFn })).dream).toEqual(dream);
    const { payload } = request(fetchFn);
    expect(payload.messages).toHaveLength(1); expect(payload.messages[0].conversationId).toBe('group_actual');
    expect(JSON.stringify(payload)).not.toContain('OTHER_GROUP_PRIVATE');
    await expect(generateCompanionMemoryDream({ ...input, messages: [groupSource], relevantMemories: [] }, config, undefined,
      { fetchFn: fetchFor({ notes: [], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([
    { ...dream, sourceMessageIds: ['fabricated'] }, { ...dream, sourceMessageIds: [source.id, source.id] },
    { ...dream, relatedMemoryIds: ['not_read'] }, { ...dream, relatedMemoryIds: [] },
    { ...dream, evidence: [{ sourceMessageId: source.id, quote: '梦中学会了没读过的知识' }] }, { ...dream, evidence: [] },
    { ...dream, evidence: [{ sourceMessageId: 'fabricated', quote: source.content }] },
  ])('rejects fictional or unsupported dream provenance %#', async value => {
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [], dream: value }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each([
    { ...reflection, relatedMemoryIds: [] }, { ...reflection, relatedMemoryIds: ['not_read'] },
    { ...reflection, sourceMessageIds: ['fabricated'] }, { ...reflection, evidence: [] },
  ])('requires retrieved journal dependencies for every sleep reflection %#', async value => {
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [value], dream: null }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects a retrieved journal that contributes none of the quoted messages', async () => {
    const unrelated = { ...journal, sources: [{ ...journal.sources[0]!, messageId: 'another_source' }] };
    await expect(generateCompanionMemoryDream({ ...input, relevantMemories: [unrelated] }, config, undefined,
      { fetchFn: fetchFor({ notes: [reflection], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it.each(['forgotten', 'invalid'] as const)('removes %s dependencies from the prompt and refuses to revive them', async status => {
    const revoked = { ...journal, status };
    const fetchFn = fetchFor({ notes: [], dream: null });
    await generateCompanionMemoryDream({ ...input, relevantMemories: [revoked] }, config, undefined, { fetchFn });
    expect(request(fetchFn).payload.relevantMemories).toEqual([]);
    await expect(generateCompanionMemoryDream({ ...input, relevantMemories: [revoked] }, config, undefined,
      { fetchFn: fetchFor({ notes: [reflection], dream: null }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(generateCompanionMemoryDream({ ...input, relevantMemories: [revoked] }, config, undefined,
      { fetchFn: fetchFor({ notes: [], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('keeps new group sources local while retaining only the sleepers own retrieved background', async () => {
    const fetchFn = fetchFor({ notes: [], dream: null });
    await generateCompanionMemoryDream({ ...input, conversation: { ...input.conversation, id: 'group_current', kind: 'group' },
      messages: [source, { ...source, id: 'other_group_source', conversationId: 'group_other' }],
      relevantMemories: [journal, { ...journal, id: 'other_companion', companionId: 'other', sourceConversationId: 'group_current' }] },
    config, undefined, { fetchFn });
    expect(request(fetchFn).payload.messages).toEqual([]); expect(request(fetchFn).payload.relevantMemories).toEqual([journal]);
  });
  it.each<Partial<CompanionMessage>>([{ status: 'failed' }, { isReplyDraft: true },
    { replyDraft: { step: 0, attemptId: 'attempt', text: 'unfinished dream evidence' } }])(
    'never consolidates failed or uncommitted reply text %#', async overrides => {
      await expect(generateCompanionMemoryDream({ ...input, messages: [{ ...source, ...overrides }] }, config, undefined,
        { fetchFn: fetchFor({ notes: [reflection], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
  it('requires a quotation for each source when a dream combines experiences', async () => {
    const second = { ...source, id: 'second', sequence: 3, content: '随后运行了保存检查。' };
    await expect(generateCompanionMemoryDream({ ...input, messages: [source, second] }, config, undefined,
      { fetchFn: fetchFor({ notes: [], dream: { ...dream, sourceMessageIds: [source.id, second.id] } }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects current-state changes from sleep evidence even when their source quotations are valid', async () => {
    const stateProposal = { reason: '旧经历并不说明此刻状态', focus: 'new', sourceMessageIds: [source.id], evidence: dream.evidence };
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [], dream, stateProposal }) }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('allows a present, source-backed integration focus only alongside a newly saved qualified reflection', async () => {
    const stateProposal = { reason: '这次整理后，下次处理类似故障时先确认可恢复副本。', expression: 'direct', focus: '下次修复先核验备份',
      sourceMessageIds: [source.id], evidence: dream.evidence, appraisals: [{ type: 'shared_success', target: 'task', intensity: .3, confidence: .9 }] };
    const result = await generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [reflection], dream: null, stateProposal }) });
    expect(result.stateProposal).toEqual(stateProposal);
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [reflection], dream: null,
      stateProposal: { ...stateProposal, appraisals: [{ type: 'shared_success', target: 'user', intensity: .3, confidence: .9 }] } }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('preserves a qualified self-understanding projection grounded in the sleepers own actual action', async () => {
    const statement = '我愿意先保留可恢复副本。', qualification = '仅是这次修复支持的暂定做法，不保证适用于所有故障。';
    const note = { ...reflection, content: statement + qualification, diaryName: '自我认识', selfDevelopment: { kind: 'value', topic: '可恢复性', statement, basis: 'reflection', qualification } };
    const result = await generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [note], dream: null }) });
    expect(result.notes[0]?.selfDevelopment).toMatchObject({ statement, qualification, basis: 'reflection' });
    await expect(generateCompanionMemoryDream({ ...input, messages: [{ ...source, authorId: 'user' }] }, config, undefined,
      { fetchFn: fetchFor({ notes: [note], dream: null }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('keeps model-authored persona, permissions and host state fields outside the strict sleep result', async () => {
    for (const extra of [{ persona: 'overwrite' }, { permissions: ['filesystem.write'] }, { energy: 100 }]) {
      await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ notes: [], dream, ...extra }) }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });
});
