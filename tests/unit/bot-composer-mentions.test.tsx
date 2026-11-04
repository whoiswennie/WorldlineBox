// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotComposer } from '../../src/renderer/companion-bot/BotComposer';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const members = [
  { id: 'fish', name: '大肥鱼', persona: '成员', createdAt: '2026-11-04' },
  { id: 'gpt', name: 'GPT', persona: '成员', createdAt: '2026-11-04' },
];
let host: HTMLDivElement, root: Root | undefined;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); root = undefined; });
async function mount(group = true, world = false) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const send = vi.fn(async () => undefined);
  function Harness() {
    const [draft, setDraft] = useState('');
    return <BotComposer locale="zh-CN" draft={draft} setDraft={setDraft} disabled={false} busy={false} group={group} world={world} mentionMembers={members}
      panel={null} setPanel={() => undefined} send={send} conversationId="current-room" addFiles={async () => undefined} removeFile={() => undefined} sendSticker={async () => undefined} />;
  }
  await act(() => root!.render(<Harness />));
  const textarea = host.querySelector('textarea')!;
  await act(() => textarea.focus());
  return { textarea, send };
}
async function type(textarea: HTMLTextAreaElement, text: string) {
  await act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text); textarea.setSelectionRange(text.length, text.length); textarea.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function key(textarea: HTMLTextAreaElement, value: string, composing = false) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, isComposing: composing });
  await act(() => textarea.dispatchEvent(event)); return event;
}
it('uses arrows and Enter to select an actual member without sending, then sends normally after insertion', async () => {
  const f = await mount(); await type(f.textarea, '@');
  expect(host.querySelectorAll('[role=option]')).toHaveLength(3);
  await key(f.textarea, 'ArrowDown'); await key(f.textarea, 'Enter');
  await act(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(f.textarea.value).toBe('@大肥鱼 '); expect(f.send).not.toHaveBeenCalled();
  expect(f.textarea.selectionStart).toBe(5); expect(host.querySelector('[role=listbox]')).toBeNull();
  await key(f.textarea, 'Enter'); expect(f.send).toHaveBeenCalledTimes(1);
});
it('filters typed names, inserts with the mouse and dismisses with Escape without deleting the draft', async () => {
  const f = await mount(); await type(f.textarea, '请 @g');
  expect(host.querySelectorAll('[role=option]')).toHaveLength(1); expect(host.querySelector('[role=option]')?.textContent).toContain('GPT');
  await act(() => (host.querySelector('[role=option]') as HTMLButtonElement).click());
  expect(f.textarea.value).toBe('请 @GPT '); expect(f.send).not.toHaveBeenCalled();
  await type(f.textarea, '@大'); await key(f.textarea, 'Escape');
  expect(host.querySelector('[role=listbox]')).toBeNull(); expect(f.textarea.value).toBe('@大'); expect(f.send).not.toHaveBeenCalled();
});
it('does not take Enter or arrows away from IME composition, including browsers that omit isComposing on the key event', async () => {
  const f = await mount(); await type(f.textarea, '@');
  await act(() => f.textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  expect((await key(f.textarea, 'Enter')).defaultPrevented).toBe(false); expect(f.send).not.toHaveBeenCalled();
  await type(f.textarea, '@大'); await act(() => f.textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '大' })));
  expect(host.querySelectorAll('[role=option]')).toHaveLength(1);
  expect((await key(f.textarea, 'Enter', true)).defaultPrevented).toBe(false); expect(f.send).not.toHaveBeenCalled();
  await key(f.textarea, 'Enter'); expect(f.textarea.value).toBe('@大肥鱼 '); expect(f.send).not.toHaveBeenCalled();
});
it('offers everyone in world chat, never displays nonmembers, and leaves private-chat typing untouched', async () => {
  const world = await mount(false, true); await type(world.textarea, '@'); expect(host.querySelector('[role=option]')?.textContent).toContain('所有人');
  await type(world.textarea, '@陌生伙伴'); expect(host.textContent).toContain('没有匹配的聊天成员'); expect(host.querySelectorAll('[role=option]')).toHaveLength(0);
  await act(() => root!.unmount()); host.remove(); root = undefined;
  const direct = await mount(false, false); await type(direct.textarea, '@大'); expect(host.querySelector('[role=listbox]')).toBeNull();
  await key(direct.textarea, 'Enter'); expect(direct.send).toHaveBeenCalledTimes(1);
});
