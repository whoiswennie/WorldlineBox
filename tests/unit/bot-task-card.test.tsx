// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotTaskCard } from '../../src/renderer/companion-bot/BotTaskCard';
import type { BotRequest, BotResponse, BotTask } from '../../src/shared/companion-bot';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
const base: BotTask = { id: 'task', conversationId: 'private', companionId: 'alice', goal: '完成项目', status: 'running' };
async function mount(task: BotTask, response: () => BotResponse = () => ({ ok: true })) {
  const requests: BotRequest[] = []; let refreshes = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotTaskCard task={task} locale="zh-CN" request={async input => { requests.push(input); return response(); }} changed={async () => { refreshes++; }} />));
  return { requests, refreshes: () => refreshes };
}
async function click(text: string) { const button = [...host.querySelectorAll('button')].find(item => item.textContent === text)!; await act(() => button.click()); }
async function input(selector: string, value: string) { const field = host.querySelector<HTMLTextAreaElement>(selector)!; await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('submits the real question IDs and selections, retaining the request ID after a lost response', async () => {
  let attempt = 0;
  const f = await mount({ ...base, status: 'waiting', attention: { id: 'batch', callId: 'ask', state: 'queued', questions: [{ id: 'style', question: '选择格式', options: [{ label: '表格' }, { label: '正文' }] }] } },
    () => ++attempt === 1 ? { ok: false, error: 'temporary' } : { ok: true });
  expect(host.querySelector<HTMLButtonElement>('form button')!.disabled).toBe(true);
  await act(() => host.querySelector<HTMLInputElement>('input')!.click());
  await input('textarea', '保留来源');
  await click('提交回答'); await click('提交回答');
  expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
  expect(f.requests[0]).toMatchObject({ type: 'task.control', taskId: 'task', conversationId: 'private', operation: 'answer', questionId: 'batch', answers: [{ id: 'style', selected: ['表格'], custom: '保留来源' }] });
  expect(f.refreshes()).toBe(1); expect(host.textContent).not.toContain('追加指导');
});

it('requires an explicit verified decision for every unknown effect before resuming', async () => {
  const f = await mount({ ...base, status: 'unknown', pendingEffects: [{ callId: 'write', toolName: 'write', argsHash: 'a', argumentsPreview: 'result.txt' }, { callId: 'command', toolName: 'pwsh', argsHash: 'b' }] });
  expect(f.requests).toEqual([]);
  await input('textarea', '已检查实际文件和命令结果');
  const submit = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '核实后继续')!;
  expect(submit.disabled).toBe(true);
  const selects = [...host.querySelectorAll('select')];
  await act(() => { selects[0]!.value = 'already_applied'; selects[0]!.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(submit.disabled).toBe(true);
  await act(() => { selects[1]!.value = 'retry'; selects[1]!.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('核实后继续');
  expect(f.requests[0]).toMatchObject({ operation: 'resume', text: '已检查实际文件和命令结果', effectResolutions: [{ callId: 'write', decision: 'already_applied' }, { callId: 'command', decision: 'retry' }] });
});

it('sends a new guidance intent when the user deliberately repeats the same completed input', async () => {
  const f = await mount(base);
  await click('任务详情');
  await input('textarea', '继续检查'); await click('发送指导');
  expect(host.querySelector('textarea')!.value).toBe('');
  await input('textarea', '继续检查'); await click('发送指导');
  expect(f.requests).toHaveLength(2);
  const [first, second] = f.requests as Array<Extract<BotRequest, { type: 'task.control' }>>;
  expect(second!.requestId).not.toBe(first!.requestId);
  expect(second).toMatchObject({ operation: 'send', text: '继续检查' });
});

it('continues the original output-limited task without submitting another goal', async () => {
  let count = 0;
  const f = await mount({ ...base, status: 'waiting', continuationAvailable: true }, () => ++count === 1 ? { ok: false, error: 'temporary' } : { ok: true });
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('等待继续');
  await click('继续任务'); await click('继续任务');
  expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
  expect(f.requests[0]).toMatchObject({ type: 'task.control', operation: 'continue', taskId: base.id, conversationId: base.conversationId });
});

it('shows a terminal result even when its last live phase was finalizing', async () => {
  await mount({ ...base, status: 'succeeded', progress: { phase: 'finalizing' }, summary: 'actual output' });
  expect(host.querySelector('.bot-task-activity [role="status"]')?.textContent).toBe('已完成');
  expect(host.textContent).not.toContain('正在整理结果');
});

it('does not offer continuation from a retained checkpoint after the task was stopped', async () => {
  await mount({ ...base, status: 'cancelled', continuationAvailable: true, cancelRequested: true });
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '继续任务')).toBe(false);
});

it('shows legacy stopped tasks as finished and keeps old diagnostics in the activity tab only', async () => {
  const f = await mount({ ...base, status: 'waiting', cancelRequested: true, progress: { phase: 'stop-unconfirmed' }, diagnostic: { attempts: 58, stage: 'attach', message: 'Timed out attaching to the original session; sanitized host receipt.' } });
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已停止');
  expect(host.querySelector('.bot-task-diagnostic')).toBeNull();
  expect(host.querySelector('.bot-task-stage-flow')).toBeNull();
  expect(host.textContent).not.toContain('核实停止');
  expect(host.textContent).not.toContain('等待执行器');
  await click('移除记录'); expect(f.requests[0]).toMatchObject({ type: 'task.control', taskId: base.id, operation: 'remove' });
  await click('执行记录');
  const diagnostic = host.querySelector('.bot-task-diagnostic')!;
  expect(diagnostic.textContent).toContain('接入原会话'); expect(diagnostic.textContent).toContain('已尝试 58 次');
  expect(diagnostic.querySelector('pre')?.textContent).toContain('Timed out attaching');
});

it('does not present stale connection diagnostics as a current terminal failure', async () => {
  await mount({ ...base, status: 'succeeded', progress: { phase: 'recovering' }, diagnostic: { attempts: 2, stage: 'stream', message: 'old temporary disconnect' } });
  expect(host.querySelector('.bot-task-diagnostic')).toBeNull();
});

it('stops immediately and offers normal record removal after the command is saved', async () => {
  let resolve!: (value: BotResponse) => void;
  const pending = new Promise<BotResponse>(done => { resolve = done; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotTaskCard task={base} locale="zh-CN" request={() => pending} changed={async () => undefined} />));
  await click('停止任务');
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已停止');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('已停止');
  expect(host.textContent).not.toContain('停止确认');
  expect(host.querySelector('.bot-task-stage-flow')).toBeNull();
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '移除记录')?.disabled).toBe(true);
  await act(() => resolve({ ok: true }));
  expect(host.querySelector('[role="status"]')?.textContent).toBe('已停止');
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '移除记录')?.disabled).toBe(false);
});

it('freezes a legacy stopped task at its original stop time across an overnight wait', async () => {
  vi.useFakeTimers(); const now = new Date('2026-11-04T05:00:00Z'); vi.setSystemTime(now);
  await mount({ ...base, createdAt: new Date(now.getTime() - 120000).toISOString(), stopRequestedAt: new Date(now.getTime() - 35000).toISOString(), cancelRequested: true, progress: { phase: 'stopping' } });
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时1 分 25 秒');
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已停止');
  const text = host.querySelector('.bot-task-metrics')?.textContent;
  await act(() => vi.advanceTimersByTime(24 * 60 * 60 * 1000));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe(text);
  expect(host.textContent).not.toContain('等待停止');
  expect(host.textContent).not.toContain('核实停止');
});

it('treats a persisted stop as finished even when an old snapshot still calls it queued', async () => {
  await mount({ ...base, status: 'queued', cancelRequested: true, progress: { phase: 'queued' } });
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已停止');
  expect(host.querySelector('.bot-task-heading')?.textContent).not.toContain('排队中');
  expect(host.querySelector('.bot-task-stage-flow')).toBeNull();
  expect(host.textContent).not.toContain('执行中');
  expect(host.textContent).toContain('移除记录');
});

it('provides keyboard navigation between task tabs and restores the selected tab focus', async () => {
  await mount(base);
  const overview = host.querySelector<HTMLButtonElement>('[role="tab"][aria-selected=true]')!;
  await act(() => { overview.focus(); overview.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  expect(document.activeElement?.textContent).toBe('执行记录');
  expect(host.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(document.activeElement?.id);
  await act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(document.activeElement?.textContent).toBe('任务详情');
  expect(host.querySelector('.bot-task-goal')).not.toBeNull();
});

it('keeps an acknowledged stop request when only the subsequent status refresh fails', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotTaskCard task={base} locale="zh-CN" request={async () => ({ ok: true })} changed={async () => { throw new Error('read transport unavailable'); }} />));
  await click('停止任务');
  expect(host.querySelector('[role="status"]')?.textContent).toBe('已停止');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('请求已记录，但状态刷新失败');
  expect(host.textContent).not.toContain('停止请求的接收状态尚未确认');
});

it('pauses immediately and resumes the same task through its distinct operation', async () => {
  const requests: BotRequest[] = []; let resolve!: (response: BotResponse) => void;
  const pending = new Promise<BotResponse>(done => { resolve = done; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const request = async (input: BotRequest) => { requests.push(input); return requests.length === 1 ? pending : { ok: true }; };
  await act(() => root!.render(<BotTaskCard task={base} locale="zh-CN" request={request} changed={async () => undefined} />));
  await click('暂停任务');
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已暂停');
  expect(host.querySelector('[role=status]')?.textContent).toContain('任务已暂停');
  expect(host.textContent).not.toContain('等待执行器确认暂停');
  expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '继续任务')?.disabled).toBe(true);
  await act(() => resolve({ ok: true }));
  await act(() => root!.render(<BotTaskCard task={{ ...base, status: 'paused', pausedAt: '2026-11-04T05:00:00Z', progress: { phase: 'paused' } }} locale="zh-CN" request={request} changed={async () => undefined} />));
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已暂停');
  await click('继续任务');
  expect(requests[0]).toMatchObject({ operation: 'pause', taskId: base.id }); expect(requests[1]).toMatchObject({ operation: 'resume_paused', taskId: base.id });
});

it('turns legacy pause intents into a simple paused view with a resume action', async () => {
  const f = await mount({ ...base, status: 'waiting', pauseRequested: true, progress: { phase: 'pause-unconfirmed' } });
  expect(host.querySelector('.bot-task-heading')?.textContent).toContain('已暂停');
  expect(host.textContent).not.toContain('核实暂停');
  expect(host.querySelector('.bot-task-stage-flow')).toBeNull();
  await click('继续任务'); expect(f.requests[0]).toMatchObject({ operation: 'resume_paused', taskId: base.id });
});

it('removes only a terminal task record and never offers removal for active or paused work', async () => {
  const f = await mount({ ...base, status: 'cancelled' }); await click('移除记录');
  expect(f.requests[0]).toMatchObject({ operation: 'remove', taskId: base.id });
  await act(() => root!.render(<BotTaskCard task={{ ...base, status: 'paused' }} locale="zh-CN" request={async () => ({ ok: true })} changed={async () => undefined} />));
  expect([...host.querySelectorAll('button')].some(button => button.textContent === '移除记录')).toBe(false);
  expect(host.textContent).toContain('停止任务');
});


it('uses accumulated execution time for pause, resume and terminal updates without counting idle intervals', async () => {
  vi.useFakeTimers(); const now = new Date('2026-11-06T01:00:00Z'); vi.setSystemTime(now);
  const pausedTask: BotTask = { ...base, status: 'paused', createdAt: '2026-11-05T01:00:00Z', elapsedMs: 42000, updatedAt: now.toISOString() };
  await mount(pausedTask);
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时42 秒');
  await act(() => vi.advanceTimersByTime(12 * 60 * 60 * 1000));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时42 秒');
  const startedAt = new Date().toISOString();
  await act(() => root!.render(<BotTaskCard task={{ ...pausedTask, status: 'running', timerStartedAt: startedAt, updatedAt: startedAt }} locale="zh-CN" request={async () => ({ ok: true })} changed={async () => undefined} />));
  await act(() => vi.advanceTimersByTime(5000));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时47 秒');
  await act(() => root!.render(<BotTaskCard task={{ ...pausedTask, status: 'cancelled', elapsedMs: 47000, updatedAt: new Date().toISOString() }} locale="zh-CN" request={async () => ({ ok: true })} changed={async () => undefined} />));
  await act(() => vi.advanceTimersByTime(60 * 60 * 1000));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时47 秒');
});

it('retains the stop request identity and offers a plain retry when saving the command fails', async () => {
  let attempts = 0;
  const f = await mount(base, () => ++attempts === 1 ? { ok: false, error: '停止操作未保存，请重试' } : { ok: true });
  await click('停止任务');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('停止操作未保存');
  expect(host.querySelector('[role=status]')?.textContent).toBe('执行中');
  await click('停止任务');
  expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]);
  expect(host.querySelector('[role=status]')?.textContent).toBe('已停止');
});


it('freezes the live clock at the click even while saving the stop command is delayed', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T01:00:05Z'));
  let resolve!: (value: BotResponse) => void;
  const pending = new Promise<BotResponse>(done => { resolve = done; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<BotTaskCard task={{ ...base, elapsedMs: 20000, timerStartedAt: '2026-11-06T01:00:00Z' }} locale="zh-CN" request={() => pending} changed={async () => undefined} />));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时25 秒');
  await click('停止任务');
  await act(() => vi.advanceTimersByTime(16 * 60 * 60 * 1000));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时25 秒');
  expect(host.querySelector('[role=status]')?.textContent).toBe('已停止');
  await act(() => resolve({ ok: true }));
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时25 秒');
});


it('does not let a late active snapshot or changed question form revive an accepted stop', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T01:00:05Z'));
  const original = { ...base, elapsedMs: 20000, timerStartedAt: '2026-11-06T01:00:00Z' };
  await mount(original);
  await click('停止任务');
  await act(() => root!.render(<BotTaskCard task={{ ...original, status: 'waiting', attention: { id: 'late-batch', callId: 'late-ask', state: 'queued', questions: [{ id: 'question', question: '旧执行器问题' }] } }} locale="zh-CN" request={async () => ({ ok: true })} changed={async () => undefined} />));
  await act(() => vi.advanceTimersByTime(60 * 60 * 1000));
  expect(host.querySelector('[role=status]')?.textContent).toBe('已停止');
  expect(host.querySelector('.bot-task-metrics')?.textContent).toBe('执行用时25 秒');
  expect(host.textContent).not.toContain('旧执行器问题');
  expect(host.textContent).toContain('移除记录');
});
