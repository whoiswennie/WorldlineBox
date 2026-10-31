// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMessageModelUsage } from '../../src/renderer/companions/CompanionModelUsageFooter';
import { CompanionReplyStreamStore } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import type { CompanionReplyProgress } from '../../src/shared/companion-reply-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const start = Date.parse('2026-10-30T00:00:00Z');
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
const progress = (patch: Partial<CompanionReplyProgress> = {}): CompanionReplyProgress => ({
  revision: 1, workId: 'work', sourceMessageId: 'source', phase: 'context', detail: '准备上下文',
  startedAt: at(0), updatedAt: at(5), timing: { elapsedMs: 2000, activeSince: at(5) }, ...patch,
});
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'fish', replyToId: 'source',
  sequence: 2, createdAt: at(-60), kind: 'text', status: 'sent', content: '', attachments: [], isReplyDraft: true };
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; host = undefined; vi.restoreAllMocks(); });
async function mount(value: CompanionMessage, now: number, store = new CompanionReplyStreamStore()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (next = value, clock = now) => act(() => root!.render(<CompanionMessageModelUsage message={next} now={clock} streamStore={store} />));
  await render(); return { render, store };
}
const duration = () => host!.querySelector<HTMLTimeElement>('[aria-label="本条回复总处理时长"]');

it('shows live preparation time before usage exists and consumes the shared clock without installing a timer', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  const { render } = await mount({ ...message, replyProgress: progress() }, start + 10000);
  expect(duration()?.textContent).toBe('总用时 7 秒');
  expect(duration()?.dataset.durationState).toBe('live');
  expect(host!.querySelector('button')).toBeNull();
  await render({ ...message, replyProgress: progress() }, start + 15000);
  expect(duration()?.textContent).toBe('总用时 12 秒');
  expect(interval).not.toHaveBeenCalled();
});

it.each(['completed', 'cancelled', 'failed', 'interrupted'] as const)('keeps %s totals beside context/output across a reload and later clock changes', async phase => {
  const persisted: CompanionMessage = { ...message, isReplyDraft: undefined, content: '已完成的正文',
    replyProgress: progress({ phase, revision: 5, finishedAt: at(12), timing: { elapsedMs: 97000 } }),
    modelUsage: { revision: 1, current: { attemptId: 'attempt', phase: 'finished', model: 'model', providerFormat: 'openai', updatedAt: at(12),
      estimate: { inputTokens: 100, method: 'utf8_bytes_div_3', hasUnmeteredImages: false, breakdown: { system: 100, dialogue: 0, toolDefinitions: 0, toolHistory: 0, other: 0 } },
      actual: { inputTokens: 128, outputTokens: 20 } }, totals: { requests: 1, reportedRequests: 1, complete: true, inputTokens: 128, outputTokens: 20 } } };
  const { render } = await mount(JSON.parse(JSON.stringify(persisted)) as CompanionMessage, start + 86400000);
  expect(duration()?.textContent).toBe('总用时 1 分 37 秒');
  expect(duration()?.dataset.durationState).toBe('fixed');
  const row = host!.querySelector('.companion-usage-footer-row')!;
  expect(row.textContent).toContain('上下文 128'); expect(row.textContent).toContain('输出 20'); expect(row.contains(duration())).toBe(true);
  await render(persisted, start + 8640000000);
  expect(duration()?.textContent).toBe('总用时 1 分 37 秒');
});

it('uses the latest scoped progress event and does not let a late revision restart a finished timer', async () => {
  const persisted = { ...message, replyProgress: progress() };
  const store = new CompanionReplyStreamStore(); store.reconcile([persisted]);
  const { render } = await mount(persisted, start + 10000, store);
  const event = (value: CompanionReplyProgress): CompanionReplyStreamEvent => ({ phase: 'progress', progress: value,
    conversationId: 'room', companionId: 'fish', sourceMessageId: 'source', messageId: 'reply', step: 0, attemptId: 'attempt', text: '' });
  await act(() => store.accept(event(progress({ revision: 2, phase: 'memory', updatedAt: at(8), timing: { elapsedMs: 5000, activeSince: at(8) } }))));
  expect(duration()?.textContent).toBe('总用时 7 秒');
  await act(() => store.accept(event(progress({ revision: 3, phase: 'completed', finishedAt: at(15), timing: { elapsedMs: 12000 } }))));
  expect(duration()?.textContent).toBe('总用时 12 秒');
  await act(() => store.accept(event(progress({ revision: 2 }))));
  await render(persisted, start + 8640000000);
  expect(duration()?.textContent).toBe('总用时 12 秒');
  expect(duration()?.dataset.durationState).toBe('fixed');
});

it('does not infer a duration from historical timestamps or borrow one from a preceding reply', async () => {
  const { render } = await mount({ ...message, replyProgress: progress({ phase: 'completed', timing: { elapsedMs: 10000 } }) }, start + 100000);
  expect(duration()?.textContent).toBe('总用时 10 秒');
  await render({ ...message, id: 'next-reply', createdAt: at(0), replyProgress: undefined }, start + 8640000000);
  expect(duration()).toBeNull(); expect(host!.textContent).toBe('耗时未记录');
});

it.each([NaN, Infinity, -1, Number.MAX_VALUE])('does not render a corrupt persisted duration %s', elapsedMs => mount({ ...message,
  replyProgress: progress({ phase: 'completed', timing: { elapsedMs } }) }, start + 10000).then(() => {
  expect(duration()).toBeNull(); expect(host!.textContent).toBe('耗时未记录');
}));
