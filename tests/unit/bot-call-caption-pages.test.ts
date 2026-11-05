import { expect, it } from 'vitest';
import { buildCallCaptionPages, callCaptionPageAt } from '../../src/renderer/companion-bot/call-caption-pages';

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

it('prefers sentence or phrase endings near the capacity and leaves short final pages intact', () => {
  expect(buildCallCaptionPages('一二三四五。六七八九', 8).map(page => page.text)).toEqual(['一二三四五。', '六七八九']);
  expect(buildCallCaptionPages('一二三四五，六七八九', 8)[0]!.text).toBe('一二三四五，');
  expect(buildCallCaptionPages('一二三四五。六七，八九十', 10)[0]!.text).toBe('一二三四五。');
  expect(buildCallCaptionPages('短句。下一句。', 20).map(page => page.text)).toEqual(['短句。下一句。']);
});

it('does not waste a page on punctuation before the preferred last 40 percent', () => {
  expect(buildCallCaptionPages('一。二三四五六七八九十', 8)[0]!.text).toBe('一。二三四五六七');
});

it('fits approximately twice as many Latin characters as CJK and still bounds long unbroken text', () => {
  const latin = buildCallCaptionPages('a'.repeat(50), 8), cjk = buildCallCaptionPages('文'.repeat(25), 8);
  expect(latin[0]!.text).toHaveLength(16); expect(latin.every(page => page.text.length <= 16)).toBe(true);
  expect(cjk[0]!.text).toHaveLength(8); expect(cjk.every(page => page.text.length <= 8)).toBe(true);
});

it('keeps emoji sequences and combining letters whole and counts emoji as wider than Latin', () => {
  const emoji = '👩🏽‍💻', pages = buildCallCaptionPages(emoji.repeat(14), 8);
  expect(pages[0]!.text).toBe(emoji.repeat(6)); expect(pages.map(page => page.text).join('')).toBe(emoji.repeat(14));
  const accent = buildCallCaptionPages('e\u0301'.repeat(35), 8);
  expect(accent[0]!.text).toBe('e\u0301'.repeat(16));
});

it('uses newline and quoted sentence boundaries without dropping whitespace or splitting decimals', () => {
  expect(buildCallCaptionPages('一二三四五\r\n六七八九十', 8)[0]!.text).toBe('一二三四五\r\n');
  expect(buildCallCaptionPages('一二三四五。”  六七八九十', 9)[0]!.text).toBe('一二三四五。”  ');
  expect(buildCallCaptionPages('1234567890.1234567890', 8)[0]!.text).toBe('1234567890.12345');
});

it.each([0, -10, .5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('uses a practical minimum for invalid or tiny capacity %s', capacity => {
  const text = '字'.repeat(25), pages = buildCallCaptionPages(text, capacity);
  expect(pages[0]!.text).toBe('字'.repeat(8)); expect(pages.map(page => page.text).join('')).toBe(text);
});

it('advances only once the next page contains revealed content and stays on the last page at completion', () => {
  const pages = buildCallCaptionPages('字'.repeat(24), 8);
  expect([0, 1, 7, 8, 9, 15, 16, 17, 24, 100].map(offset => callCaptionPageAt(pages, offset))).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 2, 2]);
  let previous = 0;
  for (let offset = 0; offset <= 30; offset++) { const page = callCaptionPageAt(pages, offset); expect(page).toBeGreaterThanOrEqual(previous); previous = page; }
  expect(callCaptionPageAt(pages, -20)).toBe(0); expect(callCaptionPageAt(pages, Number.NaN)).toBe(0); expect(callCaptionPageAt(pages, Infinity)).toBe(2);
});

it('handles empty captions without creating a blank artificial page', () => {
  expect(buildCallCaptionPages('', 80)).toEqual([]); expect(callCaptionPageAt([], 0)).toBe(0);
});
