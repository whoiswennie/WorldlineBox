// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionCharacterDevelopment } from '../../src/renderer/companions/CompanionCharacterDevelopment';
import { useCompanionRoutine } from '../../src/renderer/companions/companion-routines';
import { companionRoutineSchema } from '../../src/shared/companion-routine';
import type { CompanionCharacterDevelopment as Development } from '../../src/shared/companion-character-development';
import type { CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); vi.useRealTimers(); });
const at = '2026-10-28T08:00:00.000Z';
const routine = companionRoutineSchema.parse({ companionId: 'alice', config: {}, revision: 1, createdAt: at, updatedAt: at, habitProgress: [], runtime: { phase: 'resting', activity: 'PRIVATE_CURRENT_ROUTINE', nextTransitionAt: at, canRespond: true } });
const development: Development = { companionId: 'alice', conversationId: 'room', observedAt: at, truncated: false, items: [{ memoryId: 'self-note', memoryVersion: 1, kind: 'preference', topic: '阅读', statement: 'PRIVATE_CURRENT_PREFERENCE', basis: 'self_expression', updatedAt: at, sourceMessageIds: ['self-message'] }] };
function fixture() {
  const listeners = new Set<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>();
  const request = vi.fn(async (command: CompanionsRequest): Promise<CompanionsResponse> => command.type === 'routine.get' ? { ok: true, routine } : { ok: true, characterDevelopment: development });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; }, onReplyStream: () => () => undefined };
  return { request, api, listeners, emit: (change?: Parameters<Parameters<WorldlineBoxCompanionsApi['onChanged']>[0]>[0]) => listeners.forEach(callback => callback(change)) };
}
async function mount() { vi.useFakeTimers(); node = document.createElement('div'); document.body.append(node); root = createRoot(node); }
function Routine({ api, active = true }: { api: WorldlineBoxCompanionsApi; active?: boolean }) { const { routine } = useCompanionRoutine('alice', 'room', api.request, api, active); return <div>{routine?.runtime.activity ?? '正在核对作息'}</div>; }
async function toggle() { await act(async () => { const details = node.querySelector('details')!; details.open = !details.open; details.dispatchEvent(new Event('toggle')); }); }

it.each(['inactive', 'activity'] as const)('stops routine reads while hidden and waits for a fresh current routine on return (%s)', async mode => {
  await mount(); const f = fixture();
  const render = async (visible: boolean) => act(async () => root!.render(<Activity mode={mode === 'activity' && !visible ? 'hidden' : 'visible'}><Routine api={f.api} active={mode !== 'inactive' || visible} /></Activity>));
  await render(true); expect(node.textContent).toContain('PRIVATE_CURRENT_ROUTINE'); expect(f.request).toHaveBeenCalledOnce();
  let finish!: (response: CompanionsResponse) => void;
  f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(false); expect(f.listeners.size).toBe(0);
  await act(async () => { for (let index = 0; index < 20; index++) f.emit({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(1100); });
  expect(f.request).toHaveBeenCalledOnce();
  await render(true); expect(f.request).toHaveBeenCalledTimes(2); expect(node.textContent).not.toContain('PRIVATE_CURRENT_ROUTINE');
  await act(async () => finish({ ok: false, error: '作息来源已撤回' })); expect(node.textContent).not.toContain('PRIVATE_CURRENT_ROUTINE');
});

it('discards a pending routine response after the panel hides', async () => {
  await mount(); const f = fixture(); let finish!: (response: CompanionsResponse) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root!.render(<Routine api={f.api} />));
  await act(async () => root!.render(<Routine api={f.api} active={false} />));
  await act(async () => finish({ ok: true, routine })); expect(node.textContent).not.toContain('PRIVATE_CURRENT_ROUTINE');
  await act(async () => root!.render(<Routine api={f.api} />)); expect(f.request).toHaveBeenCalledTimes(2); expect(node.textContent).toContain('PRIVATE_CURRENT_ROUTINE');
});

it('does not reread self-understanding on progress and removes withdrawn entries before revalidation completes', async () => {
  await mount(); const f = fixture();
  await act(async () => root!.render(<CompanionCharacterDevelopment companionId="alice" conversationId="room" api={f.api} request={f.request} />));
  expect(f.request).not.toHaveBeenCalled(); await toggle(); expect(node.textContent).toContain('PRIVATE_CURRENT_PREFERENCE');
  await act(async () => { for (let index = 0; index < 20; index++) f.emit({ kind: 'progress' }); await vi.advanceTimersByTimeAsync(1100); });
  expect(f.request).toHaveBeenCalledOnce();
  let finish!: (response: CompanionsResponse) => void;
  f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => f.emit()); expect(node.textContent).not.toContain('PRIVATE_CURRENT_PREFERENCE'); expect(f.request).toHaveBeenCalledTimes(2);
  await act(async () => finish({ ok: false, error: '认识来源已撤回。' })); expect(node.textContent).toContain('认识来源已撤回'); expect(node.textContent).not.toContain('PRIVATE_CURRENT_PREFERENCE');
});

it.each(['inactive', 'activity'] as const)('preserves the expanded self-understanding panel without reads or old private entries while hidden (%s)', async mode => {
  await mount(); const f = fixture();
  const render = async (visible: boolean) => act(async () => root!.render(<Activity mode={mode === 'activity' && !visible ? 'hidden' : 'visible'}><CompanionCharacterDevelopment companionId="alice" conversationId="room" api={f.api} request={f.request} active={mode !== 'inactive' || visible} /></Activity>));
  await render(true); await toggle(); expect(node.textContent).toContain('PRIVATE_CURRENT_PREFERENCE');
  let finish!: (response: CompanionsResponse) => void;
  f.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(false); expect(f.listeners.size).toBe(0);
  await act(async () => { f.emit(); await vi.advanceTimersByTimeAsync(1100); }); expect(f.request).toHaveBeenCalledOnce();
  await render(true); expect(node.querySelector('details')!.open).toBe(true); expect(f.request).toHaveBeenCalledTimes(2); expect(node.textContent).not.toContain('PRIVATE_CURRENT_PREFERENCE');
  await render(false); await act(async () => finish({ ok: true, characterDevelopment: development }));
  await render(true); expect(f.request).toHaveBeenCalledTimes(3); expect(node.textContent).not.toContain('PRIVATE_CURRENT_PREFERENCE');
  await act(async () => finish({ ok: false, error: '新的认识来源已撤回。' })); expect(node.textContent).toContain('新的认识来源已撤回');
});
