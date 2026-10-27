// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { CompanionReplyProgress } from '../../src/renderer/companions/CompanionReplyProgress';
import { companionTaskDuration } from '../../src/renderer/companions/task-duration';
import type { CompanionReplyProgress as Progress } from '../../src/shared/companion-reply-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; });
const at = '2026-10-26T04:00:00Z', scope = { companionId: 'fish', conversationId: 'private-fish', messageId: 'reply' };
const progress = (patch: Partial<Progress> = {}): Progress => ({ revision: 1, startedAt: at, updatedAt: at, phase: 'memory', phaseStartedAt: '2026-10-26T04:01:00Z', detail: '正在召回记忆', timing: { elapsedMs: 0, activeSince: at }, ...patch });
async function render(value: Progress, now: string) { if (!node) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); } await act(async () => root!.render(<CompanionReplyProgress revealCompleted scope={scope} progress={value} now={Date.parse(now)} />)); }

it('accumulates admitted execution without resetting its clock on each preparation stage', async () => {
  await render(progress(), '2026-10-26T04:02:00Z');
  expect(node!.querySelector('time')?.textContent).toBe('总用时 2 分 00 秒');
  expect(node!.querySelector('time')?.title).toContain('当前阶段 1 分 00 秒');
  expect(node!.querySelector('time')?.title).toContain('不含排队、中断');
  await render(progress({ phase: 'tools', phaseStartedAt: '2026-10-26T04:02:00Z' }), '2026-10-26T04:02:05Z');
  expect(node!.querySelector('time')?.textContent).toBe('总用时 2 分 05 秒');
});

it.each(['completed', 'failed', 'cancelled'] as const)('preserves finished total duration for %s across later rerenders', async phase => {
  const value = progress({ phase, finishedAt: '2026-10-26T04:02:03Z', updatedAt: '2026-10-26T05:00:00Z', timing: { elapsedMs: 123000 } });
  await render(value, '2026-10-26T06:00:00Z'); expect(node!.querySelector('time')?.textContent).toBe('总用时 2 分 03 秒');
  await render(value, '2026-10-27T06:00:00Z'); expect(node!.querySelector('time')?.textContent).toBe('总用时 2 分 03 秒');
});

it('does not infer an execution duration from old message timestamps when timing was not recorded', async () => {
  await render(progress({ phase: 'completed', timing: undefined, updatedAt: '2026-10-26T04:03:00Z' }), '2026-10-26T09:00:00Z');
  expect(node!.querySelector('time')).toBeNull(); expect(node!.textContent).toContain('耗时未记录');
  expect(companionTaskDuration(undefined, at)).toBeUndefined(); expect(companionTaskDuration(at, 'invalid')).toBeUndefined();
});

it('labels explicit user cancellation as user stopped, and preserves elapsed seconds beyond an hour', async () => {
  await render(progress({ phase: 'cancelled', timing: { elapsedMs: 3723000 }, finishedAt: '2026-10-26T05:02:03Z', stop: { actor: 'user', reason: 'user_requested', requestedAt: '2026-10-26T05:02:03Z' } }), '2026-10-27T09:00:00Z');
  expect(node!.textContent).toContain('用户已停止'); expect(node!.textContent).not.toContain('回复失败');
  expect(node!.querySelector('time')?.textContent).toBe('总用时 1 小时 2 分 03 秒');
});
