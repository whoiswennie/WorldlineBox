import { expect, it } from 'vitest';
import { buildCallCaptionPages, callCaptionPageAt, callCaptionPlaybackPages } from '../../src/shared/companion-call-captions';
import { appendCallCaptions, CALL_CAPTION_HISTORY_PAGES, type CallBeat, type CaptionTimeline } from '../../src/renderer/companion-bot/call-caption-timeline';

it('bounds caption history and deduplication across a week of minute-by-minute replies', () => {
  let timeline: CaptionTimeline = { first: 0, pages: [], snapshotBeats: new Set() };
  const recent: CallBeat[] = [];
  const rounds = 7 * 24 * 60;
  for (let i = 0; i < rounds; i++) {
    const id = String(i);
    recent.push({ id, messageId: id, partId: 'cue', sequence: i, text: '这一分钟的对白。', cue: {} });
    if (recent.length > 80) recent.shift();
    timeline = appendCallCaptions(timeline, recent);
    if (timeline.pages.length > CALL_CAPTION_HISTORY_PAGES || timeline.snapshotBeats.size > 80) throw Error('Unbounded caption history');
  }
  expect(timeline.first).toBe(rounds - CALL_CAPTION_HISTORY_PAGES);
  expect(timeline.pages).toHaveLength(CALL_CAPTION_HISTORY_PAGES);
  expect(timeline.pages[0]!.beat.sequence).toBe(timeline.first);
  expect(timeline.pages.at(-1)!.beat.sequence).toBe(rounds - 1);
  expect(appendCallCaptions(timeline, recent).pages).toBe(timeline.pages);
});

it('preserves all source text and exposes contiguous UTF-16 offsets on grapheme boundaries', () => {
  const text = '  你好👩🏽‍💻！Hello e\u0301 world.\r\n这是下一段，包含🇨🇳和1️⃣。  '.repeat(9);
  const pages = buildCallCaptionPages(text, 13), boundaries = new Set([text.length, ...[...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(segment => segment.index)]);
  expect(pages.length).toBeGreaterThan(4); expect(pages.map(page => page.text).join('')).toBe(text);
  expect(pages[0]!.start).toBe(0); expect(pages.at(-1)!.end).toBe(text.length);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    expect(page.text).toBe(text.slice(page.start, page.end)); expect(page.end).toBeGreaterThan(page.start);
    expect(boundaries.has(page.start)).toBe(true); expect(boundaries.has(page.end)).toBe(true);
    if (index) expect(page.start).toBe(pages[index - 1]!.end);
  }
});

it('keeps one tool utterance together for captioning and speech, including commas and embedded sentences', () => {
  const text = '不过这个真不是一般的烂事，看完别光刷弹幕，那种人当年能被放出来就是流程出问题了。';
  expect(callCaptionPlaybackPages(text)).toEqual([{ text, start: 0, end: text.length }]);
  const cue = text + '这件事还要接着说。';
  expect(callCaptionPlaybackPages(cue, 'cue-id')).toEqual([{ text: cue, start: 0, end: cue.length }]);
  expect(callCaptionPlaybackPages('  ', 'cue-id')).toEqual([]);
});

it('packs short sentences and lets a single sentence, unpunctuated line or word exceed the reading target', () => {
  expect(buildCallCaptionPages('一二三四五。六七八九', 8).map(page => page.text)).toEqual(['一二三四五。', '六七八九']);
  expect(buildCallCaptionPages('短句。下一句。', 20).map(page => page.text)).toEqual(['短句。下一句。']);
  for (const value of ['一二三四五，六七八九，后面还有。', '在这里需要\r\n换行但还没有读完。', '字'.repeat(100), '👩🏽‍💻'.repeat(20), 'https://example.com/a.b?q=3.14', 'a'.repeat(90)]) {
    expect(buildCallCaptionPages(value, 8).map(page => page.text)).toEqual([value]);
  }
});

it('preserves quoted endings, decimals and original spacing in the text sent to the next page', () => {
  const first = '她说：“答案是 3.14，你算对了吗？！”  ';
  const second = '这里是接下来的一句。';
  expect(buildCallCaptionPages(first + second, 8).map(page => page.text)).toEqual([first, second]);
});

it.each([0, -10, .5, Number.NaN, Infinity, -Infinity])('uses the minimum reading target for invalid or tiny capacity %s', capacity => {
  const text = '第一句话。第二句话。';
  expect(buildCallCaptionPages(text, capacity).map(page => page.text)).toEqual(['第一句话。', '第二句话。']);
});

it('advances only when the next sentence has revealed a character', () => {
  const pages = buildCallCaptionPages('一二三四五六七。八九十一二三四。五六七八九十一。', 8);
  expect([0, 1, 7, 8, 9, 15, 16, 17, 24, 100].map(offset => callCaptionPageAt(pages, offset))).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  expect(callCaptionPageAt(pages, Number.NaN)).toBe(0);
  expect(callCaptionPageAt(pages, Infinity)).toBe(2);
});

it('keeps explicit list items together and skips blank playback pages', () => {
  expect(callCaptionPlaybackPages('\n\n\n- 甲\n- 乙\n- 丙\n- 丁\n- 戊').map(page => page.text)).toEqual(['- 甲\n- 乙\n- 丙\n', '- 丁\n- 戊']);
  expect(buildCallCaptionPages('', 80)).toEqual([]);
  expect(callCaptionPageAt([], 0)).toBe(0);
});
