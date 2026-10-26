// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Avatar, companionAppearance, companionPortrait } from '../../src/renderer/companions/CompanionVisuals';
import { PublicAppearanceSheet } from '../../src/renderer/companions/PublicAppearanceSheet';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; });
async function mount(content: React.ReactNode) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(() => root!.render(content)); }

it('uses the complete square sister portrait rather than the old sheet framing, and keeps custom portraits authoritative', async () => {
  await mount(<><Avatar companion={{ name: '姐姐', avatar: 'sister' }} /><Avatar companion={{ name: '妹妹', avatar: 'flash', avatarAttachmentId: 'own-flash' }} /></>);
  const avatars = container!.querySelectorAll<HTMLElement>('.companion-avatar');
  expect(avatars[0]!.classList.contains('has-square-image')).toBe(true); expect(avatars[0]!.querySelector('img')!.src).toContain('portraits/deepseek-sister.png');
  expect(avatars[1]!.classList.contains('has-local-image')).toBe(true); expect(avatars[1]!.querySelector('img')!.src).toContain('/own-flash');
  expect(companionPortrait({ avatar: 'sister', avatarAttachmentId: 'personal' })).toBe('worldlinebox-companion://attachment/personal');
  expect(companionAppearance({ avatar: 'sister', appearanceAttachmentId: 'personal-board' })).toBe('worldlinebox-companion://attachment/personal-board');
  expect(companionAppearance({ avatar: 'custom' })).toBeUndefined();
  expect(companionAppearance({ id: 'deepseek-sister', builtin: true, avatar: 'custom' }, true)).toContain('deepseek-sister-orthographic.png');
  expect(companionAppearance({ id: 'my-custom', builtin: false, avatar: 'sister' })).toBeUndefined();
});
it('uses owner URLs for saved contacts and name letters on missing or unreadable owner images without template/attachment fallback', async () => {
  const hash = 'a'.repeat(64), url = `worldlinebox-companion://portrait/alice/avatar?v=${hash}`;
  const saved = { id: 'alice', name: '艾丽丝', avatar: 'sister' as const, avatarAttachmentId: 'old-original', assetImages: { avatar: { url, sha256: hash } } };
  expect(companionPortrait(saved)).toBe(url);
  expect(companionPortrait({ ...saved, assetImages: {} })).toBeUndefined();
  expect(companionAppearance({ ...saved, appearanceAttachmentId: 'old-board', builtin: true })).toBeUndefined();
  await mount(<><Avatar companion={saved} /><Avatar companion={{ ...saved, assetImages: {} }} /></>);
  const avatars = container!.querySelectorAll('.companion-avatar');
  expect(avatars[0]!.querySelector('img')!.src).toBe(url); expect(avatars[1]!.textContent).toBe('艾');
  await act(() => avatars[0]!.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(avatars[0]!.textContent).toBe('艾'); expect(avatars[0]!.querySelector('img')).toBeNull();
  const next = { ...saved, assetImages: { avatar: { url: url.replace(hash, 'b'.repeat(64)), sha256: 'b'.repeat(64) } } };
  await act(() => root!.render(<Avatar companion={next} />));
  expect(container!.querySelector('img')!.src).toContain('v=' + 'b'.repeat(64));
});
it('keeps a saved board empty when owner files are unavailable even if an original attachment or template exists', async () => {
  await mount(<PublicAppearanceSheet name="艾丽丝" attachmentId="old-board" fallbackSource="/builtin.png" ownerSource={{}} />);
  expect(container!.querySelector('img')).toBeNull(); expect(container!.textContent).toContain('还没有添加三视图');
});
it('previews a built-in reference board as a complete image and never offers to remove the bundled file', async () => {
  const onRemove = vi.fn(), fallbackSource = '/fixtures/sister-orthographic.png';
  await mount(<PublicAppearanceSheet name="姐姐" fallbackSource={fallbackSource} onRemove={onRemove} />);
  expect(container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!.getAttribute('src')).toBe(fallbackSource);
  expect(container!.querySelector('.public-appearance-remove')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('[aria-label="预览公开三视图"]')!.click());
  expect(container!.querySelector<HTMLImageElement>('[role="dialog"] img')!.getAttribute('src')).toBe(fallbackSource); expect(onRemove).not.toHaveBeenCalled();
});
it('retains a custom board even when unavailable and returns to the built-in image only after removal', async () => {
  const fallbackSource = '/fixtures/flash-orthographic.png', onRemove = vi.fn();
  await mount(<PublicAppearanceSheet name="妹妹" attachmentId="saved-board" fallbackSource={fallbackSource} onRemove={onRemove} />);
  const current = container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!;
  expect(current.src).toContain('/saved-board'); await act(() => current.dispatchEvent(new Event('error')));
  expect(container!.textContent).toContain('图片暂时无法读取'); expect(container!.querySelector('.public-appearance-thumbnail img')).toBeNull();
  await act(() => container!.querySelector<HTMLButtonElement>('.public-appearance-remove')!.click()); expect(onRemove).toHaveBeenCalledOnce();
  await act(() => root!.render(<PublicAppearanceSheet name="妹妹" fallbackSource={fallbackSource} onRemove={onRemove} />));
  expect(container!.querySelector<HTMLImageElement>('.public-appearance-thumbnail img')!.getAttribute('src')).toBe(fallbackSource);
});
