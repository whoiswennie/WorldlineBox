// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryProcessingPanel, CompanionMemoryProcessingSummary } from '../../src/renderer/companions/CompanionMemoryProcessingPanel';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';
import type { CompanionMemoryProcessing } from '../../src/shared/companion-memory-processing';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
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

it('shows the actual next check and retry eligibility separately from the automatic trigger conditions', async () => {
  const at = '2026-10-22T01:10:00Z', retryAt = '2026-10-22T01:12:00Z';
  const scheduled: CompanionMemoryProcessing = { ...report,
    schedule: { observedAt: '2026-10-22T01:09:00Z', timeBasis: 'real', nextCheckAt: at, condition: '小肥鱼的来源队列将在下一轮核对', explanation: '检查时间不保证任务届时开始或完成。', schedulers: [] },
    jobs: [{ id: 'pending-note', kind: 'capture', status: 'pending', attempts: 1, title: '整理真实聊天来源', stage: '等待下一轮检查', schedule: {
      observedAt: '2026-10-22T01:09:00Z', scheduleKind: 'retry', timeBasis: 'real', nextCheckAt: at, nextAttemptAt: retryAt,
      waitingReason: 'retry_cooldown', condition: '冷却结束且全局聊天模型可用后，后台再次检查',
      triggerRule: '正式发布且允许记忆的来源入队后，判断哪些内容值得记下。', explanation: '最早重试是冷却下限，不是承诺开始时间。',
    } }],
  };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: scheduled }));
  await mount(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />);
  const owner = node!.querySelector('[aria-label="当前伙伴后台检查安排"]')!;
  expect(owner.textContent).toContain('下一轮核对'); expect(owner.querySelector('time')?.getAttribute('datetime')).toBe(at);
  const plan = node!.querySelector('[aria-label="任务后续执行安排"]')!;
  expect(plan.textContent).toContain('全局聊天模型可用'); expect(plan.textContent).toContain('冷却下限');
  expect(plan.textContent).toContain('现实时间'); expect(plan.querySelectorAll('time')).toHaveLength(2);
  expect(plan.querySelectorAll('time')[1]?.getAttribute('datetime')).toBe(retryAt);
  expect(node!.querySelector('.memory-processing-next-step')?.textContent).toContain('下次检查');
  expect(node!.textContent).not.toContain('预计完成');
});

it('shows a condition rather than a fabricated deadline and stops timer polling for a manual hold', async () => {
  vi.useFakeTimers();
  const held: CompanionMemoryProcessing = { ...report, summary: { pending: 1, running: 0, failed: 0, completed: 0, cancelled: 0 },
    schedule: { observedAt: '2026-10-22T01:09:00Z', timeBasis: 'real', condition: '等待用户恢复此伙伴的记忆授权', explanation: '当前没有可登记的下一次执行时间。', schedulers: [] },
    jobs: [{ id: 'held', kind: 'capture', status: 'pending', attempts: 0, title: '已暂停的来源', stage: '授权暂停', schedule: {
      scheduleKind: 'manual', timeBasis: 'real', observedAt: '2026-10-22T01:09:00Z', condition: '等待恢复当前伙伴的记忆授权', waitingReason: 'policy_hold',
      triggerRule: '恢复授权后重新核验可用来源。', explanation: '没有承诺开始或完成时间。',
    } }],
  };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: held }));
  await mount(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />);
  const plan = node!.querySelector('[aria-label="任务后续执行安排"]')!;
  expect(plan.textContent).toContain('等待恢复当前伙伴的记忆授权'); expect(plan.querySelector('time')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(15_000)); expect(request).toHaveBeenCalledOnce();
});

it('includes an actionable waiting condition in the compact current-companion entrance', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: { ...report, schedule: {
    observedAt: '2026-10-22T01:09:00Z', timeBasis: 'real', condition: '等待本地向量设备检测通过后继续索引', explanation: '模型文件就绪不代表设备已通过运行检测。', schedulers: [],
  } } }));
  await mount(<CompanionMemoryProcessingSummary companionId="alice" request={request} onOpen={vi.fn()} />);
  expect(node!.querySelector('.memory-processing-summary-next')?.textContent).toContain('设备检测通过');
});

it('can recover an exhausted pending lease even when the failed counter is zero', async () => {
  const exhausted: CompanionMemoryProcessing = { ...report, summary: { pending: 1, running: 0, failed: 0, completed: 0, cancelled: 0 },
    jobs: [{ id: 'exhausted', kind: 'index', status: 'pending', attempts: 8, title: '需要手动恢复的索引', stage: '已达到自动重试上限', schedule: {
      scheduleKind: 'manual', waitingReason: 'retry_limit', timeBasis: 'real', observedAt: '2026-10-22T01:09:00Z',
      condition: '已达到自动重试上限，需要手动重试。', triggerRule: '手动恢复后再检查设备与来源。', explanation: '不承诺开始时间。',
    } }],
  };
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.jobs.retry' ? { ok: true } : { ok: true, memoryProcessing: exhausted });
  await mount(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />);
  expect(node!.textContent).toContain('达到自动重试上限');
  await act(async () => button('重试待处理任务').click());
  expect(request).toHaveBeenCalledWith({ type: 'memory.jobs.retry', companionId: 'alice' });
});

it('keeps the owner timer fresh while viewing only completed history', async () => {
  vi.useFakeTimers();
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: { ...report,
    summary: { pending: 1, running: 0, failed: 0, completed: 1, cancelled: 0 },
    jobs: [{ id: 'done', kind: 'capture', title: '已检查的来源', stage: '无需新增日记', attempts: 1, status: 'completed' }],
    schedule: { timeBasis: 'real', observedAt: '2026-10-22T01:09:00Z', nextCheckAt: '2026-10-22T01:10:00Z', condition: '已有登记的后台检查。', explanation: '检查时间不是执行承诺。', schedulers: [
      { kind: 'capture', scheduleKind: 'timer', timeBasis: 'real', observedAt: '2026-10-22T01:09:00Z', nextCheckAt: '2026-10-22T01:10:00Z', condition: '已登记检查。', explanation: '真实定时器。', triggerRule: '检查来源队列。' },
    ] },
  } }));
  await mount(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />);
  await act(async () => button('已处理').click());
  const before = request.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(request.mock.calls.length).toBeGreaterThan(before);
  expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'memory.processing.status', companionId: 'alice', filter: 'completed' });
});

it('labels expired running leases as received records awaiting recovery rather than live progress', async () => {
  const expired: CompanionMemoryProcessing = { ...report, summary: { pending: 0, running: 1, failed: 0, completed: 0, cancelled: 0 }, jobs: [
    { id: 'expired-lease', kind: 'index', status: 'running', title: '中断的向量整理', attempts: 8, stage: '正在生成向量', schedule: {
      scheduleKind: 'manual', timeBasis: 'real', observedAt: '2026-10-22T01:09:00Z', waitingReason: 'lease_expired', condition: '上次领取已失效，需要恢复。', triggerRule: '手动恢复后再检查设备。', explanation: '此记录不代表模型正在执行。',
    } },
  ] };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProcessing: expired }));
  await mount(<CompanionMemoryProcessingSummary companionId="alice" request={request} onOpen={vi.fn()} />);
  expect(node!.textContent).toContain('1 项已领取'); expect(node!.textContent).not.toContain('向量索引进行中');
  await act(async () => root!.render(<CompanionMemoryProcessingPanel companionId="alice" request={request} onClose={vi.fn()} />));
  expect(node!.querySelector('.memory-processing-state')?.textContent).toBe('等待恢复');
  expect(node!.querySelector('.memory-processing-stage')?.textContent).toBe('上次记录：正在生成向量');
});
