// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { CompanionMessageModelUsage } from '../../src/renderer/companions/CompanionModelUsageFooter';
import { CompanionReplyStreamStore, projectCompanionModelUsage, projectCompanionReply } from '../../src/renderer/companions/reply-stream';
import type { CompanionMessage, CompanionReplyStreamEvent } from '../../src/shared/companions';
import type { CompanionModelUsage } from '../../src/shared/companion-model-usage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const message: CompanionMessage = { id: 'reply', conversationId: 'room', authorId: 'role', replyToId: 'source', sequence: 2, createdAt: '2026-10-29T00:00:00Z', kind: 'text', status: 'sent', content: '真实正文', attachments: [], isReplyDraft: true, segments: [{ text: '真实正文', actionIds: ['tool'] }] };
const estimate = { inputTokens: 1200, method: 'utf8_bytes_div_3' as const, hasUnmeteredImages: true, breakdown: { system: 400, dialogue: 300, toolDefinitions: 300, toolHistory: 200, other: 0 } };
function usage(revision = 1, patch: Partial<CompanionModelUsage['current']> = {}): CompanionModelUsage {
  return { revision, current: { attemptId: 'attempt-a', model: 'actual-model', providerFormat: 'openai', phase: 'prepared', updatedAt: '2026-10-29T00:00:00Z', estimate, ...patch }, totals: { requests: 0, reportedRequests: 0, complete: true } };
}
function event(modelUsage: CompanionModelUsage, patch: Partial<CompanionReplyStreamEvent> = {}): CompanionReplyStreamEvent {
  return { phase: 'usage', conversationId: 'room', companionId: 'role', sourceMessageId: 'source', messageId: 'reply', step: 0, attemptId: modelUsage.current.attemptId, text: '', modelUsage, ...patch };
}
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
async function mount(messages: CompanionMessage[], store = new CompanionReplyStreamStore()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = (items = messages) => root!.render(<>{items.map(item => <CompanionMessageModelUsage key={item.id} message={item} companionName="小肥鱼" streamStore={store} now={Date.parse('2026-10-29T00:00:00Z')} />)}</>);
  await act(() => render()); return { store, render };
}

it('separates estimated request input from unknown provider usage and never invents a context percentage', async () => {
  await mount([{ ...message, modelUsage: usage() }]);
  expect(host!.textContent).toContain('上下文约 1.2K'); expect(host!.textContent).not.toContain('%');
  await act(() => host!.querySelector<HTMLButtonElement>('button')!.click());
  const dialog = host!.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('1,200 估算 token');
  expect(dialog.textContent).toContain('模型未提供上下文上限');
  expect(dialog.textContent).toContain('图片未计入本地估算');
  expect(dialog.querySelector('dl')!.textContent).toContain('输入未返回');
  expect(dialog.textContent).toContain('仅包含这条回复的主脑调用，DSH 与辅助模型另计');
});

it('updates real usage without replacing reply text, accepts same-time retry revisions and rejects late or cross-owner reports', async () => {
  const store = new CompanionReplyStreamStore(); store.reconcile([message]);
  const { render } = await mount([message], store);
  expect(host!.textContent).toBe('耗时未记录');
  const measured = usage(2, { phase: 'finished', actual: { inputTokens: 2000, outputTokens: 80, totalTokens: 2080, cacheReadTokens: 500 }, contextLimit: 8000 });
  await act(() => store.accept(event(measured)));
  expect(host!.textContent).toContain('上下文 2K / 8K'); expect(host!.textContent).toContain('25.0%'); expect(host!.textContent).toContain('输出 80');
  expect(store.snapshot('reply').overlays).toHaveLength(0); expect(projectCompanionReply(message, store.snapshot('reply')).segments).toEqual(message.segments);
  await act(() => store.accept(event(usage(1))));
  await act(() => store.accept(event(usage(20), { companionId: 'other' })));
  expect(projectCompanionModelUsage(message, store.snapshot('reply'))?.revision).toBe(2);
  const retry = usage(3, { attemptId: 'attempt-b', phase: 'prepared', estimate: { ...estimate, inputTokens: 1600 } });
  await act(() => store.accept(event(retry)));
  expect(host!.textContent).toContain('上下文约 1.6K'); expect(host!.textContent).not.toContain('输出 80');
  await act(() => store.reconcile([{ ...message, modelUsage: measured }]));
  expect(projectCompanionModelUsage(message, store.snapshot('reply'))?.revision).toBe(3);
  await act(() => render([{ ...message, id: 'other-reply', conversationId: 'other-room' }]));
  expect(host!.textContent).toBe('耗时未记录'); expect(host!.querySelector('button')).toBeNull();
});

it('attaches independent persisted counters to each reply and never inherits an earlier reply while waiting for a new request', async () => {
  const persisted = { ...message, modelUsage: usage(4, { phase: 'finished', actual: { inputTokens: 128, outputTokens: 0 } }) };
  const unrelated = [{ ...persisted, id: 'user', authorId: 'user', sequence: 9 }, { ...persisted, id: 'system', authorId: 'system', sequence: 10 }, { ...persisted, id: 'background', audience: 'agenda' as const, sequence: 11 }, { ...persisted, id: 'withdrawn', sourceUnavailable: 'execution_source_changed' as const, sequence: 12 }];
  const second = { ...persisted, id: 'reply-two', sequence: 13, topicId: 'elsewhere', modelUsage: usage(1, { actual: { inputTokens: 256 } }) };
  const { render } = await mount([persisted, second, ...unrelated]);
  expect([...host!.querySelectorAll('[data-message-model-usage]')].map(element => element.getAttribute('data-message-model-usage'))).toEqual(['reply', 'reply-two']);
  expect(host!.textContent).toContain('上下文 128'); expect(host!.textContent).toContain('输出 0');
  expect(host!.textContent).toContain('上下文 256');
  await act(() => host!.querySelector<HTMLButtonElement>('button')!.click()); expect(host!.querySelector('[role="dialog"]')).not.toBeNull();
  await act(() => render([{ ...message, id: 'new-reply', sequence: 14, content: '', modelUsage: undefined }]));
  expect(host!.querySelector('[role="dialog"]')).toBeNull(); expect(host!.textContent).toBe('耗时未记录');
  expect(projectCompanionModelUsage({ ...persisted, sourceUnavailable: 'execution_source_changed' }, new CompanionReplyStreamStore().snapshot('reply'))).toBeUndefined();
});
