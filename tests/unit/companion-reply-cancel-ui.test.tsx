// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionReplyProgress } from '../../src/renderer/companions/CompanionReplyProgress';
import type { CompanionReplyProgress as Progress } from '../../src/shared/companion-reply-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.restoreAllMocks(); });
const at = '2026-10-30T01:50:00.000Z';
const progress: Progress = { workId: 'exact-work', sourceMessageId: 'original-message', revision: 1, phase: 'context',
  detail: '正在整理本轮上下文', startedAt: at, updatedAt: at };
async function render(onCancel: () => Promise<unknown>, current = progress) {
  if (!root) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); }
  await act(() => root!.render(<CompanionReplyProgress initialBubble progress={current} now={Date.parse(at)}
    scope={{ companionId: 'alice', conversationId: 'private-alice', messageId: 'reply-bubble' }} onCancel={onCancel} />));
}
const cancelButton = () => node!.querySelector<HTMLButtonElement>('[aria-label="取消这条回复"]')!;

it('shows a pending stop immediately, sends once, and waits for the actual terminal receipt after acknowledgement', async () => {
  let acknowledge!: () => void;
  const onCancel = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  await render(onCancel);
  const button = cancelButton();
  await act(() => { button.click(); button.click(); });
  expect(onCancel).toHaveBeenCalledOnce(); expect(cancelButton().disabled).toBe(true);
  expect(node!.querySelector('[aria-label="本条回复进度"]')?.textContent).toContain('正在停止…');
  expect(node!.textContent).not.toContain('已取消');
  await act(() => acknowledge());
  expect(cancelButton().disabled).toBe(true);
  await render(onCancel, { ...progress, revision: 2, phase: 'cancelled', detail: '用户已停止这次回复', finishedAt: at });
  expect(cancelButton()).toBeNull(); expect(node!.textContent).toContain('已取消');
  expect(node!.textContent).not.toContain('正在停止…');
});

it('shows a failed stop acknowledgement and permits retry without changing the real task phase', async () => {
  const onCancel = vi.fn().mockRejectedValueOnce(new Error('停止请求暂时不可用')).mockResolvedValueOnce(undefined);
  await render(onCancel);
  await act(() => cancelButton().click());
  expect(node!.querySelector('[role="alert"]')?.textContent).toBe('停止请求暂时不可用');
  expect(cancelButton().disabled).toBe(false);
  expect(node!.querySelector('[data-reply-stage]')?.getAttribute('data-reply-stage')).toBe('context');
  await act(() => cancelButton().click());
  expect(onCancel).toHaveBeenCalledTimes(2); expect(cancelButton().disabled).toBe(true);
  expect(node!.querySelector('[role="alert"]')).toBeNull();
});
