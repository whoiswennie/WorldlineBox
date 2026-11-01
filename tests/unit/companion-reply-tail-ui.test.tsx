// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMessageBubble } from '../../src/renderer/companions/CompanionMessageBubble';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import type { CompanionModelUsage } from '../../src/shared/companion-model-usage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-10-31T13:20:00.000Z';
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'role', replyToId: 'source', sequence: 2, createdAt: at,
  kind: 'text', status: 'sent', content: '', attachments: [], isReplyDraft: true, segments: [], replyProgress: {
    workId: 'work', sourceMessageId: 'source', phase: 'streaming', revision: 1, detail: '正在输出回复', startedAt: at, updatedAt: at,
    timing: { elapsedMs: 0, activeSince: at } } };
const report = (step = 0): CompanionModelUsage => ({ revision: 1, current: { attemptId: '00000000-0000-4000-8000-000000000001', step,
  model: 'actual-model', providerFormat: 'openai_chat', phase: 'finished', updatedAt: '2026-10-31T13:20:01.000Z',
  estimate: { inputTokens: 1, method: 'utf8_bytes_div_3', hasUnmeteredImages: false, breakdown: { system: 1, dialogue: 0, toolDefinitions: 0, toolHistory: 0, other: 0 } } },
  totals: { requests: 1, reportedRequests: 0, complete: false } });
const frame = (patch: Partial<CompanionReplyStreamEvent> = {}): CompanionReplyStreamEvent => ({ conversationId: 'room', companionId: 'role',
  sourceMessageId: 'source', messageId: 'reply', step: 0, attemptId: 'stream_attempt', text: '真正收到的完整尾句。', phase: 'streaming', ...patch });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
async function mount(initial = message) {
  const store = new CompanionReplyStreamStore(); store.reconcile([initial]);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = (value = initial, now = Date.parse(at) + 10000) => root!.render(<CompanionMessageBubble message={value} actions={[]} now={now}
    streamStore={store} interrupted={false} onOpenAction={vi.fn()} onOpenUrl={vi.fn()} onOpenAttachment={vi.fn()} onLocateQuote={vi.fn()}
    onStreamLayout={vi.fn()} onCancelReply={vi.fn()} />);
  await act(() => render()); return { store, render };
}

it('shows the received tail, removes the typing cursor during validation and keeps the task clock/cancel control live', async () => {
  const { store, render } = await mount();
  await act(() => store.accept(frame()));
  expect(host!.querySelector('[aria-label="伙伴正在输出"]')).not.toBeNull();
  await act(() => store.accept(frame({ phase: 'usage', text: 'USAGE_TEXT_MUST_NOT_REPLACE_PROSE', modelUsage: report() })));
  expect(host!.textContent).toContain('真正收到的完整尾句。'); expect(host!.textContent).not.toContain('USAGE_TEXT');
  expect(host!.textContent).toContain('正在核验并保存回复');
  expect(host!.querySelector('[aria-label="伙伴正在输出"]')).toBeNull();
  expect(host!.querySelector('[aria-label="取消这条回复"]')).not.toBeNull();
  await act(() => (host!.querySelector('[aria-label="展开回复过程"]') as HTMLButtonElement).click());
  expect(host!.textContent).toContain('正文已接收，正在核验并保存回复');
  expect(host!.textContent).not.toContain('正在输出回复');
  await act(() => render(message, Date.parse(at) + 20000));
  expect(host!.querySelector('[data-duration-ms]')?.getAttribute('data-duration-ms')).toBe('20000');
  expect(host!.querySelector('[data-duration-state]')?.getAttribute('data-duration-state')).toBe('live');
});

it('cannot turn a finished usage report into a game draft or keep withdrawn preview text on screen', async () => {
  const pending = { ...message, replyProgress: { ...message.replyProgress!, phase: 'thinking' as const, detail: '正在生成回复' } };
  const { store, render } = await mount(pending);
  await act(() => { store.accept(frame({ text: '' })); store.accept(frame({ phase: 'usage', text: 'PRIVATE_GAME_DRAFT', modelUsage: report() })); });
  expect(host!.textContent).not.toContain('PRIVATE_GAME_DRAFT'); expect(host!.textContent).toContain('正在核验并保存回复');
  expect(host!.querySelector('[aria-label="伙伴正在输出"]')).toBeNull();
  await act(() => { store.accept(frame()); render({ ...pending, sourceUnavailable: 'execution_source_changed' }); });
  expect(host!.textContent).not.toContain('真正收到的完整尾句。'); expect(host!.textContent).toContain('资料已变化');
});

it('does not let an older step or a foreign owner stop the current live typing cursor', async () => {
  const { store } = await mount(); await act(() => store.accept(frame()));
  await act(() => store.accept(frame({ phase: 'usage', modelUsage: report(3) })));
  expect(host!.querySelector('[aria-label="伙伴正在输出"]')).not.toBeNull(); expect(host!.textContent).not.toContain('正在核验并保存回复');
  await act(() => store.accept(frame({ phase: 'usage', companionId: 'other', modelUsage: { ...report(), revision: 2 } })));
  expect(host!.querySelector('[aria-label="伙伴正在输出"]')).not.toBeNull();
});
