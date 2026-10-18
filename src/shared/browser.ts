import { z } from 'zod';
export const BROWSER_REQUEST = 'worldlinebox:browser:request';
export const BROWSER_CHANGED = 'worldlinebox:browser:changed';
export const BROWSER_FOCUS = 'worldlinebox:browser:focus';
export const BROWSER_HOME = 'about:blank';
export const BROWSER_DEFAULT_BOOKMARKS = [
  { title: '哔哩哔哩', url: 'https://www.bilibili.com/' },
  { title: 'Pixiv', url: 'https://www.pixiv.net/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Bing 搜索', url: 'https://www.bing.com/' },
] as const;
const id = z.string().min(1).max(100);
export const browserTabSchema = z.object({ id, url: z.string().max(8192), title: z.string().max(500), pinned: z.boolean(), muted: z.boolean(), zoom: z.number().min(.25).max(5),
  loading: z.boolean(), canGoBack: z.boolean(), canGoForward: z.boolean(), audible: z.boolean().optional(), discarded: z.boolean().optional(), error: z.string().max(1000).optional() });
export const browserBookmarkSchema = z.object({ id, url: z.string().max(8192), title: z.string().max(500), folder: z.string().max(100), createdAt: z.string() });
export const browserHistorySchema = z.object({ id, url: z.string().max(8192), title: z.string().max(500), visitedAt: z.string() });
export const browserDownloadSchema = z.object({ id, url: z.string().max(8192), filename: z.string().max(500), path: z.string().max(8192),
  received: z.number().min(0), total: z.number().min(0), status: z.enum(['progressing', 'paused', 'completed', 'cancelled', 'interrupted']), startedAt: z.string(), error: z.string().optional() });
export const browserPreferencesSchema = z.object({ homepage: z.string().max(8192).default(BROWSER_HOME), restoreSession: z.boolean().default(true),
  searchEngine: z.enum(['bing', 'baidu', 'duckduckgo']).default('bing'), askDownloadLocation: z.boolean().default(false) });
export const browserPermissionSchema = z.object({ id, origin: z.string().max(8192), permission: z.string().max(100) });
export const browserStateSchema = z.object({ tabs: z.array(browserTabSchema).max(50), activeTabId: id.optional(), bookmarks: z.array(browserBookmarkSchema).max(1000),
  downloads: z.array(browserDownloadSchema).max(200), historyCount: z.number().int().min(0), preferences: browserPreferencesSchema,
  permissions: z.array(browserPermissionSchema).max(10), fullscreen: z.boolean(), revision: z.number().int().min(0),
  find: z.object({ matches: z.number(), activeMatchOrdinal: z.number() }).optional(), cacheBytes: z.number().min(0).optional(), error: z.string().optional() });
export type BrowserState = z.infer<typeof browserStateSchema>;
export type BrowserTab = z.infer<typeof browserTabSchema>;
export type BrowserDownload = z.infer<typeof browserDownloadSchema>;
export type BrowserBookmark = z.infer<typeof browserBookmarkSchema>;
export type BrowserHistory = z.infer<typeof browserHistorySchema>;
export const browserRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('activate') }), z.object({ type: z.literal('state') }),
  z.object({ type: z.literal('layout'), visible: z.boolean(), bounds: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().min(0).max(20000), height: z.number().int().min(0).max(20000) }) }),
  z.object({ type: z.literal('tab.new'), url: z.string().max(8192).optional(), background: z.boolean().optional() }),
  z.object({ type: z.literal('tab.select'), id }), z.object({ type: z.literal('tab.close'), id }), z.object({ type: z.literal('tab.restore') }),
  z.object({ type: z.literal('tab.navigate'), text: z.string().min(1).max(8192) }),
  z.object({ type: z.literal('tab.action'), action: z.enum(['back', 'forward', 'reload', 'stop', 'home', 'pin', 'mute', 'fullscreen', 'devtools']) }),
  z.object({ type: z.literal('tab.zoom'), factor: z.number().min(.25).max(5) }),
  z.object({ type: z.literal('find'), text: z.string().max(500), forward: z.boolean().optional(), next: z.boolean().optional() }),
  z.object({ type: z.literal('bookmark.save'), id: id.optional(), title: z.string().min(1).max(500), folder: z.string().max(100).default('') }), z.object({ type: z.literal('bookmark.remove'), id }),
  z.object({ type: z.literal('history'), query: z.string().max(200).default(''), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }),
  z.object({ type: z.literal('preferences.save'), preferences: browserPreferencesSchema }),
  z.object({ type: z.literal('download.action'), id, action: z.enum(['pause', 'resume', 'cancel', 'reveal', 'open', 'retry']) }),
  z.object({ type: z.literal('data.info') }),
  z.object({ type: z.literal('data.clear'), cache: z.boolean(), siteData: z.boolean(), history: z.boolean(), downloads: z.boolean(), origin: z.string().max(8192).optional() }),
  z.object({ type: z.literal('permission'), id, allow: z.boolean(), remember: z.boolean().default(false) }),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export const browserResponseSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), state: browserStateSchema.optional(),
  history: z.array(browserHistorySchema).max(100).optional(), total: z.number().int().optional(), found: z.object({ matches: z.number(), activeMatchOrdinal: z.number() }).optional() }), z.object({ ok: z.literal(false), error: z.string() })]);
export type BrowserResponse = z.infer<typeof browserResponseSchema>;
export interface WorldlineBoxBrowserApi { request(request: BrowserRequest): Promise<BrowserResponse>; onChanged(listener: (state: BrowserState) => void): () => void;
  onFocus(listener: (target: 'address' | 'find') => void): () => void; }
