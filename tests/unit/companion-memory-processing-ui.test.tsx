// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryProcessingPanel, CompanionMemoryProcessingSummary } from '../../src/renderer/companions/CompanionMemoryProcessingPanel';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';
import type { CompanionMemoryProcessing } from '../../src/shared/companion-memory-processing';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); });
const report: CompanionMemoryProcessing = { companionId: 'alice', summary: { pending: 1, running: 1, failed: 1, completed: 20, cancelled: 0 }, hasMore: true,
  jobs: [{ id: 'capture-a', kind: 'capture', status: 'running', stage: '正在判断是否值得记下', title: '整理聊天与经历', attempts: 1, preview: '今天一起约好去看海。', sourceMessageId: 'source-a', createdAt: '2026-10-22T01:00:00Z', updatedAt: '2026-10-22T01:02:00Z' },
    { id: 'index-a', kind: 'index', status: 'failed', stage: '等待重试', title: '建立记忆索引', attempts: 2, error: '本地服务暂时不可用', noteId: 'note-a' }] };
async function mount(children: React.ReactNode) { node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root!.render(children)); }
function button(name: string) { const found = [...node!.querySelectorAll('button')].find(item => item.textContent === name || item.getAttribute('aria-label') === name); if (!found) throw new Error('Missing button ' + name); return found; }

it('reads a bounded owner report, shows source checks separately from memories, and retries the same owner', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.processing.status' ? { ok: true, memoryProcessing: report } : { ok: true });
  const close = vi.fn(), openDocument = vi.fn();
  await mount(<CompanionMemoryProcessingPanel companionId="alice" companionName="小肥鱼" request={request} onClose={close} onOpenDocument={openDocument} />);
  expect(request).toHaveBeenCalledWith({ type: 'memory.processing.status', companionId: 'alice', limit: 30 });
  expect(node!.textContent).toContain('小肥鱼的来源整理'); expect(node!.textContent).toContain('可能判断无需写日记'); expect(node!.textContent).not.toContain('已学会');
  expect(node!.textContent).toContain('创建'); expect(node!.textContent).toContain('更新');
  expect(node!.querySelector('.memory-processing-overview')).toBeNull();
  expect(node!.textContent).toContain('还有其他历史任务');
  const failed = node!.querySelector<HTMLButtonElement>('[data-processing-kind="index"] button')!;
  await act(() => failed.click());
  expect(failed.getAttribute('aria-pressed')).toBe('true');
  expect(node!.textContent).toContain('本地服务暂时不可用'); expect(node!.textContent).toContain('旧任务未记录处理时间');
  await act(() => button('返回任务列表').click());
  expect(node!.querySelector('.memory-processing-content.is-detail-open')).toBeNull();
  await act(async () => button('重试失败的整理').click()); expect(request).toHaveBeenCalledWith({ type: 'memory.jobs.retry', companionId: 'alice' });
  await act(() => button('查看对应记忆').click()); expect(openDocument).toHaveBeenCalledWith('note-a');
  await act(() => button('关闭记忆处理进度').click()); expect(close).toHaveBeenCalledOnce();
});

it('keeps the compact chat entry owner-scoped and reports only actual processing status', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: report })); const open = vi.fn();
  await mount(<CompanionMemoryProcessingSummary companionId="alice" request={request} onOpen={open} />);
  expect(request).toHaveBeenCalledWith({ type: 'memory.processing.status', companionId: 'alice', limit: 1 });
  expect(node!.textContent).toContain('来源整理进行中'); await act(() => button('查看记忆处理进度').click()); expect(open).toHaveBeenCalledOnce();
});

it('loads completed history from the backend rather than filtering the first page of pending work', async () => {
  const request = vi.fn<ScheduleRequest>(async command => ({ ok: true, memoryProcessing: { ...report, jobs: command.type === 'memory.processing.status' && command.filter === 'completed'
    ? [{ id: 'older-completed', kind: 'capture', status: 'completed', title: '已经检查的旧来源', stage: '无需生成日记', attempts: 1 }] : report.jobs } }));
  await mount(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />);
  await act(async () => button('已处理').click());
  expect(request).toHaveBeenCalledWith({ type: 'memory.processing.status', companionId: 'alice', limit: 30, filter: 'completed' });
  expect(node!.textContent).toContain('已经检查的旧来源'); expect(node!.querySelector('[data-processing-status="running"]')).toBeNull();
});

it('never shows the previous owner summary while a different owner is loading', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.processing.status' && command.companionId === 'alice' ? { ok: true, memoryProcessing: report } : new Promise(() => undefined));
  const props = { request, onOpen: vi.fn() };
  await mount(<CompanionMemoryProcessingSummary companionId="alice" {...props} />);
  expect(node!.textContent).toContain('来源整理进行中');
  await act(async () => root!.render(<CompanionMemoryProcessingSummary companionId="bob" {...props} />));
  expect(node!.textContent).not.toContain('来源整理进行中'); expect(node!.textContent).toContain('正在读取处理进度');
});

it('does not let a late retry for another companion displace the new companion report', async () => {
  let finishRetry!: (value: { ok: true }) => void;
  let finishBob!: (value: { ok: true; memoryProcessing: CompanionMemoryProcessing }) => void;
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type === 'memory.jobs.retry') return new Promise(resolve => { finishRetry = resolve; });
    if (command.type === 'memory.processing.status' && command.companionId === 'bob') return new Promise(resolve => { finishBob = resolve; });
    return { ok: true, memoryProcessing: report };
  });
  const props = { request, onClose: vi.fn() };
  await mount(<CompanionMemoryProcessingPanel companionId="alice" {...props} />);
  await act(() => button('重试失败的整理').click());
  await act(async () => root!.render(<CompanionMemoryProcessingPanel companionId="bob" {...props} />));
  await act(async () => finishRetry({ ok: true }));
  await act(async () => finishBob({ ok: true, memoryProcessing: { ...report, companionId: 'bob', jobs: [
    { id: 'bob-source', kind: 'capture', status: 'running', stage: '正在核对大肥鱼的阅读记录', title: '大肥鱼的银杏书签', attempts: 1 },
  ] } }));
  expect(node!.textContent).toContain('大肥鱼的银杏书签');
  expect(node!.textContent).not.toContain('正在读取实际处理记录');
  expect(request.mock.calls.filter(([command]) => command.type === 'memory.processing.status' && command.companionId === 'alice')).toHaveLength(1);
});
