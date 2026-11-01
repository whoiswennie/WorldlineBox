// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMessageBubble } from '../../src/renderer/companions/CompanionMessageBubble';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import type { CompanionReplyProgress } from '../../src/shared/companion-reply-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-01T00:00:00.000Z';
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'alice', replyToId: 'source', sequence: 2, createdAt: at,
  content: '', kind: 'text', status: 'sent', attachments: [], isReplyDraft: true, segments: [], replyProgress: {
    workId: 'actual-work', sourceMessageId: 'source', revision: 1, phase: 'context', detail: '正在整理本轮上下文', startedAt: at, updatedAt: at } };
const frame = (patch: Partial<CompanionReplyStreamEvent> = {}): CompanionReplyStreamEvent => ({ conversationId: 'room', companionId: 'alice',
  sourceMessageId: 'source', messageId: 'reply', attemptId: 'actual-attempt', step: 0, phase: 'streaming', text: '已经实际收到的普通正文。', ...patch });
const progress = (revision: number, phase: CompanionReplyProgress['phase']) => frame({ phase: 'progress', text: '', progress: {
  ...message.replyProgress!, revision, phase, detail: phase, ...(phase === 'cancelled' ? { finishedAt: at } : {}) } });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
type Cancel = (workId: string) => Promise<unknown>;
async function mount(onCancel: Cancel) {
  const store = new CompanionReplyStreamStore(); store.reconcile([message]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<CompanionMessageBubble message={message} actions={[]} now={Date.parse(at)} streamStore={store} interrupted={false}
    onCancelReply={onCancel} onOpenAction={vi.fn()} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()} onStreamLayout={vi.fn()} />));
  return store;
}
const cancelButton = () => host!.querySelector<HTMLButtonElement>('[aria-label="取消这条回复"]');
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}

it('retains the same focused cancel button across stage revisions and the first actual reply body', async () => {
  const store = await mount(vi.fn<Cancel>().mockResolvedValue(undefined));
  const button = cancelButton()!; button.focus();
  expect(host!.querySelector('[data-reply-placeholder]')).not.toBeNull();
  await act(() => store.accept(progress(2, 'memory')));
  expect(cancelButton()).toBe(button); expect(document.activeElement).toBe(button);
  await act(() => { store.accept(progress(3, 'streaming')); store.accept(frame()); });
  expect(host!.querySelector('[data-reply-placeholder]')).toBeNull();
  expect(host!.textContent).toContain('已经实际收到的普通正文。');
  expect(cancelButton()).toBe(button); expect(document.activeElement).toBe(button);
});

it('keeps one pending stop through the first body and acknowledgement, until the real terminal receipt', async () => {
  const held = deferred(), onCancel = vi.fn<Cancel>(() => held.promise), store = await mount(onCancel);
  const button = cancelButton()!;
  await act(() => { button.click(); button.click(); });
  expect(onCancel).toHaveBeenCalledExactlyOnceWith('actual-work'); expect(button.disabled).toBe(true);
  await act(() => { store.accept(progress(2, 'memory')); store.accept(frame()); store.accept(progress(3, 'streaming')); });
  expect(cancelButton()).toBe(button); expect(button.disabled).toBe(true);
  expect(host!.textContent).toContain('正在停止…');
  await act(() => held.resolve());
  expect(cancelButton()).toBe(button); expect(button.disabled).toBe(true);
  await act(() => button.click()); expect(onCancel).toHaveBeenCalledOnce();
  await act(() => store.accept(progress(4, 'cancelled')));
  expect(cancelButton()).toBeNull(); expect(host!.textContent).toContain('已取消');
  expect(host!.textContent).toContain('已经实际收到的普通正文。');
});

it('retains a rejected stop across the first body and permits one retry for that same work', async () => {
  const held = deferred(), onCancel = vi.fn<Cancel>().mockImplementationOnce(() => held.promise).mockResolvedValueOnce(undefined);
  const store = await mount(onCancel), button = cancelButton()!;
  await act(() => button.click());
  await act(() => { store.accept(frame()); store.accept(progress(2, 'streaming')); });
  await act(() => held.reject(new Error('停止请求暂时不可用')));
  expect(cancelButton()).toBe(button); expect(button.disabled).toBe(false);
  expect(host!.querySelector('[role="alert"]')?.textContent).toBe('停止请求暂时不可用');
  await act(() => button.click());
  expect(onCancel).toHaveBeenCalledTimes(2); expect(onCancel.mock.calls.map(args => args[0])).toEqual(['actual-work', 'actual-work']);
  expect(button.disabled).toBe(true); expect(host!.querySelector('[role="alert"]')).toBeNull();
  await act(() => store.accept(progress(3, 'cancelled'))); expect(cancelButton()).toBeNull();
});
