// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionSocialGraph } from '../../src/renderer/companions/CompanionSocialGraph';
import type { CompanionSocialGraph as Graph } from '../../src/shared/companion-social';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; vi.useRealTimers(); });
const companions: Companion[] = ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '独立', avatar: 'sister', model: '', builtin: false, proactive: false, createdAt: '2026-10-20T05:00:00Z', active: id === 'alice' }));
const initial: Graph = { centerId: 'alice', timeZone: 'Asia/Shanghai', observedDay: '2026-10-20', virtualNow: '2026-10-20T05:40:00Z', backlog: false,
  nodes: [{ id: 'alice', name: 'alice', active: true, state: 'available' }, { id: 'bob', name: 'bob', active: false, state: 'dormant' }, { id: 'user', name: '我', active: true, state: 'player' }],
  links: [{ targetId: 'bob', kind: 'peer', conversationIds: ['pair'], phoneCount: 1, faceCount: 0, status: 'permission' }, { targetId: 'user', kind: 'player', conversationIds: ['private'], phoneCount: 0, faceCount: 0, status: 'idle' }], visits: [], events: [], hasMoreEvents: false };
async function click(label: string) { const button = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label)!; await act(async () => button.click()); }
it('renders the actual focal graph with the player, updates new committed events automatically, and pauses only observation', async () => {
  vi.useFakeTimers(); let graph = initial, changed: (() => void) | undefined;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => ({ ok: true, socialGraph: { ...graph, centerId: input.type === 'social.graph' ? input.companionId : 'alice' } }));
  const api: WorldlineBoxCompanionsApi = { request, onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const history = vi.fn(); await act(async () => root!.render(<CompanionSocialGraph companions={companions} initialCompanionId="alice" request={request} api={api} onHistory={history} />));
  expect(container.querySelector('[data-social-node="user"]')).not.toBeNull(); expect(container.querySelector('[data-social-node="bob"]')!.textContent).toContain('休眠中');
  expect(container.textContent).toContain('世界 2026-10-20 13:40:00'); expect(container.textContent).toContain('等待房主许可');
  graph = { ...initial, virtualNow: '2026-10-20T05:40:02Z', events: [{ id: 'real_visit', at: '2026-10-20T05:40:01Z', realAt: '2026-10-20T05:40:01Z', actorId: 'alice', targetIds: ['bob'], kind: 'visit_request', label: '申请拜访', text: '申请拜访' }] };
  await act(async () => { changed!(); await vi.advanceTimersByTimeAsync(800); });
  expect(container.querySelectorAll('[data-social-event]')).toHaveLength(1); expect(container.textContent).not.toContain('已抵达');
  const count = request.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(2100)); expect(request.mock.calls.length).toBeGreaterThan(count);
  await click('暂停实时观察'); const pausedCount = request.mock.calls.length; await act(async () => vi.advanceTimersByTimeAsync(6000)); expect(request).toHaveBeenCalledTimes(pausedCount);
  await click('恢复实时观察'); expect(request.mock.calls.length).toBeGreaterThan(pausedCount);
  await act(async () => container!.querySelector<HTMLButtonElement>('[data-social-node="bob"]')!.click()); await click('查看往来记录'); expect(history).toHaveBeenCalledWith('pair', 'alice');
  expect(request.mock.calls.every(([input]) => input.type === 'social.graph')).toBe(true);
  const beforeUnmount = request.mock.calls.length; await act(() => root!.unmount()); root = undefined;
  await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(request).toHaveBeenCalledTimes(beforeUnmount); expect(changed).toBeUndefined();
});

it('resolves the current companion when the directory arrives after the dialog opened', async () => {
  vi.useFakeTimers(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const request = vi.fn(async (): Promise<CompanionsResponse> => ({ ok: true, socialGraph: initial }));
  await act(async () => root!.render(<CompanionSocialGraph companions={[]} initialCompanionId="" request={request} onHistory={vi.fn()} />));
  expect(request).not.toHaveBeenCalled();
  await act(async () => root!.render(<CompanionSocialGraph companions={companions} initialCompanionId="alice" request={request} onHistory={vi.fn()} />));
  expect(request).toHaveBeenCalledWith({ type: 'social.graph', companionId: 'alice', limit: 16 });
  expect(container!.querySelector('[data-social-node="user"]')).not.toBeNull();
});

it('aggregates 20,000 relationships, pages a bounded neighbourhood and searches beyond the first page', async () => {
  vi.useFakeTimers();
  const node = (index: number) => ({ id: 'scale_' + String(index).padStart(5, '0'), name: '对象 ' + index, active: false, state: 'dormant' });
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type !== 'social.graph') return { ok: false };
    const start = input.afterPeerId ? Number(input.afterPeerId.slice(6)) + 1 : 0;
    const peers = input.query ? [node(19999)] : Array.from({ length: input.limit ?? 16 }, (_, index) => node(start + index));
    return { ok: true, socialGraph: { ...initial, total: 20000, matchedTotal: input.query ? 1 : 20000,
      groups: [{ id: 'dormant', count: 20000 }, { id: 'active', count: 0 }, { id: 'player', count: 0 }],
      nodes: [initial.nodes[0]!, ...peers], links: peers.map(peer => ({ targetId: peer.id, kind: 'peer', status: 'idle', conversationIds: ['pair'], phoneCount: 0, faceCount: 0 })),
      hasMorePeers: !input.query, nextPeerId: peers.at(-1)?.id } };
  });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<CompanionSocialGraph companions={companions} initialCompanionId="alice" request={request} onHistory={vi.fn()} />));
  expect(container.querySelector('[data-social-cluster="dormant"]')?.textContent).toContain('20,000');
  expect(container.querySelectorAll('[data-social-node]')).toHaveLength(0);
  await act(async () => container!.querySelector<HTMLButtonElement>('[data-social-cluster="dormant"]')!.click());
  expect(request).toHaveBeenLastCalledWith({ type: 'social.graph', companionId: 'alice', limit: 16, group: 'dormant' });
  expect(container.querySelectorAll('[data-social-node]')).toHaveLength(16);
  await click('下一批');
  expect(request).toHaveBeenLastCalledWith({ type: 'social.graph', companionId: 'alice', limit: 16, group: 'dormant', afterPeerId: 'scale_00015' });
  expect(container.querySelector('[data-social-node="scale_00000"]')).toBeNull();
  expect(container.querySelector('[data-social-node="scale_00016"]')).not.toBeNull();
  const input = container.querySelector<HTMLInputElement>('[aria-label="搜索全部社交关系"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'scale_19999'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(request).toHaveBeenLastCalledWith({ type: 'social.graph', companionId: 'alice', limit: 16, group: 'dormant', query: 'scale_19999' });
  expect(container.querySelectorAll('[data-social-node]')).toHaveLength(1);
  expect(container.querySelector('[data-social-result="scale_19999"]')).not.toBeNull();
  expect(container.querySelectorAll('option').length).toBeLessThan(100);
  await act(async () => container!.querySelector<HTMLButtonElement>('[data-social-node="scale_19999"]')!.click());
  await click('以她为中心'); expect(container.querySelector('[data-social-center="scale_19999"]')).not.toBeNull();
  await click('返回上一中心'); expect(container.querySelector('[data-social-center="alice"]')).not.toBeNull();
});
