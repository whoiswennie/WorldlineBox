// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { UserProfileSettingsPage } from '../../src/renderer/UserProfileSettingsPage';
import { LocaleProvider } from '../../src/renderer/i18n';
import { companionImages } from '../../src/renderer/companions/CompanionVisuals';
import { COMPANION_PORTRAIT_FILES } from '../../src/shared/companion-portrait-files';
import type { PlayerProfile } from '../../src/shared/companion-profile';
import type { CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../src/shared/companions';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });
const initial: PlayerProfile = { id: 'user', name: '我', description: '', revision: 1, contentHash: 'a'.repeat(64), updatedAt: '2026-10-15T00:00:00Z' };
function fixture(patch: Partial<PlayerProfile> = {}) {
  let profile = { ...initial, ...patch }, listener: (() => void) | undefined;
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => {
    if (input.type === 'player.profile.get') return { ok: true, playerProfile: { ...profile } };
    if (input.type === 'attachment.pick') return { ok: true, attachments: [{ id: input.purpose === 'appearance' ? 'sheet' : 'photo', name: '公开形象.png', mime: 'image/png', size: 2048 }] };
    if (input.type === 'avatar.crop') return { ok: true, attachments: [{ id: 'cropped-photo', name: '头像.png', mime: 'image/png', size: 4096 }] };
    if (input.type === 'player.profile.update') { if (input.expectedRevision !== profile.revision) return { ok: false, error: '资料已更新，请重新读取后再保存。' }; profile = { ...initial, ...input.profile, revision: profile.revision + 1 }; return { ok: true, playerProfile: { ...profile } }; }
    return { ok: true };
  });
  const api: WorldlineBoxCompanionsApi = { request, onChanged: next => { listener = next; return () => { listener = undefined; }; }, onReplyStream: () => () => undefined };
  return { api, request, current: () => profile, async publish(patch: Partial<PlayerProfile>) { profile = { ...profile, ...patch }; await act(() => listener?.()); } };
}
async function mount(api: WorldlineBoxCompanionsApi) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><UserProfileSettingsPage api={api} /></LocaleProvider>)); }
async function click(text: string) { const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text); expect(found).toBeTruthy(); await act(() => found!.click()); }
async function fill(name: string, value: string) { const element = container!.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!; await act(() => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function save() { await act(() => container!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); }

it('edits explicit public identity and image references only on save with the loaded revision', async () => {
  const f = fixture(); await mount(f.api);
  await fill('profile-name', '林澈'); await fill('profile-description', '喜欢看海和画画。'); await click('选择头像');
  const source = document.querySelector<HTMLImageElement>('[alt="待调整的头像原图"]')!; Object.defineProperties(source, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } }); await act(() => source.dispatchEvent(new Event('load'))); await act(() => document.querySelector<HTMLButtonElement>('.avatar-crop-dialog .companion-primary-button')!.click());
  await click('上传三视图');
  expect(f.request).toHaveBeenCalledWith({ type: 'attachment.pick', kind: 'image', purpose: 'appearance' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'player.profile.update')).toBe(false);
  expect(container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!.src).toContain('/sheet');
  await save();
  expect(f.request).toHaveBeenCalledWith({ type: 'player.profile.update', expectedRevision: 1, profile: { name: '林澈', description: '喜欢看海和画画。', avatarAttachmentId: 'cropped-photo', appearanceAttachmentId: 'sheet' } });
  expect(f.current().id).toBe('user'); expect(container!.textContent).toContain('用户信息已保存');
});
it('keeps saved images when the native picker is cancelled or returns an invalid file, and clears both references explicitly', async () => {
  const f = fixture({ avatarAttachmentId: 'saved-avatar', appearanceAttachmentId: 'saved-sheet' }); await mount(f.api);
  const original = f.request.getMockImplementation()!;
  f.request.mockImplementation(input => input.type === 'attachment.pick' ? Promise.resolve({ ok: true, attachments: [] }) : original(input));
  await click('更换三视图'); expect(container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!.src).toContain('/saved-sheet');
  f.request.mockImplementation(input => input.type === 'attachment.pick' ? Promise.resolve({ ok: true, attachments: [{ id: 'bad', mime: 'text/plain', name: 'notes.txt', size: 12 }] }) : original(input));
  await click('选择头像'); expect(container!.querySelector('[role="alert"]')!.textContent).toContain('请选择图片文件');
  expect(container!.querySelector<HTMLImageElement>('.companion-avatar img')!.src).toContain('/saved-avatar');
  await click('移除头像'); await click('移除三视图'); await save();
  expect(f.current().avatarAttachmentId).toBeUndefined(); expect(f.current().appearanceAttachmentId).toBeUndefined();
});
it('preserves an unsaved draft during external revisions and rejects stale saves before an explicit reload', async () => {
  const f = fixture(); await mount(f.api); await fill('profile-name', '还没保存的名字');
  await f.publish({ revision: 2, name: '已在别处保存' });
  expect(container!.querySelector<HTMLInputElement>('[name="profile-name"]')!.value).toBe('还没保存的名字');
  await save(); expect(container!.querySelector('[role="alert"]')!.textContent).toContain('资料已更新'); expect(f.current().name).toBe('已在别处保存');
  await click('重新读取已保存资料'); expect(container!.querySelector<HTMLInputElement>('[name="profile-name"]')!.value).toBe('已在别处保存');
});
it('ignores unrelated companion changes and previews the complete board without submitting the form', async () => {
  const f = fixture({ appearanceAttachmentId: 'sheet' }); await mount(f.api); await fill('profile-name', '小林'); await f.publish({});
  expect(container!.textContent).not.toContain('资料已在其他地方更新');
  await click('预览公开三视图'); expect(container!.querySelector('[role="dialog"] img')).toBeTruthy();
  await act(() => container!.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(container!.querySelector('[role="dialog"]')).toBeNull(); expect(container!.querySelector('form')).toBeTruthy();
  expect(f.request.mock.calls.some(([input]) => input.type === 'player.profile.update')).toBe(false);
});
it('resolves every shared built-in portrait whitelist entry to a real renderer image', () => {
  expect(Object.keys(COMPANION_PORTRAIT_FILES)).toHaveLength(15);
  for (const [avatar, file] of Object.entries(COMPANION_PORTRAIT_FILES)) { expect(existsSync(path.resolve(file)), file).toBe(true); expect(companionImages[avatar as keyof typeof companionImages], avatar).toBeTruthy(); }
});
