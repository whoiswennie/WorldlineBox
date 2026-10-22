// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryTraceWorkspace } from '../../src/renderer/companions/CompanionMemoryTraceWorkspace';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionMemoryTrace, CompanionMemoryTraceEntry, CompanionMemoryTracePage, CompanionMemoryTraceRecord } from '../../src/shared/companion-memory-trace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T01:09:00.000Z';
const companions: Companion[] = BUILTIN_COMPANIONS.slice(0, 2).map(item => ({ ...item, builtin: true, createdAt: at }));
const alice = companions[1]!, bob = companions[0]!;
type Props = ComponentProps<typeof CompanionMemoryTraceWorkspace>;
type Stage = CompanionMemoryTrace['stages'][number]['kind'];
function entry(id = 'note-a', patch: Partial<CompanionMemoryTraceEntry> = {}): CompanionMemoryTraceEntry {
  return { kind: 'journal', id, noteId: id, title: '海风里的约定', status: 'indexed', redacted: false, at, version: 2, ...patch };
}
function page(owner = alice.id, entries = [entry()], nextCursor?: string): CompanionMemoryTracePage {
  return { companionId: owner, entries, hasMore: !!nextCursor, ...(nextCursor ? { nextCursor } : {}), index: { state: 'ready', scope: 'metadata', indexed: entries.length } };
}
function record(id = 'source-a', patch: Partial<CompanionMemoryTraceRecord> = {}): CompanionMemoryTraceRecord {
  return { id, kind: 'source', title: '当天的真实聊天来源', status: 'read', at, sourceMessageId: 'message-a', relation: 'exact_source', confidence: 'exact', detail: '用户约好下次带热茶去海边。', ...patch };
}
function trace(owner = alice.id, selected = entry(), stage: Stage = 'memory', records = [record()], nextCursor?: string): CompanionMemoryTrace {
  return { companionId: owner, root: selected, stages: [{ kind: stage, label: '本环节的真实凭证', records, hasMore: !!nextCursor, ...(nextCursor ? { nextCursor } : {}) }], hasMore: !!nextCursor,
    limitations: ['共同来源关联不等于一对一产出，阅读与索引确认不等于已经理解。'] };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function changes(request: ScheduleRequest) {
  const listeners = new Set<() => void>();
  const api: WorldlineBoxCompanionsApi = { request: async input => (await request(input)) ?? { ok: false, error: '没有响应' },
    onChanged: vi.fn(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }), onReplyStream: vi.fn(() => () => undefined) };
  return { api, listeners, emit: () => { for (const listener of listeners) listener(); } };
}
async function mount(request: ScheduleRequest, patch: Partial<Props> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const props: Props = { companion: alice, request, onClose: vi.fn(), ...patch };
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} />)); return props;
}
function button(label: string) {
  const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label);
  if (!found) throw new Error('Missing button ' + label); return found;
}
function entryButton(id: string) { const found = node!.querySelector<HTMLButtonElement>(`[data-trace-entry="${id}"] button`); if (!found) throw new Error('Missing entry ' + id); return found; }
async function fill(label: string, value: string) {
  const input = node!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

it('reads bounded owner metadata and opens evidence only on demand, without invoking memory or life actions', async () => {
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? { ok: true, memoryTrace: trace(alice.id, entry(), 'memory', [record('memory-version', { kind: 'journal', noteId: 'note-a', version: 2, relation: 'root' })]) }
    : { ok: true, memoryTracePage: page() });
  const close = vi.fn(), learning = vi.fn(), processing = vi.fn(), openNote = vi.fn();
  await mount(request, { onClose: close, onLearningSources: learning, onProcessing: processing, onOpenNote: openNote });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'memory.trace.list', companionId: alice.id, kind: 'all', query: '', from: undefined, to: undefined, cursor: undefined, limit: 20 });
  expect(node!.textContent).toContain(alice.name + ' · 每一步，都有来处');
  expect(node!.querySelectorAll('[data-trace-entry]')).toHaveLength(1);
  expect(node!.querySelector('[aria-label="成长经历链"]')).toBeNull();
  await act(async () => entryButton('note-a').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'memory.trace.inspect', companionId: alice.id, kind: 'journal', id: 'note-a', stage: 'memory', cursor: undefined, limit: 10 });
  expect(node!.textContent).toContain('原始凭证'); expect(node!.textContent).toContain('版本 2');
  await act(() => button('查看这篇记忆').click()); expect(openNote).toHaveBeenCalledExactlyOnceWith('note-a');
  await act(() => button('学习来源').click()); expect(learning).toHaveBeenCalledOnce();
  await act(() => button('处理进度').click()); expect(processing).toHaveBeenCalledOnce();
  await act(() => button('关闭成长足迹').click()); expect(close).toHaveBeenCalledOnce();
  expect(request.mock.calls.every(([command]) => command.type === 'memory.trace.list' || command.type === 'memory.trace.inspect')).toBe(true);
});

it('ignores a late list for the previous owner and rejects a response that belongs to another owner', async () => {
  const aliceRead = deferred<CompanionsResponse>(), bobRead = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async command => 'companionId' in command && command.companionId === alice.id ? aliceRead.promise : bobRead.promise);
  const props = await mount(request);
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} companion={bob} />));
  await act(async () => aliceRead.resolve({ ok: true, memoryTracePage: page(alice.id, [entry('alice-only', { title: '只属于小肥鱼的私人经历' })]) }));
  expect(node!.textContent).not.toContain('只属于小肥鱼的私人经历');
  await act(async () => bobRead.resolve({ ok: true, memoryTracePage: page(alice.id) }));
  expect(node!.textContent).toContain('成长记录的归属未能核实'); expect(node!.querySelector('[data-trace-entry]')).toBeNull();
  expect(node!.textContent).toContain(bob.name + ' · 每一步，都有来处');
});

it('does not resurrect a previous owner detail after switching companions', async () => {
  const pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect' ? pending.promise
    : { ok: true, memoryTracePage: page('companionId' in command ? command.companionId : alice.id, [entry(command.type === 'memory.trace.list' && command.companionId === bob.id ? 'bob-only' : 'note-a')]) });
  const props = await mount(request); await act(async () => entryButton('note-a').click());
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} companion={bob} />));
  await act(async () => pending.resolve({ ok: true, memoryTrace: trace(alice.id, entry(), 'memory', [record('private', { detail: '上一位伙伴的秘密正文' })]) }));
  expect(node!.textContent).not.toContain('上一位伙伴的秘密正文'); expect(node!.querySelector('[aria-label="成长经历链"]')).toBeNull();
  expect(node!.querySelector('[data-trace-entry="bob-only"]')).not.toBeNull();
});

it('replaces list pages and resets backend cursor for filters, search, and real record dates', async () => {
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type !== 'memory.trace.list') return { ok: false, error: 'Unexpected detail read' };
    const offset = command.cursor ? 20 : 0;
    return { ok: true, memoryTracePage: page(alice.id, Array.from({ length: 20 }, (_, index) => entry('note-' + (offset + index))), offset ? undefined : 'list-page-two') };
  });
  await mount(request); expect(node!.querySelectorAll('[data-trace-entry]')).toHaveLength(20);
  await act(async () => button('下一页').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'memory.trace.list', cursor: 'list-page-two', limit: 20 });
  expect(node!.querySelectorAll('[data-trace-entry]')).toHaveLength(20); expect(node!.querySelector('[data-trace-entry="note-0"]')).toBeNull();
  expect(node!.querySelector('[data-trace-entry="note-20"]')).not.toBeNull();
  await act(async () => button('资料阅读').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'memory.trace.list', kind: 'learning', cursor: undefined });
  expect(node!.querySelector('[data-trace-entry="note-20"]')).toBeNull();
  await fill('搜索成长足迹', '  海边札记  ');
  await act(async () => button('查找').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'memory.trace.list', kind: 'learning', query: '海边札记', cursor: undefined });
  await fill('成长足迹开始日期', '2026-10-21'); await fill('成长足迹结束日期', '2026-10-22');
  expect(request.mock.lastCall?.[0]).toMatchObject({ from: new Date('2026-10-21T00:00:00').toISOString(), to: new Date('2026-10-22T23:59:59.999').toISOString(), cursor: undefined });
  expect(node!.textContent).toContain('现实中的记录时间');
});

it('discards a late page for an earlier filter rather than mixing unrelated results into the current list', async () => {
  const journals = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type !== 'memory.trace.list') return { ok: false, error: 'Unexpected detail read' };
    if (command.kind === 'journal') return journals.promise;
    return { ok: true, memoryTracePage: page(alice.id, [command.kind === 'dream' ? entry('dream-only', { kind: 'dream', title: '当前筛选下的梦境凭证' }) : entry()]) };
  });
  await mount(request);
  await act(async () => button('日记与认识').click()); expect(node!.querySelector('[data-trace-entry]')).toBeNull();
  await act(async () => button('梦境').click()); expect(node!.textContent).toContain('当前筛选下的梦境凭证');
  await act(async () => journals.resolve({ ok: true, memoryTracePage: page(alice.id, [entry('late-journal', { title: '已经离开的日记筛选结果' })]) }));
  expect(node!.textContent).not.toContain('已经离开的日记筛选结果'); expect(node!.querySelectorAll('[data-trace-entry]')).toHaveLength(1);
  expect(node!.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('梦境');
});

it('uses independent bounded stage cursors and distinguishes exact citation from shared-source association', async () => {
  const learning = entry('reading-a', { kind: 'learning', noteId: undefined, title: '阅读海边札记' });
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type !== 'memory.trace.inspect') return { ok: true, memoryTracePage: page(alice.id, [learning]) };
    const selected = entry(command.id, { kind: command.kind, title: '阅读海边札记' });
    const current = command.stage ?? 'reading';
    const records = command.cursor ? [record('second-proof', { title: '第二页的来源凭证' })] : [
      record('exact-proof', { title: '有明确引用的原始资料' }),
      record('shared-proof', { kind: 'capture', title: '共享原始来源的整理任务', relation: 'shared_source', confidence: 'shared_source', detail: '没有保存整理任务到日记的一对一因果。' }),
    ];
    return { ok: true, memoryTrace: trace(alice.id, selected, current, records, command.cursor ? undefined : current + '-page-two') };
  });
  await mount(request); await act(async () => entryButton('reading-a').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ type: 'memory.trace.inspect', stage: 'reading', cursor: undefined, limit: 10 });
  expect(node!.querySelector('[data-trace-record="exact-proof"]')?.textContent).toContain('直接引用');
  const associated = node!.querySelector('[data-trace-record="shared-proof"]')!;
  expect(associated.textContent).toContain('共同来源关联'); expect(associated.querySelector('.is-related')).not.toBeNull();
  expect(node!.textContent).toContain('共同来源关联不等于一对一产出');
  await act(async () => button('下一页凭证').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ stage: 'reading', cursor: 'reading-page-two', limit: 10 });
  expect(node!.querySelectorAll('[data-trace-record]')).toHaveLength(1); expect(node!.querySelector('[data-trace-record="exact-proof"]')).toBeNull();
  await act(async () => button('上一页凭证').click()); expect(request.mock.lastCall?.[0]).toMatchObject({ stage: 'reading', cursor: undefined });
  await act(async () => button('下一页凭证').click());
  await act(async () => button('来源整理').click());
  expect(request.mock.lastCall?.[0]).toMatchObject({ stage: 'capture', cursor: undefined });
  expect(node!.querySelector('[aria-label="经历链环节分页"]')?.textContent).toContain('第 1 页');
});

it('shows persisted asset fragment and sleep-job evidence without turning shared provenance into a claim of mastery', async () => {
  const asset = { libraryId: 'authorized-library', assetId: 'sea-notebook', assetRevisionId: 'asset-version-4', offset: 120, characters: 480, contentHash: 'actual-fragment-hash' };
  const learning = entry('reading-a', { kind: 'learning', title: '实际阅读的海边札记', noteId: undefined, asset });
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type !== 'memory.trace.inspect') return { ok: true, memoryTracePage: page(alice.id, [learning]) };
    if (command.kind === 'dream') return { ok: true, memoryTrace: trace(alice.id, entry(command.id, { kind: 'dream', title: '真实关联的梦境' }), 'dream', []) };
    const current = command.stage ?? 'reading';
    return { ok: true, memoryTrace: trace(alice.id, learning, current, current === 'dream'
      ? [record('dream-proof', { kind: 'dream', noteId: 'dream-a', relation: 'dependency', worldJobId: 'world-job-a', sleepEpisodeId: 'sleep-episode-a', detail: '这是梦境联想，明确作业关联来自已保存的元数据。' })]
      : [record('asset-proof', { kind: 'learning', asset, detail: '实际读取了这个资料版本的片段，不代表认可或掌握。' })]) };
  });
  await mount(request); await act(async () => entryButton('reading-a').click());
  const proof = node!.querySelector('[data-trace-record="asset-proof"]')!;
  expect(proof.textContent).toContain('asset-version-4'); expect(proof.textContent).toContain('偏移 120 · 480 字符'); expect(proof.textContent).toContain('actual-fragment-hash');
  expect(proof.textContent).toContain('不代表认可或掌握'); expect(node!.textContent).not.toContain('已学会');
  await act(async () => button('梦境').click());
  const dream = node!.querySelector('[data-trace-record="dream-proof"]')!;
  expect(dream.textContent).toContain('睡眠作业：world-job-a'); expect(dream.textContent).toContain('睡眠阶段：sleep-episode-a');
  await act(async () => button('继续追溯').click());
  expect(request).toHaveBeenLastCalledWith({ type: 'memory.trace.inspect', companionId: alice.id, kind: 'dream', id: 'dream-a', stage: 'dream', cursor: undefined, limit: 10 });
});

it('shows saved-or-confirmed batch provenance, exact output versions and an explicit zero independently of unknown legacy output', async () => {
  const selected = entry('reading-batch', { kind: 'learning', noteId: undefined, title: '一批实际阅读来源' });
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? { ok: true, memoryTrace: trace(alice.id, selected, command.stage ?? 'reading', command.stage === 'capture' ? [
      record('capture-with-output', { kind: 'capture', relation: 'batch_output', captureBatchId: 'actual-batch-a', outputCount: 2,
        outputs: [{ noteId: 'note-a', version: 4 }, { noteId: 'note-b', version: 2 }], detail: '事务保存或确认了这些记忆版本，去重结果也包含在内。' }),
      record('capture-without-output', { kind: 'capture', relation: 'batch_output', captureBatchId: 'actual-batch-empty', outputCount: 0, outputs: [], detail: '这次检查没有需要保存的记忆。' }),
      record('legacy-unknown-output', { kind: 'capture', relation: 'shared_source', detail: '旧任务未保存产出关系，结果数量未知。' }),
    ] : []) }
    : { ok: true, memoryTracePage: page(alice.id, [selected]) });
  await mount(request); await act(async () => entryButton('reading-batch').click());
  await act(async () => button('来源整理').click());
  const output = node!.querySelector('[data-trace-record="capture-with-output"]')!;
  expect(output.querySelector('.memory-trace-record-meta')?.textContent).toContain('本批保存／确认');
  const evidence = output.querySelector<HTMLDetailsElement>('details')!;
  expect(evidence.open).toBe(false); await act(() => evidence.querySelector('summary')!.click()); expect(evidence.open).toBe(true);
  expect(evidence.textContent).toContain('整理批次：actual-batch-a'); expect(evidence.textContent).toContain('本批保存／确认 2 项结果');
  expect(evidence.textContent).toContain('记忆：note-a · 版本 4'); expect(evidence.textContent).toContain('记忆：note-b · 版本 2');
  const empty = node!.querySelector('[data-trace-record="capture-without-output"]')!.querySelector<HTMLDetailsElement>('details')!;
  await act(() => empty.querySelector('summary')!.click()); expect(empty.open).toBe(true);
  expect(empty.textContent).toContain('整理批次：actual-batch-empty'); expect(empty.textContent).toContain('本批保存／确认 0 项结果');
  const unknown = node!.querySelector('[data-trace-record="legacy-unknown-output"]')!;
  expect(unknown.textContent).toContain('结果数量未知'); expect(unknown.textContent).not.toContain('本批保存／确认 0 项结果');
  expect(node!.textContent).not.toContain('新创'); expect(node!.textContent).not.toContain('已学会');
});

it('does not read while hidden, cancels indexing polls, and revalidates an old detail before showing it again', async () => {
  vi.useFakeTimers();
  const reopened = deferred<CompanionsResponse>(); let detailReads = 0;
  const request = vi.fn<ScheduleRequest>(async command => {
    if (command.type === 'memory.trace.inspect') return ++detailReads === 1 ? { ok: true, memoryTrace: trace(alice.id, entry(), 'memory', [record('old-detail', { detail: '暂存的私人经历正文' })]) } : reopened.promise;
    return { ok: true, memoryTracePage: { ...page(), index: { state: 'indexing', scope: 'metadata', indexed: 1 } } };
  });
  const notifications = changes(request);
  const props = await mount(request, { active: false, api: notifications.api });
  expect(request).not.toHaveBeenCalled(); expect(notifications.listeners.size).toBe(0);
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} active />));
  expect(notifications.listeners.size).toBe(1); expect(request).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(3_000)); expect(request).toHaveBeenCalledTimes(2);
  await act(async () => entryButton('note-a').click()); expect(node!.textContent).toContain('暂存的私人经历正文');
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} active={false} />));
  const before = request.mock.calls.length; expect(notifications.listeners.size).toBe(0);
  await act(async () => { notifications.emit(); await vi.advanceTimersByTimeAsync(30_000); });
  expect(request).toHaveBeenCalledTimes(before); expect(node!.querySelector<HTMLElement>('[aria-label="伙伴成长足迹"]')?.hidden).toBe(true);
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} active />));
  expect(node!.textContent).not.toContain('暂存的私人经历正文'); expect(node!.textContent).toContain('正在核对真实凭证');
  await act(async () => reopened.resolve({ ok: true, memoryTrace: { ...trace(), root: entry('note-a', { title: '已撤回的记忆记录', status: 'forgotten', redacted: true }), stages: [] } }));
  expect(node!.textContent).not.toContain('暂存的私人经历正文'); expect(node!.textContent).toContain('来源已撤回或记忆已失效');
});

it('coalesces real change notifications and cancels a scheduled reread when the workspace is hidden', async () => {
  vi.useFakeTimers();
  const first = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => first.promise);
  const notifications = changes(request);
  const props = await mount(request, { api: notifications.api });
  await act(() => { for (let index = 0; index < 10; index++) notifications.emit(); });
  expect(request).toHaveBeenCalledOnce();
  await act(async () => first.resolve({ ok: true, memoryTracePage: page() }));
  expect(node!.querySelector('[data-trace-entry="note-a"]')).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1_999)); expect(request).toHaveBeenCalledOnce();
  await act(async () => root!.render(<CompanionMemoryTraceWorkspace {...props} active={false} />));
  await act(() => vi.advanceTimersByTimeAsync(10_000)); expect(request).toHaveBeenCalledOnce();
  expect(notifications.listeners.size).toBe(0);
});

it('removes old text, relationships, and note actions when a visible trace is withdrawn', async () => {
  const forgotten = deferred<CompanionsResponse>(); let inspections = 0;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? ++inspections === 1 ? { ok: true, memoryTrace: trace(alice.id, entry(), 'memory', [record('original', { kind: 'journal', noteId: 'note-a', detail: '撤回前的具体私人正文' })]) } : forgotten.promise
    : { ok: true, memoryTracePage: page() });
  const openNote = vi.fn(); await mount(request, { onOpenNote: openNote }); await act(async () => entryButton('note-a').click());
  expect(node!.textContent).toContain('撤回前的具体私人正文'); expect(button('查看这篇记忆')).toBeDefined();
  await act(() => button('刷新成长足迹').click());
  await act(async () => forgotten.resolve({ ok: true, memoryTrace: { companionId: alice.id,
    root: entry('note-a', { title: '已撤回或失效的记忆记录', redacted: true, status: 'forgotten' }), stages: [], hasMore: false, limitations: ['不恢复旧正文或关系。'] } }));
  expect(node!.textContent).toContain('已遗忘'); expect(node!.textContent).not.toContain('撤回前的具体私人正文');
  expect(node!.querySelector('[data-trace-record]')).toBeNull(); expect(node!.textContent).not.toContain('查看这篇记忆'); expect(openNote).not.toHaveBeenCalled();
});

it('does not display stale titles or detail supplied alongside a redaction flag', async () => {
  const withdrawn = entry('note-a', { redacted: true, status: 'forgotten', title: '旧适配器残留的私人标题' });
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? { ok: true, memoryTrace: trace(alice.id, withdrawn, 'memory', [record('old-envelope', { noteId: 'related-note', title: '不应再显示的关联标题', detail: '不应再显示的私人正文' })]) }
    : { ok: true, memoryTracePage: page(alice.id, [withdrawn]) });
  const openNote = vi.fn(); await mount(request, { onOpenNote: openNote });
  expect(node!.textContent).not.toContain('旧适配器残留的私人标题');
  await act(async () => entryButton('note-a').click());
  expect(node!.textContent).not.toContain('旧适配器残留的私人标题'); expect(node!.textContent).not.toContain('不应再显示的关联标题'); expect(node!.textContent).not.toContain('不应再显示的私人正文');
  expect(node!.textContent).toContain('旧内容不再展示'); expect(node!.textContent).not.toContain('查看这篇记忆'); expect(node!.textContent).not.toContain('继续追溯'); expect(openNote).not.toHaveBeenCalled();
});

it('clears previously visible detail on read failure instead of preserving possibly forgotten content', async () => {
  let inspections = 0;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? ++inspections === 1 ? { ok: true, memoryTrace: trace(alice.id, entry(), 'memory', [record('private', { detail: '失败后不能继续显示的旧正文' })]) } : { ok: false, error: '原记忆已不可见，请重新核对。' }
    : { ok: true, memoryTracePage: page() });
  await mount(request); await act(async () => entryButton('note-a').click()); expect(node!.textContent).toContain('失败后不能继续显示的旧正文');
  await act(async () => button('刷新成长足迹').click());
  expect(node!.querySelector('[role="alert"]')?.textContent).toContain('原记忆已不可见');
  expect(node!.querySelector('[aria-label="成长经历链"]')).toBeNull(); expect(node!.textContent).not.toContain('失败后不能继续显示的旧正文');
});

it('rejects a changed trace root and clears stale list titles after a failed list refresh', async () => {
  let listReads = 0;
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.trace.inspect'
    ? { ok: true, memoryTrace: trace(alice.id, entry('another-note', { title: '错误归属的正文' })) }
    : ++listReads === 1 ? { ok: true, memoryTracePage: page() } : { ok: false, error: '目录不可读取' });
  await mount(request); await act(async () => entryButton('note-a').click());
  expect(node!.textContent).toContain('这条记录的归属已变化'); expect(node!.textContent).not.toContain('错误归属的正文');
  await act(async () => button('返回足迹').click());
  expect(node!.textContent).toContain('目录不可读取'); expect(node!.querySelector('[data-trace-entry]')).toBeNull(); expect(node!.textContent).not.toContain('海风里的约定');
});
