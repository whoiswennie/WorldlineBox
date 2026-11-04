// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotMemoryWorkspace } from '../../src/renderer/companion-bot/BotMemoryWorkspace';
import type { BotCompanion, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotMemoryCatalogItem, BotMemoryRecallReport, BotMemoryWorkspaceRequest } from '../../src/shared/companion-bot-memory';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const at = '2026-11-03T03:00:00Z', checksum = 'a'.repeat(32);
const companions: BotCompanion[] = [{ id: 'alice', name: 'Alice', persona: '认真', createdAt: at }, { id: 'bob', name: 'Bob', persona: '活泼', createdAt: at }];
const note = (id = '1', content = '晚上喝麦茶'): BotMemoryCatalogItem => ({ id: id.repeat(64), content, checksum, tags: ['日常'], indexState: 'indexed', createdAt: at });
const first = note();
let root: Root | undefined, host: HTMLDivElement, requests: BotMemoryWorkspaceRequest[], api: WorldlineBoxBotApi;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; vi.useRealTimers(); });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; }
async function mount(handler: (request: BotMemoryWorkspaceRequest) => Promise<BotResponse> | undefined = () => undefined, conversationId = 'private-a') {
  requests = [];
  api = { onEvent: () => () => undefined, async request(input) {
    const request = input as BotMemoryWorkspaceRequest; requests.push(request);
    const handled = handler(request); if (handled) return handled;
    if (request.type === 'memory.catalog') return { ok: true, memory: { items: [first], tags: [{ name: '日常', count: 1 }], total: 1 } };
    if (request.type === 'memory.note') return { ok: true, memory: { ...first, id: request.id, content: '晚上喝麦茶。完整原文，与列表预览不同。' } };
    return { ok: true };
  } };
  host = document.createElement('div'); host.className = 'bot-workspace'; document.body.append(host); root = createRoot(host);
  await render(conversationId);
}
async function render(conversationId = 'private-a', onClose = () => undefined) {
  await act(() => root!.render(<BotMemoryWorkspace api={api} conversationId={conversationId} companions={companions} locale="zh-CN" title={conversationId} onClose={onClose} />));
}
async function click(text: string) { const button = [...host.querySelectorAll<HTMLElement>('button,summary')].find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text)!; expect(button, text).toBeDefined(); await act(() => button.click()); }
async function fill(label: string, text: string) {
  const element = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  expect(element, label).toBeDefined();
  await act(() => { const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function owner(value: string) { const select = host.querySelector<HTMLSelectElement>('[aria-label="伙伴"]')!; await act(() => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function openFirst() { await act(() => host.querySelector<HTMLButtonElement>('.bot-memory-row-open')!.click()); }
const report = (overrides: Partial<BotMemoryRecallReport> = {}): BotMemoryRecallReport => ({ requestId: 'recall-1', query: '周末最后的安排', mode: 'passive', createdAt: at, totalMs: 12.34, stages: [{ name: 'RAG', status: 'ok' }], hits: [
  { rank: 2, text: '原第二顺位，原模块先返回', score: 0.23, scores: { rerank: 0.456 } }, { rank: 1, text: '原第一顺位，原模块后返回', source: '日记原件', date: at },
], ...overrides });

it('shows archived originals and honest empty/unknown capture receipts separately from zero journal notes', async () => {
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: [], tags: [], total: 0,
    activity: { originals: { archived: 18, pending: 0 }, capture: { queued: 0, running: 0, failed: 1, empty: 4, withNotes: 0, unknownDone: 2 } } } }) : undefined);
  expect(host.textContent).toContain('已保留 18 条原话');
  expect(host.textContent).toContain('4 段互动未提炼为日记');
  expect(host.textContent).toContain('2 段旧互动未记录提炼数量');
  expect(host.textContent).toContain('1 段互动提炼未完成');
  expect(host.textContent).toContain('还没有提炼出的日记');
  expect(host.textContent).not.toContain('换个关键词');
  expect(requests.every(request => request.type === 'memory.catalog' && request.limit === 24)).toBe(true);
});
it('quietly refreshes pending capture at a bounded rate and cancels polling on unmount', async () => {
  vi.useFakeTimers();
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: [first], tags: [], total: 1,
    activity: { originals: { archived: 18, pending: 0 }, capture: { queued: 1, running: 0, failed: 0, empty: 0, withNotes: 0, unknownDone: 0 } } } }) : undefined);
  expect(host.textContent).toContain('正在后台提炼 1 段互动');
  const row = host.querySelector('.bot-memory-row');
  for (let i = 0; i < 15; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(requests.filter(request => request.type === 'memory.catalog')).toHaveLength(13);
  expect(host.querySelector('.bot-memory-row')).toBe(row);
  expect(host.querySelector('.bot-memory-list')?.getAttribute('aria-busy')).toBe('false');
  await act(() => root!.unmount()); root = undefined;
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(requests).toHaveLength(13);
});
it('stops quiet catalog refresh when real receipts show the queue has completed', async () => {
  vi.useFakeTimers(); let count = 0;
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: [], tags: [], total: 0,
    activity: { originals: { archived: 18, pending: 0 }, capture: { queued: ++count === 1 ? 1 : 0, running: 0, failed: 0, empty: count === 1 ? 0 : 1, withNotes: 0, unknownDone: 0 } } } }) : undefined);
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(host.textContent).toContain('1 段互动未提炼为日记');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(count).toBe(2);
});

it('keeps the memory workspace open when Escape belongs to Chinese input composition', async () => {
  await mount(); let closed = 0; await render('private-a', () => { closed++; });
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  await act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })));
  expect(closed).toBe(0);
  await act(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(closed).toBe(1);
});

it('opens the scoped organization and dreams tab without discarding an unsaved journal draft', async () => {
  await mount(request => request.type === 'memory.maintenance.list' ? Promise.resolve({ ok: true, memory: { items: [] } })
    : request.type === 'memory.maintenance.settings.get' ? Promise.resolve({ ok: true, memory: { enabled: false, kind: 'organize', intervalHours: 24, idleMinutes: 30, minNotes: 4, autoApply: 'never', nextEligibleAt: at, lastActivityAt: at } }) : undefined);
  await click('新日记'); await fill('日记正文', '还没有保存的完整草稿😀');
  await click('整理与梦境'); expect(host.querySelector('[aria-label="整理与梦境"]')).not.toBeNull();
  expect(requests.find(request => request.type === 'memory.maintenance.list')).toMatchObject({ conversationId: 'private-a', companionId: 'alice', limit: 20 });
  await click('日记'); expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe('还没有保存的完整草稿😀');
  expect(requests.some(request => request.type === 'memory.remember' || request.type === 'memory.maintenance.review')).toBe(false);
});

it('wraps keyboard focus around visible maintenance controls while collapsed settings remain excluded', async () => {
  await mount(request => request.type === 'memory.maintenance.list' ? Promise.resolve({ ok: true, memory: { items: [] } })
    : request.type === 'memory.maintenance.settings.get' ? Promise.resolve({ ok: true, memory: { enabled: true, kind: 'organize', intervalHours: 24, idleMinutes: 15, minNotes: 12, autoApply: 'never', nextEligibleAt: at, lastActivityAt: at } }) : undefined);
  await click('整理与梦境');
  const summary = host.querySelector<HTMLElement>('.bot-maintenance-settings > summary')!;
  expect(summary).not.toBeNull();
  expect(summary.closest('details')?.open).toBe(false);
  const firstControl = host.querySelector<HTMLElement>('.bot-memory-tabs button')!;
  summary.focus();
  const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  await act(() => summary.dispatchEvent(forward));
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(firstControl);
  const reverse = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  await act(() => firstControl.dispatchEvent(reverse));
  expect(reverse.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(summary);
});

it('opens a full note on demand and replaces server pages rather than accumulating the entire library', async () => {
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: request.cursor ? [note('2', '下一页')] : [first], tags: [{ name: '日常', count: 90 }], total: 90, nextCursor: request.cursor ? undefined : 'cursor-2' } }) : undefined);
  expect(requests[0]).toMatchObject({ type: 'memory.catalog', conversationId: 'private-a', companionId: 'alice', limit: 24 });
  expect(requests.some(item => item.type === 'memory.note')).toBe(false);
  await openFirst(); expect(host.querySelector('.bot-memory-fulltext')?.textContent).toContain('完整原文');
  await click('下一页'); expect(host.querySelectorAll('[data-memory-note]')).toHaveLength(1); expect(host.querySelector('.bot-memory-list')?.textContent).not.toContain('晚上喝麦茶');
  expect(requests.filter(item => item.type === 'memory.catalog').at(-1)).toMatchObject({ cursor: 'cursor-2', limit: 24 });
  await fill('筛选日记', '新关键词'); await click('筛选');
  expect(requests.filter(item => item.type === 'memory.catalog').at(-1)).toMatchObject({ query: '新关键词', cursor: undefined });
});
it('keeps edits visible after a CAS conflict and never reports a pending index receipt as saved', async () => {
  let attempt = 0;
  await mount(request => request.type === 'memory.update' ? Promise.resolve(++attempt === 1 ? { ok: false, error: 'MEMORY_CONFLICT stale checksum' } : { ok: true, memory: { id: first.id, checksum, state: 'pending' } }) : undefined);
  await openFirst(); await click('编辑日记'); await fill('日记正文', '新的、尚未确认的修改'); await click('保存修改');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('发生变化');
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe('新的、尚未确认的修改');
  expect(requests.find(item => item.type === 'memory.update')).toMatchObject({ id: first.id, expectedChecksum: checksum, content: '新的、尚未确认的修改', tags: ['日常'] });
  await click('保存修改'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('未取得完整'); expect(host.textContent).not.toContain('修改已保存');
});
it('creates from an empty catalog only after indexed receipts and reuses the same request ID after a lost or pending response', async () => {
  const created = note('3', '本地草稿\n下雨时去看展。'); let attempts = 0, committed = false;
  await mount(request => {
    if (request.type === 'memory.catalog') return Promise.resolve({ ok: true, memory: { items: committed ? [created] : [], tags: [], total: committed ? 1 : 0 } });
    if (request.type === 'memory.note') return Promise.resolve({ ok: true, memory: created });
    if (request.type !== 'memory.remember') return undefined;
    if (++attempts === 1) return Promise.reject(new Error('Response connection lost'));
    if (attempts === 2) return Promise.resolve({ ok: true, memory: { receipts: [{ id: created.id, checksum, state: 'pending' }], indexed: 0, pending: 1, uncertain: 0 } });
    committed = true; return Promise.resolve({ ok: true, memory: { receipts: [{ id: created.id, checksum, state: 'indexed' }], indexed: 1, pending: 0, uncertain: 0 } });
  });
  await click('新日记'); await fill('日记正文', created.content!); await fill('标签，用逗号分隔', '本地测试,计划'); await click('保存日记');
  expect(host.querySelector('.bot-memory-editor .bot-text-field__count')?.textContent).toBe(`${created.content!.length} / 24000`);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe(created.content);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Response connection lost'); expect(host.querySelector('[role="status"]')).toBeNull();
  await click('保存日记'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('未取得完整'); expect(host.querySelector('[role="status"]')).toBeNull();
  await click('保存日记');
  const writes = requests.filter(item => item.type === 'memory.remember'); expect(writes).toHaveLength(3);
  expect(writes[0]).toMatchObject({ conversationId: 'private-a', companionId: 'alice', content: created.content, tags: ['本地测试', '计划'] });
  expect(writes[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/i); expect(new Set(writes.map(item => item.requestId)).size).toBe(1);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('新日记已保存，索引已确认');
  expect(host.querySelector('.bot-memory-fulltext')?.textContent).toContain('下雨时去看展');
  expect(host.querySelectorAll('[data-memory-note]')).toHaveLength(1); expect(host.querySelector('[aria-label="日记正文"]')).toBeNull();
});
it('cancels a new note without submitting, never accepts withdrawn receipts, and renews the request ID after draft changes', async () => {
  await mount(request => request.type === 'memory.remember' ? Promise.resolve({ ok: true, memory: {
    withdrawn: true, receipts: [{ id: '3'.repeat(64), checksum, state: 'indexed' }], indexed: 1,
  } }) : undefined);
  await click('新日记'); await fill('日记正文', '取消的草稿'); await click('取消');
  expect(requests.some(item => item.type === 'memory.remember')).toBe(false);
  await click('新日记'); expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe('');
  await fill('日记正文', '需要确认的事实'); await click('保存日记');
  expect(host.querySelector('[role="status"]')).toBeNull(); expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe('需要确认的事实');
  await fill('日记正文', '已经更正的事实'); await click('保存日记');
  await fill('标签，用逗号分隔', '更正'); await click('保存日记');
  const writes = requests.filter(item => item.type === 'memory.remember'); expect(writes).toHaveLength(3);
  expect(new Set(writes.map(item => item.requestId)).size).toBe(3);
  await click('取消'); await click('新日记'); await fill('日记正文', '已经更正的事实'); await click('保存日记');
  expect(new Set(requests.filter(item => item.type === 'memory.remember').map(item => item.requestId)).size).toBe(4);
});
it('waits for the real withdrawal receipt and leaves a failed forget available to retry', async () => {
  const pending = deferred<BotResponse>(); let attempts = 0;
  await mount(request => request.type === 'memory.forget' ? ++attempts === 1 ? pending.promise : Promise.resolve({ ok: true, memory: { forgotten: true, id: first.id } }) : undefined);
  await openFirst(); await click('更多操作'); await click('忘记这条记忆'); expect(requests.some(item => item.type === 'memory.forget')).toBe(false); await click('确认忘记');
  expect(host.textContent).not.toContain('这条记忆已撤回'); expect(host.querySelector('.bot-memory-fulltext')).not.toBeNull();
  await act(() => pending.resolve({ ok: false, error: '索引删除未确认' })); expect(host.textContent).toContain('索引删除未确认');
  await click('确认忘记'); expect(host.textContent).toContain('这条记忆已撤回');
});
it('organizes only selected checksummed originals and waits for indexed and archived receipts', async () => {
  const notes = [first, note('2', '周五去公园')], pending = deferred<BotResponse>();
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: notes, tags: [], total: 2 } }) : request.type === 'memory.organize' ? pending.promise : undefined);
  for (const checkbox of [...host.querySelectorAll<HTMLInputElement>('.bot-memory-row>input')]) await act(() => checkbox.click());
  await click('整理选中日记'); expect(host.querySelector<HTMLTextAreaElement>('[aria-label="日记正文"]')?.value).toBe('');
  await fill('日记正文', '保留日期与各自观点的整理正文'); await click('保存并归档原记录');
  const mutation = requests.find(item => item.type === 'memory.organize'); expect(mutation).toMatchObject({ sources: notes.map(item => ({ id: item.id, expectedChecksum: item.checksum })), content: '保留日期与各自观点的整理正文' });
  expect(JSON.stringify(mutation)).not.toContain('path'); expect(host.textContent).not.toContain('原记录已归档');
  await act(() => pending.resolve({ ok: true, memory: { id: '3'.repeat(64), checksum, state: 'indexed', archived: [first.id] } }));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('未取得完整'); expect(host.textContent).not.toContain('原记录已归档');
});
it('caps organization selection at sixteen without rendering additional pages', async () => {
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: Array.from({ length: 17 }, (_, i) => ({ ...note(), id: String(i), content: `日记${i}` })), tags: [] } }) : undefined);
  const choices = [...host.querySelectorAll<HTMLInputElement>('.bot-memory-row>input')];
  for (const checkbox of choices.slice(0, 16)) await act(() => checkbox.click());
  expect(choices[16]!.disabled).toBe(true); expect(host.querySelector('.bot-memory-selection')?.textContent).toContain('16/16');
});
it('discards late catalog and full-note responses when the selected companion changes', async () => {
  const oldNote = deferred<BotResponse>(), oldList = deferred<BotResponse>();
  await mount(request => request.type === 'memory.catalog' && request.companionId === 'bob' && request.conversationId === 'private-a' ? oldList.promise : request.type === 'memory.note' ? oldNote.promise : undefined);
  await openFirst(); await owner('bob'); expect(host.querySelector('.bot-memory-fulltext')).toBeNull();
  await act(() => oldNote.resolve({ ok: true, memory: { ...first, content: 'Alice私聊旧请求不能串入' } })); expect(host.textContent).not.toContain('不能串入');
  await render('group-b'); await act(() => oldList.resolve({ ok: true, memory: { items: [{ ...first, content: '旧群的秘密' }], tags: [] } }));
  expect(host.textContent).not.toContain('旧群的秘密');
});
it('displays original ranks and scores without sorting or inventing missing stage measurements', async () => {
  await mount(request => request.type === 'memory.recall' ? Promise.resolve({ ok: true, memory: report() }) : undefined);
  await click('召回试查'); await fill('想回想什么？', '周末最后的安排'); await click('开始试查');
  expect(host.querySelector('.bot-memory-recall-query .bot-text-field__count')?.textContent).toBe('7 / 4000');
  const hits = [...host.querySelectorAll('.bot-memory-hit')]; expect(hits[0]?.textContent).toContain('原第二顺位'); expect(hits[1]?.textContent).toContain('原第一顺位');
  expect(hits[0]?.textContent).toContain('0.23'); expect(hits[0]?.textContent).not.toContain('23%'); expect(hits[1]?.textContent).toContain('未提供');
  expect(host.querySelector('.bot-memory-stages')?.textContent).toContain('未提供'); expect(host.textContent).toContain('不能相加为总耗时');
  await click('原话关键词'); await fill('想回想什么？', '周末'); await click('开始试查');
  expect(requests.filter(item => item.type === 'memory.recall').at(-1)).toMatchObject({ query: '周末', mode: 'history' });
});
it('keeps many localized recall measurements compact and the original diagnostic records intact', async () => {
  const stages = [
    { name: 'host.context.prepare', durationMs: 2.06, status: 'completed', id: 1 },
    { name: 'host.preprocess', durationMs: 45.35, status: 'completed', parentId: 1 },
    { name: 'host.start', durationMs: 0.38, status: 'completed' },
    { name: 'host.start', durationMs: 0.19, status: 'completed' },
    { name: 'plugin.RAGDiaryPlugin.processMessages', durationMs: 44.6, status: 'completed', source: 'original/plugin.js#processMessages' },
    { name: 'embedding.query-cache-or-provider', durationMs: 32.01, status: 'completed' },
    { name: 'knowledge.river-query', durationMs: 8.91, status: 'completed' },
    { name: 'index.load', durationMs: 0.05, status: 'completed' },
    { name: 'native.memo-observation', durationMs: 1.63, status: 'completed' },
    { name: 'native.river', durationMs: 4.81, status: 'completed' },
    { name: 'retrieval.deduplicate', durationMs: 1.01, status: 'completed' },
    { name: 'future.' + 'extension'.repeat(80), status: 'new_unrecognized_state' },
  ];
  await mount(request => request.type === 'memory.recall' ? Promise.resolve({ ok: true, memory: report({ totalMs: 51.66, stages }) }) : undefined);
  await click('召回试查'); await fill('想回想什么？', '召回查询'); await click('开始试查');
  const diagnostic = host.querySelector<HTMLDetailsElement>('.bot-memory-diagnostics')!;
  expect(diagnostic.open).toBe(false); expect(diagnostic.querySelector('summary')?.textContent).toContain('12 个阶段');
  expect(host.querySelector('.bot-memory-result-heading')?.textContent).toContain('51.66 毫秒');
  const rows = [...host.querySelectorAll('.bot-memory-stage')];
  expect(rows).toHaveLength(12);
  expect(rows.map(item => item.querySelector('.bot-memory-stage-name')?.textContent)).toEqual([
    '上下文准备', '记忆预处理', '运行时就绪检查', '运行时就绪检查', '日记自动召回', '查询向量准备',
    '关联记忆查询', '日记索引加载', '记忆线索分析', '原生关联检索', '召回结果去重', '扩展处理阶段',
  ]);
  expect(rows[0]?.textContent).toContain('已完成'); expect(rows[0]?.textContent).toContain('2.06 毫秒');
  expect(rows.at(-1)?.textContent).toContain('未识别状态'); expect(rows.at(-1)?.textContent).toContain('未提供');
  expect(host.querySelector('.bot-memory-stages')?.textContent).not.toMatch(/host\.|plugin\.|completed|unrecognized/);
  const original = host.querySelector<HTMLDetailsElement>('.bot-memory-stage-raw')!;
  expect(original.open).toBe(false); expect(JSON.parse(original.querySelector('pre')!.textContent!)).toEqual(stages);
  expect(diagnostic.textContent).toContain('不能相加为总耗时');
});
it('loads recent reports only on demand and retires an old recall on a new query or owner', async () => {
  const pending = deferred<BotResponse>();
  await mount(request => request.type === 'memory.recall' ? pending.promise : request.type === 'memory.recall.records' ? Promise.resolve({ ok: true, memory: { reports: [report({ query: '之前的查询' })] } }) : undefined);
  await click('召回试查'); expect(requests.some(item => item.type === 'memory.recall.records')).toBe(false);
  await fill('想回想什么？', '旧查询'); await click('开始试查'); await fill('想回想什么？', '新的查询');
  await act(() => pending.resolve({ ok: true, memory: report({ hits: [{ rank: 1, text: '旧查询的敏感记录' }] }) })); expect(host.textContent).not.toContain('敏感记录');
  await click('最近5次试查'); expect(requests.filter(item => item.type === 'memory.recall.records').at(-1)).toMatchObject({ limit: 5 }); expect(host.textContent).toContain('之前的查询');
  await owner('bob'); expect(host.textContent).not.toContain('之前的查询');
});
it('closes with Escape and restores the previous keyboard focus', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus(); let closed = false;
  await mount(); await render('private-a', () => { closed = true; });
  await act(() => host.querySelector<HTMLElement>('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(closed).toBe(true); await act(() => root!.unmount()); root = undefined; expect(document.activeElement).toBe(trigger); trigger.remove();
});
it('uses a visible edit label and an SVG action menu that closes before the dialog on Escape', async () => {
  let closed = false;
  await mount(); await render('private-a', () => { closed = true; }); await openFirst();
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="编辑日记"]')!;
  expect(edit.textContent).toBe('编辑'); expect(edit.querySelector('svg')).not.toBeNull();
  const menu = host.querySelector<HTMLDetailsElement>('.bot-memory-more')!;
  const trigger = menu.querySelector('summary')!;
  expect(trigger.textContent).toBe(''); expect(trigger.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 16 16');
  await click('更多操作'); expect(menu.open).toBe(true);
  expect(menu.querySelector('[role="menuitem"]')?.textContent).toBe('忘记这条记忆');
  await act(() => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(menu.open).toBe(false); expect(closed).toBe(false); expect(document.activeElement).toBe(trigger);
});
it('keeps archived originals readable and disables every editing or selection control', async () => {
  const archived = { ...first, indexState: 'archived', content: '归档的原始标题\n第一段事实。\n\n第二段仍需保留。' };
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: [archived], tags: [], total: 1 } })
    : request.type === 'memory.note' ? Promise.resolve({ ok: true, memory: archived }) : undefined);
  expect(host.querySelector<HTMLInputElement>('.bot-memory-row>input')?.disabled).toBe(true);
  await openFirst(); expect(host.querySelector('.bot-memory-fulltext h3')?.textContent).toBe('归档的原始标题');
  expect([...host.querySelectorAll('.bot-memory-fulltext p')].map(item => item.textContent)).toEqual(['第一段事实。', '第二段仍需保留。']);
  expect(host.querySelector('.bot-memory-note-meta')?.textContent).toContain('已归档');
  expect(host.querySelector<HTMLButtonElement>('[aria-label="编辑日记"]')?.disabled).toBe(true);
  expect([...host.querySelectorAll('button')].some(item => item.textContent === '忘记这条记忆')).toBe(false);
  expect(host.querySelector('.bot-memory-scope')).toBeNull(); expect(host.querySelector('.bot-memory-heading')?.textContent).not.toContain('VCP MEMORY');
});
it('validates the actual twelve-tag and sixty-four-character limits before issuing a mutation', async () => {
  await mount(); await openFirst(); await click('编辑日记');
  await fill('标签，用逗号分隔', Array.from({ length: 13 }, (_, index) => `标签${index}`).join(',')); await click('保存修改');
  expect(requests.some(item => item.type === 'memory.update')).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain('12个标签');
  await fill('标签，用逗号分隔', '长'.repeat(65)); await click('保存修改');
  expect(requests.some(item => item.type === 'memory.update')).toBe(false); expect(host.querySelector('[role="alert"]')?.textContent).toContain('64个字符');
});
it('allows selection only for confirmed indexed or pending source versions', async () => {
  const states = ['indexed', 'pending', 'unknown', 'partial', 'writing', 'archived'];
  await mount(request => request.type === 'memory.catalog' ? Promise.resolve({ ok: true, memory: { items: states.map((indexState, index) => ({ ...first, id: String(index).repeat(64), indexState })), tags: [] } }) : undefined);
  const controls = [...host.querySelectorAll<HTMLInputElement>('.bot-memory-row>input')];
  expect(controls.map(item => item.disabled)).toEqual([false, false, true, true, true, true]);
  expect(host.textContent).toContain('结果待核实'); expect(host.textContent).toContain('部分完成'); expect(host.textContent).toContain('写入中');
});
