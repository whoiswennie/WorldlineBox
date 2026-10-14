import { describe, expect, it, vi } from 'vitest';
import { generateCompanionMemoryDream } from '../../src/main/companions/memory-model';
import type { CompanionMemory, CompanionMessage, Companion } from '../../src/shared/companions';

const at = '2026-10-14T00:00:00Z';
const companion: Companion = { id: 'sister', name: '姐姐', description: '', persona: '温柔沉稳，喜欢安静听歌。', model: '', avatar: 'sister', builtin: true, proactive: false, createdAt: at };
const source: CompanionMessage = { id: 'actual_result', sequence: 2, conversationId: 'private_sister', authorId: 'sister', kind: 'text', content: '这次先备份再修改，实际修复了聊天保存问题。', status: 'sent', createdAt: at, attachments: [] };
const atom: CompanionMemory = { id: 'actual_atom', companionId: 'sister', sourceMessageId: source.id, sourceConversationId: source.conversationId,
  content: source.content, kind: 'task', subject: 'sister', factKey: 'chat.fix', status: 'active', origin: 'companion', createdAt: at, updatedAt: at };
const input = { companion, conversation: { id: source.conversationId, kind: 'private' as const, title: '姐姐', memberIds: ['sister'], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' }, messages: [source], relevantMemories: [atom] };
const config = { apiFormat: 'openai_chat' as const, model: 'selected-model', apiKey: 'private-key', baseUrl: 'https://provider.invalid' };
const dream = { text: '梦里，我把散乱的聊天纸片慢慢整理好；这是对实际修复经历的主观联想。', sourceMessageIds: [source.id], relatedMemoryIds: [atom.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] };
function fetchFor(value: unknown) { return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))); }

describe('source-based virtual sleep consolidation', () => {
  it('forms a subjective dream and a conditional lesson from actual atomic evidence without changing persona or permissions', async () => {
    const candidate = { kind: 'knowledge', subject: 'sister', content: '在这次聊天保存修复中，先备份再修改帮助保留了可恢复副本；该经验仅适用于这次有结果的经历。',
      sourceMessageIds: [source.id], evidence: dream.evidence, relatedMemoryIds: [atom.id] };
    const fetchFn = fetchFor({ candidates: [candidate], dream });
    const result = await generateCompanionMemoryDream(input, config, undefined, { fetchFn });
    expect(result.dream).toEqual(dream); expect(result.candidates[0]).toMatchObject(candidate);
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)), payload = JSON.parse(body.messages[1].content);
    expect(payload.purpose).toBe('memory_dream'); expect(payload.stablePersona).toBe(companion.persona);
    expect(body.tools).toBeUndefined(); expect(body.stream).toBe(false);
    expect(body.messages[0].content).toContain('虚拟study或睡醒不证明学会现实知识');
  });
  it('permits no dream when the actual evidence has no meaningful new content', async () => {
    expect(await generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ candidates: [], dream: null }) })).toEqual({ candidates: [], dream: null });
  });
  it('can consolidate a real observed group experience in private sleep but excludes sources absent from the retrieved atoms', async () => {
    const groupSource = { ...source, conversationId: 'group_actual' }, groupAtom = { ...atom, sourceConversationId: groupSource.conversationId };
    const unrelated = { ...source, id: 'not_retrieved', content: 'PRIVATE_UNRELATED' };
    const fetchFn = fetchFor({ candidates: [], dream });
    expect((await generateCompanionMemoryDream({ ...input, messages: [groupSource, unrelated], relevantMemories: [groupAtom] }, config, undefined, { fetchFn })).dream).toEqual(dream);
    const payload = JSON.parse(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)).messages[1].content);
    expect(payload.messages).toHaveLength(1); expect(payload.messages[0].conversationId).toBe('group_actual');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_UNRELATED');
  });
  it.each([
    { ...dream, sourceMessageIds: ['fabricated'] }, { ...dream, relatedMemoryIds: ['not_read'] },
    { ...dream, evidence: [{ sourceMessageId: source.id, quote: '梦中学会了没读过的知识' }] }, { ...dream, evidence: [] },
  ])('rejects fictional or unsupported dream provenance %#', async value => {
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ candidates: [], dream: value }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects promotion of dream imagery to a user fact and changes to current state from old sleep evidence', async () => {
    const candidate = { kind: 'fact', subject: 'user', factKey: 'dream.happened', content: '用户真的整理了梦中的纸片。', sourceMessageIds: [source.id], evidence: dream.evidence, relatedMemoryIds: [atom.id] };
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ candidates: [candidate], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(generateCompanionMemoryDream(input, config, undefined, { fetchFn: fetchFor({ candidates: [], dream, stateProposal: { reason: '假设', focus: 'new', sourceMessageIds: [source.id], evidence: dream.evidence } }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('does not summarize an old derived summary as if it were a newly read atomic experience', async () => {
    await expect(generateCompanionMemoryDream({ ...input, relevantMemories: [{ ...atom, kind: 'overview' }] }, config, undefined,
      { fetchFn: fetchFor({ candidates: [], dream }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
