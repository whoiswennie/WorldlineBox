// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionComposerCapabilities } from '../../src/renderer/companions/CompanionComposerCapabilities';
import { DEFAULT_COMPANION_TOOL_POLICY, type CompanionToolPolicy } from '../../src/shared/companion-tool-policy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });

it('hides the retired memory switch from legacy policies while keeping the remaining independent capability selections', async () => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let policy: CompanionToolPolicy = { ...DEFAULT_COMPANION_TOOL_POLICY };
  const change = vi.fn((value: CompanionToolPolicy) => { policy = value; });
  const render = () => root!.render(<CompanionComposerCapabilities policy={policy} onChange={change} onOpen={vi.fn()} />);
  await act(render); await act(() => host!.querySelector<HTMLButtonElement>('button')!.click());
  expect(change).not.toHaveBeenCalled();
  const switches = [...host.querySelectorAll<HTMLInputElement>('[role="switch"]')];
  expect(switches).toHaveLength(7);
  expect(switches.filter(input => input.checked)).toHaveLength(6);
  expect(policy.memory).toBe(true);
  expect(host.querySelector('[aria-label="记忆"]')).toBeNull();
  expect(host.textContent).not.toContain('回忆与整理已有的经历和知识');
  expect(host.querySelector<HTMLInputElement>('[aria-label="内置浏览器"]')!.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('[aria-label="DSH"]')!.checked).toBe(true);
  expect(host.textContent).toContain('包含 DSH 内部浏览器');
  expect(host.textContent).toContain('仍需已有观察授权');
  await act(() => host!.querySelector<HTMLInputElement>('[aria-label="内置浏览器"]')!.click());
  expect(change).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_COMPANION_TOOL_POLICY, browser: true });
  await act(render);
  expect(host.querySelector<HTMLInputElement>('[aria-label="内置浏览器"]')!.checked).toBe(true);
  await act(() => host!.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(host.querySelector('section')).toBeNull();
});
