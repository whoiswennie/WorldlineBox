// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionDialogs } from '../../src/renderer/companions/CompanionDialogs';
import type { CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); });
type Creation = Extract<CompanionsRequest, { type: 'companion.create' | 'companion.add-builtin' }>;
function receipt(input: Creation, state: 'committed' | 'prepared' = 'committed'): NonNullable<CompanionsResponse['creation']> {
  return { schema: 'companion-creation-v1', operationId: input.operationId, companionId: input.companionId, state, requestHash: 'a'.repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
async function mount(handler: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>) {
  const request = vi.fn(handler), onClose = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<CompanionDialogs dialog={{ kind: 'companion' }} companions={[]} request={request} onClose={onClose} onOpen={vi.fn()} onCreated={vi.fn()} builtins={BUILTIN_COMPANIONS} />));
  return { request, onClose };
}
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
async function custom() {
  await act(() => button('自定义角色').click());
  const input = container.querySelector<HTMLInputElement>('input[maxlength="60"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '海岚'); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('freezes creation identity and starting profile across an interrupted request and retries after checking its status', async () => {
  let calls = 0;
  const f = await mount(async input => {
    if (input.type === 'companion.creation.status') return { ok: true };
    if (input.type === 'companion.create') { calls++; return calls === 1 ? undefined : { ok: true, creation: receipt(input) }; }
    return { ok: false };
  });
  await custom(); await act(() => button('添加伙伴').click());
  expect(f.onClose).not.toHaveBeenCalled(); expect(container.querySelector('fieldset')?.disabled).toBe(true);
  await act(() => button('重试同一次创建').click());
  const creations = f.request.mock.calls.map(([input]) => input).filter((input): input is Extract<Creation, { type: 'companion.create' }> => input.type === 'companion.create');
  expect(creations).toHaveLength(2); expect(creations[1]).toEqual(creations[0]);
  expect(f.request.mock.calls[1]?.[0]).toEqual({ type: 'companion.creation.status', operationId: creations[0]!.operationId });
  expect(f.onClose).toHaveBeenCalledOnce();
});
it('accepts a committed status after a lost reply without issuing creation again', async () => {
  let creation: Creation | undefined;
  const f = await mount(async input => {
    if (input.type === 'companion.create') { creation = input; return undefined; }
    if (input.type === 'companion.creation.status') return { ok: true, creation: receipt(creation!) };
    return { ok: false };
  });
  await custom(); await act(() => button('添加伙伴').click()); await act(() => button('重试同一次创建').click());
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.create')).toHaveLength(1); expect(f.onClose).toHaveBeenCalledOnce();
});
it('keeps a prepared or mismatched receipt open and prevents rapid clicks from creating multiple identities', async () => {
  const f = await mount(async input => input.type === 'companion.create' ? { ok: true, creation: receipt(input, 'prepared') } : { ok: true });
  await custom(); await act(async () => { button('添加伙伴').click(); button('添加伙伴').click(); });
  expect(f.request.mock.calls.filter(([input]) => input.type === 'companion.create')).toHaveLength(1); expect(f.onClose).not.toHaveBeenCalled();
  expect(container.textContent).toContain('尚未确认完成');
});
it('keeps the selected template and the same identity when retrying a prepared template creation', async () => {
  let calls = 0;
  const f = await mount(async input => {
    if (input.type === 'companion.add-builtin') { calls++; return { ok: true, creation: receipt(input, calls === 1 ? 'prepared' : 'committed') }; }
    return { ok: true };
  });
  await act(() => container.querySelector<HTMLButtonElement>('[data-builtin-template="flash"] button')!.click());
  expect(f.onClose).not.toHaveBeenCalled(); expect(container.textContent).toContain('本次提交的角色起点已固定');
  await act(() => button('重试同一次创建').click());
  const requests = f.request.mock.calls.map(([input]) => input).filter(input => input.type === 'companion.add-builtin');
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(f.onClose).toHaveBeenCalledOnce();
});
