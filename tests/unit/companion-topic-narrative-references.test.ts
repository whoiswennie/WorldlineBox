import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { prepareTopicNarrativeReferences } from '../../src/main/companions/topic-narrative-references';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionMessage } from '../../src/shared/companions';

const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture' };
function fixture(content = '许岚没有往北门去。他沿着北街的墙根向东侧挪。') {
  const at = '2026-10-23T00:00:00Z', id = randomUUID();
  const message: CompanionMessage = { id: 'formal', sequence: 2, conversationId: 'room', topicId: id, authorId: 'writer', content,
    kind: 'text', status: 'sent', attachments: [], createdAt: at };
  const frame: Pick<CompanionReplyInput, 'companion' | 'conversation' | 'topic' | 'messages'> = {
    companion: { id: 'writer', name: '林澄', description: '', persona: '独立伙伴', model: '', avatar: 'sister', builtin: false, proactive: false, createdAt: at },
    conversation: { id: 'room', kind: 'private', title: '私聊', memberIds: ['writer'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: at },
    topic: { id, conversationId: 'room', kind: 'story', title: '故事', status: 'active', participantIds: ['writer', 'user'], invitedIds: [], moderatorId: 'user', tags: [], revision: 1, createdAt: at, updatedAt: at },
    messages: [message] };
  return { frame, message, config };
}
const extraction = (content: string, referenceQuote: string, subjectName = '许岚', sourceMessageId = 'formal') => ({ references: [
  { sourceMessageId, subjectName, quote: content, referencePronoun: referenceQuote.includes('她') ? '她' : '他', referenceOccurrence: 0, decision: 'accept' }] });
const accepted = async () => ({ decisions: [{ index: 0, decision: 'accept', reason: '具名主体延续至身体动作，未换人。' }] });

it('binds exact UTF16 evidence and only publishes a reference after independent semantic acceptance', async () => {
  const f = fixture('🌧️许岚没有往北门去。他沿着北街的墙根向东侧挪。');
  const result = await prepareTopicNarrativeReferences({ ...f, extract: async () => extraction(f.message.content, '他沿着北街'), review: async context => {
    const payload = JSON.parse(context.user); expect(payload.candidates[0]).not.toHaveProperty('bindingMethod');
    expect(payload.sources[0].content).toBe(f.message.content); return accepted();
  } });
  const ref = result.references[0]!;
  expect(result.status).toBe('reviewed'); expect(ref.sourceChecksum).toBe(createHash('sha256').update(f.message.content).digest('hex'));
  expect(f.message.content.slice(ref.nameStart, ref.nameEnd)).toBe('许岚');
  expect(f.message.content.slice(ref.referenceStart, ref.referenceEnd)).toBe('他');
  expect(f.message.content.slice(ref.quoteStart, ref.quoteEnd)).toBe(ref.quote);
});

it.each([
  '许岚看向沈舟，他站在门边。',
  '许岚停下。短斗篷没有动。他站在雾里。',
  '许岚没有回答。雾把那人推了半步。他的斗篷融进灰白里。',
  '许岚说：“他今晚不会来。”',
])('abstains when the independent reviewer finds ambiguity or another actor despite one literal pronoun: %s', async content => {
  const f = fixture(content);
  const result = await prepareTopicNarrativeReferences({ ...f, extract: async () => extraction(content, '他'),
    review: async () => ({ decisions: [{ index: 0, decision: 'ambiguous', reason: '不能排除另一先行词/引语所指。' }] }) });
  expect(result.references).toEqual([]); expect(result.status).toBe('abstained');
});

it.each([
  { content: '他走到门外。', name: '他', reference: '他' },
  { content: '她拉停下。', name: '她拉', reference: '她' },
])('does not let the name span masquerade as its own pronoun: $content', async ({ content, name, reference }) => {
  const f = fixture(content), review = vi.fn(accepted);
  expect((await prepareTopicNarrativeReferences({ ...f, extract: async () => extraction(content, reference, name), review })).references).toEqual([]);
  expect(review).not.toHaveBeenCalled();
});

it('excludes foreign, unpublished and user sources before either semantic call', async () => {
  const f = fixture(); f.frame.messages = [{ ...f.message, id: 'draft', isReplyDraft: true }, { ...f.message, id: 'other', topicId: 'other' },
    { ...f.message, id: 'user', authorId: 'user' }, { ...f.message, id: 'failed', status: 'failed' }];
  const extract = vi.fn();
  expect((await prepareTopicNarrativeReferences({ ...f, extract, review: accepted })).status).toBe('no_formal_source'); expect(extract).not.toHaveBeenCalled();
});

it('rejects fabricated/discontinuous quotes and incomplete independent decisions', async () => {
  const f = fixture(), review = vi.fn(accepted);
  expect((await prepareTopicNarrativeReferences({ ...f, extract: async () => extraction('许岚……他走', '他'), review })).references).toEqual([]);
  expect(review).not.toHaveBeenCalled();
  expect((await prepareTopicNarrativeReferences({ ...f, extract: async () => extraction(f.message.content, '他'), review: async () => ({ decisions: [] }) })).references).toEqual([]);
});

it('retains conflicting source evidence only as diagnostics without choosing an active identity', async () => {
  const f = fixture(); const second = { ...f.message, id: 'later', sequence: 4, content: '许岚停下脚步。她举起提灯。' }; f.frame.messages = [...f.frame.messages, second];
  const result = await prepareTopicNarrativeReferences({ ...f, extract: async () => ({ references: [extraction(f.message.content, '他').references[0], extraction(second.content, '她', '许岚', second.id).references[0]] }),
    review: async () => ({ decisions: [0, 1].map(index => ({ index, decision: 'accept', reason: '各自原句主体明确，冲突应保留。' })) }) });
  expect(result.references).toEqual([]); expect(result.status).toBe('abstained');
  expect(result.diagnostics?.map(ref => ref.literalPronoun)).toEqual(['他', '她']);
  expect(result.conflicts).toEqual([{ subjectName: '许岚', sourceMessageIds: ['formal', 'later'] }]);
});

it('does not discard the later clear candidate when both models accept a complex earlier same-name binding', async () => {
  const bad = '许岚听见这话，指腹在包带上停下来。他没有看她的表，可他知道她刚才抬过手腕。';
  const clear = '许岚没有立刻过去。她抬眼看了看北门上方那块匾额，然后她迈了两步。';
  const f = fixture(bad + '\n\n' + clear), review = vi.fn(async context => {
    const data = JSON.parse(context.user); expect(data.candidates).toHaveLength(2);
    expect(data.sources[0].content).toBe(f.message.content);
    return { decisions: [0, 1].map(index => ({ index, decision: 'accept', reason: '故意复现两模型同错，宿主不能把复杂候选升级为硬人物事实。' })) };
  });
  const result = await prepareTopicNarrativeReferences({ ...f, extract: async context => {
    const data = JSON.parse(context.user), supplied = data.sources[0].candidatePassages as Array<{ start: number; end: number; text: string }>;
    expect(supplied.some(passage => passage.text.includes('许岚没有立刻过去。她抬眼'))).toBe(true);
    expect(supplied.every(passage => f.message.content.slice(passage.start, passage.end) === passage.text)).toBe(true);
    expect(supplied.some(passage => passage.text.includes('他没有看她的表'))).toBe(false);
    return { references: [extraction(bad, '他').references[0], extraction(clear, '她').references[0]] };
  }, review });
  expect(review).toHaveBeenCalledOnce(); expect(result.references).toHaveLength(1);
  expect(result.references[0]).toMatchObject({ subjectName: '许岚', sourcePronoun: '她', quote: clear });
  expect(result.diagnostics).toEqual([expect.objectContaining({ candidateSubjectName: '许岚', literalPronoun: '他', quote: bad })]);
});

it('does not force an identity when the only passage is a complex binding', async () => {
  const content = '许岚听见这话。他没有看她的表。', f = fixture(content);
  const extract = vi.fn(async () => extraction(content, '他')), review = vi.fn(accepted);
  const result = await prepareTopicNarrativeReferences({ ...f, extract, review });
  expect(result.references).toEqual([]); expect(result.status).toBe('abstained');
  expect(extract).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
});

it('does not treat an object pronoun as the named subject even if both semantic calls accept it', async () => {
  const content = '许岚看了他一眼，又看向他垂下的一只手。', f = fixture(content);
  const extract = vi.fn(async () => extraction(content, '他')), review = vi.fn(accepted);
  const result = await prepareTopicNarrativeReferences({ ...f, extract, review });
  expect(result.references).toEqual([]); expect(extract).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
});

it('reuses exact authorized source/model/owner cache across changing windows and invalidates changed bytes or withdrawn ports', async () => {
  const f = fixture();
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init!.body)), data = JSON.parse(wire.messages.find((item: { role: string }) => item.role === 'user').content);
    const result = data.purpose === 'topic_narrative_reference_extract' ? { references: data.sources.map((source: { id: string; candidatePassages: Array<{ text: string }> }) => extraction(source.candidatePassages[0]!.text, '他沿着', '许岚', source.id).references[0]) }
      : { decisions: data.candidates.map((_candidate: unknown, index: number) => ({ index, decision: 'accept', reason: '主体接续。' })) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const first = await prepareTopicNarrativeReferences({ ...f, fetchFn }); expect(first.references).toHaveLength(1); expect(fetchFn).toHaveBeenCalledTimes(2);
  await prepareTopicNarrativeReferences({ ...f, fetchFn }); expect(fetchFn).toHaveBeenCalledTimes(2);
  f.frame.messages = [...f.frame.messages, { ...f.message, id: 'new', sequence: 4 }];
  expect((await prepareTopicNarrativeReferences({ ...f, fetchFn })).references).toHaveLength(2); expect(fetchFn).toHaveBeenCalledTimes(4);
  f.message.content += '他仍在墙根。'; await prepareTopicNarrativeReferences({ ...f, fetchFn }); expect(fetchFn).toHaveBeenCalledTimes(6);
  f.frame.messages = []; expect((await prepareTopicNarrativeReferences({ ...f, fetchFn })).references).toHaveLength(0); expect(fetchFn).toHaveBeenCalledTimes(6);
});
