// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionInstancePanel } from '../../src/renderer/companions/CompanionInstancePanel';
import { CompanionAssetNavigation } from '../../src/renderer/companions/companion-asset-navigation';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
it('edits the real owner profile with its content revision and opens the same instance in asset management', async () => {
  let profile = { name: '小肥鱼', description: '', persona: BUILTIN_COMPANIONS[1]!.persona };
  const location = { libraryId: 'library', libraryPath: 'D:/library', linkedFolderId: 'owner-files', relativePath: 'deepseek-flash' };
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => {
    if (command.type === 'companion.assets.location') return { ok: true, assetLocation: location };
    if (command.type === 'companion.assets.profile.save') profile = command.profile;
    return { ok: true, companionAssets: { companionId: 'deepseek-flash', root: 'D:/library/伙伴记忆/deepseek-flash',
      profileRevision: command.type === 'companion.assets.profile.save' ? 'b'.repeat(64) : 'a'.repeat(64), promptRevision: 'c'.repeat(64), prompts: [], profile } };
  });
  const api: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: () => () => undefined, onReplyStream: () => () => undefined };
  const open = vi.fn(), dirty = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<CompanionAssetNavigation.Provider value={open}><CompanionInstancePanel companionId="deepseek-flash" api={api} view="profile" onDirtyChange={dirty} /></CompanionAssetNavigation.Provider>));
  await act(async () => { await Promise.resolve(); });
  const input = host.querySelector('input')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '小蓝'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
  await act(() => button('保存实例资料').click());
  expect(workspace).toHaveBeenCalledWith(expect.objectContaining({ type: 'companion.assets.profile.save', companionId: 'deepseek-flash', expectedRevision: 'a'.repeat(64), profile: expect.objectContaining({ name: '小蓝' }) }));
  expect(host.textContent).toContain('下一次主脑推理使用此版本');
  await act(() => button('打开资产目录').click());
  expect(open).toHaveBeenCalledWith(location);
});
