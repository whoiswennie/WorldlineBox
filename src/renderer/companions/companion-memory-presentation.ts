import type { CompanionMemoryDocument } from '../../shared/companion-memory-documents';

/** Friendly labels are projections; the original filename and body stay intact. */
export function memoryDocumentTitle(document: CompanionMemoryDocument): string {
  if (document.kind === 'profile') return '伙伴档案';
  if (document.kind === 'timeline') {
    const month = /(\d{4})-(\d{2})(?:\.summary)?\.(?:md|txt)$/iu.exec(document.name);
    if (month) return `${month[1]} 年 ${Number(month[2])} 月 · ${/\.summary\./iu.test(document.name) ? '月度摘要' : '生活时间线'}`;
  }
  if (document.captureMethod === 'automatic' && /^note_[a-f0-9]+\.(?:md|txt)$/iu.test(document.name)) {
    const title = [...document.title];
    return title.length > 32 ? title.slice(0, 32).join('') + '…' : document.title;
  }
  return document.title;
}

/** Render one bounded piece, including documents with a single very long line. */
export function memoryReadingEnd(content: string, offset: number, budget = 16_384): number {
  const target = Math.min(content.length, offset + budget);
  if (target === content.length) return target;
  const paragraph = content.lastIndexOf('\n\n', target - 2);
  let end = paragraph > offset + budget / 2 ? paragraph + 2 : target;
  if (end > offset && /[\uD800-\uDBFF]/u.test(content[end - 1]!) && /[\uDC00-\uDFFF]/u.test(content[end]!)) end--;
  return end;
}

export function memoryFilterDate(value: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return;
  const date = new Date(value + (end ? 'T23:59:59.999' : 'T00:00:00.000'));
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
