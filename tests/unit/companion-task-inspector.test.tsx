// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionTaskInspector } from '../../src/renderer/companions/CompanionTaskInspector';
import type { CompanionTaskItem } from '../../src/shared/companion-task-overview';
import type { CompanionTaskDetail, CompanionTaskRecord } from '../../src/shared/companion-task-detail';
import type { CompanionRequest } from '../../src/renderer/companions/CompanionDialogs';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.useRealTimers(); });
const task: CompanionTaskItem = { id: 'report_one', kind: 'action', companionId: 'fish', title: '核对报告', status: 'completed', rawStatus: 'succeeded', stage: '核对完成', updatedAt: '2026-10-26T09:00:00Z', canStop: false, stoppedByUser: false };
const record: CompanionTaskRecord = { id: 'result', title: '执行结果', text: '### 核对结果\n\n**通过**\n\n- 已核对收入\n- 已核对支出', totalCharacters: 40, provenance: 'host' };
const detail = (items = [record], patch: Partial<CompanionTaskDetail> = {}): CompanionTaskDetail => ({ task, purpose: '核对报告中的收入和支出。', companionName: '小肥鱼', section: 'input', items, total: items.length, offset: 0, hasMore: false, observedAt: task.updatedAt, ...patch });
async function mount(request: CompanionRequest, patch: Partial<Parameters<typeof CompanionTaskInspector>[0]> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionTaskInspector task={task} request={request} {...patch} />));
}
async function click(label: string) { await act(async () => { const button = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.includes(label)); if (!button) throw Error('Missing ' + label); button.click(); }); }

it('renders readable report headings and lists instead of raw Markdown, and reads only the selected section', async () => {
  const request = vi.fn<CompanionRequest>(async command => ({ ok: true, taskDetail: detail([record], { section: command.type === 'task.inspect' ? command.section : 'input' }) }));
  await mount(request); expect(node!.querySelector('h3')?.textContent).toBe('核对结果'); expect(node!.querySelector('strong')?.textContent).toBe('通过'); expect(node!.querySelectorAll('li')).toHaveLength(2);
  await click('任务输入'); expect(node!.querySelector('h3')?.textContent).toBe('核对结果');
  expect(request).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.inspect', section: 'input', limit: 12 }));
  await click('任务结果'); expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'task.inspect', section: 'output', offset: 0 }));
});

it('loads large content in fixed pages and replaces each chunk instead of growing the DOM', async () => {
  const long = { ...record, text: '来源内容'.repeat(1000), totalCharacters: 60000 };
  const request = vi.fn<CompanionRequest>(async command => command.type === 'task.content'
    ? { ok: true, taskContent: { ...long, text: `第${command.offset ?? 0}段 ` + '材料'.repeat(2900), offset: command.offset ?? 0, hasMore: true } }
    : { ok: true, taskDetail: detail([long]) });
  await mount(request); expect(node!.textContent!.length).toBeLessThan(1200);
  expect(request.mock.calls.some(([command]) => command.type === 'task.content')).toBe(false);
  await click('展开内容'); expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'task.content', offset: 0, limit: 6000 }));
  expect(node!.textContent).toContain('第0段'); await click('下一段'); expect(node!.textContent).toContain('第6000段'); expect(node!.textContent).not.toContain('第0段'); expect(node!.textContent!.length).toBeLessThan(6500);
  await click('收起'); expect(node!.textContent).not.toContain('正在读取这一段'); expect(node!.textContent).toContain('来源内容');
});

it('ignores a late result after switching sections and paginates records with a bounded page', async () => {
  let accept!: (value: Awaited<ReturnType<CompanionRequest>>) => void;
  const pending = new Promise<Awaited<ReturnType<CompanionRequest>>>(resolve => { accept = resolve; });
  const request = vi.fn<CompanionRequest>(command => command.type === 'task.inspect' && command.section === 'input' ? pending : Promise.resolve({ ok: true, taskDetail: detail([record], { section: 'output', total: 40, hasMore: true }) }));
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionTaskInspector task={task} request={request} />));
  await click('任务结果'); await act(async () => accept({ ok: true, taskDetail: detail([{ ...record, text: '旧输入不能覆盖结果' }]) }));
  expect(node!.textContent).not.toContain('旧输入不能覆盖结果'); await click('下一页');
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'task.inspect', section: 'output', offset: 12, limit: 12 }));
});

it('refreshes a completed task on a real change event without continuously polling its history', async () => {
  vi.useFakeTimers(); let notify!: () => void, text = '第一次已保存的结果';
  const unsubscribe = vi.fn(), api = { onChanged: vi.fn(listener => { notify = listener; return unsubscribe; }) };
  const request = vi.fn<CompanionRequest>(async () => ({ ok: true, taskDetail: detail([{ ...record, text }]) }));
  await mount(request, { api }); expect(request).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); }); expect(request).toHaveBeenCalledTimes(1);
  text = '新的实际结果'; await act(async () => { notify(); await vi.advanceTimersByTimeAsync(800); }); expect(node!.textContent).toContain('新的实际结果');
  await act(() => root!.unmount()); root = undefined; expect(unsubscribe).toHaveBeenCalledTimes(1);
});
