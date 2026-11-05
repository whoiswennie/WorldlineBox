export interface CallCaptionPage { text: string; start: number; end: number }

const MIN_CAPTION_UNITS = 8;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;
const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff01-\uff60]/u;

function units(grapheme: string): number {
  return emoji.test(grapheme) ? 1.2 : wide.test(grapheme) ? 1 : .5;
}

function breakPreference(text: string, start: number, end: number, grapheme: string): number {
  if (/[\r\n]/u.test(grapheme)) return 5;
  const tailStart = Math.max(start, end - 16), tail = text.slice(tailStart, end).trimEnd();
  const sentence = /([.!?。！？…])["'”’」』）》】]*$/u.exec(tail);
  if (sentence) {
    const punctuation = tailStart + sentence.index;
    const decimal = sentence[1] === '.' && /[0-9]/u.test(text[punctuation - 1] ?? '') && /[0-9]/u.test(text[punctuation + 1] ?? '');
    if (!decimal) return 4;
  }
  if (/[，、,;；:：]["'”’」』）》】]*$/u.test(tail)) return 3;
  return /\s$/u.test(grapheme) ? 2 : 0;
}

/** Split stable complete text; joining pages preserves every source character and space. */
export function buildCallCaptionPages(text: string, maxUnits: number): CallCaptionPage[] {
  if (!text) return [];
  const capacity = Number.isFinite(maxUnits) ? Math.max(MIN_CAPTION_UNITS, maxUnits) : MIN_CAPTION_UNITS;
  const graphemes = [...segmenter.segment(text)].map(({ segment, index }) => ({ text: segment, start: index, end: index + segment.length, units: units(segment) }));
  const pages: CallCaptionPage[] = [];
  let cursor = 0;
  while (cursor < graphemes.length) {
    let end = cursor, consumed = 0;
    while (end < graphemes.length && consumed + graphemes[end]!.units <= capacity) consumed += graphemes[end++]!.units;
    if (end === cursor) end++;
    if (end < graphemes.length) {
      let position = 0, preferred = end, preference = 0;
      for (let index = cursor; index < end; index++) {
        const grapheme = graphemes[index]!; position += grapheme.units;
        if (position < capacity * .6) continue;
        const rank = breakPreference(text, graphemes[cursor]!.start, grapheme.end, grapheme.text);
        if (rank && rank >= preference) { preference = rank; preferred = index + 1; }
      }
      end = preferred;
    }
    const start = graphemes[cursor]!.start, finish = graphemes[end - 1]!.end;
    pages.push({ text: text.slice(start, finish), start, end: finish }); cursor = end;
  }
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
