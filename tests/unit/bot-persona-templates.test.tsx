// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotCompanion, BotPersonaTemplate, BotRequest, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { BotPersonaTemplates } from '../../src/renderer/companion-bot/BotPersonaTemplates';
import { BotCompanionEditor } from '../../src/renderer/companion-bot/BotCompanionEditor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
const companion: BotCompanion = { id: 'fish', name: '大肥鱼', persona: '原有设定', createdAt: '2026-11-04T00:00:00Z' };
const make = (id: string, name: string, prompt: string, builtin = false, isDefault = false): BotPersonaTemplate => ({ id, name, prompt, builtin, isDefault, modified: false, charCount: prompt.length, updatedAt: '2026-11-04T00:00:00Z' });
function fixture(customDefault = false) {
  const original = [make('default', '默认人格', '原有设定', true, true), make('maid', '女仆人格', '温柔且有主见的设定', true)];
  if (customDefault) original[0]!.builtin = false;
  let items = structuredClone(original), activeId = 'default';
  const list = () => ({ items: items.map(item => ({ id: item.id, name: item.name, builtin: item.builtin, isDefault: item.isDefault, modified: item.modified, charCount: item.charCount, updatedAt: item.updatedAt })), activeId, limit: 64 });
  const request = vi.fn(async (input: BotRequest): Promise<BotResponse> => {
    if (!input.type.startsWith('companion.personas.')) return { ok: true };
    if (input.type === 'companion.personas.list') return { ok: true, personas: list() };
    if (input.type === 'companion.personas.get') return { ok: true, persona: structuredClone(items.find(item => item.id === input.id)!) };
    if (input.type === 'companion.personas.activate') activeId = input.id;
    if (input.type === 'companion.personas.save') {
      const existing = items.find(item => item.id === input.id), id = input.id ?? `custom-${items.length}`;
      const saved = { ...make(id, input.name, input.prompt), ...existing, id, name: input.name, prompt: input.prompt, charCount: input.prompt.length, modified: !!(existing?.builtin || existing?.isDefault) };
      items = [...items.filter(item => item.id !== id), saved]; if (input.activate) activeId = id;
      return { ok: true, personas: list(), persona: structuredClone(saved) };
    }
    if (input.type === 'companion.personas.delete') {
      items = items.filter(item => item.id !== input.id); if (activeId === input.id) activeId = 'default';
      return { ok: true, personas: list() };
    }
    if (input.type === 'companion.personas.restore') {
      const restored = original.filter(item => !input.id || item.id === input.id);
      items = [...items.filter(item => !restored.some(builtin => builtin.id === item.id)), ...structuredClone(restored)]; activeId = input.id ?? 'default';
    }
    return { ok: true, personas: list(), persona: structuredClone(items.find(item => item.id === activeId)!) };
  });
  return { api: { request, onEvent: () => () => undefined } as WorldlineBoxBotApi, request, list };
}
async function render(content: ReactNode) { await act(async () => { root.render(content); }); }
async function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent === label);
  expect(button, `button ${label}`).toBeDefined(); await act(async () => { button!.click(); });
}
async function fill(selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(() => {
    Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('loads only the selected prompt and immediately activates a chosen template without an outer save', async () => {
  const f = fixture(), changed = vi.fn();
  await render(<BotPersonaTemplates api={f.api} companionId="fish" locale="zh-CN" onChanged={changed} />);
  expect(f.request.mock.calls.map(([call]) => call.type)).toEqual(['companion.personas.list', 'companion.personas.get']);
  expect(f.request.mock.calls[1]![0]).toMatchObject({ id: 'default' }); expect(host.querySelector('textarea')?.value).toBe('原有设定');
  await click('女仆人格');
  expect(f.request.mock.calls.at(-1)![0]).toEqual({ type: 'companion.personas.activate', companionId: 'fish', id: 'maid' });
  expect(f.list().activeId).toBe('maid'); expect(host.querySelector('textarea')?.value).toBe('温柔且有主见的设定');
  expect(host.textContent).toContain('下一条新消息生效'); expect(changed).toHaveBeenCalledTimes(1);
});

it('renames and edits an inactive built-in without activating it or rerendering the transcript parent', async () => {
  const f = fixture(), changed = vi.fn(); let parentRenders = 0;
  function Parent() { parentRenders++; return <><div data-transcript>{Array.from({ length: 400 }, (_, i) => <p key={i}>消息 {i}</p>)}</div><BotPersonaTemplates api={f.api} companionId="fish" locale="zh-CN" onChanged={changed} /></>; }
  await render(<Parent />); await click('编辑 女仆人格');
  expect(f.list().activeId).toBe('default'); expect(changed).not.toHaveBeenCalled();
  const textarea = host.querySelector('textarea'), before = f.request.mock.calls.length;
  await fill('[name=templateName]', '贴心但不失主见'); await fill('textarea', '长'.repeat(23999));
  expect(parentRenders).toBe(1); expect(host.querySelectorAll('[data-transcript] p')).toHaveLength(400); expect(host.querySelector('textarea')).toBe(textarea);
  expect(f.request).toHaveBeenCalledTimes(before); expect(host.textContent).toContain('未保存的草稿');
  await click('保存修改');
  expect(f.request.mock.calls.at(-1)![0]).toMatchObject({ type: 'companion.personas.save', id: 'maid', name: '贴心但不失主见', prompt: '长'.repeat(23999), activate: false });
  expect(f.list().activeId).toBe('default'); expect(host.textContent).toContain('当前使用的人格未改变'); expect(changed).toHaveBeenCalledTimes(1);
  await click('启用此模板'); expect(f.list().activeId).toBe('maid');
});

it('creates a named custom persona, deletes with inline confirmation and restores built-in names and prompts', async () => {
  const f = fixture(); await render(<BotPersonaTemplates api={f.api} companionId="fish" locale="zh-CN" />);
  await click('新建模板'); await fill('[name=templateName]', '一起创作'); await fill('textarea', '陪我构思故事，也保留自己的判断。');
  await click('保存并启用'); expect(f.list().activeId).toBe('custom-2');
  await click('删除模板'); expect(f.list().items).toHaveLength(3); expect(host.querySelector('.bot-personas__confirmation')).not.toBeNull();
  await click('确认删除'); expect(f.list().items).toHaveLength(2); expect(f.list().activeId).toBe('default');
  await click('女仆人格'); await fill('[name=templateName]', '修改过的名字'); await fill('textarea', '修改过的设定'); await click('保存修改');
  await click('恢复原始设定');
  expect(host.querySelector<HTMLInputElement>('[name=templateName]')?.value).toBe('女仆人格'); expect(host.querySelector('textarea')?.value).toBe('温柔且有主见的设定');
  await click('恢复全部内置模板'); expect(host.textContent).toContain('保留自建模板'); await click('确认恢复'); expect(f.list().activeId).toBe('default');
  expect(host.querySelector('textarea')?.value).toBe('原有设定'); expect(host.querySelector('.bot-personas__editor-footer')?.textContent).not.toContain('删除模板');
});

it('preserves unsaved prompt drafts across switching and keeps failed changes local to the dialog', async () => {
  const f = fixture(); await render(<BotPersonaTemplates api={f.api} companionId="fish" locale="zh-CN" />);
  await fill('textarea', '尚未保存的原人格草稿'); await click('女仆人格'); await click('默认人格');
  expect(host.querySelector('textarea')?.value).toBe('尚未保存的原人格草稿');
  expect(host.textContent).toContain('已启用模板的已保存版本');
  f.request.mockResolvedValueOnce({ ok: false, error: '模板保存失败，请重试。' });
  await click('保存修改'); expect(host.querySelector('[role=alert]')?.textContent).toContain('模板保存失败');
  expect(host.querySelector('textarea')?.value).toBe('尚未保存的原人格草稿'); expect(f.list().activeId).toBe('default');
});

it('offers original-persona restoration for a custom companion default as well as built-ins', async () => {
  const f = fixture(true); await render(<BotPersonaTemplates api={f.api} companionId="fish" locale="zh-CN" />);
  await fill('textarea', '新的自建伙伴设定'); await click('保存修改'); await click('恢复原始设定');
  expect(f.request.mock.calls.at(-1)![0]).toEqual({ type: 'companion.personas.restore', companionId: 'fish', id: 'default' });
  expect(host.querySelector('textarea')?.value).toBe('原有设定');
});

it('ignores a late activation response after the editor closes', async () => {
  const f = fixture(), changed = vi.fn(); await render(<BotPersonaTemplates api={f.api} companionId="fish" locale="en" onChanged={changed} />);
  let finish!: (result: BotResponse) => void;
  f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click('女仆人格'); await render(null);
  await act(() => finish({ ok: true, personas: { ...f.list(), activeId: 'maid' } })); expect(changed).not.toHaveBeenCalled();
});

it('keeps existing companion profile saves from replacing the active template with a stale prompt', async () => {
  const f = fixture(), save = vi.fn(async (): Promise<BotResponse> => ({ ok: true }));
  await render(<BotCompanionEditor api={f.api} kind="companion" companion={companion} companions={[companion]} locale="zh-CN" onSave={save} onCancel={vi.fn()} />);
  await click('女仆人格'); await click('基本资料'); await fill('[name=name]', '改名后的大肥鱼');
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith({ name: '改名后的大肥鱼', members: [], groupMode: 'automatic' });
});

it('preserves group creation and never requests persona templates for a group editor', async () => {
  const f = fixture(), save = vi.fn(async (): Promise<BotResponse> => ({ ok: true }));
  await render(<BotCompanionEditor api={f.api} kind="group" companions={[companion]} locale="zh-CN" onSave={save} onCancel={vi.fn()} />);
  await fill('[name=name]', '一起做世界线'); await act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledWith({ name: '一起做世界线', persona: '', members: ['fish'], groupMode: 'automatic' });
  expect(f.request).not.toHaveBeenCalled();
});
