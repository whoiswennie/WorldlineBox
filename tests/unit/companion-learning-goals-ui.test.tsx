// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionLearningGoalsWorkspace } from '../../src/renderer/companions/CompanionLearningGoalsWorkspace';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionLearningGoal, CompanionLearningGoalRound } from '../../src/shared/companion-learning-goals';
import { companionLearningGoalRoundSchema } from '../../src/shared/companion-learning-goals';
import type { CompanionLearningGrant } from '../../src/shared/companion-learning';
import type { CompanionWorkspaceRequest, CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T01:00:00Z';
const owner = { id: 'reader-a', name: '小雨', avatar: 'custom', active: true } as Companion;
const second = { ...owner, id: 'reader-b', name: '小夏' };
const grant: CompanionLearningGrant = { id: 'grant-a', companionId: owner.id, libraryId: 'books', libraryName: '海洋与自然', libraryPath: 'D:/books', autonomous: false, intervalMinutes: 60, revision: 2, enabled: true, createdAt: at, updatedAt: at, status: 'idle', reads: 0 };
function goal(patch: Partial<CompanionLearningGoal> = {}): CompanionLearningGoal {
  return { id: 'goal-a', companionId: owner.id, text: '慢慢理解近岸潮汐与生物的关系，遇到不确定的地方记下来。', materials: [{ kind: 'library', grantId: grant.id }], allowWeb: false, schedule: { intervalMinutes: 60, windows: [], timeZone: 'Asia/Shanghai' }, state: 'active', revision: 3, createdAt: at, updatedAt: at, nextAt: '2026-10-22T02:00:00Z', phase: 'waiting', waitReason: '伙伴正在忙碌，等待空闲。', totalRounds: 1, ...patch };
}
function round(patch: Partial<CompanionLearningGoalRound> = {}): CompanionLearningGoalRound {
  return { id: 'round-a', goalId: 'goal-a', companionId: owner.id, ordinal: 1, startedAt: at, updatedAt: at, endedAt: at, status: 'completed', phase: 'idle', plan: { focus: '今天先理解潮汐的来源', questions: ['为什么会有潮汐？'], searchQueries: ['潮汐来源'] }, reads: [{ id: 'read-a', kind: 'library', title: '近岸潮汐.md', uri: 'library:books/asset', revision: 'rev-a', contentHash: 'a'.repeat(64), readAt: at, characters: 30, excerpt: '潮汐与月球、太阳的引力和地球运动有关。', truncated: false }], summary: '本轮初步理解潮汐，并保留适用范围。', claims: [{ text: '引力是潮汐的影响因素。', evidence: [{ sourceId: 'read-a', quote: '潮汐与月球、太阳的引力' }] }], memoryIds: ['note-actual'], selfTest: { kind: 'self_test', questions: [{ question: '潮汐受什么影响？', answer: '月球与太阳的引力是重要因素。', evaluation: 'supported', rationale: '回答可以对应本轮原文。', evidence: [{ sourceId: 'read-a', quote: '潮汐与月球、太阳的引力' }] }], supportedAnswers: 1, assessedQuestions: 1, disclaimer: '模型自测与自评，仅核验引用来自本轮实际读取材料，不代表客观考试正确率或已经掌握。' }, gaps: ['还没有比较不同海岸的差异。'], nextPlan: ['下一轮读取海湾地形与潮差的资料。'], ...patch };
}
function fixture(initialGoals = [goal()], initialRounds = [round()]) {
  let items = initialGoals, records = initialRounds;
  const listeners = new Set<() => void>();
  const workspace = vi.fn(async (input: CompanionWorkspaceRequest): Promise<CompanionWorkspaceResponse> => {
    if (input.type === 'memory.learning.status') return { ok: true, learning: { grants: [grant], reads: [], libraries: [{ libraryId: 'books', displayName: grant.libraryName, folders: [] }] } };
    if (input.type === 'memory.learning.goals.list') return { ok: true, learningGoals: { items, hasMore: false } };
    if (input.type === 'memory.learning.goals.rounds') return { ok: true, learningRounds: { items: records.filter(item => item.goalId === input.id), hasMore: false } };
    if (input.type === 'memory.learning.goals.create') { const saved = goal({ ...input, id: 'goal-new', revision: 1, totalRounds: 0 }); items = [saved, ...items]; return { ok: true, learningGoal: saved }; }
    if (input.type === 'memory.learning.goals.update' || input.type === 'memory.learning.goals.run') {
      const old = items.find(item => item.id === input.id)!; const saved = { ...old, ...(input.type === 'memory.learning.goals.update' ? input : {}), revision: old.revision + 1 }; items = items.map(item => item.id === input.id ? saved : item); return { ok: true, learningGoal: saved };
    }
    return { ok: false, error: '未实现的测试命令' };
  });
  const request = vi.fn<(input: CompanionsRequest) => Promise<CompanionsResponse>>(async () => ({ ok: true, attachments: [{ id: 'attachment-a', name: '潮间带笔记.md', mime: 'text/markdown', size: 30 }] }));
  const api = { workspace, onChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as WorldlineBoxCompanionsApi;
  return { workspace, request, api, emit: () => listeners.forEach(listener => listener()), replaceGoals: (values: CompanionLearningGoal[]) => { items = values; }, replaceRounds: (values: CompanionLearningGoalRound[]) => { records = values; } };
}
type Props = ComponentProps<typeof CompanionLearningGoalsWorkspace>;
async function mount(f = fixture(), patch: Partial<Props> = {}) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  const props: Props = { owner, api: f.api, request: f.request, onClose: vi.fn(), onOpenNote: vi.fn(), ...patch };
  await act(async () => root!.render(<CompanionLearningGoalsWorkspace {...props} />)); return { ...f, props };
}
function button(label: string) { const item = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(value => value.getAttribute('aria-label') === label || value.textContent?.trim() === label); if (!item) throw new Error('Missing button ' + label); return item; }
async function click(label: string) { await act(async () => button(label).click()); }
async function fill(label: string, value: string) { const input = node!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(() => { Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function select(label: string, value: string) { const input = node!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; await act(() => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function toggleSummary(label: string) { const summary = [...node!.querySelectorAll('summary')].find(item => item.textContent === label)!; await act(() => { const details = summary.parentElement as HTMLDetailsElement; details.open = !details.open; details.dispatchEvent(new Event('toggle')); }); }

it('shows owner-specific real scheduling and receipts without starting any learning when opening the page', async () => {
  const f = await mount();
  expect(node!.textContent).toContain('学习与成长'); expect(node!.textContent).toContain('伙伴正在忙碌，等待空闲'); expect(node!.textContent).toContain('下次可学习'); expect(node!.textContent).toContain('Asia/Shanghai');
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.learning.goals.run' || command.type === 'memory.learning.run')).toBe(false); expect(f.request).not.toHaveBeenCalled();
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.rounds', companionId: owner.id, id: 'goal-a', cursor: 0, limit: 10 });
  expect(node!.textContent).toContain('本轮初步理解潮汐'); expect(node!.textContent).toContain('不代表客观考试正确率或已经掌握'); expect(node!.textContent).not.toContain('100%');
  expect(node!.textContent).not.toContain('月球与太阳的引力是重要因素。');
});

it('creates a natural-language persistent goal with explicitly chosen materials, web permission and weekly windows', async () => {
  const f = await mount(fixture([], [])); await click('写下第一个学习目标'); await fill('持续学习目标', '  每周研究潮间带，先理解观察方法。  ');
  await act(() => node!.querySelector<HTMLInputElement>('.learning-goal-grants input')!.click()); await click('选择本地文件'); expect(f.request).toHaveBeenCalledWith({ type: 'attachment.pick' });
  await fill('学习网页地址', 'https://example.org/tides'); await click('加入网页'); await act(() => node!.querySelector<HTMLInputElement>('.learning-goal-check input')!.click());
  await select('学习目标间隔', '180'); await fill('学习目标时区', 'Asia/Shanghai'); await click('添加学习时段'); await fill('学习时段 1 开始', '21:30'); await fill('学习时段 1 结束', '06:30'); await click('时段 1 星期日');
  expect(node!.textContent).toContain('跨至次日'); await click('创建持续学习目标');
  expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.create', companionId: owner.id, text: '每周研究潮间带，先理解观察方法。', allowWeb: true, materials: [{ kind: 'library', grantId: grant.id }, { kind: 'file', attachmentId: 'attachment-a', name: '潮间带笔记.md' }, { kind: 'web', url: 'https://example.org/tides' }], schedule: { intervalMinutes: 180, timeZone: 'Asia/Shanghai', windows: [{ startMinute: 1290, endMinute: 390, days: [1, 2, 3, 4, 5, 6] }] } });
  expect(f.workspace.mock.calls.some(([command]) => command.type === 'memory.learning.goals.run')).toBe(false);
});

it('keeps the natural-language draft while opening the existing material authorization page', async () => {
  await mount(fixture([], [])); await click('新建学习目标'); await fill('持续学习目标', '这段方向不能丢失'); await click('管理资产库授权');
  expect(node!.querySelector('.learning-goals-preserved')?.hasAttribute('hidden')).toBe(true); expect(node!.querySelector('[aria-label="学习来源管理"]')).not.toBeNull();
  const sources = node!.querySelector('.companion-learning-sources')!; await act(() => sources.querySelector<HTMLButtonElement>('[aria-label="返回记忆库"]')!.click());
  expect(node!.querySelector<HTMLTextAreaElement>('[aria-label="持续学习目标"]')!.value).toBe('这段方向不能丢失');
});

it('pauses, resumes and queues a round with current optimistic revisions and truthful execution language', async () => {
  const f = await mount(); await click('暂停学习'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.update', companionId: owner.id, id: 'goal-a', expectedRevision: 3, state: 'paused' });
  expect(button('安排下一轮').disabled).toBe(true); await click('恢复学习'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.update', companionId: owner.id, id: 'goal-a', expectedRevision: 4, state: 'active' });
  await click('安排下一轮'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.run', companionId: owner.id, id: 'goal-a', expectedRevision: 5 });
  expect(node!.textContent).toContain('按学习时段与伙伴状态等待执行'); expect(node!.textContent).not.toContain('已经学会');
});

it('shows actual questions, evidence and memory links lazily without treating self-test as mastery', async () => {
  const f = await mount(); await toggleSummary('查看 1 道自测题与回答');
  expect(node!.textContent).toContain('潮汐受什么影响'); expect(node!.textContent).toContain('自评：有材料支持'); expect(node!.textContent).toContain('回答可以对应本轮原文');
  await click('近岸潮汐.md'); expect(node!.querySelector('.learning-round-read-detail')?.textContent).toContain(round().reads[0]!.excerpt);
  await click('查看记忆 1'); expect(f.props.onOpenNote).toHaveBeenCalledExactlyOnceWith('note-actual'); expect(node!.querySelector('a[href^="file:"]')).toBeNull();
});

it('requires explicit end confirmation and preserves a failed edit rather than inventing a saved result', async () => {
  const f = fixture(); const original = f.workspace.getMockImplementation()!; f.workspace.mockImplementation(input => input.type === 'memory.learning.goals.update' && input.text ? Promise.resolve({ ok: false, error: '目标已变化，请重新核对版本。' }) : original(input));
  await mount(f); await toggleSummary('学习节奏与材料'); await click('结束这个学习目标'); expect(f.workspace.mock.calls.some(([input]) => input.type === 'memory.learning.goals.update')).toBe(false); await click('继续保留');
  await click('调整目标'); await fill('持续学习目标', '修改后的学习方向'); await click('保存调整'); expect(node!.querySelector<HTMLTextAreaElement>('[aria-label="持续学习目标"]')!.value).toBe('修改后的学习方向'); expect(node!.querySelector('[role="alert"]')?.textContent).toContain('目标已变化');
  expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.learning.goals.update', expectedRevision: 3, text: '修改后的学习方向' }));
});

it('does not re-download unchanged large round bodies during unrelated world changes and preserves drafts on a new revision', async () => {
  vi.useFakeTimers(); const f = await mount(); expect(f.workspace.mock.calls.filter(([input]) => input.type === 'memory.learning.goals.rounds')).toHaveLength(1);
  await act(async () => { f.emit(); await vi.advanceTimersByTimeAsync(1700); }); expect(f.workspace.mock.calls.filter(([input]) => input.type === 'memory.learning.goals.rounds')).toHaveLength(1);
  await click('调整目标'); await fill('持续学习目标', '保留这份调整草稿'); f.replaceGoals([goal({ revision: 8 })]); await act(async () => { f.emit(); await vi.advanceTimersByTimeAsync(1700); });
  expect(node!.querySelector<HTMLTextAreaElement>('[aria-label="持续学习目标"]')!.value).toBe('保留这份调整草稿'); await click('保存调整');
  expect(f.workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.learning.goals.update', expectedRevision: 3, text: '保留这份调整草稿' }));
});

it('paginates round records instead of appending their bodies into the document', async () => {
  const f = fixture(); const original = f.workspace.getMockImplementation()!;
  f.workspace.mockImplementation(input => input.type === 'memory.learning.goals.rounds' ? Promise.resolve({ ok: true, learningRounds: input.cursor ? { items: [round({ id: 'round-old', ordinal: 99, plan: { focus: '仅在第二页的旧记录', questions: [], searchQueries: [] } })], hasMore: false } : { items: [round()], hasMore: true, nextCursor: 10 } }) : original(input));
  await mount(f); await click('下一页记录'); expect(f.workspace).toHaveBeenCalledWith({ type: 'memory.learning.goals.rounds', companionId: owner.id, id: 'goal-a', cursor: 10, limit: 10 }); expect(node!.querySelectorAll('.learning-round-detail')).toHaveLength(1); expect(node!.textContent).toContain('仅在第二页的旧记录'); expect(node!.textContent).not.toContain('今天先理解潮汐的来源');
  await click('上一页记录'); expect(node!.textContent).toContain('今天先理解潮汐的来源'); expect(node!.textContent).not.toContain('仅在第二页的旧记录');
});

it('rejects wrong-owner records and resets all visible history immediately when changing companions', async () => {
  const f = await mount(); await act(async () => root!.render(<CompanionLearningGoalsWorkspace {...f.props} owner={second} />));
  expect(node!.textContent).not.toContain('本轮初步理解潮汐'); expect(node!.textContent).not.toContain('近岸潮汐.md'); expect(node!.querySelector('[role="alert"]')?.textContent).toContain('归属未能核实'); expect(node!.textContent).toContain('小夏');
});

it('renders hostile learning text literally and only shows evidence verified against this round read', async () => {
  const hostile = '<img src=x onerror="alert(1)">'; const r = round({ summary: hostile, claims: [{ text: '需要证据的结论', evidence: [{ sourceId: 'read-other', quote: '未经核对的伪造引用' }] }] });
  await mount(fixture([goal()], [r])); expect(node!.textContent).toContain(hostile); expect(node!.querySelector('img[src="x"]')).toBeNull(); await toggleSummary('查看 1 项理解与原文依据'); expect(node!.textContent).toContain('此引用未能与本轮原文凭证核对'); expect(node!.textContent).not.toContain('未经核对的伪造引用');
});

it('mounts at most one bounded excerpt slice and keeps later source text available on demand', async () => {
  const excerpt = '甲'.repeat(2999) + '😀' + '中间内容'.repeat(1500) + '末尾'; const r = round(); r.reads[0] = { ...r.reads[0]!, excerpt, characters: excerpt.length };
  await mount(fixture([goal()], [r])); expect(node!.querySelector('.learning-round-read-detail')).toBeNull(); await click('近岸潮汐.md');
  const slices: string[] = []; for (;;) { const text = node!.querySelector('.learning-round-read-detail > p')!.textContent!; expect(text.length).toBeLessThanOrEqual(3000); expect(text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u); slices.push(text); const next = button('下一段'); if (next.disabled) break; await click('下一段'); }
  expect(slices.join('')).toBe(excerpt);
});

it('keeps a selected goal receipt visible when selecting it again', async () => {
  await mount(); const selected = node!.querySelector<HTMLButtonElement>('[aria-label="学习目标列表"] [aria-current="true"]')!; await act(() => selected.click()); expect(node!.querySelector('.learning-round-detail')).not.toBeNull(); expect(node!.textContent).toContain('本轮初步理解潮汐');
});

it('shows the actual memory reuse or revision receipt without claiming every learning round created new knowledge', async () => {
  await mount(fixture([goal()], [round({ integration: { action: 'reused', noteId: 'note-actual', version: 4, reason: '本轮结论与已有版本一致，保留原理解和新的阅读依据。' } })]));
  expect(node!.querySelector('.learning-round-integration')?.textContent).toContain('复用了已有的学习记忆'); expect(node!.querySelector('.learning-round-integration')?.textContent).toContain('版本 4'); expect(node!.textContent).toContain('本轮结论与已有版本一致'); expect(node!.textContent).not.toContain('留下了一份新的学习记忆');
});

it('shows whether a learning reflection changed current focus and links its actual reading evidence', async () => {
  await mount(fixture([goal()], [round({ stateReflection: { focus: '接下来先核实潮汐的当地条件', reason: '这轮仍缺少沿岸观测。', expectedRevision: 9,
    outcome: 'skipped', detail: '期间有更新的聊天，保留当前关注；正式笔记仍有效。', evidence: [{ sourceId: 'read-a', quote: '潮汐与月球、太阳的引力' }] } })]));
  expect(node!.textContent).toContain('整理后的关注 · 保留当前状态');
  expect(node!.textContent).toContain('期间有更新的聊天，保留当前关注');
  expect(node!.textContent).not.toContain('已更新情绪');
  const quote = [...node!.querySelectorAll('blockquote')].find(item => item.textContent?.includes('潮汐与月球、太阳的引力'))!;
  await act(() => quote.querySelector('button')!.click());
  expect(node!.querySelector('#learning-round-read-read-a .learning-round-read-detail')?.textContent).toContain('地球运动有关');
});

it('exposes real partial-reading issues beside successful receipts without pretending that all materials were read', async () => {
  const actualDto = companionLearningGoalRoundSchema.parse(round({ readingIssues: ['海湾观测网页：本轮请求超时，未读到正文。'] }));
  await mount(fixture([goal()], [actualDto])); expect(node!.textContent).toContain('近岸潮汐.md'); expect(node!.textContent).toContain('本轮未能读取的材料 · 1 项'); expect(node!.textContent).not.toContain('本轮请求超时');
  await toggleSummary('本轮未能读取的材料 · 1 项'); expect(node!.querySelector('.learning-round-reading-issues')?.textContent).toContain('海湾观测网页：本轮请求超时，未读到正文。'); expect(node!.textContent).toContain('本轮初步理解潮汐');
});

it('keeps a long goal compact in navigation and its heading while retaining the exact full reading and editing text', async () => {
  const text = '长期目标'.repeat(2998) + '阅读结尾'; await mount(fixture([goal({ text })], []));
  expect(node!.querySelector('.learning-goals-sidebar li strong')?.textContent).toBe(text.slice(0, 100) + '…');
  expect(node!.querySelector('.learning-goal-overview > h3')?.textContent).toBe(text.slice(0, 160) + '…');
  expect(node!.querySelector('.learning-goal-full-text > p')).toBeNull(); expect(node!.textContent).not.toContain('阅读结尾');
  await toggleSummary('完整学习目标'); expect(node!.querySelector('.learning-goal-full-text > p')?.textContent).toBe(text);
  await click('调整目标'); expect(node!.querySelector<HTMLTextAreaElement>('[aria-label="持续学习目标"]')!.value).toBe(text);
  expect(node!.textContent).toContain('工作与聊天可独立并行'); expect(node!.textContent).toContain('睡眠、用餐、未激活或暂停时会等待'); expect(node!.textContent).not.toContain('忙碌、休眠或暂停时会等待');
});
