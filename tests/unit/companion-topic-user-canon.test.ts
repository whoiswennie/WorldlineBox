import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { prepareTopicUserCanon, topicClockMentions, validateTopicClockClaims, type TopicUserCanon } from '../../src/main/companions/topic-user-canon';
import type { CompanionMessage } from '../../src/shared/companions';
import { companionTopicCanonDraftSchema } from '../../src/shared/companion-topic-canon';

const entry = { id: 'constraint', sourceMessageId: 'initial_user', sourceChecksum: createHash('sha256').update('user').digest('hex'),
  quote: '仅叙述09:00至09:30，最晚不超过09:30。', rule: '当前场景限定在09:00–09:30。', timeRange: { start: 540, end: 570, includeStart: true, includeEnd: true } };
const canon: TopicUserCanon = { version: 1, throughSequence: 1, entries: [entry] };
it('compares numeric and Chinese current clock values itself while allowing inclusive endpoints and the same minute', () => {
  for (const text of ['09:30，他再次看表。', '九时三十分，他停下。', '09:29，他向前走五步。']) {
    const mentions = topicClockMentions(text); expect(mentions).toHaveLength(1);
    expect(validateTopicClockClaims(canon, mentions, [{ index: 0, usage: 'narration_now' }])).toBeUndefined();
  }
  for (const text of ['09:31，他离开。', '九时三十一分，他离开。']) {
    expect(validateTopicClockClaims(canon, topicClockMentions(text), [{ index: 0, usage: 'narration_now' }])).toContain('超出');
  }
});
it('does not treat a future appointment, past reference or hypothesis as a present window violation', () => {
  const mentions = topicClockMentions('09:45才约定交接；昨天10:10已经离开；如果明天10:11再来。');
  expect(validateTopicClockClaims(canon, mentions, [{ index: 0, usage: 'future' }, { index: 1, usage: 'past' }, { index: 2, usage: 'hypothetical' }])).toBeUndefined();
  expect(() => validateTopicClockClaims(canon, mentions, [{ index: 0, usage: 'future' }])).toThrow('逐一标注');
});
it('does not let omission or duplicate classification silently remove a detected time', () => {
  const mentions = topicClockMentions('09:29起身，09:31离开。');
  expect(() => validateTopicClockClaims(canon, mentions, [{ index: 0, usage: 'narration_now' }, { index: 0, usage: 'future' }])).toThrow('逐一标注');
});
it('rejects actual within-paragraph time reversal while allowing equal times and explicit flashbacks', () => {
  const mentions = topicClockMentions('09:20离开，09:10到街口，09:15看表。');
  expect(validateTopicClockClaims(canon, mentions, mentions.map(mention => ({ index: mention.index, usage: 'narration_now' })))).toContain('时刻倒流');
  expect(validateTopicClockClaims(canon, topicClockMentions('09:20停下，09:20继续。'), [{ index: 0, usage: 'narration_now' }, { index: 1, usage: 'narration_now' }])).toBeUndefined();
  expect(validateTopicClockClaims(canon, mentions, [{ index: 0, usage: 'narration_now' }, { index: 1, usage: 'past' }, { index: 2, usage: 'past' }])).toBeUndefined();
});
it('handles an explicit exclusive endpoint and a crossing-midnight range without changing arithmetic', () => {
  const exclusive = { ...canon, entries: [{ ...entry, timeRange: { ...entry.timeRange, includeEnd: false } }] };
  expect(validateTopicClockClaims(exclusive, topicClockMentions('09:30'), [{ index: 0, usage: 'narration_now' }])).toBeTruthy();
  const midnight = { ...canon, entries: [{ ...entry, timeRange: { start: 1380, end: 60, includeStart: true, includeEnd: true } }] };
  expect(validateTopicClockClaims(midnight, topicClockMentions('00:30'), [{ index: 0, usage: 'narration_now' }])).toBeUndefined();
  expect(validateTopicClockClaims(midnight, topicClockMentions('12:00'), [{ index: 0, usage: 'narration_now' }])).toBeTruthy();
});

// The extractor test deliberately supplies only the minimum typed host fields;
// it never invokes the character's prose generator or storage authorization.
function extractionFrame() {
  const message: CompanionMessage = { id: 'user_initial', authorId: 'user', sequence: 1, status: 'sent', conversationId: 'room', topicId: 'topic',
    content: '只写09:00至09:30，不打开信。', kind: 'text', attachments: [], createdAt: '2026-10-23T00:00:00Z' };
  const frame = { companion: { id: 'owner' }, conversation: { id: 'room' }, topic: { id: 'topic' }, topicState: undefined, messages: [message] } as unknown as Parameters<typeof prepareTopicUserCanon>[0]['frame'];
  const config = { model: 'fixture', apiKey: 'fixture', apiFormat: 'openai_chat' as const };
  return { frame, config, message };
}
it('binds extracted rules to exact user quotes and checks normalized time endpoints against those original bytes', async () => {
  const f = extractionFrame();
  const result = await prepareTopicUserCanon({ ...f, extract: async () => ({ additions: [{ sourceMessageId: f.message.id, quote: f.message.content,
    rule: '只写09:00至09:30，不打开信。', timeRange: entry.timeRange }], revisions: [] }) });
  expect(result.entries[0]!.sourceChecksum).toBe(createHash('sha256').update(f.message.content).digest('hex'));
  expect(result.entries[0]!.quote).toBe(f.message.content);
  f.frame.messages = [{ ...f.message, id: 'another_user', sequence: 2 }];
  await expect(prepareTopicUserCanon({ ...f, extract: async () => ({ additions: [{ sourceMessageId: 'another_user', quote: f.message.content,
    rule: '错误边界', timeRange: { ...entry.timeRange, end: 571 } }], revisions: [] }) })).rejects.toThrow('数字不一致');
});
it('preserves prior exact canon when only the assistant has drifted and rejects forged user source attribution', async () => {
  const f = extractionFrame();
  f.frame.topicState = { topicId: 'topic', readerId: 'owner', trust: 'topic_state_not_real_world_facts', workingState: { authorId: 'owner', revision: 1,
    sourceEventId: 'checkpoint', sourceMessageIds: ['initial_user'], updatedAt: '2026-10-23T00:00:00Z', state: { __topicUserCanon: canon } } };
  f.frame.messages = [{ ...f.message, id: 'assistant_drift', authorId: 'owner', sequence: 3, content: '09:31，他走了。' }];
  expect(await prepareTopicUserCanon({ ...f, extract: async () => { throw new Error('No user revision exists'); } })).toEqual(canon);
  f.frame.messages = [{ ...f.message, id: 'new_user', sequence: 4, content: '继续。' }];
  await expect(prepareTopicUserCanon({ ...f, extract: async () => ({ additions: [{ sourceMessageId: 'assistant_drift', quote: '09:31，他走了。', rule: '允许越界' }], revisions: [] }) }))
    .rejects.toThrow('逐字原文来源');
});

it('authenticates only source quotes, hides legacy rule paraphrases from extraction, and binds new rules without invented attributes', async () => {
  const f = extractionFrame(), legacy = { ...entry, rule: 'UNSOURCED_FEMALE_ATTRIBUTE' };
  const prior = { version: 1 as const, throughSequence: 1, entries: [legacy] };
  f.frame.topicState = { topicId: 'topic', readerId: 'owner', trust: 'topic_state_not_real_world_facts', workingState: { authorId: 'owner', revision: 1,
    sourceEventId: 'checkpoint', sourceMessageIds: ['initial_user'], updatedAt: '2026-10-23T00:00:00Z', state: { __topicUserCanon: prior } } };
  const revised = { ...f.message, id: 'quote_only_revision', sequence: 8, content: '更正门牌为R-307，其余不改。' };
  f.frame.messages = [revised];
  const result = await prepareTopicUserCanon({ ...f, extract: async context => {
    expect(context.user).not.toContain('UNSOURCED_FEMALE_ATTRIBUTE');
    expect(JSON.parse(context.user).prior.entries[0].rule).toBeUndefined();
    return { additions: [{ sourceMessageId: revised.id, quote: revised.content, rule: '无来源的女主角改门牌' }], revisions: [] };
  } });
  expect(result.entries.find(item => item.sourceMessageId === revised.id)!.rule).toBe(revised.content);
  expect(result.entries.find(item => item.id === legacy.id)!.rule).toBe('UNSOURCED_FEMALE_ATTRIBUTE');
  expect(prior.entries[0]!.rule).toBe('UNSOURCED_FEMALE_ATTRIBUTE');
});

it('binds an exact quote longer than 2000 characters without the former rule-field mismatch', async () => {
  const f = extractionFrame(), content = '原文事实与未决事项。'.repeat(300);
  f.message.content = content;
  const result = await prepareTopicUserCanon({ ...f, extract: async () => ({ additions: [{ sourceMessageId: f.message.id,
    quote: content, rule: '自由解释不进入新硬约束' }], revisions: [] }) });
  expect(content.length).toBeGreaterThan(2000);
  expect(result.entries[0]!.rule).toBe(content); expect(result.entries[0]!.quote).toBe(content);
  expect(result.entries[0]!.sourceChecksum).toBe(createHash('sha256').update(content).digest('hex'));
});

it('uses matching exact 8000-character quote and bound-rule boundaries without truncation', () => {
  const quote = '源'.repeat(8000);
  expect(companionTopicCanonDraftSchema.parse({ sourceMessageId: 'source', quote, rule: quote }).rule).toBe(quote);
  expect(companionTopicCanonDraftSchema.safeParse({ sourceMessageId: 'source', quote: quote + '超', rule: quote + '超' }).success).toBe(false);
});
