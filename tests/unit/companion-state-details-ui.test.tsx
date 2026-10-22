// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionPlanner } from '../../src/renderer/companions/CompanionPlanner';
import { CompanionStateChanges } from '../../src/renderer/companions/CompanionStateChanges';
import { CompanionCharacterDevelopment } from '../../src/renderer/companions/CompanionCharacterDevelopment';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';
import { companionStateChangeSchema, type CompanionStateChange } from '../../src/shared/companion-state-change';
import { companionCharacterDevelopmentSchema, type CompanionCharacterDevelopment as Development } from '../../src/shared/companion-character-development';
import type { CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
const at = '2026-10-22T12:00:00.000Z', earlier = '2026-10-22T11:50:00.000Z';
const companion = { ...BUILTIN_COMPANIONS[0]!, builtin: true, createdAt: at };
const runtime: CompanionRuntimeState = { companionId: companion.id, energy: 67, mood: 'bright', expression: 'playful', affect: { pleasure: .4, arousal: .2, dominance: .1 }, relationship: { affinity: 52, trust: 61, respect: 70 }, focus: '海洋阅读', reason: '当前已核实的关注说明。', familiarity: { stage: 'acquainted', interactionCount: 12, sharedEventCount: 2 }, updatedAt: at, revision: 5 };
function change(patch: Partial<CompanionStateChange> = {}) { return companionStateChangeSchema.parse({ id: 'change-a', kind: 'memory', appliedAt: earlier, occurredAt: earlier, reason: '从实际整理的经历中确认了自己的表达边界。', affectDelta: { pleasure: .12, arousal: -.08, dominance: 0 }, relationshipDelta: { affinity: 0, trust: 0, respect: 0 }, energyDelta: 0, expression: { before: 'gentle', after: 'direct' }, focus: { before: '等待回复', after: '整理海洋资料' }, sourceConversationId: 'source-room', sourceMessageIds: ['source-a'], memoryIds: ['note-a'], ...patch }); }
function development(patch: Partial<Development> = {}): Development { return companionCharacterDevelopmentSchema.parse({ companionId: companion.id, conversationId: 'room', observedAt: at, truncated: false, items: [{ memoryId: 'note-preference', memoryVersion: 4, kind: 'preference', topic: '阅读节奏', statement: '我更喜欢安静地把一个问题读清楚。', basis: 'self_expression', updatedAt: earlier, sourceMessageIds: ['actual-self-message'] }], ...patch }); }
function fixture() {
  let state: CompanionRuntimeState | undefined = { ...runtime, recentChanges: [change()] }, profile = development(), fail = false, profileFail = false;
  const listeners = new Set<() => void>();
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type === 'state.get') return fail ? { ok: false, error: '状态来源正在重新核验。' } : { ok: true, runtimeState: state };
    if (input.type === 'character.development') return profileFail ? { ok: false, error: '认识来源已不可访问。' } : { ok: true, characterDevelopment: profile };
    if (input.type === 'schedule.list') return { ok: true, schedules: [], scheduleOccurrences: [] };
    if (input.type === 'work-order.list') return { ok: true, workOrderPage: { items: [], hasMore: false } };
    return { ok: true };
  });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onReplyStream: () => () => undefined };
  return { request, api, emit: () => listeners.forEach(listener => listener()), setState: (value: typeof state) => { state = value; }, setProfile: (value: Development) => { profile = value; }, failState: () => { fail = true; }, restoreState: () => { fail = false; }, failProfile: () => { profileFail = true; } };
}
async function mount(element: React.ReactNode) { vi.useFakeTimers(); vi.setSystemTime(at); node = document.createElement('div'); document.body.append(node); root = createRoot(node); await act(async () => root!.render(element)); }
function button(label: string) { const found = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label); if (!found) throw new Error('Missing button ' + label); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function toggle(label: string) { const summary = [...node!.querySelectorAll('summary')].find(item => item.textContent?.includes(label)); if (!summary) throw new Error('Missing summary ' + label); await act(async () => { const details = summary.parentElement as HTMLDetailsElement; details.open = !details.open; details.dispatchEvent(new Event('toggle')); }); }
async function advance(ms = 250) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function plannerProps(f = fixture()): ComponentProps<typeof CompanionPlanner> { return { companion, members: [companion], conversationId: 'room', actions: [], request: f.request, api: f.api, onOwnerChange: vi.fn(), onClose: vi.fn(), onProfile: vi.fn(), onMemory: vi.fn(), onTasks: vi.fn(), onSchedules: vi.fn(), onWork: vi.fn(), onLocateStateSource: vi.fn(), onStateMemory: vi.fn() }; }

it('keeps committed change details out of the main card and shows actual deltas, authored transitions and exact source links on demand', async () => {
  const props = plannerProps(); await mount(<CompanionPlanner {...props} />);
  expect(node!.textContent).not.toContain(change().reason); expect(node!.querySelector('[data-state-change]')).toBeNull();
  await click('查看当前伙伴状态详情'); expect(node!.textContent).toContain('状态变化的来处'); expect(node!.textContent).not.toContain(change().reason);
  await toggle('状态变化的来处'); expect(node!.querySelector('[data-state-change="change-a"] time')?.getAttribute('dateTime')).toBe(earlier);
  expect(node!.textContent).toContain(change().reason); expect(node!.textContent).toContain('愉悦+0.12'); expect(node!.textContent).toContain('活跃-0.08'); expect(node!.textContent).toContain('表达 温柔 → 直率'); expect(node!.textContent).toContain('关注 等待回复 → 整理海洋资料');
  expect(node!.querySelector('.companions-state-change-deltas')?.textContent).not.toContain('好感'); expect(node!.textContent).not.toContain('来源消息 1');
  await toggle('查看来源'); await click('查看来源消息 1'); expect(props.onLocateStateSource).toHaveBeenCalledExactlyOnceWith('source-room', 'source-a'); await click('查看相关记忆 1'); expect(props.onStateMemory).toHaveBeenCalledExactlyOnceWith('note-a');
  expect(node!.textContent).toContain('增减值是当时的生效记录'); expect(node!.textContent).toContain('状态核对');
});

it('does not invent changes from a tick timestamp or a new snapshot when the host has no committed receipt', async () => {
  const f = fixture(); f.setState({ ...runtime, updatedAt: at, recentChanges: [] }); await mount(<CompanionPlanner {...plannerProps(f)} />); await click('查看当前伙伴状态详情'); await toggle('状态变化的来处');
  expect(node!.textContent).toContain('当前没有可展示的近期生效凭证'); expect(node!.querySelector('[data-state-change]')).toBeNull();
  f.setState({ ...runtime, affect: { ...runtime.affect, pleasure: .65 }, revision: 6, recentChanges: [] }); await act(async () => f.emit()); await advance(); expect(node!.querySelector('[data-state-change]')).toBeNull(); expect(node!.textContent).not.toContain('+0.25');
});

it('clears obsolete values and receipts on a failed state read and restores only freshly verified values', async () => {
  const f = fixture(); await mount(<CompanionPlanner {...plannerProps(f)} />); await click('查看当前伙伴状态详情'); await toggle('状态变化的来处'); expect(node!.textContent).toContain(change().reason);
  f.failState(); await act(async () => f.emit()); await advance(); expect(node!.textContent).toContain('状态来源正在重新核验'); expect(node!.textContent).toContain('旧状态与来源已隐藏'); expect(node!.textContent).not.toContain(change().reason); expect(node!.textContent).not.toContain('心情明亮'); expect(node!.querySelector('[aria-label="伙伴精力"]')?.hasAttribute('aria-valuenow')).toBe(false);
  f.restoreState(); f.setState({ ...runtime, mood: 'low', recentChanges: [] }); await click('重新核对'); expect(node!.textContent).toContain('情绪低落'); expect(node!.textContent).not.toContain('心情明亮');
});

it('does not flash private state or receipts when the same companion is selected in a different conversation', async () => {
  const f = fixture(), props = plannerProps(f); let finish: ((result: CompanionsResponse) => void) | undefined;
  const original = f.request.getMockImplementation()!; f.request.mockImplementation(input => input.type === 'state.get' && input.conversationId === 'group-room' ? new Promise(resolve => { finish = resolve; }) : original(input));
  await mount(<CompanionPlanner {...props} />); await click('查看当前伙伴状态详情'); await toggle('状态变化的来处');
  await act(async () => root!.render(<CompanionPlanner {...props} conversationId="group-room" conversationKind="group" />)); expect(node!.textContent).not.toContain(change().reason); expect(node!.textContent).not.toContain(runtime.reason!); expect(node!.textContent).not.toContain('好感 52');
  await act(async () => finish!({ ok: true, runtimeState: { ...runtime, reason: '当前群内的公开状态。', recentChanges: [] } })); expect(node!.textContent).toContain('当前群内的公开状态'); expect(node!.querySelector('[data-state-change]')).toBeNull();
});

it('accepts fresh state during a continuous stream of change events instead of postponing every read', async () => {
  const f = fixture(); await mount(<CompanionPlanner {...plannerProps(f)} />); f.setState({ ...runtime, mood: 'tired', energy: 21, recentChanges: [] });
  for (let index = 0; index < 8; index++) { await act(async () => f.emit()); await advance(100); }
  expect(node!.textContent).toContain('有点疲惫'); expect(node!.querySelector('[aria-label="伙伴精力"]')?.getAttribute('aria-valuenow')).toBe('21'); expect(f.request.mock.calls.filter(([input]) => input.type === 'state.get').length).toBeGreaterThan(2);
});

it('keeps zero changes neutral, tiny real changes nonzero, source DOM bounded and hostile reasons literal', async () => {
  const source = vi.fn(), note = vi.fn(), text = '<img src=x onerror="alert(1)">';
  await mount(<CompanionStateChanges changes={[change({ reason: text, affectDelta: { pleasure: 0, arousal: -0, dominance: .0000001 }, sourceMessageIds: Array.from({ length: 100 }, (_, index) => 'source-' + index) })]} onLocateSource={source} onOpenMemory={note} />);
  await toggle('状态变化的来处'); expect(node!.querySelector('img[src=x]')).toBeNull(); expect(node!.textContent).toContain(text); expect(node!.querySelector('.companions-state-change-deltas')?.textContent).toBe('自主+1.00e-7');
  expect(node!.querySelector('.companions-state-change-sources code')).toBeNull(); await toggle('查看来源'); expect(node!.querySelectorAll('.companions-state-change-sources li')).toHaveLength(10); expect(node!.textContent).not.toContain('source-99');
  for (let page = 0; page < 10; page++) await click('下一页来源'); expect(node!.querySelectorAll('.companions-state-change-sources li')).toHaveLength(1); await click('查看相关记忆 1'); expect(note).toHaveBeenCalledWith('note-a');
});

it('reads current source-backed preferences only when opened, links their exact VCP note, and replaces withdrawn entries', async () => {
  const f = fixture(), openMemory = vi.fn(); await mount(<CompanionCharacterDevelopment companionId={companion.id} conversationId="room" request={f.request} api={f.api} onOpenMemory={openMemory} />); expect(f.request).not.toHaveBeenCalled();
  await toggle('现在的喜好与自我认识'); expect(f.request).toHaveBeenCalledWith({ type: 'character.development', companionId: companion.id, conversationId: 'room', limit: 12 }); expect(node!.textContent).toContain('我更喜欢安静地把一个问题读清楚'); expect(node!.textContent).toContain('本人表达'); expect(node!.textContent).toContain('版本 4'); await click('查看认识原文'); expect(openMemory).toHaveBeenCalledExactlyOnceWith('note-preference');
  f.setProfile(development({ items: [] })); await act(async () => f.emit()); await advance(1100); expect(node!.textContent).not.toContain('我更喜欢安静'); expect(node!.textContent).toContain('不推断固定喜好或价值观');
});

it('rejects mismatched or unavailable self-understanding without retaining old cached private content', async () => {
  const f = fixture(); await mount(<CompanionCharacterDevelopment companionId={companion.id} conversationId="room" request={f.request} api={f.api} />); await toggle('现在的喜好与自我认识'); expect(node!.textContent).toContain('阅读节奏');
  f.setProfile(development({ conversationId: 'other-private-room' })); await act(async () => f.emit()); await advance(1100); expect(node!.textContent).not.toContain('阅读节奏'); expect(node!.textContent).toContain('暂时无法核实');
  f.failProfile(); await click('重新核对认识'); expect(node!.textContent).toContain('认识来源已不可访问'); expect(node!.querySelector('[data-development-note]')).toBeNull();
});
