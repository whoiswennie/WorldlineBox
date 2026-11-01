import { expect, it } from 'vitest';
import { companionSocialReviewableText } from '../../src/main/companions/social-review-scope';

it.each(['等会儿我还得去跟她说一声。', '稍后我准备联系她。', '我明天会跟你聊聊。', '我打算联系她们。', '过一会儿我再去跟她说一声。'])('excludes only an exact future self-contact intent: %s', text => {
    expect(companionSocialReviewableText(text)).toBe('');
  });

it('handles the actual multi-clause shape without removing a weather comparison or splitting its quoted comma', () => {
  const before = '——顺带说个小事，我刚才整理完了桌面。\n跟你提的那个“云少、风轻”挺不一样的，';
  expect(companionSocialReviewableText(before + '等会儿我还得去跟她说一声。')).toBe(before);
});

it.each([
  '我已经联系她了。', '我把配置告诉她们了。', '文件已经附上。', '我已经播放并听懂了音频。',
  '等会儿我还得去跟她说一声她已经答应了。', '我明天会告诉她文件已经发出了。', '等会儿她会同意我的计划。',
  '她说，等会儿我还得去跟她说一声。', '她的原话是：等会儿我还得去跟她说一声。',
  '她说过，\n等会儿我还得去跟她说一声。', '她说“等会儿我还得去跟她说一声”。',
  '她的意思是，等会儿我还得去跟她说一声。', '她让我转达，等会儿我还得去跟她说一声。',
  '对方的说明：\n等会儿我还得去跟她说一声。',
  '“她说‘等会儿我还得去跟她说一声’”。', '（等会儿我还得去跟她说一声）。',
  '`等会儿我还得去跟她说一声`。', '``等会儿我还得去跟她说一声``。',
  '“一份未结束的转述，等会儿我还得去跟她说一声。', '如果等会儿我还得去跟她说一声，那也只是一个条件。',
])('retains factual, mixed, third-party, quoted or uncertain text for the original guard: %s', text => {
  expect(companionSocialReviewableText(text)).toBe(text);
});

it.each(['我已经联系她了。', '她已经答应了。', '文件已经附上。'])('keeps a separate false claim even beside a valid intent: %s', claim => {
  expect(companionSocialReviewableText('等会儿我还得去跟她说一声，' + claim)).toBe(claim);
  expect(companionSocialReviewableText(claim + '等会儿我还得去跟她说一声。')).toBe(claim);
});

it('escapes actual public names and does not turn regex syntax into an authority matcher', () => {
  expect(companionSocialReviewableText('我打算联系小伙伴+。', ['小伙伴+'])).toBe('');
  expect(companionSocialReviewableText('我打算联系任意人。', ['.*'])).toBe('我打算联系任意人。');
});
