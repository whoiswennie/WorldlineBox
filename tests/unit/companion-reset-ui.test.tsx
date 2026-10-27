// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionResetDialog } from '../../src/renderer/companions/CompanionResetDialog';
import type { Companion, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import type { CompanionReset } from '../../src/shared/companion-reset';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';

const companion: Companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, revision: 4, createdAt: '2026-10-15T00:00:00.000Z' };
const pending: CompanionReset = { id: 'reset-one', companionId: companion.id, scope: 'all', status: 'running', phase: 'messages', processed: 500, startedAt: companion.createdAt, updatedAt: companion.createdAt };
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function mount(initialJob?: CompanionReset) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const request = vi.fn<(input: CompanionsRequest) => Promise<CompanionsResponse | undefined>>(async input => ({ ok: true, reset: input.type === 'companion.reset' ? pending : { ...pending, status: 'completed', phase: 'completed' } }));
  const onStarted = vi.fn(), onClose = vi.fn();
  await act(() => root!.render(<CompanionResetDialog companion={companion} initialJob={initialJob} request={request} onStarted={onStarted} onClose={onClose} />));
  return { request, onStarted, onClose };
}
function button(name: string) { return [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === name)!; }
async function fill(value: string) { const input = container.querySelector<HTMLInputElement>('input')!; await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
it('requires the exact visible companion name and starts a full reset with its revision', async () => {
  const f = await mount(); expect(button('确认重置').disabled).toBe(true);
  await fill('其他伙伴'); expect(button('确认重置').disabled).toBe(true); expect(f.request).not.toHaveBeenCalled();
  await fill(companion.name); expect(button('确认重置').disabled).toBe(false);
  await act(() => button('确认重置').click());
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.reset', id: companion.id, scope: 'all', expectedRevision: 4 });
  expect(f.onStarted).toHaveBeenCalledWith(companion.id); expect(container.textContent).toContain('已处理 500 项数据');
  expect(container.querySelector<HTMLInputElement>('input')).toBeNull();
});
it('resumes the view of a durable reset and reaches completion without issuing a second reset', async () => {
  vi.useFakeTimers(); const f = await mount(pending);
  expect(container.querySelector('progress')).not.toBeNull(); expect(button('后台继续')).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(260)); expect(container.textContent).toContain('重置完成');
  expect(f.request.mock.calls.every(([input]) => input.type === 'companion.reset.status')).toBe(true);
  expect(container.querySelector('progress')).toBeNull(); await act(() => button('完成').click()); expect(f.onClose).toHaveBeenCalledOnce();
});
it('shows the actual native cleanup stage without presenting its wait as zero data processed', async () => {
  vi.useFakeTimers(); await mount({ ...pending, phase: 'stopping', processed: 0, cleanupStage: 'native-records' });
  expect(container.textContent).toContain('正在清理原生任务记录');
  expect(container.textContent).toContain('完成后会自动继续');
  expect(container.textContent).not.toContain('已处理 0 项数据');
});
it('allows a failed durable job to continue and closing the panel does not cancel the job', async () => {
  const f = await mount({ ...pending, status: 'failed', error: '旧任务未停止，请重试。' });
  expect(container.textContent).toContain('旧任务未停止'); await act(() => button('继续重置').click());
  expect(f.request).toHaveBeenCalledWith({ type: 'companion.reset', id: companion.id, scope: 'all', expectedRevision: 4 });
  await act(() => button('后台继续').click()); expect(f.onClose).toHaveBeenCalledOnce();
  expect(f.request.mock.calls.some(([input]) => input.type !== 'companion.reset')).toBe(false);
});
it('does not start a reset on cancel or an IME Escape and clearly preserves other participants', async () => {
  const f = await mount(); expect(container.textContent).toContain('其他伙伴的资料和群聊发言会保留');
  await act(() => container.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(f.onClose).not.toHaveBeenCalled(); await act(() => button('取消').click()); expect(f.onClose).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled();
});
