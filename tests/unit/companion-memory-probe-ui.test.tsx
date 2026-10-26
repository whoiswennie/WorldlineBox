// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryProbeWorkspace } from '../../src/renderer/companions/CompanionMemoryProbeWorkspace';
import { CompanionMemoryManager } from '../../src/renderer/companions/CompanionMemoryManager';
import { companionMemoryProbeCommand, type CompanionMemoryProbe } from '../../src/shared/companion-memory-probe';
import type { CompanionMemoryProbeProgressEvent } from '../../src/shared/companion-memory-probe-progress';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { Companion, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { ScheduleRequest } from '../../src/renderer/companions/companion-schedules';
import type { CompanionMemoryRetrieval } from '../../src/shared/companion-memory-retrieval';
import { memorySourcePathKey, memoryToolPresentation, memoryToolSourceBlocks, nativeMemoryScore, readableMemoryExcerpt } from '../../src/renderer/companions/companion-memory-tool-presentation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T07:00:00.000Z';
const owner: Companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const second = { ...owner, id: 'another-owner', name: '另一位伙伴' };
type Props = ComponentProps<typeof CompanionMemoryProbeWorkspace>;
function value(patch: Partial<CompanionMemoryProbe> = {}): CompanionMemoryProbe {
  return { companionId: owner.id, query: '你记得我的名字吗', mode: 'active', observedAt: at, contextText: '用户第一次见面时介绍自己叫天幻呀。', corpusStamp: 'owner-corpus-1', pending: false, degraded: false, explanation: '本次使用真实 VCP 原生检索获得回忆。', memories: [
    { score: .81, reasons: ['原生语义检索'], path: [], memory: { id: 'note-name', companionId: owner.id, scopeId: 'owner-scope', content: '初次见面的日记\n用户介绍自己叫天幻呀。', tags: ['名字'], metadata: { title: '初次见面的日记' }, sourceConversationId: 'private-room', sourceSequence: 1, sources: [{ messageId: 'intro', conversationId: 'private-room', sequence: 1, authorId: 'user', revision: 1, checksum: 'original', createdAt: at }], createdAt: at, updatedAt: at, origin: 'companion', status: 'indexed', version: 1, captureMethod: 'automatic' } },
  ], ...patch };
}
function retrieval(): CompanionMemoryRetrieval {
  return { mode: 'active', engine: 'river', observedAt: at, resultCount: 1, candidateQuerySeparateFromContext: true, stages: [
    { id: 'scope', state: 'completed', title: '确认可用记忆', description: '这是实际的范围检查凭证。', facts: [{ label: '可用文档', value: '17' }], tags: [], matches: [] },
    { id: 'embedding', state: 'not_observed', title: '理解这次提问', description: '没有返回执行细节。', facts: [], tags: [], matches: [] },
    { id: 'sensing', state: 'completed', title: '唤起话题线索', description: '实际返回的话题线索。', facts: [], tags: ['初见'], matches: [{ memoryId: 'note-name', facts: [], tags: ['初见'] }] },
    { id: 'candidates', state: 'completed', title: '寻找相关片段', description: '来自实际候选计数。', facts: [{ label: '候选池', value: '23' }], tags: [], matches: [] },
    { id: 'ranking', state: 'completed', title: '核对并排列记忆', description: '沿用本次引擎顺序。', facts: [{ label: '返回片段', value: '1' }], tags: [], matches: [{ memoryId: 'note-name', sourcePath: 'C:/My Notes/note.md', rank: 1, excerpt: '用户介绍自己叫天幻呀。', facts: [{ label: '拓扑加成', value: '0.0700' }], tags: ['名字'] }] },
    { id: 'context', state: 'completed', title: '返回主动回忆', description: '候选与工具正文分别调用；没有逐条注入轨迹。', facts: [], tags: [], matches: [] },
  ] };
}
function events(request: ScheduleRequest) {
  const listeners = new Set<() => void>(), progress = new Set<(event: CompanionMemoryProbeProgressEvent) => void>();
  const retired: Array<(event: CompanionMemoryProbeProgressEvent) => void> = [];
  const api: WorldlineBoxCompanionsApi = { request: async input => (await request(input)) ?? { ok: false }, onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onReplyStream: () => () => undefined,
    onMemoryProbeProgress: listener => { progress.add(listener); return () => { progress.delete(listener); retired.push(listener); }; } };
  return { api, emit: () => { for (const listener of listeners) listener(); }, emitProgress: (event: CompanionMemoryProbeProgressEvent) => { for (const listener of progress) listener(event); },
    progressListeners: progress, retiredProgressListeners: retired };
}
async function mount(request: ScheduleRequest, patch: Partial<Props> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const props: Props = { companion: owner, request, onClose: vi.fn(), ...patch }; await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} />)); return props;
}
function button(label: string) { const result = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!result) throw new Error('Missing button ' + label); return result; }
async function fill(text: string) { const input = node!.querySelector<HTMLTextAreaElement>('[aria-label="想回忆的事"]')!; await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function run() { await act(async () => button('开始回忆').click()); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function recallCommand(request: ReturnType<typeof vi.fn<ScheduleRequest>>) {
  const command = request.mock.calls.find(([command]) => command.type === 'memory.recall.test')?.[0];
  if (command?.type !== 'memory.recall.test' || !command.requestId) throw new Error('Missing correlated memory probe request.');
  return command;
}
function progressFor(command: ReturnType<typeof recallCommand>, patch: Partial<CompanionMemoryProbeProgressEvent> = {}): CompanionMemoryProbeProgressEvent {
  return { requestId: command.requestId!, companionId: command.companionId, mode: command.mode, state: 'running', sequence: 1,
    stageId: 'queue', label: '等待记忆查询', elapsedMs: 0, stageElapsedMs: 0, stages: [{ id: 'queue', label: '等待记忆查询', elapsedMs: 0 }], ...patch };
}
function outputMs(label: string) {
  const output = node!.querySelector(`[aria-label="${label}"]`);
  if (!output) throw new Error('Missing timing output ' + label);
  const text = output.textContent!;
  return parseFloat(text) * (/毫秒/u.test(text) ? 1 : 1000);
}
function fakeClock() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return async (milliseconds: number) => { now += milliseconds; await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
}

it('executes only an explicit manual query through the companion recall API and exposes literal real context', async () => {
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value() })); await mount(request);
  expect(request).not.toHaveBeenCalled(); expect(button('开始回忆').disabled).toBe(true);
  await fill('  你记得我的名字吗  '); expect(request).not.toHaveBeenCalled(); await run();
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'memory.recall.test', companionId: owner.id, mode: 'active', query: '你记得我的名字吗', limit: 8, requestId: expect.any(String) });
  expect(node!.querySelector('[aria-label="VCP上下文原文"]')?.textContent).toBe(value().contextText);
  expect(node!.textContent).toContain('找到的记忆不一定都会出现在这次回忆里'); expect(node!.querySelectorAll('[data-probe-note]')).toHaveLength(1);
});

it('changes mode or query without running models or retaining results from a previous question', async () => {
  const request = vi.fn<ScheduleRequest>(async command => ({ ok: true, memoryProbe: value(command.type === 'memory.recall.test' ? { query: command.query, mode: command.mode } : {}) })); await mount(request);
  await fill('你记得我的名字吗'); await run();
  const passive = [...node!.querySelectorAll<HTMLButtonElement>('[aria-label="回忆方式"] button')].find(item => item.textContent?.includes('被动回忆'))!;
  await act(() => passive.click()); expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
  await run(); expect(request.mock.lastCall?.[0]).toMatchObject({ mode: 'passive' }); expect(node!.textContent).toContain('随话题想起的内容');
  await fill('另一道问题'); expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull(); expect(request).toHaveBeenCalledTimes(2);
});

it('keeps full literal context accessible with bounded pages and never executes recalled HTML', async () => {
  const context = '原文\n<script>绝不执行</script>\n' + '文'.repeat(8191) + '😀' + '后文'.repeat(6000);
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ contextText: context }) })); await mount(request); await fill('你记得我的名字吗'); await run();
  const pieces: string[] = [];
  for (;;) {
    const pre = node!.querySelector('[aria-label="VCP上下文原文"]')!; pieces.push(pre.textContent!); expect(pre.textContent!.length).toBeLessThanOrEqual(8192);
    expect(pre.textContent).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); expect(node!.querySelector('script')).toBeNull();
    const next = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '下一段'); if (!next || next.disabled) break; await act(() => next.click());
  }
  expect(pieces.join('')).toBe(context); expect(request).toHaveBeenCalledTimes(1);
});

it('distinguishes candidate evidence from generated context and opens the exact current note id', async () => {
  const openNote = vi.fn(); const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value() })); await mount(request, { onOpenNote: openNote }); await fill('你记得我的名字吗'); await run();
  await act(() => node!.querySelector<HTMLButtonElement>('[data-probe-note="note-name"]')!.click());
  expect(node!.querySelector('[aria-label="候选记忆正文"]')?.textContent).toBe(value().memories[0]!.memory.content); expect(node!.textContent).toContain('召回分数 0.810'); expect(node!.textContent).not.toContain('81%');
  expect(node!.textContent).toContain('private-room / intro'); await act(() => button('打开记忆文档').click()); expect(openNote).toHaveBeenCalledExactlyOnceWith('note-name');
});
it('shows only actual native score components, preserves zero scores and never reorders the engine results', async () => {
  const fixture = value();
  const first = { ...fixture.memories[0]!, score: 0, scoreDetails: { engine: 'river' as const, rank: 4, nativeRank: 2, finalScore: 0, baseScore: .3, topologyBonus: .07, anchorBonus: 0, omega: .81, algorithmVersion: 'river-v3', coreTagsMatched: ['初见'] } };
  const secondHit = { ...first, memory: { ...first.memory, id: 'later-native-result', metadata: { title: '引擎后续的结果' } }, score: 9, scoreDetails: { ...first.scoreDetails, rank: 5, nativeRank: 1, finalScore: 9 } };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: { ...fixture, memories: [first, secondHit] } })); await mount(request); await fill('你记得我的名字吗'); await run();
  expect([...node!.querySelectorAll('[data-probe-note]')].map(item => item.getAttribute('data-probe-note'))).toEqual(['note-name', 'later-native-result']);
  expect(node!.querySelector('[data-probe-note="note-name"] .memory-probe-native-rank')?.textContent).toContain('#20.0000');
  await act(() => node!.querySelector<HTMLButtonElement>('[data-probe-note="note-name"]')!.click());
  const scores = node!.querySelector('[aria-label="原生VCP评分"]')!;
  expect(scores.textContent).toContain('RiverMemo原生评分'); expect(scores.textContent).toContain('拓扑增益0.0700'); expect(scores.textContent).toContain('锚点增益0.0000');
  expect(scores.textContent).toContain('河网可观测性 Ω0.8100'); expect(scores.textContent).toContain('不是记忆真实性的置信度'); expect(scores.textContent).not.toContain('%');
  expect([...scores.querySelectorAll('dt')].map(item => item.textContent)).not.toContain('向量分'); expect(scores.textContent).toContain('river-v3');
});

it('prefills a document-search query without running the model automatically', async () => {
  const request = vi.fn<ScheduleRequest>(); await mount(request, { initialQuery: '旧灯塔旁边的那次散步' });
  expect(node!.querySelector<HTMLTextAreaElement>('[aria-label="想回忆的事"]')!.value).toBe('旧灯塔旁边的那次散步'); expect(request).not.toHaveBeenCalled();
});

it('unwraps a known native tool receipt into literal readable text and preserves the exact raw receipt on demand', async () => {
  const first = '  --- LightMemo ---\n用户说自己叫天幻呀。\n<script>不得执行</script>\n'; const secondText = '拓扑 +0.0700，锚点 -0.0000。';
  const raw = ' {"status":"success","result":{"content":' + JSON.stringify([{ type: 'text', text: first }, { type: 'text', text: secondText }]) + '},"score":-0} ';
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ contextText: raw }) })); await mount(request); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('[aria-label="VCP上下文原文"]')?.textContent).toBe(first + '\n\n' + secondText); expect(node!.querySelector('script')).toBeNull();
  expect(node!.textContent).toContain('内容与原始回执一致'); expect(node!.querySelector('[aria-label="原始工具回执原文"]')).toBeNull();
  const details = [...node!.querySelectorAll<HTMLDetailsElement>('details')].find(item => item.querySelector('summary')?.textContent === '原始工具回执')!;
  await act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(node!.querySelector('[aria-label="原始工具回执原文"]')?.textContent).toBe(raw);
  expect(node!.querySelector('script')).toBeNull(); expect(request).toHaveBeenCalledTimes(1);
});

it('leaves passive context and unknown or mixed native formats completely literal', async () => {
  const known = JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: '原始文本' }] } });
  const cases = ['未知文本 {不是JSON}', JSON.stringify({ status: 'error', result: { content: [{ type: 'text', text: '报错不可被隐藏' }] } }), JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: '文本' }, { type: 'image', data: '原始图片字段' }] } }), '{"futureFormat":true,"score":-0}'];
  for (const raw of cases) expect(memoryToolPresentation(raw)).toEqual({ text: raw, decoded: false });
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ mode: 'passive', contextText: known }) })); await mount(request);
  const passive = [...node!.querySelectorAll<HTMLButtonElement>('[aria-label="回忆方式"] button')].find(item => item.textContent?.includes('被动回忆'))!; await act(() => passive.click()); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('[aria-label="VCP上下文原文"]')?.textContent).toBe(known); expect(node!.textContent).not.toContain('原始工具回执');
});

it('retains every known text block and real signed score values without rewriting their meaning', async () => {
  const text = '真实原生分值：-0.0000，-0.1250，0.7000。\n';
  expect(memoryToolPresentation(JSON.stringify({ content: [{ type: 'text', text }] }))).toEqual({ text, decoded: true });
  expect(nativeMemoryScore(-0)).toBe('-0.0000'); expect(nativeMemoryScore(0)).toBe('0.0000'); expect(nativeMemoryScore(-.125)).toBe('-0.1250');
  const fixture = value(); fixture.memories[0] = { ...fixture.memories[0]!, score: -0, scoreDetails: { engine: 'river', rank: 1, finalScore: -0, originalScore: -.125, baseScore: .7, topologyBonus: -.125, anchorBonus: -0, omega: .25 } };
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: fixture })); await mount(request); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('.memory-probe-native-rank')?.textContent).toContain('-0.0000'); await act(() => node!.querySelector<HTMLButtonElement>('[data-probe-note="note-name"]')!.click());
  const scores = node!.querySelector('[aria-label="原生VCP评分"]')!;
  expect(scores.textContent).toContain('最终评分-0.0000'); expect(scores.textContent).toContain('初始候选分-0.1250'); expect(scores.textContent).toContain('拓扑增益-0.1250'); expect(scores.textContent).toContain('锚点增益-0.0000');
});

it('shows an actual vertical retrieval story with source links and explicitly unknown stages', async () => {
  const openNote = vi.fn(); const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ memoryRetrieval: retrieval() }) })); await mount(request, { onOpenNote: openNote }); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('h2')?.textContent).toBe('回忆'); expect(node!.textContent).not.toContain('记忆验证');
  expect(node!.querySelector('[aria-label="回忆流程"]')?.getAttribute('aria-orientation')).toBe('vertical'); expect(node!.querySelectorAll('[data-retrieval-stage]')).toHaveLength(6);
  const stage = node!.querySelector('[aria-label="核对并排列记忆"]')!; expect(stage.textContent).toContain('用户介绍自己叫天幻呀。');
  await act(() => stage.querySelector<HTMLButtonElement>('.memory-retrieval-document-link')!.click()); expect(openNote).toHaveBeenCalledExactlyOnceWith('note-name');
  await act(() => node!.querySelector<HTMLButtonElement>('[data-retrieval-stage="embedding"]')!.click());
  const unknown = node!.querySelector('[aria-label="理解这次提问"]')!; expect(unknown.textContent).toContain('细节未提供'); expect(unknown.querySelector('dd')).toBeNull();
  await act(() => node!.querySelector<HTMLButtonElement>('[data-retrieval-stage="candidates"]')!.click()); expect(node!.querySelector('[aria-label="寻找相关片段"]')!.textContent).toContain('候选池23');
  expect(node!.querySelector('[aria-label="寻找相关片段"]')!.textContent).toContain('原版未提供逐条候选正文');
  await act(() => node!.querySelector<HTMLButtonElement>('[data-retrieval-stage="context"]')!.click()); expect(node!.querySelector('[aria-label="返回主动回忆"]')!.textContent).toContain('原版未提供逐条聚焦引用轨迹');
  expect(request).toHaveBeenCalledTimes(1);
});

it('reads native excerpts without host anchors while preserving the exact original evidence', async () => {
  const raw = '[2026-10-22] - 大肥鱼\n[15:21:48]\n<!-- WorldlineBoxMemory:' + 'a'.repeat(64) + ' -->\n用户喜欢看海。\nTag: 用户, 看海';
  const flow = retrieval(); flow.stages[4]!.matches[0]!.excerpt = raw;
  expect(readableMemoryExcerpt(raw)).toBe('用户喜欢看海。'); expect(readableMemoryExcerpt('<!-- WorldlineBoxMemory:普通用户评论 -->')).toBe('<!-- WorldlineBoxMemory:普通用户评论 -->');
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ memoryRetrieval: flow }) })); await mount(request); await fill('你记得我的名字吗'); await run();
  const item = node!.querySelector('[data-retrieval-memory="note-name"]')!; expect(item.querySelector(':scope > p')?.textContent).toBe('用户喜欢看海。');
  expect(item.querySelector('pre')?.textContent).toBe(raw); expect(flow.stages[4]!.matches[0]!.excerpt).toBe(raw);
});

it('bounds source-card tags, long titles and metadata in large native receipts', async () => {
  const tags = Array.from({ length: 2000 }, (_, index) => '标签' + index);
  const nativeText = '[--- LightMemo 轻量回忆 ---]\n[找到 1 条相关记忆片段:]\n--- (来源: ' + '来源'.repeat(10000) + ', 相关性: N/A)\n[2026-10-22] - ' + '作者'.repeat(10000) + '\n[15:21:48]\n<!-- WorldlineBoxMemory:' + 'a'.repeat(64) + ' -->\n' + '文'.repeat(30000) + '\nTag: ' + tags.join(', ') + '\n\n[--- 回忆结束 ---]\n';
  const raw = JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: nativeText }] } });
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ contextText: raw }) })); await mount(request); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelectorAll('.memory-probe-source-block .memory-probe-note-tags span')).toHaveLength(50);
  expect(node!.textContent).toContain('另有 1950 个标签'); expect(node!.querySelector('.memory-probe-source-block summary strong')!.textContent!.length).toBeLessThanOrEqual(161);
  expect(node!.querySelector('[aria-label="回忆来源正文"]')!.textContent!.length).toBeLessThanOrEqual(8192); expect(node!.querySelector('[aria-label="回忆来源元数据"]')).toBeNull(); expect(node!.textContent!.length).toBeLessThan(16000);
  const details = [...node!.querySelectorAll<HTMLDetailsElement>('details')].find(item => item.querySelector('summary')?.textContent === '来源位置与原始标记')!;
  await act(() => { details.open = true; details.dispatchEvent(new Event('toggle')); }); expect(node!.querySelector('[aria-label="回忆来源元数据"]')!.textContent!.length).toBeLessThanOrEqual(8192);
});

it('does not guess a document link when a native source path maps to conflicting trusted note ids', async () => {
  const fixture = value(); fixture.memories.push({ ...fixture.memories[0]!, memory: { ...fixture.memories[0]!.memory, id: 'another-note' } });
  const flow = retrieval(); flow.stages[4]!.matches.push({ ...flow.stages[4]!.matches[0]!, memoryId: 'another-note' });
  const nativeText = '[--- LightMemo 轻量回忆 ---]\n[找到 1 条相关记忆片段:]\n--- (来源: 日记, 相关性: N/A)\n    [路径: file:////?/C:/My%20Notes/note.md]\n正文\n\n[--- 回忆结束 ---]\n';
  const open = vi.fn(); const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: { ...fixture, contextText: nativeText, memoryRetrieval: flow } })); await mount(request, { onOpenNote: open }); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('[aria-label^="打开回忆来源"]')).toBeNull(); expect(node!.querySelector('a[href^="file:"]')).toBeNull(); expect(open).not.toHaveBeenCalled(); expect(node!.querySelector('[aria-label="回忆来源正文"]')?.textContent).toBe('正文');
});

it('turns native source sections into readable cards and opens only host-mapped note ids', async () => {
  const body = '用户喜欢看海。\n<script>仍是资料</script>';
  const nativeText = '\n[--- LightMemo 轻量回忆 ---]\n[查询内容: "海边"]\n[搜索范围: 日记]\n\n[找到 1 条相关记忆片段:]\n--- (来源: 日记, 相关性: 86.9%(混合))\n    [路径: file:////?/C:/My%20Notes/note.md]\n    [RiverMemo Topology V3: Ω=0.250/sparse, 角色=concept, 拓扑+0.0700, 直锚+-0.0000]\n[2026-10-22] - 大肥鱼\n[15:21:48]\n<!-- WorldlineBoxMemory:' + 'a'.repeat(64) + ' -->\n' + body + '\nTag: 用户, 看海\n\n\n[--- 回忆结束 ---]\n';
  const raw = JSON.stringify({ status: 'success', result: { content: [{ type: 'text', text: nativeText }] } });
  expect(memoryToolSourceBlocks(nativeText)?.[0]).toMatchObject({ body, author: '大肥鱼', date: '2026-10-22', time: '15:21:48', tags: ['用户', '看海'] });
  expect(memorySourcePathKey('file:////?/C:/My%20Notes/note.md')).toBe('c:/my notes/note.md');
  expect(memorySourcePathKey(String.raw`\\?\C:\My Notes\note.md`)).toBe('c:/my notes/note.md');
  expect(memorySourcePathKey('file:////tmp/notes/note.md')).toBe(memorySourcePathKey('/tmp/notes/note.md'));
  const openNote = vi.fn(); const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ contextText: raw, memoryRetrieval: retrieval() }) })); await mount(request, { onOpenNote: openNote }); await fill('你记得我的名字吗'); await run();
  expect(node!.querySelector('[aria-label="回忆来源正文"]')?.textContent).toBe(body); expect(node!.querySelector('script, a[href^="file:"]')).toBeNull();
  await act(() => button('打开回忆来源 note-name').click()); expect(openNote).toHaveBeenCalledExactlyOnceWith('note-name');
  expect(node!.querySelector('[aria-label="原始工具回执原文"]')).toBeNull();
  const rawDetails = [...node!.querySelectorAll<HTMLDetailsElement>('details')].find(item => item.querySelector('summary')?.textContent === '原始工具回执')!;
  await act(() => { rawDetails.open = true; rawDetails.dispatchEvent(new Event('toggle')); }); expect(node!.querySelector('[aria-label="原始工具回执原文"]')?.textContent).toBe(raw);
});

it('keeps ambiguous native source formats literal and rejects foreign stage references', async () => {
  const ambiguous = '[--- LightMemo 轻量回忆 ---]\n[找到 1 条相关记忆片段:]\n--- (来源: 日记, 相关性: N/A)\n正文\n--- (来源: 正文里的假标记, 相关性: N/A)\n[--- 回忆结束 ---]';
  expect(memoryToolSourceBlocks(ambiguous)).toBeUndefined();
  const flow = retrieval(); flow.stages[4]!.matches[0]!.memoryId = 'foreign-owner-note';
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true, memoryProbe: value({ memoryRetrieval: flow }) })); await mount(request); await fill('你记得我的名字吗'); await run();
  expect(node!.textContent).toContain('处理记录与来源不一致'); expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull();
});

it('rejects mismatched owners, queries and foreign candidate records', async () => {
  const foreign = value(); foreign.memories[0]!.memory.companionId = 'foreign';
  const request = vi.fn<ScheduleRequest>().mockResolvedValueOnce({ ok: true, memoryProbe: value({ companionId: 'foreign' }) }).mockResolvedValueOnce({ ok: true, memoryProbe: value({ query: '不是这个问题' }) }).mockResolvedValueOnce({ ok: true, memoryProbe: foreign });
  await mount(request); await fill('你记得我的名字吗');
  for (let index = 0; index < 3; index++) { await run(); expect(node!.textContent).toContain('范围未能核实'); expect(node!.querySelector('[aria-label="VCP上下文原文"], [data-probe-note]')).toBeNull(); }
});

it('discards late responses after changing partner or question', async () => {
  const pending = deferred<CompanionsResponse>(); const request = vi.fn<ScheduleRequest>(async () => pending.promise); const props = await mount(request); await fill('你记得我的名字吗'); await run();
  await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} companion={second} />));
  await act(async () => pending.resolve({ ok: true, memoryProbe: value({ contextText: '上一位伙伴的迟到回忆' }) }));
  expect(node!.textContent).not.toContain('迟到回忆'); expect(node!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(''); expect(node!.textContent).toContain(second.name + '的个人记忆');
});

it('keeps results through unrelated events and invalidates actual corpus changes without automatic recall', async () => {
  vi.useFakeTimers(); let stamp = 'owner-corpus-1';
  const request = vi.fn<ScheduleRequest>(async command => command.type === 'memory.recall.state' ? { ok: true, memoryCorpusStamp: stamp } : { ok: true, memoryProbe: value() });
  const { api, emit } = events(request); const props = await mount(request, { api }); await fill('你记得我的名字吗'); await run();
  await act(() => { emit(); emit(); emit(); }); await act(async () => vi.advanceTimersByTimeAsync(751));
  expect(node!.querySelector('[aria-label="本次回忆结果"]')).not.toBeNull(); expect(request.mock.calls.filter(([command]) => command.type === 'memory.recall.test')).toHaveLength(1);
  expect(request.mock.calls.filter(([command]) => command.type === 'memory.recall.state')).toHaveLength(1);
  stamp = 'owner-corpus-2'; await act(() => emit()); await act(async () => vi.advanceTimersByTimeAsync(751));
  expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull(); expect(node!.textContent).toContain('记忆数据已更新');
  await run(); await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} active={false} />));
  expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull(); await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} active />));
  expect(request.mock.calls.filter(([command]) => command.type === 'memory.recall.test')).toHaveLength(2);
});

it('reports empty, pending, degraded and failed retrieval truthfully without document-search fallback', async () => {
  const request = vi.fn<ScheduleRequest>().mockResolvedValueOnce({ ok: true, memoryProbe: value({ contextText: '', memories: [], pending: true, degraded: true }) }).mockResolvedValueOnce({ ok: false, error: '本地向量模型当前不可用' });
  await mount(request); await fill('你记得我的名字吗'); await run();
  expect(node!.textContent).toContain('召回已降级'); expect(node!.textContent).toContain('仍在收录或建立索引'); expect(node!.textContent).toContain('没有命中相关记忆'); expect(node!.textContent).toContain('没有返回可注入的记忆原文');
  await run(); expect(node!.textContent).toContain('本地向量模型当前不可用'); expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull(); expect(request.mock.calls.every(([command]) => command.type === 'memory.recall.test')).toBe(true);
});

it('shows click-to-settle waiting time before progress and keeps backend time separate through completion', async () => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise), source = events(request);
  await mount(request, { api: source.api }); await fill('你记得我的名字吗'); await run();
  const command = recallCommand(request);
  expect(source.progressListeners.size).toBe(1);
  expect(node!.querySelector('[aria-label="本次回忆耗时"]')?.textContent).toContain('等待回忆服务响应');
  await advance(3000);
  expect(outputMs('等待总用时')).toBe(3000);
  expect(node!.querySelector('[aria-label="后端处理用时"]')).toBeNull();
  expect(node!.querySelector('[data-memory-probe-stage="projection"]')?.textContent).toContain('未观测');
  await act(() => source.emitProgress(progressFor(command)));
  await advance(1000);
  expect(outputMs('等待总用时')).toBe(4000); expect(outputMs('后端处理用时')).toBe(1000); expect(outputMs('当前阶段用时')).toBe(1000);
  const focus = progressFor(command, { sequence: 2, stageId: 'focus', label: '原版检索与片段整理', elapsedMs: 1000, stageElapsedMs: 0,
    stages: [{ id: 'queue', label: '等待记忆查询', elapsedMs: 1000 }, { id: 'focus', label: '原版检索与片段整理', elapsedMs: 0 }] });
  await act(() => source.emitProgress(focus)); await advance(2000);
  expect(outputMs('等待总用时')).toBe(6000); expect(outputMs('当前阶段用时')).toBe(2000);
  await advance(500);
  const stages: CompanionMemoryProbeProgressEvent['stages'] = [{ id: 'queue', label: '等待记忆查询', elapsedMs: 1000 },
    { id: 'focus', label: '原版检索与片段整理', elapsedMs: 2400 }, { id: 'verification', label: '核验回忆结果', elapsedMs: 100 }];
  await act(() => source.emitProgress(progressFor(command, { state: 'completed', sequence: 3, stageId: 'verification', label: '核验回忆结果',
    elapsedMs: 3500, stageElapsedMs: 100, stages })));
  await advance(500);
  expect(outputMs('等待总用时')).toBe(7000); expect(outputMs('后端处理用时')).toBe(3500); expect(outputMs('最后后端环节用时')).toBe(100);
  expect(node!.querySelector('[aria-label="当前阶段用时"]')).toBeNull(); expect(node!.textContent).toContain('最后后端环节');
  expect(node!.textContent).toContain('等待结果返回');
  await act(() => pending.resolve({ ok: true, memoryProbe: value({ timing: { totalMs: 3500, stages }, memoryRetrieval: retrieval() }) }));
  expect(outputMs('等待总用时')).toBe(7000); expect(outputMs('后端处理用时')).toBe(3500);
  expect(source.progressListeners.size).toBe(0);
  const table = node!.querySelector('[aria-label="实际阶段耗时"]')!;
  expect(table.querySelectorAll('tbody tr')).toHaveLength(8);
  expect(table.querySelector('[data-memory-probe-stage="focus"]')?.textContent).toContain('2.4 秒');
  expect(table.querySelector('[aria-label="最慢阶段"]')?.closest('tr')?.getAttribute('data-memory-probe-stage')).toBe('focus');
  for (const id of ['preparation', 'sources', 'runtime', 'projection', 'retrieval']) {
    const text = table.querySelector(`[data-memory-probe-stage="${id}"]`)?.textContent;
    expect(text).toContain('未观测'); expect(text).not.toMatch(/0(?:\.0)?\s*(?:秒|毫秒)/u);
  }
  // The six semantic retrieval cards never become fabricated timing phases.
  expect(table.querySelector('[data-memory-probe-stage="projection"]')?.textContent).toContain('同步记忆索引');
  expect(table.querySelector('[data-memory-probe-stage="embedding"], [data-memory-probe-stage="sensing"], [data-memory-probe-stage="ranking"]')).toBeNull();
  const frozen = node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent;
  await advance(10_000);
  await act(() => source.retiredProgressListeners[0]!(progressFor(command, { sequence: 99, elapsedMs: 99_999, stageElapsedMs: 99_999 })));
  expect(node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent).toBe(frozen);
});

it('keeps failure timing frozen and preserves the original backend error', async () => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise), source = events(request);
  await mount(request, { api: source.api }); await fill('你记得我的名字吗'); await run();
  const command = recallCommand(request);
  await advance(1000); await act(() => source.emitProgress(progressFor(command, { stageId: 'focus', label: '正在聚焦回忆' })));
  await advance(1200);
  await act(() => source.emitProgress(progressFor(command, { state: 'failed', sequence: 2, stageId: 'focus', label: '聚焦失败',
    elapsedMs: 1200, stageElapsedMs: 1200, stages: [{ id: 'focus', label: '正在聚焦回忆', elapsedMs: 1200 }] })));
  expect(outputMs('最后后端环节用时')).toBe(1200); expect(node!.querySelector('[aria-label="当前阶段用时"]')).toBeNull();
  await advance(300); expect(outputMs('最后后端环节用时')).toBe(1200);
  await act(() => pending.resolve({ ok: false, error: '原版记忆模型当前不可用' }));
  expect(node!.textContent).toContain('原版记忆模型当前不可用'); expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull();
  expect(outputMs('等待总用时')).toBe(2500); expect(outputMs('后端处理用时')).toBe(1200);
  expect(node!.querySelector('[data-memory-probe-stage="focus"]')?.textContent).toContain('已停止');
  const frozen = node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent;
  await advance(20_000); expect(node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent).toBe(frozen);
  expect(source.progressListeners.size).toBe(0);
});

it('does not interpret a backend completion event as a successful request before the response is validated', async () => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise), source = events(request);
  await mount(request, { api: source.api }); await fill('你记得我的名字吗'); await run();
  const command = recallCommand(request); await advance(1000);
  await act(() => source.emitProgress(progressFor(command, { state: 'completed', stageId: 'verification', label: '后端已结束',
    elapsedMs: 500, stageElapsedMs: 100, stages: [{ id: 'verification', label: '核验回忆结果', elapsedMs: 100 }] })));
  expect(node!.querySelector('[aria-label="本次回忆结果"]')).toBeNull();
  await advance(500); await act(() => pending.resolve({ ok: false, error: '最终来源凭证没有通过验证' }));
  expect(node!.textContent).toContain('最终来源凭证没有通过验证');
  expect(node!.querySelector('[aria-label="本次回忆耗时"]')?.getAttribute('data-probe-timing-state')).toBe('failed');
  expect(outputMs('等待总用时')).toBe(1500); expect(outputMs('后端处理用时')).toBe(500);
});

it('rejects progress from foreign requests, owners, modes and out-of-order sequences', async () => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise), source = events(request);
  await mount(request, { api: source.api }); await fill('你记得我的名字吗'); await run();
  const command = recallCommand(request);
  await act(() => source.emitProgress(progressFor(command, { sequence: 5, stageId: 'sources', label: '当前已核实进度', elapsedMs: 100, stageElapsedMs: 100,
    stages: [{ id: 'sources', label: '核验记忆来源', elapsedMs: 100 }] })));
  const snapshot = node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent;
  for (const patch of [{ requestId: 'other-run' }, { companionId: second.id }, { mode: 'passive' as const }, { sequence: 4 }]) {
    await act(() => source.emitProgress(progressFor(command, { sequence: 6, label: '应忽略的旧消息', elapsedMs: 99_999, stageElapsedMs: 99_999, ...patch })));
    expect(node!.querySelector('[aria-label="本次回忆耗时"]')!.textContent).toBe(snapshot);
  }
  await advance(100); expect(node!.textContent).not.toContain('应忽略的旧消息');
  await act(() => pending.resolve({ ok: true, memoryProbe: value() }));
});

it.each(['owner', 'mode', 'query', 'inactive', 'close', 'unmount'] as const)('disposes live timers and ignores old events and promises after %s changes', async change => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise), source = events(request);
  const props = await mount(request, { api: source.api }); await fill('你记得我的名字吗'); await run();
  const command = recallCommand(request); await advance(1000);
  await act(() => source.emitProgress(progressFor(command, { label: '切换前的旧进度', elapsedMs: 100, stageElapsedMs: 100 })));
  if (change === 'owner') await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} companion={second} />));
  else if (change === 'mode') await act(() => [...node!.querySelectorAll<HTMLButtonElement>('[aria-label="回忆方式"] button')].find(item => item.textContent?.includes('被动回忆'))!.click());
  else if (change === 'query') await fill('新的问题');
  else if (change === 'inactive') await act(async () => root!.render(<CompanionMemoryProbeWorkspace {...props} active={false} />));
  else if (change === 'close') await act(() => button('返回记忆库').click());
  else { await act(() => root!.unmount()); root = undefined; }
  expect(source.progressListeners.size).toBe(0);
  await act(() => source.retiredProgressListeners[0]!(progressFor(command, { state: 'completed', sequence: 99, elapsedMs: 99_999,
    stageElapsedMs: 99_999, label: '旧运行迟到事件' })));
  await act(() => pending.resolve({ ok: true, memoryProbe: value({ contextText: '旧运行迟到回忆正文', timing: { totalMs: 99_999, stages: [] } }) }));
  await advance(10_000);
  expect(node!.textContent).not.toContain('旧运行迟到');
  expect(node!.querySelector('[aria-label="本次回忆耗时"], [aria-label="本次回忆结果"]')).toBeNull();
  if (change === 'close') expect(props.onClose).toHaveBeenCalledOnce();
});

it('retains legacy result compatibility while measuring actual UI waiting without backend timing', async () => {
  const advance = fakeClock(), pending = deferred<CompanionsResponse>();
  const request = vi.fn<ScheduleRequest>(async () => pending.promise);
  await mount(request); await fill('你记得我的名字吗'); await run(); await advance(2000);
  await act(() => pending.resolve({ ok: true, memoryProbe: value() }));
  expect(outputMs('等待总用时')).toBe(2000); expect(node!.querySelector('[aria-label="后端处理用时"]')).toBeNull();
  expect(node!.querySelector('[aria-label="本次回忆结果"]')).not.toBeNull();
  await advance(5000); expect(outputMs('等待总用时')).toBe(2000);
});

it('opens the probe as a memory child page and returns to the existing library workspace', async () => {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const request = vi.fn<ScheduleRequest>(async () => ({ ok: true })); const { api } = events(request);
  api.workspace = vi.fn(async () => ({ ok: true }));
  await act(async () => root!.render(<CompanionMemoryManager companions={[owner]} ownerId={owner.id} request={request} api={api} onDraftConsumed={vi.fn()} onDismissError={vi.fn()} authorName={id => id} onOwnerChange={vi.fn()} onLocateSource={vi.fn()} onClose={vi.fn()} />));
  await act(() => button('回忆').click()); expect(node!.querySelector('[aria-label="伙伴回忆"]')).not.toBeNull();
  expect(node!.querySelector<HTMLElement>('.learning-workspace-preserved')!.hidden).toBe(true);
  expect(request.mock.calls.some(([command]) => command.type === 'memory.recall.test')).toBe(false);
  await act(() => button('返回记忆库').click()); expect(node!.querySelector('[aria-label="伙伴回忆"]')).toBeNull(); expect(node!.querySelector<HTMLElement>('.learning-workspace-preserved')!.hidden).toBe(false);
});

it('validates explicit bounded queries in the public contract', () => {
  expect(companionMemoryProbeCommand.parse({ type: 'memory.recall.test', companionId: owner.id, query: '  海边  ', mode: 'passive' }).query).toBe('海边');
  expect(companionMemoryProbeCommand.safeParse({ type: 'memory.recall.test', companionId: owner.id, query: ' ', mode: 'active' }).success).toBe(false);
  expect(companionMemoryProbeCommand.safeParse({ type: 'memory.recall.test', companionId: owner.id, query: '海边', mode: 'active', limit: 13 }).success).toBe(false);
});
