// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from '../../src/renderer/theme/ThemeProvider';
import { BACKGROUND_PREFERENCES_KEY, DEFAULT_BACKGROUND_PREFERENCES, loadBackgroundPreferences } from '../../src/renderer/theme/background-preferences';
import { THEME_PROFILE_PREF_KEY } from '../../src/renderer/theme/theme-profiles';
import { restoreWallpaperPanels } from '../../src/renderer/theme/wallpaper-panels';
import { BackgroundOpacitySettings } from '../../src/renderer/theme/ThemeAppearanceControls';
import { LocaleProvider } from '../../src/renderer/i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const values = new Map<string, string>();
const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
let root: Root | undefined, host: HTMLDivElement | undefined;
function Probe() {
  const theme = useTheme();
  return <><output>{JSON.stringify(theme.backgroundPreferences)}</output>
    <button onClick={() => theme.setBackgroundPreferences({ ...theme.backgroundPreferences, showInMainPanel: false })}>opaque</button>
    <button onClick={() => theme.setBackgroundPreferences({ ...theme.backgroundPreferences, panelOpacity: .66 })}>custom opacity</button>
    <button onClick={() => theme.setThemeProfile('shuimo-danqing')}>wallpaper theme</button>
    <button onClick={() => theme.setBackgroundPreferences({ ...theme.backgroundPreferences, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' })}>image</button>
    <button onClick={() => theme.setBackgroundPreferences({ ...theme.backgroundPreferences, imageDataUrl: null })}>remove image</button>
    <BackgroundOpacitySettings />
  </>;
}
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><ThemeProvider storage={storage} initialPreference="light"><Probe /></ThemeProvider></LocaleProvider>));
}
async function unmount() { await act(() => root?.unmount()); root = undefined; host?.remove(); host = undefined; }
async function click(label: string) { await act(() => [...host!.querySelectorAll('button')].find(button => button.textContent === label)!.click()); }
function seed(preset = 'shuimo-danqing', preferences = {}) {
  values.set(THEME_PROFILE_PREF_KEY, JSON.stringify({ version: 3, preset, overrides: {} }));
  values.set(BACKGROUND_PREFERENCES_KEY, JSON.stringify({ ...DEFAULT_BACKGROUND_PREFERENCES, ...preferences }));
}
afterEach(async () => { await unmount(); values.clear(); document.documentElement.removeAttribute('data-bg-main-panel'); });

it.each([{ showInMainPanel: false, panelOpacity: .72 }, { showInMainPanel: true, panelOpacity: 1 }])('reveals restored legacy wallpaper without selecting another theme: %j', async preferences => {
  seed('shuimo-danqing', preferences); await mount();
  expect(document.documentElement.getAttribute('data-bg-main-panel')).toBe('on');
  expect(document.documentElement.style.getPropertyValue('--ui-panel-opacity')).toBe('48%');
  expect(loadBackgroundPreferences(storage)).toMatchObject({ showInMainPanel: true, panelOpacity: .48, panelVisibilityVersion: 1 });
  await unmount(); await mount(); expect(document.documentElement.getAttribute('data-bg-main-panel')).toBe('on');
});
it('preserves an explicit opaque choice after migration and restart', async () => {
  seed(); await mount(); await click('opaque');
  expect(document.documentElement.hasAttribute('data-bg-main-panel')).toBe(false);
  await unmount(); await mount(); expect(document.documentElement.hasAttribute('data-bg-main-panel')).toBe(false);
  expect(loadBackgroundPreferences(storage)).toMatchObject({ panelVisibilityVersion: 1, showInMainPanel: false });
});
it('preserves a later custom opacity without reducing it again on restart', async () => {
  seed(); await mount(); await click('custom opacity'); await unmount(); await mount();
  expect(document.documentElement.style.getPropertyValue('--ui-panel-opacity')).toBe('66%');
});
it('reveals a newly selected wallpaper or imported image from an existing solid appearance', async () => {
  seed('worldlinebox'); await mount(); expect(document.documentElement.hasAttribute('data-bg-main-panel')).toBe(false);
  await click('wallpaper theme'); expect(document.documentElement.getAttribute('data-bg-main-panel')).toBe('on');
  await click('opaque'); await click('image'); expect(document.documentElement.getAttribute('data-bg-main-panel')).toBe('on');
  expect(loadBackgroundPreferences(storage)).toMatchObject({ panelOpacity: .48, panelVisibilityVersion: 1 });
});
it('keeps disabled backgrounds and solid themes intact, without discarding original image metadata or a lower opacity', () => {
  const disabled = { ...DEFAULT_BACKGROUND_PREFERENCES, enabled: false };
  expect(restoreWallpaperPanels(disabled, true)).toBe(disabled);
  expect(restoreWallpaperPanels(DEFAULT_BACKGROUND_PREFERENCES, false)).toBe(DEFAULT_BACKGROUND_PREFERENCES);
  const image = { ...DEFAULT_BACKGROUND_PREFERENCES, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', mode: 'tile' as const, panelOpacity: .3 };
  expect(restoreWallpaperPanels(image, true)).toMatchObject({ ...image, showInMainPanel: true, panelVisibilityVersion: 1 });
});
async function setOpacity(value: number) {
  const input = host!.querySelector<HTMLInputElement>('input[type=range]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
it('exposes illustrated skin opacity with a 40% default while preserving old personal-image settings', async () => {
  seed('shuimo-danqing', { imageOpacity: .85, panelVisibilityVersion: 1, showInMainPanel: true }); await mount();
  const slider = host!.querySelector<HTMLInputElement>('input[aria-label="皮肤不透明度"]')!;
  expect(slider.value).toBe('0.4'); expect(slider.disabled).toBe(false);
  expect(host!.textContent).toContain('40%');
  expect(document.documentElement.style.getPropertyValue('--ui-background-image-opacity')).toBe('0.4');
  expect(loadBackgroundPreferences(storage).imageOpacity).toBe(.85);
  await setOpacity(.2);
  expect(document.documentElement.style.getPropertyValue('--ui-background-image-opacity')).toBe('0.2');
  expect(loadBackgroundPreferences(storage)).toMatchObject({ themeOpacity: .2, imageOpacity: .85 });
  await unmount(); await mount();
  expect(host!.querySelector<HTMLInputElement>('input[aria-label="皮肤不透明度"]')!.value).toBe('0.2');
  await click('image');
  expect(host!.querySelector<HTMLInputElement>('input[aria-label="背景不透明度"]')!.value).toBe('0.85');
  expect(document.documentElement.style.getPropertyValue('--ui-background-image-opacity')).toBe('0.85');
  await setOpacity(.6); await click('remove image');
  expect(document.documentElement.style.getPropertyValue('--ui-background-image-opacity')).toBe('0.2');
  expect(loadBackgroundPreferences(storage).imageOpacity).toBe(.6);
});
it('leaves text opacity alone and disables the skin control for solid profiles without artwork', async () => {
  seed('worldlinebox'); await mount();
  expect(host!.querySelector<HTMLInputElement>('input[aria-label="皮肤不透明度"]')!.disabled).toBe(true);
  expect(document.documentElement.style.opacity).toBe('');
  await click('wallpaper theme');
  expect(host!.querySelector<HTMLInputElement>('input[aria-label="皮肤不透明度"]')!.disabled).toBe(false);
  await setOpacity(0); expect(document.documentElement.style.getPropertyValue('--ui-background-image-opacity')).toBe('0');
  expect(document.documentElement.style.opacity).toBe('');
});
