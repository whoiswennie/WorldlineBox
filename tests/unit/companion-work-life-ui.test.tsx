// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionWorkManager } from '../../src/renderer/companions/CompanionWorkManager';
import { CompanionLifeEvents } from '../../src/renderer/companions/CompanionLifeEvents';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import type { CompanionWorkOrder } from '../../src/shared/companion-work-order';
import type { CompanionLifeRule } from '../../src/shared/companion-life-event';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-15T08:00:00.000Z';
const companions: Companion[] = BUILTIN_COMPANIONS.slice(0, 3).map(item => ({ ...item, builtin: true, createdAt: at }));
const companion = companions[0]!;
const order: CompanionWorkOrder = { id: 'order1', companionId: companion.id, publisherId: companions[1]!.id, conversationId: 'room', sourceMessageId: 'source', authorizationSourceMessageIds: ['source'], title: '帮朋友读一篇文章', instruction: '完整阅读伙伴提供的文章，写出三点想法。\n不需要操作玩家电脑。', execution: 'internal', status: 'offered', revision: 4, createdAt: at, worldCreatedAt: at, updatedAt: at };
const rule: CompanionLifeRule = { id: 'rule1', companionId: companion.id, title: '夜间问候朋友', enabled: false, startMinute: 23 * 60, endMinute: 60, probability: .35, action: 'message', targetId: companions[1]!.id, revision: 7, createdAt: at };
type Request = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
async function mount(node: ReactNode) { vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(async () => root!.render(node)); await act(() => vi.advanceTimersByTimeAsync(30)); }
function button(label: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function fill(label: string, value: string) { const element = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function choose(label: string, value: string) { const element = container!.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!; await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); }
function work(request: Request, onOpenAction = vi.fn()) { return <CompanionWorkManager companion={companion} companions={companions} conversationId="room" request={request} onClose={vi.fn()} onOpenAction={onOpenAction} onDismissError={vi.fn()} />; }

it('keeps a failed creation for an identical retry, publishes the full request and selects the returned order', async () => {
  const attempts: CompanionsRequest[] = []; let orders: CompanionWorkOrder[] = [];
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse | undefined> => {
    if (input.type === 'work-order.list') return { ok: true, workOrderPage: { items: orders, hasMore: false } };
    if (input.type === 'work-order.create') { attempts.push(input); if (attempts.length === 1) return; orders = [{ ...order, publisherId: 'user', execution: 'external', status: 'accepted', title: input.title, instruction: input.instruction }]; return { ok: true, workOrder: orders[0] }; }
    return { ok: true };
  });
  await mount(work(request)); await click('发布工作'); await fill('工作标题', '整理读书笔记'); const instruction = '请整理完整笔记，保留所有引用。\n' + '资料内容。'.repeat(600); await fill('工作要求', instruction);
  await click('确认发布工作'); expect(container!.textContent).toContain('工作未保存'); expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(instruction);
  await click('确认发布工作'); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]).toMatchObject({ type: 'work-order.create', companionId: companion.id, conversationId: 'room', title: '整理读书笔记', instruction, clientId: expect.any(String) });
  expect(container!.textContent).toContain('你发布'); expect(container!.textContent).toContain(instruction); expect(container!.querySelector('textarea')).toBeNull();
});

it('accepts genuine peer work without converting it to player authority, preserves revisions and confirms cancellation', async () => {
  let current = order;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type === 'work-order.list') return { ok: true, workOrderPage: { items: [current], hasMore: false } };
    if (input.type === 'work-order.accept') current = { ...current, status: 'accepted', revision: current.revision + 1 };
    if (input.type === 'work-order.pause') current = { ...current, status: input.paused ? 'paused' : 'accepted', revision: current.revision + 1 };
    if (input.type === 'work-order.update') current = { ...current, ...input.patch, revision: current.revision + 1 };
    if (input.type === 'work-order.cancel') current = { ...current, status: 'cancelled', revision: current.revision + 1 };
    return { ok: true, workOrder: current };
  });
  await mount(work(request)); expect(container!.textContent).toContain(companions[1]!.name + '发布'); expect(container!.textContent).toContain('伙伴内部工作');
  await click('接受工作'); expect(request).toHaveBeenCalledWith({ type: 'work-order.accept', companionId: companion.id, conversationId: 'room', id: order.id, expectedRevision: 4 });
  expect([...container!.querySelectorAll('button')].some(item => item.textContent === '修改要求')).toBe(false);
  await click('暂停工作'); expect([...container!.querySelectorAll('button')].some(item => item.textContent === '修改要求')).toBe(false);
  await click('恢复工作'); await click('取消工作'); expect(request.mock.calls.some(([input]) => input.type === 'work-order.cancel')).toBe(false);
  await click('确认取消工作'); expect(request).toHaveBeenCalledWith({ type: 'work-order.cancel', companionId: companion.id, conversationId: 'room', id: order.id, expectedRevision: 7 });
});

it('edits paused player work only within its original conversation and submits the loaded revision', async () => {
  const current: CompanionWorkOrder = { ...order, publisherId: 'user', execution: 'external', status: 'paused' };
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'work-order.list' ? { ok: true, workOrderPage: { items: [current], hasMore: false } } : { ok: true, workOrder: current });
  await mount(work(request)); await click('修改要求'); await fill('工作要求', '改为写五点想法，保留原文出处。'); await click('保存工作修改');
  expect(request).toHaveBeenCalledWith({ type: 'work-order.update', companionId: companion.id, conversationId: 'room', id: order.id, expectedRevision: 4, patch: { title: order.title, instruction: '改为写五点想法，保留原文出处。' } });
});

it('pages scoped work history and routes actual action IDs to execution details without inventing results', async () => {
  const open = vi.fn(); const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'work-order.list' ? { ok: true, workOrderPage: input.before ? { items: [{ ...order, id: 'old', status: 'completed', actionId: 'actual-action', result: '真实保存的结果' }], hasMore: false } : { items: [order], hasMore: true, nextBefore: 12 } } : { ok: true });
  await mount(work(request, open)); await click('全部记录'); await click('读取更多工作');
  expect(request).toHaveBeenCalledWith({ type: 'work-order.list', companionId: companion.id, conversationId: 'room', includeHistory: true, limit: 40, before: 12 });
  await act(async () => container!.querySelector<HTMLButtonElement>('[data-work-order="old"]')!.click()); await click('查看执行过程'); expect(open).toHaveBeenCalledWith('actual-action'); expect(container!.textContent).toContain('真实保存的结果');
});

it('shows work revision conflicts without clearing the unsaved request', async () => {
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'work-order.list' ? { ok: true, workOrderPage: { items: [{ ...order, publisherId: 'user', execution: 'external', status: 'paused' }], hasMore: false } } : { ok: false, error: '工作单已更新，请刷新后重试。' });
  await mount(work(request)); await click('修改要求'); await fill('工作标题', '未保存的新标题'); await click('保存工作修改'); expect(container!.textContent).toContain('工作单已更新'); expect(container!.querySelector<HTMLInputElement>('[aria-label="工作标题"]')!.value).toBe('未保存的新标题');
});

it('edits repeated life rhythm and probability while preserving disabled status and owner revision', async () => {
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'life-rule.list' ? { ok: true, lifeRules: [rule], lifeOccurrences: [] } : { ok: true });
  await mount(<CompanionLifeEvents companion={companion} companions={companions} request={request} />);
  expect(container!.textContent).toContain('23:00—次日 01:00'); await click('编辑事件'); await fill('日常事件机会百分比', '42');
  await fill('日常事件评估间隔分钟', '10'); await fill('日常事件行动冷却分钟', '75');
  await fill('日常事件沉默冷却分钟', '25'); await fill('日常事件失败冷却分钟', '35'); await click('保存日常事件');
  expect(request).toHaveBeenCalledWith({ type: 'life-rule.update', companionId: companion.id, id: rule.id, expectedRevision: 7, rule: { title: rule.title, enabled: false, startMinute: 1380, endMinute: 60, probability: .42, action: 'message', targetId: companions[1]!.id,
    checkIntervalMinutes: 10, actionCooldownMinutes: 75, silenceCooldownMinutes: 25, failureCooldownMinutes: 35 } });
  await click('启用事件'); expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'life-rule.update', expectedRevision: 7, rule: expect.objectContaining({ enabled: true }) }));
  await click('移除事件'); expect(request.mock.calls.some(([input]) => input.type === 'life-rule.remove')).toBe(false); await click('确认移除事件'); expect(request).toHaveBeenCalledWith({ type: 'life-rule.remove', companionId: companion.id, id: rule.id, expectedRevision: 7 });
});

it('creates an exact day-end window, removes player visit targets, and never submits invalid equal-time windows', async () => {
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'life-rule.list' ? { ok: true, lifeRules: [], lifeOccurrences: [] } : { ok: true });
  await mount(<CompanionLifeEvents companion={companion} companions={companions} request={request} />); await click('添加日常事件'); await fill('日常事件名称', '午夜前看看朋友'); await choose('日常事件对象', 'user'); await choose('日常事件动作', 'visit');
  expect([...container!.querySelectorAll<HTMLOptionElement>('[aria-label="日常事件对象"] option')].some(item => item.value === 'user' || item.value === companion.id)).toBe(false);
  await fill('日常事件开始时间', '18:00'); await fill('日常事件结束时间', '18:00'); await click('保存日常事件'); expect(request.mock.calls.some(([input]) => input.type === 'life-rule.create')).toBe(false);
  await fill('日常事件结束时间', '24:00'); await choose('日常事件对象', companions[1]!.id); await click('保存日常事件'); expect(request).toHaveBeenCalledWith({ type: 'life-rule.create', companionId: companion.id, clientId: expect.any(String), rule: { title: '午夜前看看朋友', enabled: true, startMinute: 1080, endMinute: 1440, probability: .35, action: 'visit', targetId: companions[1]!.id,
    checkIntervalMinutes: 15, actionCooldownMinutes: 90, silenceCooldownMinutes: 20, failureCooldownMinutes: 30 } });
});
