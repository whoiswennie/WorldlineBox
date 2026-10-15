// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionAttachment, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import { AvatarCropDialog } from '../../src/renderer/companions/AvatarCropDialog';
import { INITIAL_AVATAR_CROP, avatarCropGeometry, avatarCropImageStyle, clampAvatarCrop, rotateAvatarCrop } from '../../src/renderer/companions/avatar-crop';

let root: Root | undefined, container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); vi.restoreAllMocks(); });
const source: CompanionAttachment = { id: 'original', name: 'portrait.jpg', mime: 'image/jpeg', size: 4096 }, output: CompanionAttachment = { id: 'cropped', name: '头像.png', mime: 'image/png', size: 8192 };
async function render(node: ReactNode) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); await act(() => root!.render(node)); }
async function fixture(implementation?: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>) {
  const request = vi.fn(implementation ?? (async () => ({ ok: true, attachments: [output] }))), onConfirm = vi.fn(), onCancel = vi.fn();
  await render(<AvatarCropDialog attachment={source} name="小林" request={request} onConfirm={onConfirm} onCancel={onCancel} />);
  const image = document.querySelector<HTMLImageElement>('[alt="待调整的头像原图"]')!; Object.defineProperties(image, { naturalWidth: { value: 1200 }, naturalHeight: { value: 800 } }); await act(() => image.dispatchEvent(new Event('load')));
  const stage = document.querySelector<HTMLDivElement>('.avatar-crop-stage')!; vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({ width: 440, height: 440, x: 0, y: 0, top: 0, left: 0, bottom: 440, right: 440, toJSON() {} });
  return { request, onConfirm, onCancel, stage, image };
}
async function click(label: string) { const target = [...document.querySelectorAll<HTMLButtonElement>('.avatar-crop-dialog button')].find(button => button.getAttribute('aria-label') === label || button.textContent === label); expect(target).toBeTruthy(); await act(() => target!.click()); }
async function pointer(element: HTMLElement, type: string, x: number, y: number) { const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }); Object.defineProperty(event, 'pointerId', { value: 1 }); await act(() => element.dispatchEvent(event)); }

it('uses the same rounded source square and edge bounds as actual quarter-turn cropping', () => {
  expect(avatarCropGeometry({ width: 1000, height: 600 }, { ...INITIAL_AVATAR_CROP, zoom: 1.3 })).toEqual({ width: 1000, height: 600, side: 462, left: 269, top: 69 });
  const rotated = rotateAvatarCrop({ width: 1000, height: 600 }, { ...INITIAL_AVATAR_CROP, centerX: .7 }); expect(rotated).toMatchObject({ rotation: 90, centerX: .5, centerY: .7 });
  const clamped = clampAvatarCrop({ width: 1200, height: 800 }, { ...INITIAL_AVATAR_CROP, centerX: -20, centerY: 9, zoom: 100 }); const geometry = avatarCropGeometry({ width: 1200, height: 800 }, clamped); expect(clamped.zoom).toBe(8); expect(geometry).toMatchObject({ side: 100, left: 0, top: 700 });
  expect(avatarCropGeometry({ width: 13, height: 5 }, { ...INITIAL_AVATAR_CROP, zoom: 8 })).toMatchObject({ side: 1, left: 6, top: 2 });
  expect(avatarCropImageStyle({ width: 1000, height: 600 }, INITIAL_AVATAR_CROP).transform).toContain('rotate(0deg)');
});
it('drags, nudges, rotates, zooms without scrolling the parent, and resets before committing a new attachment', async () => {
  const f = await fixture(), originalLeft = f.image.style.left;
  await pointer(f.stage, 'pointerdown', 200, 200); await pointer(f.stage, 'pointermove', 260, 220); await pointer(f.stage, 'pointerup', 260, 220); expect(f.image.style.left).not.toBe(originalLeft);
  const wheel = new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }); await act(() => f.stage.dispatchEvent(wheel)); expect(wheel.defaultPrevented).toBe(true); expect(Number(document.querySelector<HTMLInputElement>('[aria-label="头像缩放"]')!.value)).toBeGreaterThan(1);
  await act(() => f.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))); await click('旋转 90°'); expect(f.image.style.transform).toContain('rotate(90deg)');
  await click('重置'); expect(document.querySelector('output')!.textContent).toBe('100%'); expect(f.image.style.left).toBe(originalLeft);
  await click('使用此头像'); expect(f.request).toHaveBeenCalledWith({ type: 'avatar.crop', attachmentId: 'original', crop: INITIAL_AVATAR_CROP }); expect(f.onConfirm).toHaveBeenCalledWith(output);
});
it('retains the crop for a failed request and retries without mutating the parent draft', async () => {
  const f = await fixture(async () => ({ ok: false, error: '原图发生变化，请重新选取。' })); await click('放大头像'); await click('使用此头像');
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('原图发生变化'); expect(f.onConfirm).not.toHaveBeenCalled(); expect(document.querySelector('output')!.textContent).toBe('125%');
  f.request.mockResolvedValue({ ok: true, attachments: [output] }); await click('使用此头像'); expect(f.onConfirm).toHaveBeenCalledWith(output);
});
it('cancels only the topmost crop, ignores IME Escape and never requests a crop on cancel', async () => {
  const f = await fixture(); await act(() => f.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }))); expect(f.onCancel).not.toHaveBeenCalled();
  const top = document.createElement('div'); top.setAttribute('role', 'alertdialog'); top.setAttribute('aria-modal', 'true'); document.body.append(top); await act(() => top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(f.onCancel).not.toHaveBeenCalled(); top.remove();
  await act(() => f.stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); expect(f.onCancel).toHaveBeenCalledOnce(); expect(f.request).not.toHaveBeenCalled(); expect(f.onConfirm).not.toHaveBeenCalled();
});
it('ignores a late crop response after cancellation and unmount', async () => {
  let complete!: (value: CompanionsResponse) => void; const f = await fixture(() => new Promise(resolve => { complete = resolve; }));
  await act(() => document.querySelector<HTMLButtonElement>('.avatar-crop-dialog .companion-primary-button')!.click()); await click('取消'); await act(() => root!.render(null)); await act(() => complete({ ok: true, attachments: [output] })); expect(f.onConfirm).not.toHaveBeenCalled();
});
it('keeps confirmation disabled when the original cannot load', async () => {
  const f = await fixture(); await act(() => f.image.dispatchEvent(new Event('error'))); expect(document.querySelector('[role="alert"]')!.textContent).toContain('原图无法读取'); expect(document.querySelector<HTMLButtonElement>('.avatar-crop-dialog .companion-primary-button')!.disabled).toBe(true);
});
it('restores the picker trigger even when the OS chooser had disabled and blurred it', async () => {
  const trigger = document.createElement('button'); trigger.textContent = '选择头像'; trigger.disabled = true; document.body.append(trigger);
  try {
    await render(<AvatarCropDialog attachment={source} name="我" request={async () => ({ ok: true })} onCancel={() => undefined} onConfirm={() => undefined} returnFocusRef={{ current: trigger }} />);
    trigger.disabled = false; await act(() => root!.render(null));
    expect(document.activeElement).toBe(trigger);
  } finally { trigger.remove(); }
});
