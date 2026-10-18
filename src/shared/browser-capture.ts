import { z } from 'zod';

export const BROWSER_CAPTURE_REQUEST = 'worldlinebox:browser:capture:request';
export const BROWSER_CAPTURE_CONTENT_REQUEST = 'worldlinebox:browser:capture:content:request';
export const BROWSER_CAPTURE_CONTENT_EVENT = 'worldlinebox:browser:capture:content:event';
export const BROWSER_CAPTURE_OPEN_ASSETS = 'worldlinebox:browser:capture:open-assets';
export const BROWSER_CAPTURE_MAX_BYTES = 500 * 1024 * 1024;
export const BROWSER_CAPTURE_LOCAL_MAX_BYTES = 32 * 1024 * 1024;
export const BROWSER_CAPTURE_HISTORY_LIMIT = 1000;
export const BROWSER_CAPTURE_TEXT_MAX_BYTES = 4 * 1024 * 1024;

const id = z.string().min(1).max(255);
const folderId = z.string().min(1).max(4096);
const url = z.string().min(1).max(8192);
export const browserCaptureKindSchema = z.enum(['image', 'video', 'audio', 'file', 'text', 'page', 'screenshot']);
export type BrowserCaptureKind = z.infer<typeof browserCaptureKindSchema>;
export const browserCaptureRemoteKindSchema = z.enum(['image', 'video', 'audio', 'file']);
export type BrowserCaptureRemoteKind = z.infer<typeof browserCaptureRemoteKindSchema>;
const jobStatus = z.enum(['saving', 'saved', 'failed', 'cancelled']);
// A name is one path component. In particular, the browser cannot escape a
// selected folder or address Windows device names through folder creation.
export const browserCaptureFolderNameSchema = z.string().trim().min(1).max(200)
  // eslint-disable-next-line no-control-regex -- filesystem name validation
  .refine(value => !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && !/[. ]$/.test(value)
    && value !== '.' && value !== '..' && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value), '文件夹名称无效。');

export const browserCapturePreferencesSchema = z.strictObject({
  notificationsEnabled: z.boolean(),
  focusAppAfterSave: z.boolean(),
  revealInLibrary: z.boolean(),
  dragRadialMenuEnabled: z.boolean(),
});
export type BrowserCapturePreferences = z.infer<typeof browserCapturePreferencesSchema>;
export const DEFAULT_BROWSER_CAPTURE_PREFERENCES: BrowserCapturePreferences = {
  notificationsEnabled: true, focusAppAfterSave: true, revealInLibrary: true, dragRadialMenuEnabled: true,
};

export const browserCaptureTargetSchema = z.strictObject({ libraryId: id, folderId: folderId.nullable() });
export type BrowserCaptureTarget = z.infer<typeof browserCaptureTargetSchema>;
export const browserCaptureLibrarySchema = z.strictObject({ libraryId: id, displayName: z.string().min(1).max(255), readOnly: z.boolean().optional() });
export type BrowserCaptureLibrary = z.infer<typeof browserCaptureLibrarySchema>;
export const browserCaptureFolderSchema = z.strictObject({
  libraryId: id, folderId, name: z.string().min(1).max(255), relativePath: z.string().max(8192), assetCount: z.number().int().nonnegative(),
  kind: z.enum(['managed', 'linked']).optional(), available: z.boolean().optional(),
});
export type BrowserCaptureFolder = z.infer<typeof browserCaptureFolderSchema>;
export const browserCaptureJobSchema = z.strictObject({
  id, tabId: id, target: browserCaptureTargetSchema, kind: browserCaptureKindSchema,
  status: jobStatus,
  message: z.string().max(1000), filename: z.string().max(500).optional(),
  assetId: id.optional(), deduplicated: z.boolean().optional(),
  receivedBytes: z.number().int().nonnegative().optional(), totalBytes: z.number().int().nonnegative().optional(),
  startedAt: z.string().max(64), finishedAt: z.string().max(64).optional(),
});
export type BrowserCaptureJob = z.infer<typeof browserCaptureJobSchema>;
export const browserCaptureHistorySchema = z.strictObject({
  items: z.array(browserCaptureJobSchema).max(100), total: z.number().int().nonnegative(),
  page: z.number().int().positive(), pageSize: z.number().int().min(1).max(100),
});
export type BrowserCaptureHistory = z.infer<typeof browserCaptureHistorySchema>;
export const browserCaptureStateSchema = z.strictObject({
  connected: z.boolean(), libraries: z.array(browserCaptureLibrarySchema).max(100),
  activeLibraryId: id.nullable(), target: browserCaptureTargetSchema.nullable(),
  folders: z.array(browserCaptureFolderSchema).max(20_000), recentFolderIds: z.array(folderId).max(20),
  recentBrowsedFolderIds: z.array(folderId).max(20),
  preferences: browserCapturePreferencesSchema, jobs: z.array(browserCaptureJobSchema).max(50),
  error: z.string().max(1000).optional(),
});
export type BrowserCaptureState = z.infer<typeof browserCaptureStateSchema>;

export const browserCaptureRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('target.set'), target: browserCaptureTargetSchema }),
  z.strictObject({ type: z.literal('preferences.save'), preferences: browserCapturePreferencesSchema }),
  z.strictObject({ type: z.literal('save'), kind: browserCaptureRemoteKindSchema, mediaUrl: url,
    tabId: id.optional(), target: browserCaptureTargetSchema.optional() }),
  z.strictObject({ type: z.literal('text.save'), tabId: id.optional(), target: browserCaptureTargetSchema.optional() }),
  z.strictObject({ type: z.literal('page.save'), tabId: id.optional(), target: browserCaptureTargetSchema.optional() }),
  z.strictObject({ type: z.literal('folder.create'), target: browserCaptureTargetSchema, name: browserCaptureFolderNameSchema }),
  z.strictObject({ type: z.literal('history.list'), page: z.number().int().positive().optional(),
    pageSize: z.number().int().min(1).max(100).optional(), query: z.string().max(200).optional(),
    status: jobStatus.optional(), kind: browserCaptureKindSchema.optional() }),
  z.strictObject({ type: z.literal('history.clear') }),
  z.strictObject({ type: z.literal('cancel'), id }),
  z.strictObject({ type: z.literal('open-assets') }),
  z.strictObject({ type: z.literal('local.open') }),
  z.strictObject({ type: z.literal('file.open') }),
]);
export type BrowserCaptureRequest = z.infer<typeof browserCaptureRequestSchema>;
export const browserCaptureResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), state: browserCaptureStateSchema, jobId: id.optional(),
    folderId: folderId.optional(), history: browserCaptureHistorySchema.optional() }),
  z.strictObject({ ok: z.literal(false), error: z.string().max(1000), state: browserCaptureStateSchema.optional() }),
]);
export type BrowserCaptureResponse = z.infer<typeof browserCaptureResponseSchema>;

const runtimeMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('worldlinebox-connection-status') }),
  z.strictObject({ type: z.literal('worldlinebox-list-folders') }),
  z.strictObject({ type: z.literal('worldlinebox-save-request'), intent: z.strictObject({
    kind: z.enum(['image', 'video']), sourcePageUrl: url, mediaUrl: url,
    targetFolderId: folderId.nullable().optional(),
  }) }),
  z.strictObject({ type: z.literal('worldlinebox-local-save-request'), kind: z.enum(['image', 'video']),
    bodyBase64: z.string().min(1).max(Math.ceil(BROWSER_CAPTURE_LOCAL_MAX_BYTES / 3) * 4),
    contentType: z.string().min(1).max(255), filename: z.string().min(1).max(500),
    sourcePageUrl: url.optional(), mediaUrl: url.optional(), targetFolderId: folderId.nullable().optional(),
  }),
]);
const storageArea = z.enum(['local', 'sync']);
const storageKey = z.enum([
  'worldlineboxNotificationsEnabled', 'worldlineboxFocusAppAfterSave',
  'worldlineboxRevealInLibraryAfterSave', 'worldlineboxDragRadialMenuEnabled', 'recentFolderIds',
]);
export const browserCaptureContentRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('runtime.message'), message: runtimeMessageSchema }),
  z.strictObject({ type: z.literal('storage.get'), area: storageArea, keys: z.array(storageKey).max(5) }),
  z.strictObject({ type: z.literal('storage.set'), area: storageArea,
    values: z.partialRecord(storageKey, z.union([z.boolean(), z.array(folderId).max(20)])) }),
]);
export type BrowserCaptureContentRequest = z.infer<typeof browserCaptureContentRequestSchema>;
// Expected denials and document teardown are normal browser lifecycles. Reply
// explicitly instead of rejecting ipcMain.handle (which Electron logs as a Main
// process handler error, even when the isolated content script handles it).
export const browserCaptureContentResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), code: z.enum([
    'unavailable', 'forbidden', 'invalid-request', 'document-gone', 'capture-failed',
  ]), error: z.string().min(1).max(1000) }),
]);
export type BrowserCaptureContentResponse = z.infer<typeof browserCaptureContentResponseSchema>;

export function readBrowserCaptureContentResponse(value: unknown): unknown {
  const parsed = browserCaptureContentResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error('资产采集返回了无效响应。');
  if (!parsed.data.ok) throw new Error(parsed.data.error);
  return parsed.data.value;
}
export type BrowserCaptureContentEvent =
  | { type: 'runtime.message'; message: unknown }
  | { type: 'storage.changed'; area: 'local' | 'sync'; changes: Record<string, { oldValue?: unknown; newValue?: unknown }> };
