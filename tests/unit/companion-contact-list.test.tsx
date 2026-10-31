// @vitest-environment happy-dom
import { Activity, act } from 'react';
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
  const input = async (value: string) => act(() => { const field = document.querySelector<HTMLInputElement>('#contact-manager-group-name')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="联系人管理"]')!;
  const manageButton = (text: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  const create = async (name: string) => {
    await act(() => manageButton('新建分组').click()); await input(name);
    await act(() => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  };
  const move = async (title: string, target: string) => {
    await act(() => dialog().querySelector<HTMLInputElement>('[aria-label="选择' + title + '"]')!.click());
    await act(() => dialog().querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
    await act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(item => item.textContent === target)!.click());
  };
  await act(() => button('联系人管理').click());
  expect(host.querySelector('form,select')).toBeNull(); expect(dialog()).not.toBeNull();
  await create('特别关心'); await move(role.name, '特别关心');
  await act(() => manageButton('完成').click());
  expect(document.querySelector('[role="dialog"][aria-label="联系人管理"]')).toBeNull();
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('section[aria-label="特别关心"] .companion-contact-group-heading > button')!.click());
  expect(host.querySelector('section[aria-label="特别关心"] [data-companion-contact]')).toBeNull();
  await act(() => button('群聊').click()); expect(host.textContent).not.toContain('特别关心');
  await act(() => button('联系人管理').click()); await create('休闲群'); await move('周末', '休闲群');
  await act(() => manageButton('完成').click());
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

it('removes the managed dialog and its themed move menu when the retained companion view is deactivated, without reopening on return', async () => {
  const state = initialCompanionContactGroups();
  state.groups.push({ id: 'friends', kind: 'contacts', name: '常联系', system: false });
  const request = vi.fn(async (): Promise<CompanionsResponse> => ({ ok: true, contactGroups: state }));
  const role = { ...BUILTIN_COMPANIONS[1]!, builtin: true, createdAt: '2026-10-29T01:00:00Z' };
  const props = { companions: [role], conversations: [], request, onSelect: vi.fn(), onOpenConversation: vi.fn(),
    onAdd: vi.fn(), onCreateGroup: vi.fn(), renderConversationAvatar: () => null };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (active: boolean) => { await act(() => root!.render(<Activity mode={active ? 'visible' : 'hidden'}><CompanionContactList {...props} active={active} /></Activity>)); };
  await render(true);
  await act(() => host.querySelector<HTMLButtonElement>('.companion-contact-manager')!.click());
  expect(host.querySelector('form,select')).toBeNull();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="联系人管理"]')!;
  expect(dialog).not.toBeNull();
  await act(() => dialog.querySelector<HTMLInputElement>(`[aria-label="选择${role.name}"]`)!.click());
  await act(() => dialog.querySelector<HTMLButtonElement>('[role="combobox"]')!.click());
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(1);
  expect(document.querySelector('[role="option"]')!.textContent).toBe('常联系');
  await render(false);
  expect(document.querySelector('[role="dialog"][aria-label="联系人管理"]')).toBeNull();
  expect(document.querySelector('[role="option"]')).toBeNull();
  await render(true);
  expect(document.querySelector('[role="dialog"][aria-label="联系人管理"]')).toBeNull();
  expect(host.querySelector('.companion-contact-manager')!.getAttribute('aria-expanded')).toBe('false');
});

it('keeps the group draft and actual save error after a rejected mutation, then retries with the refreshed revision', async () => {
  let state = initialCompanionContactGroups(), attempts = 0;
  const revisions: number[] = [];
  const request = vi.fn(async (command: CompanionsRequest): Promise<CompanionsResponse> => {
    if (command.type === 'contact.groups.create') {
      revisions.push(command.expectedRevision);
      expect(command.name).toBe('特别关心');
      if (++attempts === 1) { state = { ...state, revision: 7 }; return { ok: false, error: '分组已经更新，请核对后重试。' }; }
      expect(command.expectedRevision).toBe(7);
      state = { ...state, revision: 8, groups: [...state.groups, { id: 'saved', kind: 'contacts', name: command.name, system: false }] };
    }
    return { ok: true, contactGroups: state };
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<CompanionContactList companions={[]} conversations={[]} request={request} onSelect={vi.fn()} onOpenConversation={vi.fn()} onAdd={vi.fn()} onCreateGroup={vi.fn()} renderConversationAvatar={() => null} />));
  await act(() => host.querySelector<HTMLButtonElement>('.companion-contact-manager')!.click());
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="联系人管理"]')!;
  const create = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '新建分组')!;
  await act(() => create.click());
  const field = dialog().querySelector<HTMLInputElement>('#contact-manager-group-name')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '特别关心'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  const submit = async () => { await act(() => dialog().querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); };
  await submit();
  expect(field.value).toBe('特别关心');
  expect(dialog().querySelector('[role="alert"]')!.textContent).toContain('分组已经更新，请核对后重试。');
  expect(dialog().querySelector('form')).not.toBeNull();
  await submit();
  expect(revisions).toEqual([1, 7]);
  expect(dialog().querySelector('form')).toBeNull();
  expect(dialog().querySelector('[role="alert"]')).toBeNull();
  await act(() => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '完成')!.click());
  expect(host.querySelector('section[aria-label="特别关心"]')).not.toBeNull();
});
