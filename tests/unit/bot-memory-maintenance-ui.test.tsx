// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotMemoryMaintenance } from '../../src/renderer/companion-bot/BotMemoryMaintenance';
import type { BotEvent, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotMaintenanceCandidateDetail, BotMaintenanceCandidateSummary, BotMaintenanceJob, BotMaintenanceSettings } from '../../src/shared/companion-bot-maintenance';
import type { BotMemoryWorkspaceRequest } from '../../src/shared/companion-bot-memory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-03T03:00:00Z', checksum = 'a'.repeat(32), revision = 'b'.repeat(64);
const job = (id = 'job-1', patch: Partial<BotMaintenanceJob> = {}): BotMaintenanceJob => ({ id, kind: 'organize', status: 'review', phase: 'pending_review', automatic: false,
  createdAt: at, updatedAt: at, elapsedMs: 2500, attempts: 1, metrics: { examined: 30, selected: 3, deferred: 6, candidates: 2, applied: 0, rejected: 0 }, ...patch });
const candidate = (id = 'candidate-1', patch: Partial<BotMaintenanceCandidateSummary> = {}): BotMaintenanceCandidateSummary => ({ id, jobId: 'job-1', type: 'archive', title: '归档重复的旧安排', status: 'pending', revision, sourceCount: 1, uncertaintyCount: 1, updatedAt: at, ...patch });
const detail = (patch: Partial<BotMaintenanceCandidateDetail> = {}): BotMaintenanceCandidateDetail => ({ ...candidate(), content: '旧安排已明确更正，这份原件仅退出召回，不撤回其他同源事实。', tags: ['已更正'], reason: '新安排明确替代旧时间，原始来源保留。', uncertainties: ['出发状态尚无新回执'],
  sources: [{ id: 'source-1', checksum, createdAt: at, tags: ['原安排'] }], quotes: [{ sourceId: 'source-1', text: '改为周六三点在南门见。' }], ...patch });
const settings = (patch: Partial<BotMaintenanceSettings> = {}): BotMaintenanceSettings => ({ enabled: false, kind: 'organize', intervalHours: 24, idleMinutes: 30, minNotes: 4, autoApply: 'never', nextEligibleAt: at, lastActivityAt: at, ...patch });
let root: Root | undefined, host: HTMLDivElement, api: WorldlineBoxBotApi, requests: BotMemoryWorkspaceRequest[], handler: ((request: BotMemoryWorkspaceRequest) => Promise<BotResponse> | undefined) | undefined;
let listeners: Set<(event: BotEvent) => void>;
afterEach(async () => { await act(() => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function mount(override?: typeof handler) {
  requests = []; handler = override; listeners = new Set();
  api = { async request(input) { const request = input as BotMemoryWorkspaceRequest; requests.push(request); const result = handler?.(request); if (result) return result;
    if (request.type === 'memory.maintenance.list') return { ok: true, memory: { items: [job()] } };
    if (request.type === 'memory.maintenance.get') return { ok: true, memory: job(request.jobId) };
    if (request.type === 'memory.maintenance.candidates') return { ok: true, memory: { items: [candidate('candidate-1', { jobId: request.jobId })] } };
    if (request.type === 'memory.maintenance.candidate') return { ok: true, memory: detail({ id: request.candidateId, jobId: request.jobId }) };
    if (request.type === 'memory.maintenance.settings.get') return { ok: true, memory: settings() };
    if (request.type === 'memory.maintenance.settings.update') return { ok: true, memory: settings(request.settings) };
    if (request.type === 'memory.maintenance.review') return { ok: true, memory: detail({ id: request.candidateId, jobId: request.jobId, status: request.decision === 'reject' ? 'rejected' : 'applied' }) };
    if (request.type === 'memory.maintenance.run') return { ok: true, memory: job('new-job', { kind: request.kind, status: 'queued', phase: 'queued' }) };
    if (request.type === 'memory.maintenance.cancel') return { ok: true, memory: job(request.jobId, { status: 'cancelled' }) };
    if (request.type === 'memory.maintenance.retry') return { ok: true, memory: job(request.jobId, { status: 'queued' }) };
    if (request.type === 'memory.maintenance.diagnostics') return { ok: true, memory: request.entryId ? { items: [], entry: { id: request.entryId, text: request.offset ? '原始诊断第二页' : '原始诊断第一页', offset: request.offset ?? 0, nextOffset: request.offset ? undefined : 800, total: 1600 } } : { items: [{ id: 1, phase: 'dream', createdAt: at, preview: '可能的联想预览', chars: 1600 }] } };
    if (request.type === 'memory.note') return { ok: true, memory: { id: request.id, checksum, content: '这是按需读取的完整原日记。', tags: [], indexState: 'indexed', createdAt: at } };
    return { ok: false, error: 'unexpected test request' };
  }, onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  host = document.createElement('div'); host.className = 'bot-workspace'; document.body.append(host); root = createRoot(host); await render();
}
async function render(owner = 'alice', conversationId = 'private-a') { await act(() => root!.render(<div className="bot-memory-workspace"><BotMemoryMaintenance key={`${conversationId}:${owner}`} api={api} conversationId={conversationId} companionId={owner} locale="zh-CN" /></div>)); }
async function click(label: string, parent: ParentNode = host) { const target = [...parent.querySelectorAll<HTMLElement>('button,summary')].find(item => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)!; expect(target, label).toBeDefined(); await act(() => target.click()); }
async function openJob(index = 0) { await act(() => host.querySelectorAll<HTMLButtonElement>('[data-maintenance-job]')[index]!.click()); }
async function openCandidate(index = 0) { await act(() => host.querySelectorAll<HTMLButtonElement>('.bot-maintenance-candidate-open')[index]!.click()); }
async function fill(label: string, value: string) { const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!; await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
const maintenanceRequests = <T extends BotMemoryWorkspaceRequest['type']>(type: T) => requests.filter((request): request is Extract<BotMemoryWorkspaceRequest, { type: T }> => request.type === type);
it('distinguishes new diary versions from related historical context in incremental tasks', async () => {
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job('job-1', { metrics: { examined: 2, selected: 5, deferred: 0, candidates: 1, applied: 0, rejected: 0, incremental: true, context: 3 } }) }) : undefined);
  await openJob(); const facts = host.querySelector('.bot-maintenance-facts')!.textContent;
  expect(facts).toContain('新增/变化2'); expect(facts).toContain('相关旧记忆3'); expect(host.textContent).toContain('已分析版本和待审来源不会重复排队');
});
it('saves the automatic review switch immediately and shows per-candidate model and human review history', async () => {
  let enabled = false;
  await mount(request => request.type === 'memory.maintenance.settings.get' ? Promise.resolve({ ok: true, memory: settings({ autoReview: enabled }) })
    : request.type === 'memory.maintenance.settings.update' ? Promise.resolve({ ok: true, memory: settings({ autoReview: enabled = !!request.settings.autoReview }) })
      : request.type === 'memory.maintenance.reviews' ? Promise.resolve({ ok: true, memory: { items: [{ id: 'review-1', jobId: 'job-1', candidateId: 'candidate-1', candidateRevision: revision, actor: 'model', model: 'global-model', promptVersion: 'worldlinebox-memory-review-v1', decision: 'manual', reason: '归档覆盖证据不足，需要人工核对。', checks: [{ criterion: 'evidence', passed: false, reason: '缺少原文证据。' }], createdAt: at }] } }) : undefined);
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="自动审阅"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false'); await act(() => toggle.click());
  expect(maintenanceRequests('memory.maintenance.settings.update')[0]).toMatchObject({ settings: { autoReview: true } });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await openJob(); await openCandidate(); await click('审阅记录');
  expect(host.textContent).toContain('global-model'); expect(host.textContent).toContain('归档覆盖证据不足'); expect(host.textContent).toContain('worldlinebox-memory-review-v1');
  expect(maintenanceRequests('memory.maintenance.reviews')[0]).toMatchObject({ jobId: 'job-1', candidateId: 'candidate-1' });
  await click('返回方案列表'); await act(() => toggle.click()); expect(toggle.getAttribute('aria-checked')).toBe('false');
});

it('shows real automatic-review progress and distinguishes a reviewed manual case from an unreviewed candidate', async () => {
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job('job-1', { autoReview: { state: 'queued', total: 8, reviewed: 2, manual: 1, busyJobId: 'older-job' } }) })
    : request.type === 'memory.maintenance.candidates' ? Promise.resolve({ ok: true, memory: { items: [candidate('candidate-1', { autoReview: { state: 'manual', reason: '归档覆盖证据不足' } })] } }) : undefined);
  await openJob(); expect(host.querySelector('.bot-maintenance-review-progress')?.textContent).toContain('正在处理此前的任务');
  expect(host.querySelector('.bot-maintenance-review-progress')?.textContent).toContain('已审 2/8');
  expect(host.querySelector('.bot-maintenance-candidate-open')?.textContent).toContain('已审阅 · 需人工');
});

it('loads bounded summaries first and reads candidate details and original notes only on demand', async () => {
  await mount(); expect(requests.map(request => request.type).sort()).toEqual(['memory.maintenance.list', 'memory.maintenance.settings.get']);
  expect(maintenanceRequests('memory.maintenance.list')[0]).toMatchObject({ conversationId: 'private-a', companionId: 'alice', limit: 20 });
  await openJob(); expect(maintenanceRequests('memory.maintenance.candidates')[0]).toMatchObject({ jobId: 'job-1', limit: 12 });
  expect(maintenanceRequests('memory.maintenance.candidate')).toHaveLength(0); await openCandidate();
  expect(host.textContent).toContain('归档冗余日记'); expect(host.textContent).toContain('候选不等于已改写'); expect(host.textContent).toContain('改为周六三点在南门见。');
  expect(maintenanceRequests('memory.note')).toHaveLength(0); await click('来源原文'); await click('查看原日记');
  expect(host.textContent).toContain('这是按需读取的完整原日记'); expect(maintenanceRequests('memory.note')[0]).toMatchObject({ id: 'source-1', companionId: 'alice' });
  expect(host.textContent).not.toContain('可信度 100%');
});

it('approves one candidate with an explicit single action and never maps archiving to forgetting', async () => {
  await mount(); await openJob(); await openCandidate(); expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0);
  expect(host.querySelector('.bot-review-reader-footer')?.textContent).toContain('保留并可恢复');
  await click('批准并应用'); expect(maintenanceRequests('memory.maintenance.review')[0]).toMatchObject({ candidateId: 'candidate-1', jobId: 'job-1', revision, decision: 'approve' });
  expect(requests.some(request => request.type === 'memory.forget')).toBe(false); expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).toContain('已应用');
});

it('keeps human approval visible for an unknown execution and offers per-candidate verification', async () => {
  const approval = { actor: 'user' as const, approvedAt: at };
  await mount(request => request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ status: 'unknown', approval, receipt: { error: { code: 'MEMORY_NOTE_UNAVAILABLE' } } }) })
    : request.type === 'memory.maintenance.resume' ? Promise.resolve({ ok: true, memory: detail({ status: 'unknown', approval, execution: { operation: 'reconcile', state: 'queued' } }) }) : undefined);
  await openJob(); await openCandidate(); expect(host.querySelector('.bot-review-reader-footer')?.textContent).toContain('人工已批准');
  expect(host.querySelector('.bot-review-reader-footer')?.textContent).toContain('执行结果待核实'); await click('核实并继续');
  expect(maintenanceRequests('memory.maintenance.resume')[0]).toMatchObject({ candidateId: 'candidate-1', jobId: 'job-1', revision });
  expect(host.querySelector('.bot-review-reader-footer')?.textContent).toContain('等待核实执行结果');
  expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0);
});

it('shows the verified prior note when another proposal already organized the same sources', async () => {
  await mount(request => request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ status: 'superseded', approval: { actor: 'user', approvedAt: at }, receipt: { resolution: { noteId: 'already-organized-note' } } }) }) : undefined);
  await openJob(); await openCandidate(); expect(host.textContent).toContain('已由其他方案整理'); expect(host.textContent).toContain('人工已批准');
  await click('查看已整理日记'); expect(maintenanceRequests('memory.note').at(-1)).toMatchObject({ id: 'already-organized-note' }); expect(host.textContent).toContain('已保存的整理结果');
});

it('opens a full-page reader, hides the candidate list, and returns to the same list without submitting decisions', async () => {
  await mount(request => request.type === 'memory.maintenance.candidates' ? Promise.resolve({ ok: true, memory: { items: [candidate(), candidate('candidate-2', { title: '第二项候选' })] } }) : request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ id: request.candidateId, content: request.candidateId }) }) : undefined);
  await openJob(); await openCandidate();
  expect(host.querySelectorAll('.bot-maintenance-candidate-detail')).toHaveLength(1);
  expect(host.querySelector('.bot-review-candidate-list')?.contains(host.querySelector('.bot-maintenance-candidate-detail'))).toBe(false);
  expect(host.querySelector<HTMLElement>('.bot-review-candidate-list')?.hidden).toBe(true);
  expect(host.querySelector('.bot-maintenance-review-workbench')?.getAttribute('data-reading')).toBe('true');
  await click('下一项候选'); expect(host.querySelector('.bot-maintenance-proposed')?.textContent).toBe('candidate-2');
  await click('上一项候选'); expect(host.querySelector('.bot-maintenance-proposed')?.textContent).toBe('candidate-1');
  await click('返回方案列表'); expect(host.querySelector('.bot-review-reader')).toBeNull();
  expect(host.querySelector<HTMLElement>('.bot-review-candidate-list')?.hidden).toBe(false);
  expect(host.querySelectorAll('[data-maintenance-candidate]')).toHaveLength(2);
  await openCandidate(1); expect(host.querySelector('.bot-maintenance-proposed')?.textContent).toBe('candidate-2');
  await act(() => host.querySelector('.bot-review-reader')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('.bot-review-reader')).toBeNull();
  expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0);
});

it('keeps actions and settings in the left column and makes success feedback a transient overlay', async () => {
  vi.useFakeTimers(); await mount(); await openJob();
  const body = host.querySelector('.bot-maintenance-body'), right = host.querySelector('.bot-maintenance-detail');
  expect(host.querySelector('.bot-maintenance-toolbar-actions')?.closest('.bot-maintenance-jobs')).not.toBeNull();
  expect(host.querySelector('.bot-maintenance-settings')?.closest('.bot-maintenance-jobs')).not.toBeNull(); expect(host.querySelector('.bot-maintenance-toolbar')).toBeNull();
  await click('生成梦境候选'); expect(host.querySelector('.bot-maintenance-toasts [role=status]')?.textContent).toContain('请求已记录');
  expect(host.querySelector('.bot-maintenance-toasts')?.parentElement?.className).toBe('bot-memory-maintenance');
  expect(host.querySelector('.bot-maintenance-body')).toBe(body); expect(host.querySelector('.bot-maintenance-detail')).toBe(right);
  await act(() => vi.advanceTimersByTime(2999)); expect(host.querySelector('.bot-maintenance-toast')).not.toBeNull();
  await act(() => vi.advanceTimersByTime(1)); expect(host.querySelector('.bot-maintenance-toast')).toBeNull(); expect(host.querySelector('.bot-maintenance-detail-heading')?.textContent).toContain('等待后台处理');
});

it('keeps an error notification until explicit dismissal and does not turn reloading into task retry', async () => {
  vi.useFakeTimers(); await mount(request => request.type === 'memory.maintenance.run' ? Promise.resolve({ ok: false, error: '后台暂未连接' }) : undefined);
  await click('生成整理方案'); expect(host.querySelector('.bot-maintenance-toast[role=alert]')?.textContent).toContain('后台暂未连接');
  await act(() => vi.advanceTimersByTime(10000)); expect(host.querySelector('.bot-maintenance-toast')).not.toBeNull();
  await click('重新读取'); expect(maintenanceRequests('memory.maintenance.retry')).toHaveLength(0);
  await click('生成整理方案'); await click('关闭错误提示'); expect(host.querySelector('.bot-maintenance-toast')).toBeNull();
});

it('retains a stable decision request ID after transport failure and does not call a conflict applied', async () => {
  let calls = 0; await mount(request => request.type === 'memory.maintenance.review' ? ++calls === 1 ? Promise.reject(new Error('connection lost')) : Promise.resolve({ ok: true, memory: detail({ status: 'conflict' }) }) : undefined);
  await openJob(); await openCandidate(); await click('批准并应用'); expect(host.textContent).toContain('connection lost');
  await click('批准并应用'); const decisions = maintenanceRequests('memory.maintenance.review'); expect(decisions).toHaveLength(2); expect(decisions[0]!.requestId).toBe(decisions[1]!.requestId);
  expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).toContain('来源已变化'); expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).not.toContain('已应用');
  expect(host.querySelector('.bot-maintenance-review-confirm')).toBeNull();
});

it('rejects a candidate independently without issuing any memory mutation or approval', async () => {
  await mount(); await openJob(); await openCandidate(); await click('驳回此项');
  expect(maintenanceRequests('memory.maintenance.review')[0]?.decision).toBe('reject'); expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).toContain('已驳回');
  expect(requests.some(request => ['memory.update', 'memory.organize', 'memory.forget', 'memory.remember'].includes(request.type))).toBe(false);
});

it('offers a real reread after an incomplete candidate response without enabling approval', async () => {
  let reads = 0; await mount(request => request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: ++reads === 1 ? { id: 'candidate-1', content: '不完整结果', revision: 'invalid' } : detail() }) : undefined);
  await openJob(); await openCandidate(); expect(host.textContent).toContain('未取得完整候选'); expect(host.querySelector('.bot-maintenance-review-actions')).toBeNull();
  await click('重新读取候选'); expect(host.textContent).toContain('新安排明确替代旧时间'); expect(host.querySelector('.bot-maintenance-review-actions')).not.toBeNull();
});

it('disables approval when reading an original proves that its checksum changed', async () => {
  await mount(request => request.type === 'memory.note' ? Promise.resolve({ ok: true, memory: { id: request.id, checksum: 'c'.repeat(32), content: '日记刚刚有新的更正', tags: [], indexState: 'indexed', createdAt: at } }) : undefined);
  await openJob(); await openCandidate(); await click('来源原文'); await click('查看原日记'); expect(host.textContent).toContain('来源与方案快照已不同');
  const approve = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '批准并应用')!;
  expect(approve.disabled).toBe(true); await act(() => approve.click()); expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0);
});

it('distinguishes a changed current original from historical quotes even after a candidate was applied', async () => {
  await mount(request => request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ status: 'applied' }) })
    : request.type === 'memory.note' ? Promise.resolve({ ok: true, memory: { id: request.id, checksum: 'c'.repeat(32), content: '应用后又发生的来源更正', tags: [], indexState: 'archived', createdAt: at } }) : undefined);
  await openJob(); await openCandidate(); await click('来源原文'); await click('查看原日记');
  expect(host.textContent).toContain('下方是当前版本，上方引用保留方案生成时的摘录'); expect(host.textContent).toContain('此原件已归档，仍可读取');
  expect(host.querySelector('.bot-maintenance-quote')?.textContent).toBe('改为周六三点在南门见。'); expect(host.querySelector('.bot-maintenance-source-body')?.textContent).toBe('应用后又发生的来源更正');
  expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0);
});

it('refreshes an open candidate from approved to the actual indexed outcome after a real changed event', async () => {
  vi.useFakeTimers(); let status: BotMaintenanceCandidateDetail['status'] = 'pending';
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { updatedAt: status === 'applied' ? '2026-11-03T03:01:00Z' : at }) })
    : request.type === 'memory.maintenance.candidates' ? Promise.resolve({ ok: true, memory: { items: [candidate('candidate-1', { status })] } })
      : request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ status }) })
        : request.type === 'memory.maintenance.review' ? Promise.resolve({ ok: true, memory: detail({ status: status = 'approved' }) }) : undefined);
  await openJob(); await openCandidate(); await click('批准并应用');
  expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).toContain('已批准，待执行');
  status = 'applied'; await act(() => { for (const listener of listeners) listener({ type: 'changed', conversationId: 'private-a' }); }); await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(host.querySelector('.bot-maintenance-candidate-detail')?.textContent).toContain('已应用');
});

it('labels an insight explicitly as a non-factual dream and still requires individual approval', async () => {
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { kind: 'dream' }) })
    : request.type === 'memory.maintenance.candidates' ? Promise.resolve({ ok: true, memory: { items: [candidate('candidate-1', { type: 'insight' })] } })
      : request.type === 'memory.maintenance.candidate' || request.type === 'memory.maintenance.review' ? Promise.resolve({ ok: true, memory: detail({ type: 'insight', status: request.type === 'memory.maintenance.review' ? 'applied' : 'pending', content: '梦境联想：下雨也可能是一种暂停。并非用户的真实经历。' }) }) : undefined);
  await openJob(); await openCandidate(); expect(host.textContent).toContain('梦境不是用户事实'); expect(host.textContent).toContain('拟保存的梦境感悟 · 非用户事实');
  expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0); await click('批准并应用');
  expect(host.querySelector('.bot-review-reader-footer')?.textContent).toContain('不作为用户事实'); expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(1);
});

it('maps the actual maintenance phases to human language without calling partial or unknown outcomes completed', async () => {
  vi.useFakeTimers(); let phase = 'scanning';
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { status: 'running', phase }) }) : undefined);
  await openJob(); expect(host.querySelector('.bot-maintenance-detail-heading')?.textContent).toContain('查找可整理日记');
  for (const [next, words] of [['reading', '读取来源原文'], ['recalling', '回查相关记忆'], ['planning', '生成候选方案'], ['waiting_index', '等待索引确认'], ['paused_user', '用户交互期间已暂停'], ['partial', '部分结果待核实'], ['unknown', '核实执行结果']]) {
    phase = next!; await act(() => { for (const listener of listeners) listener({ type: 'changed', conversationId: 'private-a' }); }); await act(async () => vi.advanceTimersByTimeAsync(600));
    const status = host.querySelector('.bot-maintenance-detail-heading')?.textContent ?? ''; expect(status).toContain(words); expect(status).not.toContain('状态未提供'); expect(status).not.toContain('已完成');
  }
});

it('replaces task and candidate pages instead of accumulating unbounded rows', async () => {
  await mount(request => request.type === 'memory.maintenance.list' ? Promise.resolve({ ok: true, memory: { items: request.cursor ? [job('other')] : Array.from({ length: 30 }, (_, index) => job(`job-${index + 1}`)), nextCursor: request.cursor ? undefined : 'next-jobs' } })
    : request.type === 'memory.maintenance.candidates' ? Promise.resolve({ ok: true, memory: { items: request.cursor ? [candidate('later-candidate')] : Array.from({ length: 20 }, (_, index) => candidate(`candidate-${index + 1}`)), nextCursor: request.cursor ? undefined : 'next-candidates' } }) : undefined);
  expect(host.querySelectorAll('[data-maintenance-job]')).toHaveLength(20); await openJob(); expect(host.querySelectorAll('[data-maintenance-candidate]')).toHaveLength(12);
  await click('下一页', host.querySelector('.bot-maintenance-detail')!); expect(host.querySelectorAll('[data-maintenance-candidate]')).toHaveLength(1);
  expect(host.querySelector('[data-maintenance-candidate]')?.getAttribute('data-maintenance-candidate')).toBe('later-candidate');
  await click('下一页', host.querySelector('.bot-maintenance-jobs')!); expect(host.querySelectorAll('[data-maintenance-job]')).toHaveLength(1);
  expect(maintenanceRequests('memory.maintenance.list').at(-1)).toMatchObject({ cursor: 'next-jobs', limit: 20 });
});

it('fences late task details and late approval receipts across selection and scope changes', async () => {
  const oldTask = deferred<BotResponse>(), oldApproval = deferred<BotResponse>();
  await mount(request => request.type === 'memory.maintenance.list' ? Promise.resolve({ ok: true, memory: { items: [job('slow-job'), job('job-1', { kind: 'dream' })] } })
    : request.type === 'memory.maintenance.get' && request.jobId === 'slow-job' ? oldTask.promise
      : request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { kind: 'dream' }) })
        : request.type === 'memory.maintenance.review' ? oldApproval.promise : undefined);
  await openJob(0); await openJob(1); await act(() => oldTask.resolve({ ok: true, memory: job('slow-job') }));
  expect(host.querySelector('.bot-maintenance-detail-heading h3')?.textContent).toContain('梦境');
  await openCandidate(); await click('批准并应用'); await render('bob', 'private-b');
  await act(() => oldApproval.resolve({ ok: true, memory: detail({ content: '旧范围私密文本', status: 'applied' }) }));
  expect(host.textContent).not.toContain('旧范围私密文本'); expect(host.querySelector('.bot-maintenance-detail-heading')).toBeNull();
  expect(requests.at(-1)).toMatchObject({ companionId: 'bob', conversationId: 'private-b' });
});

it('keeps schedule changes local, preserves an edited draft during refresh, and saves the actual constrained settings', async () => {
  vi.useFakeTimers(); let reads = 0;
  await mount(request => request.type === 'memory.maintenance.settings.get' ? Promise.resolve({ ok: true, memory: settings({ enabled: ++reads > 1, blockedReason: reads > 1 ? '等待空闲' : undefined }) }) : undefined);
  await fill('最短间隔（小时）', '48'); expect(maintenanceRequests('memory.maintenance.settings.update')).toHaveLength(0);
  await act(() => { for (const listener of listeners) listener({ type: 'changed', conversationId: 'private-a' }); }); await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(host.querySelector<HTMLInputElement>('[aria-label="最短间隔（小时）"]')?.value).toBe('48'); expect(host.textContent).toContain('等待空闲');
  await click('保存后台设置'); expect(maintenanceRequests('memory.maintenance.settings.update')[0]).toMatchObject({ settings: { enabled: false, intervalHours: 48, autoApply: 'never', minNotes: 4, idleMinutes: 30 } });
  expect(host.textContent).toContain('后台设置已保存'); expect(host.textContent).toContain('下次启动并空闲后补跑'); expect(host.textContent).toContain('不设每日次数或累计用量额度');
});

it('queues manual work with a stable request ID and provides real cancel and retry actions', async () => {
  let runCalls = 0; await mount(request => request.type === 'memory.maintenance.run' && ++runCalls === 1 ? Promise.reject(new Error('reply lost')) : undefined);
  await click('生成梦境候选'); expect(host.textContent).toContain('reply lost'); await click('生成梦境候选');
  const runs = maintenanceRequests('memory.maintenance.run'); expect(runs).toHaveLength(2); expect(runs[0]!.requestId).toBe(runs[1]!.requestId); expect(runs[1]!.kind).toBe('dream');
  await click('取消待处理部分'); expect(maintenanceRequests('memory.maintenance.cancel')[0]).toMatchObject({ jobId: 'new-job' });
  await click('重试未完成部分'); expect(maintenanceRequests('memory.maintenance.retry')[0]).toMatchObject({ jobId: 'new-job' });
});

it('starts a separately approved next batch with the actual server cursor rather than claiming the whole library completed', async () => {
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { nextCursor: 'real-library-next' }) }) : undefined);
  await openJob(); expect(host.textContent).toContain('每批最多检查24篇'); await click('继续下一批');
  expect(maintenanceRequests('memory.maintenance.run')[0]).toMatchObject({ cursor: 'real-library-next', kind: 'organize' });
  expect(maintenanceRequests('memory.maintenance.review')).toHaveLength(0); expect(host.textContent).not.toContain('已整理全部记忆');
});

it.each(['candidates', 'diagnostics'] as const)('retires visible %s text when the real job reports source withdrawal', async view => {
  vi.useFakeTimers(); let withdrawn = false;
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, withdrawn ? { status: 'blocked', phase: 'source_withdrawn', updatedAt: '2026-11-03T03:01:00Z' } : {}) })
    : request.type === 'memory.maintenance.candidate' ? Promise.resolve({ ok: true, memory: detail({ content: '撤回后不再展示的旧正文' }) })
      : request.type === 'memory.maintenance.diagnostics' && request.entryId ? Promise.resolve({ ok: true, memory: { items: [], entry: { id: 1, text: '撤回后不再展示的旧正文', offset: 0, total: 14 } } }) : undefined);
  await openJob(); if (view === 'candidates') await openCandidate(); else { await click('梦境与诊断'); await click('阅读这段'); }
  expect(host.textContent).toContain('撤回后不再展示的旧正文'); withdrawn = true;
  await act(() => { for (const listener of listeners) listener({ type: 'changed', conversationId: 'private-a' }); }); await act(async () => vi.advanceTimersByTimeAsync(600));
  expect(host.textContent).toContain('旧候选和诊断正文已停止显示'); expect(host.textContent).not.toContain('撤回后不再展示的旧正文');
  expect(host.querySelector('.bot-maintenance-candidate-detail')).toBeNull(); expect(host.querySelector('.bot-maintenance-proposed')).toBeNull();
});

it('reads dream diagnostics by bounded pages and marks associations as non-factual', async () => {
  await mount(); await openJob(); expect(maintenanceRequests('memory.maintenance.diagnostics')).toHaveLength(0); await click('梦境与诊断');
  expect(host.textContent).toContain('联想是推测'); expect(host.textContent).not.toContain('原始诊断第一页');
  await click('阅读这段'); expect(host.textContent).toContain('原始诊断第一页');
  const diagnostic = host.querySelector('.bot-maintenance-detail>.bot-maintenance-diagnostic:last-child') ?? host.querySelectorAll('.bot-maintenance-diagnostic')[1]!;
  await click('下一页', diagnostic); expect(host.textContent).toContain('原始诊断第二页'); expect(host.textContent).not.toContain('原始诊断第一页');
  expect(maintenanceRequests('memory.maintenance.diagnostics').at(-1)).toMatchObject({ entryId: 1, offset: 800, limit: 20 });
});

it('keeps the running-task clock local instead of rereading lists or rendering all job dates every second', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse(at) + 3000);
  await mount(request => request.type === 'memory.maintenance.get' ? Promise.resolve({ ok: true, memory: job(request.jobId, { status: 'running', phase: 'scan', startedAt: at, elapsedMs: 2000 }) }) : undefined);
  await openJob(); const before = requests.length, dates = vi.spyOn(Date.prototype, 'toLocaleString');
  await act(() => vi.advanceTimersByTime(5000));
  expect(host.querySelector('.bot-maintenance-live-time')?.textContent).toContain('8 秒'); expect(dates.mock.calls).toHaveLength(0); expect(requests).toHaveLength(before);
  await act(() => root!.unmount()); root = undefined; expect(vi.getTimerCount()).toBe(0);
});
