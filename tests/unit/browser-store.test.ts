import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { BrowserStore, browserAddress, isBrowserUrl, newBrowserTab } from '../../src/main/browser/store';
import { browserRequestSchema, BROWSER_HOME, type BrowserDownload } from '../../src/shared/browser';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function store() { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-browser-store-')); roots.push(root); const value = new BrowserStore(root); await value.init(); return { value, root }; }
it('normalizes webpage/search input and rejects scripts, file access, credential URLs and invalid IPC bounds', () => {
  expect(browserAddress('bilibili.com/video')).toBe('https://bilibili.com/video');
  expect(browserAddress('http://localhost:8000/a')).toBe('http://localhost:8000/a');
  expect(browserAddress('天气 上海', 'baidu')).toContain('https://www.baidu.com/s?wd=');
  expect(browserAddress('about:blank')).toBe('about:blank');
  for (const value of ['javascript:alert(1)', 'file:///C:/secret', 'data:text/html,test', 'https://user:secret@example.com']) { expect(() => browserAddress(value)).toThrow(); expect(isBrowserUrl(value)).toBe(false); }
  expect(browserRequestSchema.safeParse({ type: 'layout', visible: true, bounds: { x: -10, y: 0, width: 500, height: 400 } }).success).toBe(false);
  expect(browserRequestSchema.safeParse({ type: 'history', limit: 101 }).success).toBe(false);
});
it('restores tabs, bookmarks, preferences and download metadata while leaving pages dormant', async () => {
  const { value, root } = await store(); expect(value.data.tabs[0]!.url).toBe(BROWSER_HOME);
  const tab = newBrowserTab('https://example.org/page'); value.data.tabs.push(tab); value.data.activeTabId = tab.id; tab.loading = true;
  value.data.bookmarks.push({ id: 'b', url: tab.url, title: 'Example', folder: 'Work', createdAt: '' });
  value.data.downloads.push({ id: 'd', url: tab.url, filename: 'a.zip', path: 'C:/Downloads/a.zip', received: 40, total: 100, status: 'progressing', startedAt: '' });
  value.data.preferences.askDownloadLocation = true; await value.flush();
  const reopened = new BrowserStore(root); await reopened.init();
  expect(reopened.data.activeTabId).toBe(tab.id); expect(reopened.data.tabs).toHaveLength(2);
  expect(reopened.data.tabs.every(row => row.discarded && !row.loading)).toBe(true);
  expect(reopened.data.bookmarks.find(bookmark => bookmark.id === 'b')!.folder).toBe('Work'); expect(reopened.data.preferences.askDownloadLocation).toBe(true);
  expect(reopened.data.downloads[0]!.status).toBe('interrupted');
});
it('honors session restore preference without clearing favorites or browsing data', async () => {
  const { value, root } = await store(); value.data.preferences.restoreSession = false; value.data.preferences.homepage = 'https://example.org/';
  value.data.tabs.push(newBrowserTab('https://other.example/')); value.visit('https://other.example/', 'History'); await value.flush();
  const reopened = new BrowserStore(root); await reopened.init(); expect(reopened.data.tabs).toHaveLength(1); expect(reopened.data.tabs[0]!.url).toBe('https://example.org/'); expect(reopened.data.history).toHaveLength(1);
});
it('starts blank, seeds requested bookmarks once, and preserves removals and existing tabs', async () => {
  const { value, root } = await store();
  expect(value.data.tabs[0]?.url).toBe('about:blank'); expect(value.data.preferences.homepage).toBe('about:blank');
  expect(value.data.bookmarks.map(item => item.title)).toEqual(['哔哩哔哩', 'Pixiv', 'GitHub', 'Bing 搜索']);
  value.data.bookmarks.splice(1, 1); value.data.tabs[0]!.url = 'https://example.org/'; await value.flush();
  const reopened = new BrowserStore(root); await reopened.init();
  expect(reopened.data.bookmarks.map(item => item.title)).toEqual(['哔哩哔哩', 'GitHub', 'Bing 搜索']); expect(reopened.data.tabs[0]?.url).toBe('https://example.org/');
});
it('adds Bing when upgrading without restoring other removed presets', async () => {
  const { value, root } = await store(); value.data.defaultsVersion = 1; value.data.bookmarks = value.data.bookmarks.filter(item => ['哔哩哔哩', 'GitHub'].includes(item.title)); await value.flush();
  const reopened = new BrowserStore(root); await reopened.init();
  expect(reopened.data.bookmarks.map(item => item.title)).toEqual(['哔哩哔哩', 'GitHub', 'Bing 搜索']);
});
it('bounds history retention and paged reads and avoids duplicate rapid same-page visits', async () => {
  const { value } = await store();
  for (let index = 0; index < 2010; index++) value.visit('https://example.org/' + index, 'Page ' + index);
  value.visit('https://example.org/2009', 'Updated title');
  expect(value.data.history).toHaveLength(2000); expect(value.data.history[0]!.title).toBe('Updated title');
  expect(value.history('', 0, 999).history).toHaveLength(100); expect(value.history('Updated title', 0, 50).total).toBe(1); await value.flush();
});
it('preserves corrupt files and refuses duplicate tab identities without overwriting the saved data', async () => {
  const { value, root } = await store(); const file = path.join(root, 'browser.json');
  await writeFile(file, '{broken'); await expect(new BrowserStore(root).init()).rejects.toThrow(); expect(await readFile(file, 'utf8')).toBe('{broken');
  value.data.tabs.push({ ...value.data.tabs[0]! }); await value.flush();
  await expect(new BrowserStore(root).init()).rejects.toThrow('重复 ID');
});

it('bounds download cleanup requests and accepts only IDs rather than file paths', () => {
  expect(browserRequestSchema.safeParse({ type: 'download.records.remove', ids: ['finished'] }).success).toBe(true);
  expect(browserRequestSchema.safeParse({ type: 'download.records.clear' }).success).toBe(true);
  for (const input of [{ type: 'download.records.remove', ids: [] }, { type: 'download.records.remove', ids: ['x'.repeat(101)] },
    { type: 'download.records.remove', ids: Array(201).fill('x') }, { type: 'download.records.remove', ids: ['finished'], path: 'C:/secret' },
    { type: 'download.records.clear', deleteFiles: true }]) expect(browserRequestSchema.safeParse(input).success).toBe(false);
});

it('removes selected history idempotently, keeps all live or paused records, and preserves files across restart', async () => {
  const { value, root } = await store(); const file = path.join(root, 'downloaded.txt');
  await writeFile(file, 'Keep this downloaded file');
  const statuses: BrowserDownload['status'][] = ['completed', 'cancelled', 'interrupted', 'progressing', 'paused', 'interrupted'];
  value.data.downloads = statuses.map((status, index) => ({ id: String(index), filename: 'downloaded.txt', path: file,
    url: 'https://example.org/' + index, received: 100, total: 100, status, startedAt: new Date().toISOString() }));
  const active = new Set(['5']); // Resumable interrupted DownloadItem is still alive.
  expect(value.removeDownloadRecords(['0', '0', '3', '4', '5', 'unknown'], active)).toBe(1);
  expect(value.data.downloads.map(item => item.id)).toEqual(['1', '2', '3', '4', '5']);
  expect(value.removeDownloadRecords(['0'], active)).toBe(0);
  expect(value.removeDownloadRecords(undefined, active)).toBe(2);
  expect(value.data.downloads.map(item => item.id)).toEqual(['3', '4', '5']);
  await value.flush();
  const reopened = new BrowserStore(root); await reopened.init();
  expect(reopened.data.downloads.map(item => item.id)).toEqual(['3', '4', '5']);
  expect(await readFile(file, 'utf8')).toBe('Keep this downloaded file');
  expect(reopened.removeDownloadRecords(undefined, new Set())).toBe(3);
  await reopened.flush(); expect(await readFile(file, 'utf8')).toBe('Keep this downloaded file');
});
