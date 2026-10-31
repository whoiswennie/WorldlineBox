// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgenda, CompanionAgendaSummary, type AgendaRequest } from '../../src/renderer/companions/CompanionAgenda';
import { agendaCandidate, agendaDayKey, agendaEntries, agendaEntryGroups, agendaResultText } from '../../src/renderer/companions/companion-agenda-presentation';
import { companionAgendaGoalSchema, companionAgendaGrantSchema, companionAgendaRuleSchema, companionAgendaRunSchema, type CompanionAgendaOccurrence, type CompanionAgendaResponse, type CompanionAgendaView } from '../../src/shared/companion-agenda';
import type { Companion } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-10-29T01:00:00.000Z';
const owner: Companion = { id: 'agenda-owner', name: '澄澄', description: '', persona: '从真实经历慢慢学习', model: '', avatar: 'custom', builtin: false, proactive: true, active: true, createdAt: at };
const rule = companionAgendaRuleSchema.parse({ id: 'reading', companionId: owner.id, revision: 3, category: 'task', title: '继续音频分析', intent: '阅读相位资料，核对上次的问题。', kind: 'learning', executor: 'brain', trigger: { kind: 'at', at, timeZone: 'Asia/Shanghai' }, reason: '上次还有一个未解决的问题。', origin: 'self', status: 'active', createdAt: at, updatedAt: at, nextAt: at });
const conditionRule = companionAgendaRuleSchema.parse({ ...rule, id: 'memory', category: 'event', title: '梳理刚才的经历', kind: 'memory', trigger: { kind: 'event', topic: 'experience.changed', quietSeconds: 60 } });
const occurrence: CompanionAgendaOccurrence = { id: 'occurrence', companionId: owner.id, ruleId: rule.id, ruleRevision: 3, scheduledAt: at, lastEvaluatedAt: at, state: 'running', accumulatedHazard: 0, conditionResults: [], reason: '已开始核对资料。' };
const run = companionAgendaRunSchema.parse({ id: 'run-reading', companionId: owner.id, ruleId: rule.id, occurrenceId: occurrence.id, revision: 2, status: 'running', stage: '正在读获准资料。', createdAt: at, updatedAt: at, notBefore: at, startedAt: at, failureCount: 0, cycleFailureCount: 0, retryCycle: 0, attemptCount: 1 });
const view: CompanionAgendaView = { companionId: owner.id, rules: [rule, conditionRule], occurrences: [occurrence], runs: [run], goals: [], grants: [], hasMore: false, observedAt: at, revision: 4 };
let host: HTMLDivElement | undefined, root: Root | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T02:00:00Z')); });
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); host = undefined; root = undefined; vi.useRealTimers(); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === text || node.textContent?.trim() === text)!;
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
async function click(text: string) { expect(button(text), text).toBeTruthy(); await act(async () => button(text).click()); }
function requestFixture() { return vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: view } : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: [], agendaHasMore: false } : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule: { ...rule, revision: 7 }, occurrences: [occurrence], runs: [run], steps: [] } } : { ok: true }); }
const fieldLabel = (name: string) => [...document.querySelectorAll<HTMLLabelElement>('.agenda-compose label')].find(label => label.textContent?.trim() === name)!;
async function fillCompose(name: string, value: string) {
  const label = fieldLabel(name), input = label.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')!;
  await act(async () => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function selectCompose(name: string, value: string) {
  const id = fieldLabel(name).htmlFor; expect(id, name).toBeTruthy();
  await act(async () => document.getElementById(id)!.click());
  const option = document.querySelector<HTMLButtonElement>(`[role="option"][data-value="${value}"]`)!;
  expect(option, value).toBeTruthy(); await act(async () => option.click());
}
async function beginCompose() { await click('添加安排'); await fillCompose('名称', '接下来的安排'); await fillCompose('完整想法', '按真实来源与范围继续进行。'); }

it('shows actual events and conditions together, and opens independent detail only on selection', async () => {
  const request = requestFixture();
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  const dialog = document.querySelector('[role="dialog"][aria-label="伙伴日程"]')!;
  expect(dialog.textContent).toContain('澄澄的日程'); expect(dialog.textContent).toContain('继续音频分析'); expect(dialog.textContent).toContain('梳理刚才的经历');
  expect(dialog.textContent).not.toContain('工作台'); expect(dialog.textContent).not.toContain('任务中心');
  expect(request.mock.calls.filter(([input]) => input.type === 'agenda.event.read')).toHaveLength(0);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  expect(request).toHaveBeenCalledWith({ type: 'agenda.event.read', companionId: owner.id, id: rule.id });
  const detail = document.querySelector('[role="dialog"][aria-label="日程详情：继续音频分析"]')!;
  expect(detail.textContent).toContain('修订 7'); expect(dialog.contains(detail)).toBe(false);
  expect(dialog.querySelector('.agenda-event-detail')).toBeNull(); expect(dialog.querySelector('.agenda-live-strip')).toBeNull();
  await click('暂停未来安排');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.rule.control', id: rule.id, companionId: owner.id, expectedRevision: 7, action: 'pause', operationId: expect.any(String) }));
});

it('moves the minute marker into its real event order without polling or moving user scroll', async () => {
  const future = { ...rule, id: 'next-event', title: '接下来的一件事', trigger: { kind: 'at' as const, at: new Date(Date.now() + 1000).toISOString(), timeZone: 'Asia/Shanghai', repeat: 'once' as const, probability: 1 } };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, rules: [rule, future] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  const scroll = document.querySelector<HTMLElement>('.agenda-scroll')!; scroll.scrollTop = 177;
  const marker = document.querySelector<HTMLElement>('[data-agenda-now]')!, next = document.querySelector('[data-agenda-entry="rule:next-event"]')!;
  const before = marker.querySelector('time')!.dateTime, reads = request.mock.calls.length;
  expect(marker.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const after = document.querySelector<HTMLElement>('[data-agenda-now]')!;
  expect(after.querySelector('time')!.dateTime).not.toBe(before); expect(after.querySelector('time')!.textContent).toMatch(/^\d{2}:\d{2}$/u);
  expect(after.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  expect(document.querySelector('.agenda-calendar-rail,.agenda-real-clock,.agenda-clock-track,.agenda-live-strip')).toBeNull();
  expect(request.mock.calls).toHaveLength(reads); expect(scroll.scrollTop).toBe(177);
});

it('follows real midnight only until the user chooses another date and restores following on today', async () => {
  const before = new Date(); before.setHours(23, 59, 59, 0); vi.setSystemTime(before);
  const request = requestFixture(); await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  const today = agendaDayKey(Date.now());
  expect(document.querySelector<HTMLTimeElement>('.agenda-date-heading')?.dateTime).toBe(today);
  const reads = request.mock.calls.filter(([input]) => input.type === 'agenda.read'); expect(reads).toHaveLength(2);
  await click('前一天'); expect(document.querySelector('[data-agenda-now]')).toBeNull();
  const selected = document.querySelector<HTMLTimeElement>('.agenda-date-heading')!.dateTime, currentReads = request.mock.calls.length;
  await act(async () => { vi.setSystemTime(Date.now() + 86400000); await vi.advanceTimersByTimeAsync(1000); });
  expect(document.querySelector<HTMLTimeElement>('.agenda-date-heading')!.dateTime).toBe(selected); expect(request.mock.calls).toHaveLength(currentReads);
  await click('回到此刻'); expect(document.querySelector('[data-agenda-now]')).not.toBeNull();
  expect(document.querySelector<HTMLTimeElement>('.agenda-date-heading')?.dateTime).toBe(agendaDayKey(Date.now()));
});

it('never places a now cursor on the future or history views', async () => {
  await mount(<CompanionAgenda companions={[owner]} request={requestFixture()} onClose={vi.fn()} />);
  await click('任务'); expect(document.querySelector('[data-agenda-now]')).toBeNull();
  await click('系统事件'); expect(document.querySelector('[data-agenda-now]')).toBeNull();
  await click('日常'); expect(document.querySelector('[data-agenda-now]')).not.toBeNull();
  await click('后一天'); expect(document.querySelector('[data-agenda-now]')).toBeNull(); expect(document.querySelector('.agenda-date-heading')).not.toBeNull();
});

it('stops the clock while the document is hidden and catches up when visible without IPC', async () => {
  const request = requestFixture(); await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  const clock = document.querySelector<HTMLTimeElement>('[data-agenda-now] time')!, before = clock.dateTime, reads = request.mock.calls.length;
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(3000); });
    expect(clock.dateTime).toBe(before); expect(request.mock.calls).toHaveLength(reads);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(clock.dateTime).not.toBe(before); expect(request.mock.calls).toHaveLength(reads);
  } finally { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); }
});

it('contains Escape and focus inside the event dialog and restores focus to its event', async () => {
  const close = vi.fn(); await mount(<CompanionAgenda companions={[owner]} request={requestFixture()} onClose={close} />);
  const event = document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!;
  await act(async () => { event.focus(); event.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(30); });
  const detail = document.querySelector<HTMLElement>('.agenda-detail-dialog')!;
  expect(detail.contains(document.activeElement)).toBe(true);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true })));
  expect(document.querySelector('.agenda-detail-dialog')).not.toBeNull();
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.agenda-detail-dialog')).toBeNull(); expect(close).not.toHaveBeenCalled(); expect(document.activeElement).toBe(event);
});

it('shows actual readable result fields and folds the original technical receipt', async () => {
  const result = JSON.stringify({ summary: '已核对引用的原始资料。', receipt: { leaseToken: 'technical-record' } });
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: view } : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule, occurrences: [occurrence], runs: [{ ...run, result }], steps: [] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  const detail = document.querySelector('.agenda-detail-dialog')!;
  expect([...detail.querySelectorAll('.agenda-detail-section > p')].some(node => node.textContent === '已核对引用的原始资料。')).toBe(true);
  const raw = detail.querySelector<HTMLDetailsElement>('.agenda-raw-receipt')!; expect(raw.open).toBe(false); expect(raw.querySelector('pre')!.textContent).toBe(result);
  expect(agendaResultText('{"receipt":{"status":"done"}}')).toEqual({ raw: '{"receipt":{"status":"done"}}' });
  expect(agendaResultText('实际原文')).toEqual({ text: '实际原文' });
});

it('retains the current verified snapshot during background refresh and ignores late results from another owner', async () => {
  let changed: (() => void) | undefined, settle: ((response: CompanionAgendaResponse) => void) | undefined, slow = false;
  const other = { ...owner, id: 'other', name: '另一个伙伴' };
  const request = vi.fn<AgendaRequest>(async input => input.type !== 'agenda.read' ? { ok: true } : input.companionId === other.id ? { ok: true, agenda: { ...view, companionId: other.id, rules: [], occurrences: [], runs: [] } } : slow ? new Promise(resolve => { settle = resolve; }) : { ok: true, agenda: view });
  const api = { onChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; } };
  await mount(<CompanionAgenda companions={[owner]} request={request} api={api} onClose={vi.fn()} modal={false} />);
  slow = true; await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(850); });
  expect(host!.textContent).toContain('继续音频分析'); expect(host!.textContent).not.toContain('正在读取日程…');
  await act(async () => root!.render(<CompanionAgenda companions={[other]} request={request} api={api} onClose={vi.fn()} modal={false} />));
  expect(host!.textContent).toContain('另一个伙伴的日程'); expect(host!.textContent).not.toContain('继续音频分析');
  await act(async () => settle!({ ok: true, agenda: view }));
  expect(host!.textContent).not.toContain('继续音频分析');
});

it('removes the actual portal and suspends reads while the containing module is hidden', async () => {
  const request = requestFixture();
  const render = (active: boolean) => <Activity mode={active ? 'visible' : 'hidden'}><CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} active={active} /></Activity>;
  await mount(render(true)); expect(document.querySelector('[role="dialog"][aria-label="伙伴日程"]')).not.toBeNull();
  await act(async () => root!.render(render(false)));
  expect(document.querySelector('[role="dialog"][aria-label="伙伴日程"]')).toBeNull();
  const reads = request.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(request.mock.calls).toHaveLength(reads);
  await act(async () => root!.render(render(true))); expect(document.querySelector('[role="dialog"][aria-label="伙伴日程"]')).not.toBeNull();
});

it('keeps a stable operation identity when a save outcome is unknown', async () => {
  let attempts = 0;
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: view } : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule, occurrences: [occurrence], runs: [run], steps: [] } } : input.type === 'agenda.rule.control' ? (++attempts === 1 ? undefined : { ok: true }) : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  await click('暂停未来安排'); await click('暂停未来安排');
  const mutations = request.mock.calls.filter(([input]) => input.type === 'agenda.rule.control').map(([input]) => input);
  expect(mutations).toHaveLength(2); expect(mutations[0]).toEqual(mutations[1]);
});

it('discovers observation sources only on explicit selection and creates an observe-only grant for chosen actual ids', async () => {
  const request = requestFixture(), load = vi.fn(async () => [{ id: 'window:123:0', title: '编辑器' }, { id: 'window:456:0', title: '播放器' }]);
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} loadObservationSources={load} />);
  expect(load).not.toHaveBeenCalled();
  await act(async () => { document.querySelector<HTMLDetailsElement>('.agenda-observation')!.open = true; });
  await click('选择可观察的窗口'); expect(load).toHaveBeenCalledExactlyOnceWith(owner.id);
  await act(async () => document.querySelector<HTMLInputElement>('.agenda-observation-sources input')!.click());
  await click('允许持续查看所选范围');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.grant.configure', companionId: owner.id, grant: { title: '查看选定的电脑画面', capabilities: ['observe'], windowIds: ['window:123:0'], captureSources: [{ id: 'window:123:0', title: '编辑器' }], fileRoots: [], outputRoots: [], allowPublicWeb: false } }));
});

it('reads concurrency only when its compact settings opens and saves the chosen partner limit', async () => {
  const read = vi.fn(async () => ({ companionId: owner.id, limit: 3, active: 2, queued: 1 }));
  const configure = vi.fn(async (_owner: string, limit: number) => ({ companionId: owner.id, limit, active: 2, queued: 1 }));
  await mount(<CompanionAgenda companions={[owner]} request={requestFixture()} onClose={vi.fn()} readCapacity={read} configureCapacity={configure} />);
  expect(read).not.toHaveBeenCalled();
  await act(async () => { document.querySelector<HTMLDetailsElement>('.agenda-capacity')!.open = true; });
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(read).toHaveBeenCalledWith(owner.id);
  await click('伙伴并发数量');
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"][data-value="4"]')!.click());
  await click('保存'); expect(configure).toHaveBeenCalledWith(owner.id, 4);
  const reads = read.mock.calls.length; await act(async () => { await vi.advanceTimersByTimeAsync(60000); }); expect(read).toHaveBeenCalledTimes(reads);
});

it('projects candidate windows without inventing runs and groups actual running conversations as parallel', () => {
  const window = { ...rule, trigger: { kind: 'window' as const, startMinute: 23 * 60, endMinute: 60, probability: .6, checkIntervalMinutes: 15, timeZone: 'UTC' } };
  const day = '2026-10-29', candidate = agendaCandidate(window, day)!;
  expect(candidate.at).toBeDefined(); expect(candidate.endAt).toBeDefined(); expect(Date.parse(candidate.endAt!) - Date.parse(candidate.at!)).toBe(2 * 3600000);
  const otherRule = { ...rule, id: 'other-rule' }, otherOccurrence = { ...occurrence, id: 'other-occurrence', ruleId: otherRule.id, scheduledAt: '2026-10-29T01:02:00Z' }, otherRun = { ...run, id: 'other-run', ruleId: otherRule.id, occurrenceId: otherOccurrence.id, startedAt: otherOccurrence.scheduledAt };
  const entries = agendaEntries({ ...view, rules: [rule, otherRule], occurrences: [occurrence, otherOccurrence], runs: [run, otherRun] }, 'today', day);
  const grouped = agendaEntryGroups(entries); expect(grouped).toHaveLength(1); expect(grouped[0]!.parallel).toBe(true); expect(grouped[0]!.entries).toHaveLength(2);
  const planned = agendaEntries({ ...view, rules: [window], occurrences: [], runs: [] }, 'today', day); expect(planned).toHaveLength(1); expect(planned[0]!.planned).toBe(true); expect(planned[0]!.run).toBeUndefined();
});

it('keeps paused arrangements discoverable, does not revive a completed once event, and keeps a running event across midnight', () => {
  const day = '2026-10-29';
  const paused = { ...rule, status: 'paused' as const, nextAt: undefined, trigger: { ...rule.trigger, kind: 'at' as const, at: '2026-10-28T01:00:00Z', repeat: 'once' as const, timeZone: 'UTC' } };
  expect(agendaEntries({ ...view, rules: [paused], occurrences: [], runs: [] }, 'upcoming', day)[0]?.rule.status).toBe('paused');
  expect(agendaEntries({ ...view, occurrences: [{ ...occurrence, state: 'completed' }], runs: [{ ...run, status: 'completed' }] }, 'upcoming', day).some(entry => entry.rule.id === rule.id)).toBe(false);
  const continued = agendaEntries({ ...view, rules: [rule], occurrences: [{ ...occurrence, scheduledAt: '2026-10-28T01:00:00Z' }], runs: [{ ...run, startedAt: '2026-10-28T01:00:00Z' }] }, 'today', day);
  expect(continued).toHaveLength(1); expect(continued[0]?.run?.status).toBe('running');
});

it('requires an explicit current observation grant and binds the real observation executor', async () => {
  const grant = companionAgendaGrantSchema.parse({ id: 'observe-grant', companionId: owner.id, title: '查看编辑器', revision: 1, status: 'active', capabilities: ['observe'],
    windowIds: ['window:123:0'], captureSources: [{ id: 'window:123:0', title: '编辑器' }], conversationId: 'owner-private', createdAt: at, updatedAt: at });
  const grants = [grant, { ...grant, id: 'revoked', status: 'revoked' as const }, { ...grant, id: 'other-owner', companionId: 'other' }, { ...grant, id: 'expired', expiresAt: at }];
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, grants } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />); await beginCompose();
  await selectCompose('事项', 'observation'); await click('保存');
  expect(document.querySelector('.agenda-compose [role="alert"]')?.textContent).toContain('选择这次安排可使用的授权');
  expect(request.mock.calls.some(([input]) => input.type === 'agenda.rule.create')).toBe(false);
  await selectCompose('本次观察范围', grant.id); await click('保存');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.rule.create', rule: expect.objectContaining({ kind: 'observation', executor: 'observation', grantId: grant.id, conversationId: 'owner-private', overlapPolicy: 'parallel' }) }));
});

it('guides unprepared learning to a long-term direction instead of silently running an unlinked brain event', async () => {
  const request = requestFixture(); await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />); await beginCompose();
  await selectCompose('事项', 'learning'); await click('保存');
  expect(request.mock.calls.some(([input]) => input.type === 'agenda.rule.create')).toBe(false);
  expect(document.querySelector('.agenda-compose [role="alert"]')?.textContent).toContain('长期方向'); await click('前往任务');
  expect(document.querySelector('.agenda-tabs [aria-selected="true"]')?.textContent).toContain('任务'); expect(document.querySelector('.agenda-compose')).toBeNull();
});

it('continues the selected actual learning processor and preserves its exclusive resource/source binding', async () => {
  const goal = companionAgendaGoalSchema.parse({ id: 'study-goal', companionId: owner.id, title: '学习音频', intent: '研究相位', domain: 'knowledge', successCriteria: ['能解释引用的证据'], revision: 1, status: 'active', origin: 'user', createdAt: at, updatedAt: at });
  const linked = { ...rule, id: 'linked-study', executor: 'learning' as const, goalId: goal.id, referenceId: 'actual-study', grantId: 'study-grant', conversationId: 'owner-private', resourceKeys: ['learning:actual-study'] };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, goals: [goal], rules: [linked] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />); await beginCompose(); await selectCompose('事项', 'learning');
  await selectCompose('继续哪个学习方向', goal.id); await click('保存');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.rule.create', rule: expect.objectContaining({ kind: 'learning', executor: 'learning',
    goalId: goal.id, referenceId: 'actual-study', grantId: 'study-grant', conversationId: 'owner-private', resourceKeys: ['learning:actual-study'] }) }));
});

it('creates a real overnight opportunity window with one whole-window probability', async () => {
  const request = requestFixture(); await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />); await beginCompose();
  await selectCompose('时间方式', 'window'); await fillCompose('开始时间', '22:00'); await fillCompose('结束时间', '01:00'); await fillCompose('窗口内发生的概率（%）', '35');
  await click('保存');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.rule.create', rule: expect.objectContaining({ trigger: { kind: 'window', startMinute: 1320, endMinute: 60, probability: .35, checkIntervalMinutes: 15, timeZone: expect.any(String) } }) }));
});

it.each(['daily', 'interval'] as const)('supports %s timing through the actual typed rule contract', async timing => {
  const request = requestFixture(); await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />); await beginCompose();
  if (timing === 'daily') await selectCompose('重复', 'daily');
  else { await selectCompose('时间方式', 'interval'); await fillCompose('每隔多少分钟', '90'); }
  await selectCompose('时间重合时', 'wait'); await click('保存');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.rule.create', rule: expect.objectContaining({ overlapPolicy: 'wait',
    trigger: expect.objectContaining(timing === 'daily' ? { kind: 'at', repeat: 'daily' } : { kind: 'interval', everyMinutes: 90 }) }) }));
});

it('protects a base rule without blocking recovery of its actual parked batch', async () => {
  const protectedRule = { ...rule, protected: true, origin: 'system' as const }, parked = { ...run, status: 'parked' as const };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, rules: [protectedRule], runs: [parked] } }
    : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule: protectedRule, occurrences: [occurrence], runs: [parked], steps: [] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  expect(button('暂停未来安排').disabled).toBe(true); expect(button('结束这项安排').disabled).toBe(true); expect(button('继续本次').disabled).toBe(false);
  await click('继续本次');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.run.control', id: run.id, expectedRevision: run.revision, action: 'resume' }));
});

it('keeps an uncertain outcome available for inspection/abandonment without offering a normal retry', async () => {
  const unknown = { ...run, status: 'unknown' as const };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, runs: [unknown] } }
    : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule, occurrences: [occurrence], runs: [unknown], steps: [] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  expect(button('继续本次')).toBeUndefined(); await click('放弃本次'); await click('确认放弃');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.run.control', id: run.id, expectedRevision: run.revision, action: 'abandon' }));
});

it.each(['pausedByRuleId', 'pausedByGoalId'] as const)('explains %s instead of queuing a batch whose parent is still paused', async marker => {
  const parked = { ...run, status: 'parked' as const, [marker]: 'paused-parent' };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, runs: [parked] } }
    : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule, occurrences: [occurrence], runs: [parked], steps: [] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-agenda-entry="occurrence"] > button')!.click());
  expect(button('继续本次').disabled).toBe(true); expect(document.querySelector('.agenda-event-detail')?.textContent).toContain(marker === 'pausedByRuleId' ? '请先恢复所属日程规则' : '请先恢复所属长期方向');
});

it('keeps host system maintenance folded outside daily life and unites scheduled and long-term tasks', async () => {
  const goal = companionAgendaGoalSchema.parse({ id: 'long-goal', companionId: owner.id, title: '持续学习怎样表达', intent: '在真实交流中练习', domain: 'persona', successCriteria: ['保留真实练习依据'], revision: 1, status: 'active', origin: 'self', createdAt: at, updatedAt: at });
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: view } : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: [{ form: 'scheduled', rule }, { form: 'longterm', goal }], agendaHasMore: false } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} modal={false} />);
  expect(document.querySelector('[data-agenda-entry="rule:memory"]')).toBeNull();
  expect(document.querySelector<HTMLDetailsElement>('.agenda-system-overview')?.open).toBe(false);
  expect([...document.querySelectorAll('[role="tab"]')].map(node => node.textContent)).toEqual(['日常', '任务', '系统事件']);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'agenda.read', compactRecurring: true }));
  await click('任务');
  expect(request).toHaveBeenCalledWith({ type: 'agenda.tasks.read', companionId: owner.id, limit: 50, executionStatus: 'active' });
  expect(document.querySelector('[data-agenda-task="reading"]')).not.toBeNull(); expect(document.querySelector('[data-agenda-goal="long-goal"]')).not.toBeNull();
  expect(document.querySelector('[data-agenda-goal="long-goal"]')!.textContent).toContain('持续学习怎样表达');
});

it('keeps daily meals and ordinary chat in daily life while listing only deliberate work as tasks', async () => {
  const meal = companionAgendaRuleSchema.parse({ ...rule, id: 'daily-meal', title: '用餐', category: 'daily', classification: { basis: 'daily_routine', reason: '日常作息。' },
    kind: 'rest', executor: 'routine', clock: 'world', routine: { kind: 'meal', name: '用餐' }, trigger: { kind: 'window', startMinute: 480, endMinute: 500, timeZone: 'Asia/Shanghai', probability: 1 } });
  const chat = companionAgendaRuleSchema.parse({ ...rule, id: 'daily-chat', title: '回应收到的消息', category: 'daily', classification: { basis: 'daily_conversation', reason: '普通交流。' }, kind: 'chat', executor: 'chat', referenceId: 'chat-work' });
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, rules: [meal, chat, rule], occurrences: [], runs: [] } }
    : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: [{ form: 'scheduled', rule: meal }, { form: 'scheduled', rule: chat }, { form: 'scheduled', rule }], agendaHasMore: false }
      : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} modal={false} />);
  expect(document.querySelector('[data-agenda-entry="rule:daily-meal"]')).not.toBeNull();
  expect(document.querySelector('[data-agenda-entry="rule:daily-chat"]')).not.toBeNull();
  await click('任务');
  expect(document.querySelector('[data-agenda-task="daily-meal"]')).toBeNull();
  expect(document.querySelector('[data-agenda-task="daily-chat"]')).toBeNull();
  expect(document.querySelector('[data-agenda-task="reading"]')).not.toBeNull();
  await act(async () => root!.render(<CompanionAgendaSummary companionId={owner.id} request={request} onOpen={vi.fn()} />));
  expect(document.querySelector('[aria-label="伙伴日程摘要"]')?.textContent).toContain('用餐');
  expect(document.querySelector('[aria-label="伙伴日程摘要"]')?.textContent).toContain('回应收到的消息');
});

it('refreshes an open task sidebar only from actual host registration and change notifications', async () => {
  let changed: (() => void) | undefined;
  let hostView: CompanionAgendaView = { ...view, rules: [], occurrences: [], runs: [] };
  let hostTasks: Array<{ form: 'scheduled'; rule: typeof rule }> = [];
  const api = { onChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; } };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: hostView }
    : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: hostTasks, agendaHasMore: false } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} initialView="upcoming" request={request} api={api} onClose={vi.fn()} modal={false} />);
  expect(document.querySelector('[data-agenda-task="reading"]')).toBeNull();
  hostView = { ...view, rules: [rule], runs: [{ ...run, stage: 'DSH 正在核对这份实际报告。' }] };
  hostTasks = [{ form: 'scheduled', rule }];
  await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(850); });
  expect(document.querySelector('[data-agenda-task="reading"]')?.textContent).toContain('DSH 正在核对这份实际报告。');
  hostView = { ...hostView, runs: [{ ...run, status: 'completed', stage: '实际报告已核对完成。' }] };
  await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(850); });
  expect(document.querySelector('[data-agenda-task="reading"]')?.textContent).toContain('实际报告已核对完成。');
  expect(request.mock.calls.filter(([input]) => input.type === 'agenda.tasks.read')).toHaveLength(3);
});

it('renders a real execution task and opens its original action popup without inventing a schedule rule', async () => {
  let changed: (() => void) | undefined;
  const execution = { id: 'actual-dsh-action', companionId: owner.id, conversationId: 'owner-private', sourceMessageId: 'real-source', title: '核对报告中的引用', status: 'running' as const,
    stage: '正在读取报告的原始资料。', createdAt: at, updatedAt: at, canResume: false, contentAvailable: true, taskId: 'native-task' };
  let stage = execution.stage;
  const unavailable = { ...execution, id: 'withdrawn-action', contentAvailable: false, title: '不可展示的旧标题', stage: '不可展示的旧阶段' };
  const api = { onChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined; }; } };
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, rules: [], occurrences: [], runs: [] } }
    : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: [{ form: 'execution', execution: { ...execution, stage, ...(input.executionStatus === 'ended' ? { status: 'succeeded' as const, stage: '原执行已结束。' } : {}) } }, { form: 'execution', execution: { ...execution, id: 'waiting-action', waitingApproval: true, stage: '等待你确认执行权限。' } }, { form: 'execution', execution: unavailable }, { form: 'execution', execution: { ...execution, id: 'foreign', companionId: 'other-owner' } }], agendaHasMore: false } : { ok: true });
  const onOpenAction = vi.fn();
  await mount(<CompanionAgenda companions={[owner]} initialView="upcoming" request={request} api={api} onClose={vi.fn()} onOpenAction={onOpenAction} modal={false} />);
  const row = document.querySelector('[data-agenda-execution="actual-dsh-action"]')!;
  expect(row.textContent).toContain(execution.title); expect(row.textContent).toContain(execution.stage); expect(row.textContent).toContain('正在进行');
  expect(document.querySelector('[data-agenda-execution="foreign"]')).toBeNull();
  expect(document.querySelector('[data-agenda-execution="waiting-action"]')?.textContent).toContain('等待你确认权限');
  const hidden = document.querySelector('[data-agenda-execution="withdrawn-action"]')!;
  expect(hidden.textContent).not.toContain('不可展示的旧'); expect(hidden.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  await act(async () => row.querySelector<HTMLButtonElement>('button')!.click());
  expect(onOpenAction).toHaveBeenCalledExactlyOnceWith(execution.id);
  expect(document.querySelector('.agenda-event-detail')).toBeNull();
  stage = '已找到引用，正在逐条核验。';
  await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(850); });
  expect(document.querySelector('[data-agenda-execution="actual-dsh-action"]')?.textContent).toContain(stage);
  await click('已结束的执行');
  expect(request).toHaveBeenCalledWith({ type: 'agenda.tasks.read', companionId: owner.id, limit: 50, executionStatus: 'ended' });
  expect(document.querySelector('[data-agenda-execution="actual-dsh-action"]')?.textContent).toContain('已完成');
  await click('进行中的执行');
  expect(document.querySelector('[data-agenda-execution="actual-dsh-action"]')?.textContent).toContain(stage);
  expect(request.mock.calls.some(([input]) => input.type === 'agenda.rule.create')).toBe(false);
});

it('shows only the latest recurring result plus its actual next consideration and leaves all history to detail', () => {
  const repeated = companionAgendaRuleSchema.parse({ ...rule, trigger: { kind: 'interval', anchorAt: at, everyMinutes: 5, probability: .7, timeZone: 'UTC' }, nextAt: '2026-10-29T03:05:00Z' });
  const occurrences = Array.from({ length: 12 }, (_, index) => ({ ...occurrence, id: `past-${index}`, state: 'completed' as const, scheduledAt: new Date(Date.parse(at) + index * 300000).toISOString() }));
  const rows = agendaEntries({ ...view, rules: [repeated], occurrences, runs: [], observedAt: '2026-10-29T03:00:00Z' }, 'today', '2026-10-29');
  expect(rows).toHaveLength(2); expect(rows.filter(item => !item.planned).map(item => item.key)).toEqual(['past-11']);
  expect(rows.find(item => item.planned)?.at).toBe('2026-10-29T03:05:00.000Z');
});

it('explicitly combines only the selected generic observation windows with checked new abilities and omits them when unchecked', async () => {
  const observed = companionAgendaGrantSchema.parse({ id: 'generic-observe', companionId: owner.id, title: '允许看编辑器', revision: 1, status: 'active', capabilities: ['observe', 'browser'], allowPublicWeb: true,
    windowIds: ['window:123:0'], captureSources: [{ id: 'window:123:0', title: '我的编辑器', displayId: 'display-one' }], expiresAt: '2026-10-29T04:00:00.000Z', createdAt: at, updatedAt: at });
  const other = { ...observed, id: 'generic-other', title: '另一个范围', windowIds: ['window:456:0'], captureSources: [{ id: 'window:456:0', title: '播放器' }] };
  const grants = [observed, other, { ...observed, id: 'goal-only', goalId: 'private-goal' }, { ...observed, id: 'room-only', conversationId: 'private-room' },
    { ...observed, id: 'expired', expiresAt: at }, { ...observed, id: 'revoked', status: 'revoked' as const }, { ...observed, id: 'foreign', companionId: 'another-owner' }];
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, grants } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  const scope = [...document.querySelectorAll<HTMLDetailsElement>('.agenda-observation')].find(node => node.querySelector('summary')?.textContent?.includes('自主行动范围'))!;
  await act(async () => { scope.open = true; });
  const checkbox = (text: string) => [...scope.querySelectorAll<HTMLLabelElement>('label')].find(label => label.textContent?.trim() === text)!.querySelector<HTMLInputElement>('input')!;
  expect(checkbox('同时使用已允许的观察范围').checked).toBe(false);
  await act(async () => { checkbox('使用 DSH 独立思考').click(); checkbox('同时使用已允许的观察范围').click(); });
  expect(button('保存持续范围').disabled).toBe(true);
  await act(async () => scope.querySelector<HTMLElement>('[role="combobox"]')!.click());
  expect([...document.querySelectorAll('[role="option"]')].map(node => node.getAttribute('data-value'))).toEqual(['generic-observe', 'generic-other']);
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"][data-value="generic-observe"]')!.click());
  expect(scope.textContent).toContain('仅使用：我的编辑器'); await click('保存持续范围');
  let writes = request.mock.calls.map(([input]) => input).filter(input => input.type === 'agenda.grant.configure');
  expect(writes).toHaveLength(1); expect(writes[0]!.grant).toEqual({ title: '自主探索与学习', capabilities: ['dsh', 'observe'], windowIds: ['window:123:0'], captureSources: observed.captureSources,
    expiresAt: observed.expiresAt, fileRoots: [], outputRoots: [], allowPublicWeb: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(900); checkbox('同时使用已允许的观察范围').click(); }); await click('保存持续范围');
  writes = request.mock.calls.map(([input]) => input).filter(input => input.type === 'agenda.grant.configure');
  expect(writes).toHaveLength(2); expect(writes[1]!.grant).toEqual({ title: '自主探索与学习', capabilities: ['dsh'], windowIds: [], captureSources: [], fileRoots: [], outputRoots: [], allowPublicWeb: false });
});

it('shows verified concrete activity presentation in daily/task/detail views without changing its stored rule controls', async () => {
  const activity = { ...rule, id: 'native-activity', title: '接续一项持续虚拟行动', intent: '只接续绑定的原生目标。', executor: 'activity' as const,
    presentation: { title: '去姐姐家聊周末的安排', intent: '到了姐姐的小屋后，问问她周末是否一起去公园。' } };
  const before = JSON.stringify(activity);
  const request = vi.fn<AgendaRequest>(async input => input.type === 'agenda.read' ? { ok: true, agenda: { ...view, rules: [activity], occurrences: [], runs: [] } }
    : input.type === 'agenda.tasks.read' ? { ok: true, agendaTasks: [{ form: 'scheduled', rule: activity }], agendaHasMore: false }
      : input.type === 'agenda.event.read' ? { ok: true, agendaEvent: { rule: activity, occurrences: [], runs: [], steps: [] } } : { ok: true });
  await mount(<CompanionAgenda companions={[owner]} request={request} onClose={vi.fn()} />);
  const daily = document.querySelector('[data-agenda-entry="rule:native-activity"]')!;
  expect(daily.textContent).toContain(activity.presentation.title); expect(daily.textContent).toContain(activity.presentation.intent); expect(daily.textContent).not.toContain(activity.title);
  await act(async () => daily.querySelector<HTMLButtonElement>('button')!.click());
  const detail = document.querySelector('[role="dialog"][aria-label="日程详情：去姐姐家聊周末的安排"]')!;
  expect(detail.textContent).toContain(activity.presentation.intent); await click('暂停未来安排');
  const control = request.mock.calls.map(([input]) => input).find(input => input.type === 'agenda.rule.control')!;
  expect(control).toEqual({ type: 'agenda.rule.control', companionId: owner.id, id: activity.id, expectedRevision: activity.revision, action: 'pause', operationId: expect.any(String) });
  await click('关闭日程详情'); await click('任务');
  expect(document.querySelector('[data-agenda-task="native-activity"]')?.textContent).toContain(activity.presentation.title);
  expect(document.querySelector('[data-agenda-task="native-activity"]')?.textContent).toContain(activity.presentation.intent); expect(JSON.stringify(activity)).toBe(before);
});
