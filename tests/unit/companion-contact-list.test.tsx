// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionContactList } from '../../src/renderer/companions/CompanionContactList';
import { initialCompanionContactGroups } from '../../src/shared/companion-contact-groups';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
it('groups contacts and chats independently, supports collapse and moving, and restores saved grouping on remount', async () => {
  let state = initialCompanionContactGroups();
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type === 'contact.groups.create') { expect(input.expectedRevision).toBe(state.revision); state = { ...state, revision: state.revision + 1, groups: [...state.groups, { id: `g${state.revision}`, kind: input.kind, name: input.name, system: false }] }; }
    if (input.type === 'contact.groups.assign') { expect(input.expectedRevision).toBe(state.revision); state = { ...state, revision: state.revision + 1, assignments: { ...state.assignments, ...Object.fromEntries(input.itemIds.map(id => [id, input.groupId])) } }; }
    return { ok: true, contactGroups: state };
  });
  const role = { ...BUILTIN_COMPANIONS[1]!, builtin: true, createdAt: new Date().toISOString() };
  const onSelect = vi.fn(), onOpen = vi.fn();
  const props = { companions: [role], selectedId: role.id, conversations: [{ id: 'weekend', kind: 'group' as const, title: '周末', memberIds: [role.id], pinned: false, muted: false, unread: 0, updatedAt: role.createdAt, lastMessage: '' }], request,
    onSelect, onOpenConversation: onOpen, onAdd: vi.fn(), onCreateGroup: vi.fn(), renderConversationAvatar: () => null };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<CompanionContactList {...props} />));
  const heading = host.querySelector<HTMLButtonElement>('section[aria-label="我的伙伴"] .companion-contact-group-heading > button')!;
  const arrow = heading.querySelector<HTMLElement>('.companion-contact-disclosure')!;
  const content = document.getElementById(heading.getAttribute('aria-controls')!)!;
  expect(heading.getAttribute('aria-expanded')).toBe('true'); expect(arrow.style.transform).toBe('rotate(90deg)');
  expect(host.querySelector('[data-companion-contact]')?.getAttribute('aria-pressed')).toBe('true');
  await act(() => heading.click());
  expect(heading.getAttribute('aria-expanded')).toBe('false'); expect(arrow.style.transform).toBe('rotate(0deg)');
  expect(content.hidden).toBe(true); expect(host.querySelector('[data-companion-contact]')).toBeNull();
  await act(() => heading.click());
  expect(content.hidden).toBe(false); expect(arrow.style.transform).toBe('rotate(90deg)');
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  const input = async (value: string) => act(() => { const field = host.querySelector<HTMLInputElement>('#contact-group-name')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => button('联系人管理').click()); await input('特别关心');
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const select = host.querySelector('select')!;
  await act(() => { select.value = 'g1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('section[aria-label="特别关心"] .companion-contact-group-heading > button')!.click());
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).toBeNull();
  await act(() => button('群聊').click()); expect(host.textContent).not.toContain('特别关心');
  await input('休闲群'); await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await act(() => { const field = host.querySelector('select')!; field.value = 'g3'; field.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('section[aria-label="休闲群"] [data-companion-contact-group]')).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[data-companion-contact-group]')!.click()); expect(onOpen).toHaveBeenCalledWith(props.conversations[0]);
  await act(() => root!.unmount()); root = createRoot(host);
  await act(() => root!.render(<CompanionContactList {...props} />));
  await act(() => host.querySelector<HTMLButtonElement>('[data-companion-contact]')!.click()); expect(onSelect).toHaveBeenCalledWith(role.id);
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).not.toBeNull();
  // Search opens matching groups, while their disclosure remains interactive.
  await act(() => { const input = host.querySelector<HTMLInputElement>('[aria-label="搜索联系人"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, role.name); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const searchHeading = host.querySelector<HTMLButtonElement>('section[aria-label="特别关心"] .companion-contact-group-heading > button')!;
  await act(() => searchHeading.click());
  expect(searchHeading.getAttribute('aria-expanded')).toBe('false');
  expect(searchHeading.querySelector<HTMLElement>('.companion-contact-disclosure')!.style.transform).toBe('rotate(0deg)');
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click());
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).not.toBeNull();
});
