// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { CompanionCharacterEditor } from '../../src/renderer/companions/CompanionCharacterEditor';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { parseCompanionCharacter } from '../../src/shared/companion-character';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); });
async function mount(initial: string) {
  let value = initial;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  const render = () => root!.render(<CompanionCharacterEditor value={value} name="海岚" onChange={next => { value = next; render(); }} />);
  await act(render);
  return () => value;
}
it('edits a specific character dimension while preserving other dimensions and supports raw text', async () => {
  const read = await mount(BUILTIN_COMPANIONS[0]!.persona), before = parseCompanionCharacter(read());
  expect(container.querySelectorAll('legend')).toHaveLength(5);
  const voice = [...container.querySelectorAll('label')].find(label => label.textContent?.startsWith('说话方式'))!.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(voice, '现在更直率，解释仍温柔清楚。');
    voice.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(parseCompanionCharacter(read()).fields.voice).toBe('现在更直率，解释仍温柔清楚。');
  expect(parseCompanionCharacter(read()).fields.contacts).toBe(before.fields.contacts);
  await act(() => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelectorAll('textarea')).toHaveLength(1);
  expect(container.querySelector('textarea')!.value).toBe(read());
});
it('applies the starting template only on request, retaining authored free text', async () => {
  const legacy = '海岚会直言不同意见。\n不要覆盖这段用户设定。', read = await mount(legacy);
  expect(read()).toBe(legacy);
  await act(() => container.querySelector<HTMLButtonElement>('button')!.click());
  await act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '使用起始模板')!.click());
  expect(parseCompanionCharacter(read()).standardized).toBe(true);
  expect(parseCompanionCharacter(read()).extra).toContain(legacy);
  expect(container.querySelectorAll('legend')).toHaveLength(6);
});

it('projects arbitrary source sections and fields and never restores a deleted built-in field', async () => {
  const read = await mount('【基础】\n姓名/自称/别称：海岚\n\n【契约】\n潮汐印记：银色\n');
  const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  expect([...container.querySelectorAll('legend')].map(item => item.textContent)).toEqual(['基础', '契约']);
  await act(() => button('编辑完整文本').click());
  await act(() => { const input = container.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '【契约】\n新称呼：领航员\n\n【生活约定】\n见面礼：一杯茶\n'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => button('按字段编辑').click());
  expect(read()).not.toContain('姓名/自称/别称');
  expect([...container.querySelectorAll('legend')].map(item => item.textContent)).toEqual(['契约', '生活约定']);
  expect(container.querySelector('textarea[aria-label="新称呼"]')!.textContent).toBe('领航员');
  await act(() => button('管理字段').click());
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="删除字段 新称呼"]')!.click());
  expect(read()).not.toContain('新称呼'); expect(read()).toContain('见面礼：一杯茶');
});
