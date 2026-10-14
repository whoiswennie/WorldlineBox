// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryPanel } from '../../src/renderer/companions/CompanionMemoryPanel';
import type { CompanionMemory, CompanionMessage, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; vi.useRealTimers(); });
const at = '2026-10-14T08:00:00.123Z';
const memory: CompanionMemory = { id: 'memory-a', companionId: 'role', content: '喜欢喝淡咖啡', origin: 'companion', captureMethod: 'automatic', createdAt: at, updatedAt: at, kind: 'preference', status: 'active', epistemicStatus: 'asserted', version: 2, sourceMessageId: 'source', sourceConversationId: 'room', tags: [{ id: 'coffee', name: '咖啡', type: 'topic', aliases: ['coffee'] }] };
const source: CompanionMessage = { id: 'source', conversationId: 'room', sequence: 200, authorId: 'user', content: '我喜欢喝淡咖啡。', status: 'sent', kind: 'text', attachments: [], createdAt: at };
const processing = { pending: 1, running: 0, failed: 1, completed: 199, memories: 21, forgotten: 0, messageWatermark: 200, extractionWatermark: 199, backfillThrough: 200, backfillTarget: 200, lastError: '模型暂时不可用' };
type Request = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
async function mount(request: Request, onLocateSource = vi.fn(), api?: WorldlineBoxCompanionsApi) {
  vi.useFakeTimers();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionMemoryPanel companionId="role" conversationId="room" conversationKind="group" request={request} api={api} onLocateSource={onLocateSource} authorName={id => id === 'user' ? '我' : '测试伙伴'} />));
  await advance();
  return onLocateSource;
}
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); }
function button(label: string, scope: ParentNode = container!) { const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label); if (!found) throw new Error(`Missing button ${label}`); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function select(label: string, value: string) { const element = container!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); await advance(); }
async function fill(label: string, value: string) { const element = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
function fixture() {
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type === 'memory.status') return { ok: true, memoryStatus: processing };
    if (input.type === 'memory.browse') return { ok: true, memoryPage: { items: [{ memory: input.cursor ? { ...memory, id: 'memory-old', content: '以前喜欢浓咖啡', status: 'superseded' } : memory, reasons: ['标签：咖啡'], path: [] }], hasMore: !input.cursor, ...(!input.cursor ? { nextCursor: 20 } : {}) } };
    if (input.type === 'memory.inspect') return { ok: true, memoryRead: { memory, sources: [source], related: [{ ...memory, id: 'memory-v1', status: 'superseded', version: 1, content: '以前喜欢浓咖啡' }], hasMore: false } };
    return { ok: true };
  });
  return request;
}

it('searches and paginates with partner and conversation scope, and resets the cursor for type and history filters', async () => {
  const request = fixture(); await mount(request);
  expect(container!.textContent).toContain('当前群聊可见的记忆');
  expect(container!.textContent).toContain('偏好');
  expect(container!.textContent).toContain('明确表达');
  expect(container!.textContent).toContain('咖啡');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.browse', companionId: 'role', conversationId: 'room', status: 'active', includeHistory: false, limit: 20 }));
  await click('下一页'); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'memory.browse', cursor: 20 }));
  expect(container!.textContent).toContain('第 2 页');
  await select('记忆类型', 'event');
  const search = request.mock.calls.filter(([input]) => input.type === 'memory.browse').at(-1)![0];
  expect(search).toMatchObject({ kind: 'event' }); expect(search).not.toHaveProperty('cursor');
  expect(container!.textContent).toContain('第 1 页');
  await select('记忆状态', 'history');
  const historical = request.mock.calls.filter(([input]) => input.type === 'memory.browse').at(-1)![0];
  expect(historical).toMatchObject({ includeHistory: true }); expect(historical).not.toHaveProperty('status');
  await fill('搜索共同记忆', '旧约定'); await advance();
  expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'memory.browse', query: '旧约定' }));
});

it('exposes durable extraction errors and retry without requiring the user to create memories', async () => {
  const request = fixture(); await mount(request);
  expect(container!.textContent).toContain('收录遇到问题');
  expect(container!.textContent).toContain('200 / 199');
  expect(container!.textContent).toContain('模型暂时不可用');
  expect(request).toHaveBeenCalledWith({ type: 'memory.status', companionId: 'role', conversationId: 'room' });
  expect(request.mock.calls.some(([input]) => input.type === 'memory.save')).toBe(false);
  await click('重试失败收录');
  expect(request).toHaveBeenCalledWith({ type: 'memory.jobs.retry', companionId: 'role' });
});

it('opens original sources and predecessor records, submits versioned corrections, and confirms scoped forgetting', async () => {
  const request = fixture(); const locate = await mount(request);
  await click('查看记忆来源 memory-a');
  expect(request).toHaveBeenCalledWith({ type: 'memory.inspect', companionId: 'role', conversationId: 'room', id: 'memory-a', sourceLimit: 10 });
  expect(container!.textContent).toContain(source.content); expect(container!.textContent).toContain('以前喜欢浓咖啡');
  await click('定位记忆来源 source'); expect(locate).toHaveBeenCalledWith(source);
  await click('编辑记忆 memory-a'); await fill('共同记忆内容', '现在不喝咖啡了'); await click('保存修正');
  expect(request).toHaveBeenCalledWith({ type: 'memory.save', companionId: 'role', conversationId: 'room', id: 'memory-a', expectedVersion: 2, content: '现在不喝咖啡了', sourceMessageId: 'source' });
  await click('删除记忆 memory-a');
  expect(request.mock.calls.some(([input]) => input.type === 'memory.forget')).toBe(false);
  expect(container!.textContent).toContain('聊天原文仍保留');
  await click('确认遗忘');
  expect(request).toHaveBeenCalledWith({ type: 'memory.forget', companionId: 'role', conversationId: 'room', id: 'memory-a', sourceMessageIds: [], persistent: false });
});

it('keeps a failed correction in the editor and does not claim it was saved', async () => {
  const base = fixture(); const request: Request = input => input.type === 'memory.save' ? Promise.resolve(undefined) : base(input);
  await mount(request); await click('编辑记忆 memory-a'); await fill('共同记忆内容', '新的修正'); await click('保存修正');
  expect(container!.textContent).toContain('记忆未保存');
  expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('新的修正');
});

it('ignores an older search result when the current query has changed', async () => {
  let resolveOld: ((value: CompanionsResponse) => void) | undefined;
  const base = fixture(); const request: Request = input => input.type === 'memory.browse' && input.query === '旧关键词' ? new Promise(resolve => { resolveOld = resolve; }) : base(input);
  await mount(request);
  await fill('搜索共同记忆', '旧关键词'); await advance();
  await fill('搜索共同记忆', '新关键词'); await advance();
  await act(async () => resolveOld!({ ok: true, memoryPage: { items: [{ memory: { ...memory, content: '过时的搜索结果' }, reasons: [], path: [] }], hasMore: false } }));
  expect(container!.textContent).not.toContain('过时的搜索结果');
});

it('shows stored task outcomes as readable evidence and sends navigation to the task record', async () => {
  const base = fixture();
  const taskSource: CompanionMessage = { ...source, kind: 'action', memoryEvidenceOnly: true, actionId: 'task-done', content: JSON.stringify({ title: '整理文件', status: 'succeeded', result: '整理了 6 个文件' }) };
  const request: Request = input => input.type === 'memory.inspect' ? Promise.resolve({ ok: true, memoryRead: { memory, sources: [taskSource], related: [], hasMore: false } }) : base(input);
  const locate = await mount(request); await click('查看记忆来源 memory-a');
  expect(container!.textContent).toContain('整理了 6 个文件');
  expect(container!.textContent).not.toContain('"status":"succeeded"');
  expect(button('查看任务记录')).toBeDefined();
  await click('定位记忆来源 source'); expect(locate).toHaveBeenCalledWith(taskSource);
});

it('shows forgotten records only as tombstones without edit actions or source content', async () => {
  const base = fixture();
  const tombstone: CompanionMemory = { ...memory, status: 'forgotten', content: '已遗忘的记忆', sourceMessageId: undefined, subject: undefined, value: undefined, tags: [], sources: [] };
  const request: Request = input => input.type === 'memory.browse' && input.status === 'forgotten' ? Promise.resolve({ ok: true, memoryPage: { items: [{ memory: tombstone, reasons: [], path: [] }], hasMore: false } })
    : input.type === 'memory.inspect' ? Promise.resolve({ ok: true, memoryRead: { memory: tombstone, sources: [], related: [], hasMore: false } }) : base(input);
  await mount(request); await select('记忆状态', 'forgotten');
  expect(container!.textContent).toContain('已遗忘的记忆');
  expect(container!.textContent).not.toContain('喜欢喝淡咖啡');
  expect(container!.querySelector('[aria-label="编辑记忆 memory-a"]')).toBeNull();
  await click('查看记忆来源 memory-a');
  expect(container!.textContent).not.toContain(source.content);
});

it('preserves expanded source reading while background memory changes refresh the record', async () => {
  const request = fixture(); let changed: (() => void) | undefined;
  const api: WorldlineBoxCompanionsApi = { request, onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  await mount(request, vi.fn(), api); await click('查看记忆来源 memory-a');
  const details = container!.querySelector<HTMLDetailsElement>('.companions-memory-source')!;
  await act(async () => { details.open = true; changed!(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(container!.querySelector<HTMLDetailsElement>('.companions-memory-source')!.open).toBe(true);
  expect(container!.textContent).toContain(source.content);
});

it('renders human subject names without exposing fact keys or management enums', async () => {
  const base = fixture(); let subject = 'user';
  const request: Request = input => input.type === 'memory.browse' ? Promise.resolve({ ok: true, memoryPage: { items: [{ memory, reasons: ['management'], path: [] }], hasMore: false } })
    : input.type === 'memory.inspect' ? Promise.resolve({ ok: true, memoryRead: { memory: { ...memory, subject, factKey: 'activity:seaside' }, sources: [source], related: [], hasMore: false } }) : base(input);
  await mount(request); await click('查看记忆来源 memory-a');
  expect(container!.textContent).toContain('主体：你');
  expect(container!.textContent).not.toContain('activity:seaside');
  expect(container!.textContent).not.toContain('management');
  await click('查看记忆来源 memory-a'); subject = 'role'; await click('查看记忆来源 memory-a');
  expect(container!.textContent).toContain('主体：测试伙伴');
  await click('查看记忆来源 memory-a'); subject = '阿明'; await click('查看记忆来源 memory-a');
  expect(container!.textContent).toContain('主体：阿明');
});
