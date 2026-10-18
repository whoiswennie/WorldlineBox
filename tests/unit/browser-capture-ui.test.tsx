// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { BrowserCapturePanel } from '../../src/renderer/browser/BrowserCapturePanel';
import { LocaleProvider } from '../../src/renderer/i18n';
import { DEFAULT_BROWSER_CAPTURE_PREFERENCES, type BrowserCaptureState } from '../../src/shared/browser-capture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });

function state(): BrowserCaptureState {
  return {
    connected: true,
    activeLibraryId: 'library-a',
    libraries: [{ libraryId: 'library-a', displayName: '素材库' }, { libraryId: 'library-b', displayName: '另一个库' }],
    target: { libraryId: 'library-a', folderId: null },
    folders: [
      { libraryId: 'library-a', folderId: 'parent', name: '原画', relativePath: '原画', assetCount: 2 },
      { libraryId: 'library-a', folderId: 'child', name: '角色', relativePath: '原画/角色', assetCount: 1 },
      { libraryId: 'library-a', folderId: 'linked', name: '链接目录', relativePath: '链接目录', assetCount: 0, kind: 'linked' },
      { libraryId: 'library-a', folderId: 'offline', name: '离线目录', relativePath: '离线目录', assetCount: 0, kind: 'linked', available: false },
      { libraryId: 'library-b', folderId: 'other', name: '其他库文件夹', relativePath: '其他库文件夹', assetCount: 1 },
    ],
    recentFolderIds: ['child', 'other'],
    recentBrowsedFolderIds: ['parent'],
    preferences: { ...DEFAULT_BROWSER_CAPTURE_PREFERENCES },
    jobs: [],
  };
}

async function mount(capture = state()) {
  const run = vi.fn().mockResolvedValue({ ok: true, state: capture });
  const onOpenAssets = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference="zh-CN"><BrowserCapturePanel capture={capture} run={run} onOpenAssets={onOpenAssets} /></LocaleProvider>));
  return { run, onOpenAssets };
}

function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label)!;
}

it('limits choices to the target library, permits linked folders and disables unavailable folders', async () => {
  const { run } = await mount();
  expect(host.textContent).toContain('素材库');
  expect(host.textContent).not.toContain('其他库文件夹');
  expect(button('保存到 链接目录').disabled).toBe(false);
  expect(button('保存到 离线目录').disabled).toBe(true);
  await act(() => button('保存到 链接目录').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'target.set', target: { libraryId: 'library-a', folderId: 'linked' } });
  expect(host.querySelectorAll('.browser-capture-recent .browser-capture-folder')).toHaveLength(2);
});

it('chooses a nested folder or the library root without navigating the web page', async () => {
  const { run } = await mount();
  await act(() => button('保存到 原画/角色').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'target.set', target: { libraryId: 'library-a', folderId: 'child' } });
  await act(() => button('保存到 根目录').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'target.set', target: { libraryId: 'library-a', folderId: null } });
});

it('persists each save preference without resetting other existing choices', async () => {
  const capture = state();
  capture.preferences.focusAppAfterSave = false;
  capture.preferences.revealInLibrary = false;
  const { run } = await mount(capture);
  const notifications = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!;
  await act(() => notifications.click());
  expect(run).toHaveBeenLastCalledWith({ type: 'preferences.save', preferences: {
    notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: true,
  } });
});

it('keeps the asset-manager route available when there is no library and disables local capture', async () => {
  const capture = state();
  capture.activeLibraryId = null;
  capture.target = null;
  capture.libraries = [];
  capture.folders = [];
  const { run, onOpenAssets } = await mount(capture);
  expect(button('采集本地图片').disabled).toBe(true);
  await act(() => button('打开资产管理').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'open-assets' });
  expect(onOpenAssets).toHaveBeenCalledOnce();
});

it('opens local-image capture through the native picker without sending a file path to the page', async () => {
  const { run, onOpenAssets } = await mount();
  await act(() => button('采集本地图片').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'local.open' });
  expect(onOpenAssets).not.toHaveBeenCalled();
});

it('shows capture failures and cancels only the selected active save', async () => {
  const capture = state();
  capture.jobs = [
    { id: 'failed-job', tabId: 'web-tab', target: capture.target!, kind: 'image', status: 'failed', message: 'HTTP 403', startedAt: '', filename: 'cover.png' },
    { id: 'active-job', tabId: 'web-tab', target: capture.target!, kind: 'video', status: 'saving', message: '', startedAt: '', receivedBytes: 1024, totalBytes: 4096 },
  ];
  const { run } = await mount(capture);
  expect(host.textContent).toContain('HTTP 403');
  expect(host.textContent).toContain('cover.png');
  await act(() => button('取消').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'cancel', id: 'active-job' });
});
