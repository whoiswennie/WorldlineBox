import { expect, it } from 'vitest';
import { botMentionOptions, botMentionQuery, insertBotMention } from '../../src/renderer/companion-bot/bot-mentions';
const members = [
  { id: 'fish', name: '大肥鱼', persona: '真实聊天成员', createdAt: '2026-11-04' },
  { id: 'gpt', name: 'GPT', persona: '真实聊天成员', createdAt: '2026-11-04' },
];
it('finds only the active collapsed mention at the caret, rejecting email, completed tokens and distant text', () => {
  expect(botMentionQuery('请 @大', 4)).toEqual({ start: 2, end: 4, query: '大' });
  expect(botMentionQuery('你好@大', 4)).toEqual({ start: 2, end: 4, query: '大' });
  expect(botMentionQuery('a@example.com', 6)).toBeUndefined();
  expect(botMentionQuery('@大肥鱼 后续', 7)).toBeUndefined();
  expect(botMentionQuery('@', 0)).toBeUndefined();
  expect(botMentionQuery('@GPT', 4, 2)).toBeUndefined();
  expect(botMentionQuery('@' + 'x'.repeat(81), 82)).toBeUndefined();
});
it('searches only supplied members plus everyone and preserves original names rather than inventing nonmembers', () => {
  expect(botMentionOptions(members, '', 'zh-CN').map(value => value.name)).toEqual(['所有人', '大肥鱼', 'GPT']);
  expect(botMentionOptions(members, 'gPt', 'zh-CN').map(value => value.id)).toEqual(['gpt']);
  expect(botMentionOptions(members, 'all', 'zh-CN').map(value => value.mention)).toEqual(['所有人']);
  expect(botMentionOptions(members, '陌生伙伴', 'zh-CN')).toEqual([]);
  expect(botMentionOptions([members[0]!, members[0]!], '', 'en').map(value => value.mention)).toEqual(['all', '大肥鱼']);
});
it('inserts a correctly separated mention while preserving text after the caret and UTF-16 selection offsets', () => {
  expect(insertBotMention('请 @大 看一下', { start: 2, end: 4, query: '大' }, '大肥鱼')).toEqual({ text: '请 @大肥鱼 看一下', caret: 7 });
  expect(insertBotMention('你好@大', { start: 2, end: 4, query: '大' }, '大肥鱼')).toEqual({ text: '你好 @大肥鱼 ', caret: 8 });
  expect(insertBotMention('🐟 @g\n后文', { start: 3, end: 5, query: 'g' }, 'GPT')).toEqual({ text: '🐟 @GPT \n后文', caret: 8 });
});
