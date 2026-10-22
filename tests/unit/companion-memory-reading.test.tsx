// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionMemoryDocument, CompanionMemoryDocumentRead } from '../../src/shared/companion-memory-documents';
import { MemoryDocumentProcessing, MemoryDocumentTimes, MemoryReading } from '../../src/renderer/companions/CompanionMemoryReading';
import { memoryDocumentTitle, memoryFilterDate, memoryReadingEnd } from '../../src/renderer/companions/companion-memory-presentation';

vi.mock('../../src/renderer/companions/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div data-reading-body>{content}</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; });
async function mount(content: React.ReactNode) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(() => root!.render(content)); }
const doc: CompanionMemoryDocument = { path: '日记/note_abc.md', name: 'note_abc.md', directory: '日记', title: '原始日记', kind: 'note', category: 'diary', createdAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-22T02:00:00Z', occurredAt: '2026-10-16T03:00:00Z', bytes: 20, revision: 'r1', contentHash: 'a'.repeat(64), readOnly: false, tags: [], syncState: 'pending', captureMethod: 'automatic' };

it('uses friendly monthly titles without changing the original internal path or manual title', () => {
  const timeline = { ...doc, kind: 'timeline' as const, name: 'VCP-world_pair_a91cd2b4fac7671790337488-2026-10.summary.md' };
  expect(memoryDocumentTitle(timeline)).toBe('2026 年 10 月 · 月度摘要');
  expect(timeline.name).toContain('world_pair_');
  const long = { ...doc, title: '这是一个非常长的自动日记首句'.repeat(10) };
  expect([...memoryDocumentTitle(long)]).toHaveLength(33);
  expect(memoryDocumentTitle({ ...long, captureMethod: 'manual' })).toBe(long.title);
});

it('renders only one bounded part of a long document and preserves every original character across reading pages', async () => {
  const content = ('一段很长的中文资料。\n\n' + '文'.repeat(15_999) + '😀').repeat(6);
  const onPageChange = vi.fn(); await mount(<MemoryReading content={content} onPageChange={onPageChange} />);
  const parts: string[] = [];
  for (;;) {
    const body = node!.querySelector('[data-reading-body]')!.textContent!; parts.push(body);
    expect(body.length).toBeLessThanOrEqual(16_384);
    expect(body).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    const next = [...node!.querySelectorAll('button')].find(button => button.textContent?.includes('下一段'));
    if (!next || next.disabled) break;
    await act(() => next.click());
  }
  expect(parts.join('')).toBe(content);
  expect(onPageChange.mock.calls.length).toBe(parts.length - 1);
  const previous = [...node!.querySelectorAll('button')].find(button => button.textContent?.includes('上一段'))!;
  await act(() => previous.click());
  expect(node!.querySelector('[data-reading-body]')!.textContent).toBe(parts.at(-2));
});

it('keeps even a huge single line bounded and never splits a surrogate pair', () => {
  const content = '文'.repeat(16_383) + '😀' + '字'.repeat(50_000);
  const end = memoryReadingEnd(content, 0);
  expect(end).toBe(16_383); expect(content.slice(end, end + 2)).toBe('😀');
});

it('shows creation, modification and experience dates as distinct facts', async () => {
  await mount(<MemoryDocumentTimes read={{ document: doc, content: '原文', sources: [], hasMoreSources: false }} />);
  const times = [...node!.querySelectorAll('time')].map(time => time.dateTime);
  expect(times).toEqual([doc.createdAt, doc.updatedAt, doc.occurredAt]);
  expect(node!.textContent).toContain('创建'); expect(node!.textContent).toContain('修改'); expect(node!.textContent).toContain('经历');
});

it('distinguishes saved text from indexed memory, and never labels an unfinished document as learned', async () => {
  const read: CompanionMemoryDocumentRead = { document: doc, content: '原文', sources: [], hasMoreSources: false };
  await mount(<MemoryDocumentProcessing read={read} onOpen={vi.fn()} />);
  expect(node!.textContent).toContain('正文已保存'); expect(node!.textContent).toContain('记忆索引待处理'); expect(node!.textContent).not.toContain('已学会');
  await act(() => root!.render(<MemoryDocumentProcessing read={{ ...read, document: { ...doc, syncState: 'indexed' } }} onOpen={vi.fn()} />));
  expect(node!.textContent).toContain('相关话题下可参与召回');
});

it('maps a date interval to local day boundaries without inventing invalid dates', () => {
  const start = new Date(memoryFilterDate('2026-10-22', false)!); const end = new Date(memoryFilterDate('2026-10-22', true)!);
  expect(start.getHours()).toBe(0); expect(end.getHours()).toBe(23); expect(end.getMilliseconds()).toBe(999);
  expect(memoryFilterDate('', false)).toBeUndefined();
});
