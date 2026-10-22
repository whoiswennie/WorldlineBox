// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import { CompanionMessageBubble } from '../../src/renderer/companions/CompanionMessageBubble';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
const empty = () => ({ text: '', actionIds: [] as string[] });
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'fish', sequence: 2, createdAt: '2026-10-21T05:32:00Z', kind: 'text', status: 'sent', content: '往门口走。\n\n到门口了。', attachments: [], replyToId: 'source' };
async function mount(value: CompanionMessage, streamStore = new CompanionReplyStreamStore()) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  const onOpenAction = vi.fn();
  await act(() => root!.render(<CompanionMessageBubble message={value} actions={[]} now={0} streamStore={streamStore} interrupted={false}
    onOpenAction={onOpenAction} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()} onStreamLayout={vi.fn()} />));
  return onOpenAction;
}
function frame(patch: Partial<CompanionReplyStreamEvent> = {}): CompanionReplyStreamEvent {
  return { conversationId: 'room', companionId: 'fish', sourceMessageId: 'source', messageId: 'reply', step: 9, attemptId: 'attempt', text: '', phase: 'streaming', ...patch };
}

it('omits six empty native tool turns and middle whitespace turns from a saved reply without reindexing visible steps', async () => {
  await mount({ ...message, segments: [...Array.from({ length: 6 }, empty), { text: '往门口走。', actionIds: [] }, empty(), { text: ' \t\r\n\n', actionIds: [] }, { text: '到门口了。', actionIds: [] }] });
  expect([...container!.querySelectorAll('[data-loop-step]')].map(element => element.getAttribute('data-loop-step'))).toEqual(['6', '9']);
  expect([...container!.querySelectorAll('.companions-message-content')].map(element => element.textContent)).toEqual(['往门口走。', '到门口了。']);
  expect(container!.querySelector('.companions-loop-pending, .companions-reply-cursor')).toBeNull();
});

it('keeps an actual capability entry even when that turn has no text', async () => {
  const open = await mount({ ...message, segments: [empty(), { text: ' \n', actionIds: ['tool-actual'] }, { text: '    const aligned = true;\n', actionIds: [] }] });
  const entry = container!.querySelector<HTMLButtonElement>('[data-loop-action="tool-actual"]')!;
  expect(entry.closest('[data-loop-step]')!.getAttribute('data-loop-step')).toBe('1');
  expect(container!.querySelector('[aria-label="第 2 步能力调用"]')).not.toBeNull();
  await act(() => entry.click()); expect(open).toHaveBeenCalledExactlyOnceWith('tool-actual');
  // Visibility checks must not trim Markdown indentation or change the raw text.
  expect(container!.querySelector('pre code')!.textContent).toBe('const aligned = true;');
});

it('renders only the current cursor through sparse streaming, discarded retries, durable commits and reopening', async () => {
  const store = new CompanionReplyStreamStore(), draft = { ...message, content: '', segments: [], isReplyDraft: true };
  store.reconcile([draft]); await mount(draft, store);
  expect(container!.querySelectorAll('.companions-loop-pending')).toHaveLength(1);
  await act(() => store.accept(frame({ text: ' \n\n' })));
  expect(container!.querySelectorAll('[data-loop-step]')).toHaveLength(1);
  expect(container!.querySelector('[data-loop-step]')!.getAttribute('data-loop-step')).toBe('9');
  expect(container!.querySelectorAll('.companions-reply-cursor')).toHaveLength(1);
  expect(container!.querySelector('.companions-loop-pending, .companions-message-content')).toBeNull();
  await act(() => store.accept(frame({ text: '正在走向门口。' })));
  expect(container!.textContent).toBe('正在走向门口。');
  await act(() => store.accept(frame({ phase: 'discarded' })));
  expect(container!.querySelector('[data-loop-step]')).toBeNull();
  await act(() => store.accept(frame({ attemptId: 'retry', text: '已经到门口。' })));
  expect(container!.querySelector('[data-loop-step="9"]')!.textContent).toBe('已经到门口。');
  const saved = { ...message, content: '已经到门口。', segments: [...Array.from({ length: 9 }, empty), { text: '已经到门口。', actionIds: [] }] };
  await act(() => store.reconcile([saved])); await mount(saved, store);
  expect(container!.querySelectorAll('[data-loop-step]')).toHaveLength(1);
  expect(container!.querySelector('.companions-reply-cursor')).toBeNull();
  await mount(saved); expect(container!.querySelectorAll('[data-loop-step]')).toHaveLength(1);
});

it('renders each parallel partner progress inside its own stable bubble and targets cancellation by loop work id', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const store = new CompanionReplyStreamStore(), cancel = vi.fn(), retry = vi.fn();
  const items: CompanionMessage[] = ['a', 'b', 'c'].map((id, index) => ({ ...message, id: 'reply-' + id, authorId: id,
    sequence: index + 2, content: '', segments: [], isReplyDraft: true,
    replyProgress: { workId: 'work-' + id, revision: 1, phase: 'queued', detail: '实际队列', startedAt: message.createdAt, updatedAt: message.createdAt } }));
  store.reconcile(items);
  await act(() => root!.render(<>{items.map(item => <article key={item.id} data-owner={item.authorId}><CompanionMessageBubble message={item} actions={[]} now={Date.parse(message.createdAt) + 5000} streamStore={store} interrupted={false}
    onOpenAction={vi.fn()} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()} onStreamLayout={vi.fn()} onCancelReply={cancel} onRetryReply={retry} /></article>)}</>));
  const bubbles = [...container.querySelectorAll('.companions-message-bubble')];
  await act(() => {
    for (const [index, phase] of ['tools', 'streaming', 'waiting'].entries()) store.accept(frame({ messageId: items[index]!.id, companionId: items[index]!.authorId,
      phase: 'progress', progress: { ...items[index]!.replyProgress!, revision: 2, phase: phase as 'tools' | 'streaming' | 'waiting', detail: ['正在执行 read_file', '正在输出回复', '正在完成先前活动'][index]!, ...(index === 1 ? { memory: { status: 'completed', injected: true, count: 2 } } : {}) } }));
    store.accept(frame({ messageId: 'reply-b', companionId: 'b', text: '只有乙的正文增量' }));
  });
  expect([...container.querySelectorAll('[data-reply-stage]')].map(node => node.getAttribute('data-reply-stage'))).toEqual(['tools', 'streaming', 'waiting']);
  expect(bubbles[0]!.textContent).toContain('read_file'); expect(bubbles[0]!.textContent).not.toContain('只有乙');
  expect(bubbles[1]!.textContent).toContain('只有乙的正文增量'); expect(bubbles[1]!.textContent).toContain('已注入话题相关的记忆上下文');
  expect(bubbles[1]!.textContent).not.toContain('2 条');
  expect(bubbles[1]!.querySelector('.companions-bubble-progress-detail')).toBeNull();
  expect(bubbles[2]!.textContent).toContain('正在完成先前活动');
  await act(() => container!.querySelector<HTMLButtonElement>('[data-owner="c"] [aria-label="取消这条回复"]')!.click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('work-c');
  await act(() => store.accept(frame({ messageId: 'reply-c', companionId: 'c', phase: 'progress', progress: { ...items[2]!.replyProgress!, revision: 3, phase: 'cancelled', detail: '这次回复已取消' } })));
  expect(container.querySelector('[data-owner="c"] [data-reply-stage="cancelled"]')).not.toBeNull();
  expect(container.querySelector('[data-owner="b"] [data-reply-stage="streaming"]')).not.toBeNull();
  expect([...container.querySelectorAll('.companions-message-bubble')]).toEqual(bubbles);
  await act(() => container!.querySelector<HTMLButtonElement>('[data-owner="c"] [aria-label="重试这条回复"]')!.click());
  expect(retry).toHaveBeenCalledExactlyOnceWith('work-c');
  expect(container.querySelector('.companions-reply-progress, .companions-typing')).toBeNull();
});

it('distinguishes native candidates from the focused context and keeps guide on its own queued bubble', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const guide = vi.fn(), cancel = vi.fn();
  const queued: CompanionMessage = { ...message, content: '', segments: [], isReplyDraft: true,
    replyProgress: { workId: 'queued-work', sourceMessageId: 'queued-source', revision: 1, phase: 'queued', detail: '已加入回复队列',
      startedAt: message.createdAt, updatedAt: message.createdAt, memory: { status: 'completed', count: 3, injected: false } } };
  await act(() => root!.render(<CompanionMessageBubble message={queued} actions={[]} now={0} streamStore={new CompanionReplyStreamStore()} interrupted={false}
    onOpenAction={vi.fn()} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()} onStreamLayout={vi.fn()} onCancelReply={cancel} onGuideReply={guide} />));
  expect(container.textContent).toContain('已筛选 3 条候选 · 未纳入话题上下文'); expect(container.textContent).not.toContain('已注入');
  expect(container.querySelector('.companions-bubble-progress-detail')).toBeNull();
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
  await act(() => buttons.find(button => button.textContent === '立即引导')!.click());
  expect(guide).toHaveBeenCalledExactlyOnceWith('queued-source');
  await act(() => buttons.find(button => button.getAttribute('aria-label') === '取消这条回复')!.click());
  expect(cancel).toHaveBeenCalledExactlyOnceWith('queued-work');
});

it('distinguishes unfinished memory capture from an empty settled corpus', async () => {
  await mount({ ...message, replyProgress: { revision: 1, phase: 'completed', detail: '回复已完成', startedAt: message.createdAt, updatedAt: message.createdAt,
    memory: { status: 'completed', count: 0, injected: false, pending: true } } });
  expect(container!.textContent).toContain('记忆仍在整理 · 本轮未命中'); expect(container!.textContent).not.toContain('无相关记忆');
  await mount({ ...message, replyProgress: { revision: 2, phase: 'completed', detail: '回复已完成', startedAt: message.createdAt, updatedAt: message.createdAt,
    memory: { status: 'completed', count: 0, injected: false, pending: false } } });
  expect(container!.textContent).toContain('被动召回完成 · 无相关记忆'); expect(container!.textContent).not.toContain('仍在整理');
});
