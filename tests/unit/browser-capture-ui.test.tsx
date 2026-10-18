// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { BrowserCapturePanel } from '../../src/renderer/browser/BrowserCapturePanel';
import { LocaleProvider } from '../../src/renderer/i18n';
import { DEFAULT_BROWSER_CAPTURE_PREFERENCES, type BrowserCaptureRequest, type BrowserCaptureState } from '../../src/shared/browser-capture';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });

function state(): BrowserCaptureState {
  return {
    connected: true, activeLibraryId: 'library-a',
    libraries: [{ libraryId: 'library-a', displayName: '素材库' }, { libraryId: 'library-b', displayName: '另一个库' }],
    target: { libraryId: 'library-a', folderId: null },
    folders: [
      { libraryId: 'library-a', folderId: 'parent', name: '原画', relativePath: '原画', assetCount: 2 },
      { libraryId: 'library-a', folderId: 'child', name: '角色', relativePath: '原画/角色', assetCount: 1 },
      { libraryId: 'library-a', folderId: 'linked', name: '链接目录', relativePath: '链接目录', assetCount: 0, kind: 'linked' },
      { libraryId: 'library-a', folderId: 'offline', name: '离线目录', relativePath: '离线目录', assetCount: 0, kind: 'linked', available: false },
      { libraryId: 'library-b', folderId: 'other', name: '其他库文件夹', relativePath: '其他库文件夹', assetCount: 1 },
    ],
    recentFolderIds: ['child', 'other'], recentBrowsedFolderIds: ['parent'],
    preferences: { ...DEFAULT_BROWSER_CAPTURE_PREFERENCES }, jobs: [],
  };
}

async function mount(capture = state(), locale: 'zh-CN' | 'en' = 'zh-CN') {
  const run = vi.fn(async (request: BrowserCaptureRequest) => {
    if (request.type === 'history.list') {
      const matched = capture.jobs.filter(job => (!request.status || job.status === request.status) && (!request.query || (job.filename + job.message).includes(request.query)));
      const start = ((request.page ?? 1) - 1) * (request.pageSize ?? 10);
      return { ok: true as const, state: capture, history: { items: matched.slice(start, start + (request.pageSize ?? 10)), total: matched.length, page: request.page ?? 1, pageSize: request.pageSize ?? 10 } };
    }
    return { ok: true as const, state: capture };
  });
  const onOpenAssets = vi.fn();
  const onScreenshot = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(<LocaleProvider initialPreference={locale}><BrowserCapturePanel capture={capture} run={run} onOpenAssets={onOpenAssets} onScreenshot={onScreenshot} /></LocaleProvider>));
  return { run, onOpenAssets, onScreenshot };
}

function button(label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw Error('Missing button: ' + label);
  return found;
}
async function enter(input: HTMLInputElement, value: string) {
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function openHistory() {
  await act(() => button('记录').click());
  await act(() => vi.advanceTimersByTimeAsync(200));
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

it('chooses nested folders and the root while allowing recovery from an unavailable target', async () => {
  const capture = state();
  capture.target!.folderId = 'offline';
  const { run } = await mount(capture);
  expect(button('保存网页').disabled).toBe(true);
  expect(button('保存到 根目录').disabled).toBe(false);
  await act(() => button('保存到 原画/角色').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'target.set', target: { libraryId: 'library-a', folderId: 'child' } });
  await act(() => button('保存到 根目录').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'target.set', target: { libraryId: 'library-a', folderId: null } });
});

it('moves save preferences to a separate tab and preserves other choices', async () => {
  const capture = state();
  capture.preferences.focusAppAfterSave = false;
  capture.preferences.revealInLibrary = false;
  const { run } = await mount(capture);
  expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  await act(() => button('选项').click());
  await act(() => host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[0]!.click());
  expect(run).toHaveBeenLastCalledWith({ type: 'preferences.save', preferences: {
    notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: true,
  } });
});

it('keeps screenshots and the asset-manager route available without a library', async () => {
  const capture = state();
  capture.activeLibraryId = null; capture.target = null; capture.libraries = []; capture.folders = [];
  const { run, onOpenAssets, onScreenshot } = await mount(capture);
  expect(button('采集本地图片').disabled).toBe(true);
  expect(button('截图与标注').disabled).toBe(false);
  await act(() => button('截图与标注').click());
  expect(onScreenshot).toHaveBeenCalledOnce();
  await act(() => button('打开资产管理').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'open-assets' });
  expect(onOpenAssets).toHaveBeenCalledOnce();
});

it('routes media, page, selected text and common local files through typed native requests', async () => {
  const { run } = await mount();
  for (const [label, type] of [['采集本地图片', 'local.open'], ['导入本地文件', 'file.open'], ['保存网页', 'page.save'], ['保存选中文字', 'text.save']] as const) {
    await act(() => button(label).click());
    expect(run).toHaveBeenLastCalledWith({ type });
  }
});

it('keeps a bounded summary on Save and shows cancellable jobs only in History', async () => {
  vi.useFakeTimers();
  const capture = state();
  capture.jobs = [
    { id: 'failed-job', tabId: 'web-tab', target: capture.target!, kind: 'image', status: 'failed', message: 'HTTP 403', startedAt: '', filename: 'cover.png' },
    { id: 'active-job', tabId: 'web-tab', target: capture.target!, kind: 'video', status: 'saving', message: '', startedAt: '', receivedBytes: 1024, totalBytes: 4096 },
  ];
  const { run } = await mount(capture);
  expect(host.textContent).not.toContain('HTTP 403');
  expect(host.querySelector('.capture-history-list')).toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('.capture-activity-preview')!.click());
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(host.textContent).toContain('HTTP 403');
  expect(host.textContent).toContain('cover.png');
  await act(() => button('取消').click());
  expect(run).toHaveBeenLastCalledWith({ type: 'cancel', id: 'active-job' });
});

it('requests ten history entries per page and searches without rendering the full history', async () => {
  vi.useFakeTimers();
  const capture = state();
  capture.jobs = Array.from({ length: 25 }, (_, index) => ({ id: 'job-' + index, tabId: 'web', target: capture.target!, kind: 'image', status: 'saved', filename: 'image-' + index + '.png', message: '', startedAt: '2026-10-18T10:00:00Z' }));
  const { run } = await mount(capture);
  await openHistory();
  expect(host.querySelectorAll('.capture-history-item')).toHaveLength(10);
  expect(host.textContent).toContain('1 / 3');
  await act(() => button('下一页').click());
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(run).toHaveBeenLastCalledWith({ type: 'history.list', page: 2, pageSize: 10, query: '' });
  expect(host.querySelector('.capture-job-filename')?.textContent).toBe('image-10.png');
  await enter(host.querySelector<HTMLInputElement>('input[aria-label="搜索文件名或消息"]')!, 'image-24');
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(run).toHaveBeenLastCalledWith({ type: 'history.list', page: 1, pageSize: 10, query: 'image-24' });
  expect(host.querySelectorAll('.capture-history-item')).toHaveLength(1);
});

it('creates folders inline under the selected folder and rejects path-like names', async () => {
  const capture = state(); capture.target!.folderId = 'parent';
  const { run } = await mount(capture);
  await act(() => button('新建文件夹').click());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')!;
  await enter(input, '../bad');
  expect(button('创建并选中').disabled).toBe(true);
  await enter(input, '  灵感  ');
  expect(button('创建并选中').disabled).toBe(false);
  await act(() => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(run).toHaveBeenLastCalledWith({ type: 'folder.create', target: { libraryId: 'library-a', folderId: 'parent' }, name: '灵感' });
});

it('blocks writes and folder creation for read-only libraries', async () => {
  const capture = state(); capture.libraries[0]!.readOnly = true;
  await mount(capture);
  expect(button('保存网页').disabled).toBe(true);
  expect(button('导入本地文件').disabled).toBe(true);
  expect(button('新建文件夹').disabled).toBe(true);
  expect(host.textContent).toContain('此资源库为只读');
});

it('supports keyboard navigation between tabs and translated labels', async () => {
  await mount(state(), 'en');
  const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  await act(() => tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
  expect(tabs[2]!.getAttribute('aria-selected')).toBe('true');
  expect(host.textContent).toContain('Save preferences');
  expect(host.textContent).not.toContain('browser.capture');
});
