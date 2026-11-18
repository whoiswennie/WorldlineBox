export interface CallCaptionPage { text: string; start: number; end: number }
const targetUnits = 36;
export const callBeatKey = (messageId: string, partId?: string) => JSON.stringify([messageId, partId ?? null]);
export const CALL_CAPTION_AUTO_HIDE_MS = 1800;
export const callCaptionHoldMs = (text: string) => Math.min(90_000, 900 + Array.from(text).length * 82);

export function callCaptionPlaybackPages(text: string, partId?: string): CallCaptionPage[] {
  // An authored performance cue is already one utterance, even when it wraps on screen.
  if (partId !== undefined) return text.trim() ? [{ text, start: 0, end: text.length }] : [];
  return buildCallCaptionPages(text, targetUnits, 3).filter(page => page.text.trim());
}

const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' });
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u;

function readingWidth(text: string) {
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    width += emoji.test(segment) ? 1.2 : wide.test(segment) ? 1 : .5;
  }
  return width;
}

/** Group complete sentences from unstructured replies. Capacity is a reading target, never a cut point. */
export function buildCallCaptionPages(text: string, maxUnits: number, maxLines = Infinity): CallCaptionPage[] {
  const capacity = Number.isFinite(maxUnits) ? Math.max(8, maxUnits) : 8;
  // Ignore soft line wraps for sentence detection. Paragraphs and list items retain their boundaries.
  // Each replacement has the original UTF-16 length so offsets still address the untouched source.
  const prose = text.replace(/https?:\/\/[^\s。！？，”」]+/giu, url => url.replace(/[.!?]/gu, '_')).replace(/(?:\r\n|[\r\n])+/gu, (breaks, offset: number) => {
    if (!/^(?:\r\n|[\r\n])$/u.test(breaks) || /^[ \t]*(?:[-*•]|\d+[.)、])[ \t]+/u.test(text.slice(offset + breaks.length))) return breaks;
    return ' '.repeat(breaks.length);
  });
  const pages: CallCaptionPage[] = [];
  let start = 0, width = 0, lineBreaks = 0;
  for (const { segment, index } of sentences.segment(prose)) {
    const sentence = text.slice(index, index + segment.length);
    const units = readingWidth(sentence);
    if (index > start && (width + units > capacity || lineBreaks >= maxLines)) {
      pages.push({ text: text.slice(start, index), start, end: index });
      start = index;
      width = 0;
      lineBreaks = 0;
    }
    width += units;
    lineBreaks += (sentence.match(/\r\n|[\r\n]/gu) ?? []).length;
  }
  if (start < text.length) pages.push({ text: text.slice(start), start, end: text.length });
  return pages;
}

/** A boundary with no revealed character on its next page still belongs to the previous page. */
export function callCaptionPageAt(pages: readonly CallCaptionPage[], revealedOffset: number): number {
  if (!pages.length) return 0;
  const offset = Number.isNaN(revealedOffset) ? 0 : Math.max(0, Math.floor(revealedOffset));
  let first = 0, last = pages.length - 1;
  while (first < last) {
    const middle = Math.ceil((first + last) / 2);
    if (offset > pages[middle]!.start) first = middle; else last = middle - 1;
  }
  return first;
}
