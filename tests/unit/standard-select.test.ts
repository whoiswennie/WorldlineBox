// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

import { Select } from '../../src/renderer/ui/primitives/Select';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  root = undefined;
  container?.remove();
  container = undefined;
});

test('standard select opens one themed menu and does not use a native select', async () => {
  const onValueChange = vi.fn();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(Select, {
      'aria-label': '显示模式',
      onValueChange,
      options: [
        { value: 'pbr', label: 'PBR' },
        { value: 'clay', label: '灰模' },
      ],
      value: 'pbr',
    }));
  });

  expect(container.querySelector('select')).toBeNull();
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]');
  expect(trigger?.textContent).toContain('PBR');
  expect(trigger?.getAttribute('data-value')).toBe('pbr');

  await act(async () => {
    trigger?.click();
  });

  const menu = document.body.querySelector('.ui-menu-surface');
  expect(menu?.getAttribute('role')).toBe('listbox');
  const selected = menu?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
  expect(selected?.classList.contains('is-selected')).toBe(true);
  expect(selected?.getAttribute('data-value')).toBe('pbr');

  await act(async () => {
    menu?.querySelector<HTMLButtonElement>('[data-value="clay"]')?.click();
  });

  expect(onValueChange).toHaveBeenCalledWith('clay');
  expect(document.body.querySelector('.ui-menu-surface')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
