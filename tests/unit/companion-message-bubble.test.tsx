// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import { CompanionMessageBubble } from '../../src/renderer/companions/CompanionMessageBubble';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';
import { CompanionReplyProgress } from '../../src/renderer/companions/CompanionReplyProgress';
import type { CompanionReplyProgress as Progress } from '../../src/shared/companion-reply-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('shows recovery in progress, prevents duplicate clicks and displays a failed recovery without losing retry', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  let reject!: (error: Error) => void;
  const retry = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  await act(() => root!.render(<CompanionReplyProgress scope={{ companionId: 'fish', conversationId: 'room', messageId: 'reply' }} now={0}
    progress={{ revision: 1, phase: 'cancelled', detail: '用户已停止', startedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:01Z' }} onRetry={retry} />));
  const button = container.querySelector<HTMLButtonElement>('[aria-label="重试这条回复"]')!;
  await act(() => button.click());
  expect(button.disabled).toBe(true); expect(button.textContent).toBe('正在恢复…');
  await act(() => button.click()); expect(retry).toHaveBeenCalledTimes(1);
  await act(() => reject(new Error('上次执行尚未确认停止')));
  expect(button.disabled).toBe(false); expect(container.querySelector('[role="alert"]')!.textContent).toBe('上次执行尚未确认停止');
  await act(() => root!.render(<CompanionReplyProgress scope={{ companionId: 'fish', conversationId: 'room', messageId: 'reply' }} now={0}
    progress={{ revision: 2, phase: 'tools', detail: '已恢复', startedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:02Z' }} />));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
const empty = () => ({ text: '', actionIds: [] as string[] });
it('freezes stopped execution time and resumes without including the paused hour', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const at = Date.parse('2026-10-27T00:00:00Z');
  const progress = { revision: 1, phase: 'cancelled' as const, detail: '', startedAt: new Date(at).toISOString(),
    updatedAt: new Date(at + 15000).toISOString(), timing: { elapsedMs: 15000 } };
  const render = async (value: Progress, now: number) =>
    act(() => root!.render(<CompanionReplyProgress scope={{ companionId: 'fish', conversationId: 'room', messageId: 'reply' }} progress={value} now={now} />));
  await render(progress, at + 3600000);
  expect(container.querySelector('time')!.textContent).toBe('总用时 15 秒');
  await render({ ...progress, phase: 'tools', timing: { elapsedMs: 15000, activeSince: new Date(at + 3600000).toISOString() } }, at + 3607000);
  expect(container.querySelector('time')!.textContent).toBe('总用时 22 秒');
});
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
  expect(entry.closest('.companions-message-bubble')).toBeNull();
  expect(entry.closest('.companions-loop-capabilities')!.classList.contains('is-standalone')).toBe(true);
});

it('gives each spoken step its own bubble and attaches capabilities below that exact step', async () => {
  await mount({ ...message, segments: [{ text: '我先检查一下文件。', actionIds: ['inspect'] }, { text: '', actionIds: ['convert'] }, { text: '图片已转换完成。', actionIds: [] }] });
  const bubbles = [...container!.querySelectorAll('.companions-message-bubble')];
  expect(bubbles.map(value => value.textContent)).toEqual(['我先检查一下文件。', '图片已转换完成。']);
  const first = container!.querySelector('[data-loop-step="0"]')!, toolOnly = container!.querySelector('[data-loop-step="1"]')!;
  expect(first.children[0]).toBe(bubbles[0]); expect(first.children[1]!.querySelector('[data-loop-action="inspect"]')).not.toBeNull();
  expect(toolOnly.querySelector('.companions-message-bubble')).toBeNull();
  expect(toolOnly.querySelector('[data-loop-action="convert"]')).not.toBeNull();
  expect(container!.querySelector('.companions-message-bubble [data-loop-action]')).toBeNull();
});

it('collapses live progress, hides it on completion and allows explicit inspection without reopening on newer revisions', async () => {
  const progress = { revision: 1, phase: 'tools' as const, detail: '正在检查文件', startedAt: message.createdAt, updatedAt: message.createdAt };
  const value = { ...message, segments: [{ text: '我来处理。', actionIds: ['inspect'] }], replyProgress: progress };
  await mount(value);
  expect(container!.querySelector('.companions-message-bubble')!.textContent).toBe('我来处理。');
  const card = container!.querySelector('[data-reply-stage]')!;
  expect(card.closest('.companions-message-bubble')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('[aria-label="收起回复过程"]')!.click());
  expect(container!.querySelector('[aria-label="展开回复过程"]')!.getAttribute('aria-expanded')).toBe('false');
  expect(container!.querySelector('.companions-bubble-progress-detail')).toBeNull();
  await mount({ ...value, replyProgress: { ...progress, revision: 2, phase: 'thinking' } });
  expect(container!.querySelector('[aria-label="展开回复过程"]')).not.toBeNull();
  const completed = { ...value, replyProgress: { ...progress, revision: 3, phase: 'completed' as const } };
  await mount(completed);
  expect(container!.querySelector('[data-reply-stage]')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('[aria-label="查看回复过程"]')!.click());
  expect(container!.querySelector('[data-reply-stage="completed"]')).not.toBeNull();
  await mount({ ...completed, replyProgress: { ...completed.replyProgress, revision: 4 } });
  expect(container!.querySelector('[data-reply-stage]')).toBeNull();
});

it('renders only the current cursor through sparse streaming, discarded retries, durable commits and reopening', async () => {
  const store = new CompanionReplyStreamStore(), draft = { ...message, content: '', segments: [], isReplyDraft: true };
  store.reconcile([draft]); await mount(draft, store);
  expect(container!.querySelectorAll('.companions-loop-pending')).toHaveLength(1);
  expect(container!.querySelector('.companions-message-bubble')).toBeNull();
  await act(() => store.accept(frame({ text: ' \n\n' })));
  expect(container!.querySelectorAll('[data-loop-step]')).toHaveLength(1);
  expect(container!.querySelector('[data-loop-step]')!.getAttribute('data-loop-step')).toBe('9');
  expect(container!.querySelectorAll('.companions-reply-cursor')).toHaveLength(1);
  expect(container!.querySelector('.companions-message-bubble')).toBeNull();
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

it('renders each parallel partner progress below its own stable reply thread and targets cancellation by loop work id', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const store = new CompanionReplyStreamStore(), cancel = vi.fn(), retry = vi.fn();
  const items: CompanionMessage[] = ['a', 'b', 'c'].map((id, index) => ({ ...message, id: 'reply-' + id, authorId: id,
    sequence: index + 2, content: '', segments: [], isReplyDraft: true,
    replyProgress: { workId: 'work-' + id, revision: 1, phase: 'queued', detail: '实际队列', startedAt: message.createdAt, updatedAt: message.createdAt } }));
  store.reconcile(items);
  await act(() => root!.render(<>{items.map(item => <article key={item.id} data-owner={item.authorId}><CompanionMessageBubble message={item} actions={[]} now={Date.parse(message.createdAt) + 5000} streamStore={store} interrupted={false}
    onOpenAction={vi.fn()} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()} onStreamLayout={vi.fn()} onCancelReply={cancel} onRetryReply={retry} /></article>)}</>));
  const bubbles = [...container.querySelectorAll('.companions-reply-thread')];
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
  expect([...container.querySelectorAll('.companions-reply-thread')]).toEqual(bubbles);
  expect(container.querySelector('.companions-message-bubble .companions-bubble-progress')).toBeNull();
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
  await mount({ ...message, replyProgress: { revision: 1, phase: 'thinking', detail: '正在思考', startedAt: message.createdAt, updatedAt: message.createdAt,
    memory: { status: 'completed', count: 0, injected: false, pending: true } } });
  expect(container!.textContent).toContain('记忆仍在整理 · 本轮未命中'); expect(container!.textContent).not.toContain('无相关记忆');
  await mount({ ...message, replyProgress: { revision: 2, phase: 'thinking', detail: '正在思考', startedAt: message.createdAt, updatedAt: message.createdAt,
    memory: { status: 'completed', count: 0, injected: false, pending: false } } });
  expect(container!.textContent).toContain('被动召回完成 · 无相关记忆'); expect(container!.textContent).not.toContain('仍在整理');
});
