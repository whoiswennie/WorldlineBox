import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { browserTabSchema, browserBookmarkSchema, browserDownloadSchema, browserHistorySchema, browserPreferencesSchema, BROWSER_HOME, BROWSER_DEFAULT_BOOKMARKS, type BrowserTab } from '../../shared/browser';
import { atomicJson, readJson } from '../dsh/files';

export function browserAddress(text: string, engine = 'bing'): string {
  const value = text.trim();
  if (value === 'about:blank') return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[\w.-]+:\d+(?:\/|$)/.test(value)) {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw Error('浏览器仅打开 HTTP/HTTPS 网页，不接受脚本、文件或含密码的地址。');
    return url.href;
  }
  if (!/\s/.test(value) && /^(localhost|\[[\da-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/i.test(value)) return browserAddress('https://' + value, engine);
  const base = engine === 'baidu' ? 'https://www.baidu.com/s?wd=' : engine === 'duckduckgo' ? 'https://duckduckgo.com/?q=' : 'https://www.bing.com/search?q=';
  return base + encodeURIComponent(value);
}
export function isBrowserUrl(value: string): boolean { try { return browserAddress(value) === value || ['http:', 'https:'].includes(new URL(value).protocol) && !new URL(value).username && !new URL(value).password; } catch { return false; } }
const persistedSchema = z.object({ version: z.literal(1), defaultsVersion: z.number().int().min(0).default(0), tabs: z.array(browserTabSchema).max(50), activeTabId: z.string().optional(), closedTabs: z.array(browserTabSchema).max(20).default([]),
  bookmarks: z.array(browserBookmarkSchema).max(1000), downloads: z.array(browserDownloadSchema).max(200), history: z.array(browserHistorySchema).max(2000),
  preferences: browserPreferencesSchema, sitePermissions: z.record(z.string(), z.record(z.string(), z.boolean())).default({}),
  navigation: z.record(z.string(), z.object({ entries: z.array(z.object({ url: z.string().max(8192), title: z.string().max(500) })).max(30), index: z.number().int().min(0).max(29) })).default({}) });
export type BrowserData = z.infer<typeof persistedSchema>;
export function newBrowserTab(url = BROWSER_HOME): BrowserTab { return { id: randomUUID(), url, title: '新标签页', pinned: false, muted: false, zoom: 1, loading: false, canGoBack: false, canGoForward: false, discarded: true }; }
export class BrowserStore {
  data: BrowserData = { version: 1, defaultsVersion: 0, tabs: [], closedTabs: [], bookmarks: [], downloads: [], history: [], preferences: browserPreferencesSchema.parse({}), sitePermissions: {}, navigation: {} };
  private timer?: ReturnType<typeof setTimeout>;
  private writes = Promise.resolve();
  constructor(private readonly root: string, private readonly report: (error: unknown) => void = () => undefined) {}
  async init(): Promise<void> {
    const saved = await readJson<unknown>(path.join(this.root, 'browser.json'));
    if (saved) this.data = persistedSchema.parse(saved);
    if (!this.data.defaultsVersion && this.data.preferences.homepage === 'https://www.bilibili.com/') this.data.preferences.homepage = BROWSER_HOME;
    if (this.data.defaultsVersion < 2) {
      const presets = this.data.defaultsVersion ? BROWSER_DEFAULT_BOOKMARKS.filter(item => item.url === 'https://www.bing.com/') : BROWSER_DEFAULT_BOOKMARKS;
      for (const preset of presets) if (this.data.bookmarks.length < 1000 && !this.data.bookmarks.some(item => item.url === preset.url))
        this.data.bookmarks.push({ id: randomUUID(), ...preset, folder: '', createdAt: new Date().toISOString() });
      this.data.defaultsVersion = 2;
    }
    if (!isBrowserUrl(this.data.preferences.homepage)) throw Error('已保存的浏览器主页无效；原配置保留。');
    if (new Set(this.data.tabs.map(tab => tab.id)).size !== this.data.tabs.length) throw Error('标签页配置包含重复 ID；原配置保留。');
    this.data.tabs = this.data.preferences.restoreSession ? this.data.tabs.filter(tab => isBrowserUrl(tab.url)).map(tab => ({ ...tab, title: tab.title || (tab.url === BROWSER_HOME ? '新标签页' : tab.url), loading: false, discarded: true, audible: false })) : [];
    if (!this.data.tabs.length) this.data.tabs = [newBrowserTab(this.data.preferences.homepage)];
    if (!this.data.tabs.some(tab => tab.id === this.data.activeTabId)) this.data.activeTabId = this.data.tabs[0]!.id;
    this.data.downloads = this.data.downloads.map(item => ['progressing', 'paused'].includes(item.status) ? { ...item, status: 'interrupted' } : item);
  }
  changed(): void { if (this.timer) return; this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(this.report); }, 350); this.timer.unref(); }
  async flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined; const snapshot = structuredClone(this.data);
    const write = this.writes.catch(() => undefined).then(() => atomicJson(path.join(this.root, 'browser.json'), snapshot));
    this.writes = write; return write;
  }
  visit(url: string, title: string): void {
    if (!isBrowserUrl(url) || url === 'about:blank') return;
    const last = this.data.history[0];
    if (last?.url === url && Date.now() - Date.parse(last.visitedAt) < 5_000) { last.title = title.slice(0, 500); return; }
    this.data.history.unshift({ id: randomUUID(), url: url.slice(0, 8192), title: title.slice(0, 500), visitedAt: new Date().toISOString() });
    this.data.history.length = Math.min(2000, this.data.history.length); this.changed();
  }
  history(query: string, offset: number, limit: number) { const needle = query.toLocaleLowerCase(); const rows = this.data.history.filter(item => (item.title + ' ' + item.url).toLocaleLowerCase().includes(needle)); return { history: rows.slice(offset, offset + Math.min(100, limit)), total: rows.length }; }
}
