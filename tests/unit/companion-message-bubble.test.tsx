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
