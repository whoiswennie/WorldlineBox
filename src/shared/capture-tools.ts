import { z } from 'zod';

export const CAPTURE_TOOLS_REQUEST = 'worldlinebox:capture-tools:request';
export const CAPTURE_TOOLS_CHANGED = 'worldlinebox:capture-tools:changed';
export const CAPTURE_TOOLS_ARGUMENT = '--worldlinebox-capture-tools';
export const CAPTURE_VIDEO_LIMIT_SECONDS = 7200;
export const CAPTURE_GIF_LIMIT_SECONDS = 60;
export const CAPTURE_SELECTION_MAX_BYTES = 32 * 1024;
export const CAPTURE_SELECTION_DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Shift+D';
export const captureRecordingQualitySchema = z.enum(['original', '1080p', '720p']);
export type CaptureRecordingQuality = z.infer<typeof captureRecordingQualitySchema>;
export const captureToolTaskSchema = z.enum(['screenshot', 'recording', 'ocr', 'translate', 'long-screenshot', 'selection']);
export type CaptureToolTask = z.infer<typeof captureToolTaskSchema>;
const accelerator = z.string().max(100);
export const captureToolsSettingsSchema = z.strictObject({
  shortcuts: z.strictObject({ screenshot: accelerator, recording: accelerator, ocr: accelerator, translate: accelerator, 'long-screenshot': accelerator,
    selection: accelerator.default(CAPTURE_SELECTION_DEFAULT_SHORTCUT) }),
  hideApp: z.boolean(), systemAudio: z.boolean(), microphone: z.boolean(), format: z.enum(['mp4', 'webm', 'gif']), quality: captureRecordingQualitySchema.default('original'),
});
export type CaptureToolsSettings = z.infer<typeof captureToolsSettingsSchema>;
export const DEFAULT_CAPTURE_TOOLS_SETTINGS: CaptureToolsSettings = {
  shortcuts: { screenshot: 'CommandOrControl+Alt+Shift+S', recording: 'CommandOrControl+Alt+Shift+R', ocr: 'CommandOrControl+Alt+Shift+O', translate: 'CommandOrControl+Alt+Shift+T', 'long-screenshot': 'CommandOrControl+Alt+Shift+L', selection: CAPTURE_SELECTION_DEFAULT_SHORTCUT },
  hideApp: true, systemAudio: true, microphone: false, format: 'mp4', quality: 'original',
};
/** Desktop geometry is absolute Electron DIP; image width/height remain pixels. */
export const captureScreenRectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive().max(32768), height: z.number().positive().max(32768) });
export type CaptureScreenRect = z.infer<typeof captureScreenRectSchema>;
export const captureDesktopRegionSchema = z.object({ id: z.string().max(100), kind: z.enum(['window', 'workarea', 'screen']), name: z.string().max(500), bounds: captureScreenRectSchema });
export type CaptureDesktopRegion = z.infer<typeof captureDesktopRegionSchema>;
export const captureDesktopContextSchema = z.object({ displayId: z.string().max(100), bounds: captureScreenRectSchema, workArea: captureScreenRectSchema,
  pixelBounds: captureScreenRectSchema.optional(), pixelWorkArea: captureScreenRectSchema.optional(),
  scaleFactor: z.number().positive().max(8), cursor: z.object({ x: z.number().finite(), y: z.number().finite() }),
  windowSnapping: z.boolean(), candidates: z.array(captureDesktopRegionSchema).max(258),
});
export type CaptureDesktopContext = z.infer<typeof captureDesktopContextSchema>;
export const captureRecordingControlsSchema = z.object({ hidden: z.boolean(), bounds: captureScreenRectSchema.optional() });
export type CaptureRecordingControls = z.infer<typeof captureRecordingControlsSchema>;
export const captureSourceSchema = z.object({ dataUrl: z.string().max(46_000_000), width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768), title: z.string().max(500), url: z.string().max(8192), desktop: captureDesktopContextSchema.optional() });
export type CaptureImageSource = z.infer<typeof captureSourceSchema>;
export const desktopSourceSchema = z.object({ id: z.string().max(255), name: z.string().max(500), displayId: z.string().max(100), thumbnail: z.string().max(2_000_000), kind: z.enum(['screen', 'window']) });
export type CaptureDesktopSource = z.infer<typeof desktopSourceSchema>;
const recordingSchema = z.object({ id: z.string(), status: z.enum(['recording', 'paused', 'finalizing', 'saved', 'failed', 'cancelled']), format: z.enum(['mp4', 'webm', 'gif']), bytes: z.number().nonnegative(), startedAt: z.string(), path: z.string().optional(), error: z.string().optional() });
export type CaptureRecordingState = z.infer<typeof recordingSchema>;
export const captureToolsStateSchema = z.object({ settings: captureToolsSettingsSchema, downloadPath: z.string(), task: captureToolTaskSchema,
  shortcuts: z.array(z.object({ task: captureToolTaskSchema, accelerator, registered: z.boolean(), error: z.string().optional() })),
  ai: z.object({ configured: z.boolean(), model: z.string(), visionSupported: z.boolean().nullable(), reason: z.string().optional() }),
  recording: recordingSchema.optional(), revision: z.number().int().nonnegative(),
});
export type CaptureToolsState = z.infer<typeof captureToolsStateSchema>;
const imageData = z.string().min(1).max(46_000_000);
const message = z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(16384) });
const selectionText = z.string().max(CAPTURE_SELECTION_MAX_BYTES).refine(value => new TextEncoder().encode(value).byteLength <= CAPTURE_SELECTION_MAX_BYTES, '选中文字超过 32 KiB 上限。');
export const captureToolsRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }), z.strictObject({ type: z.literal('context') }),
  z.strictObject({ type: z.literal('settings.save'), settings: captureToolsSettingsSchema }),
  z.strictObject({ type: z.literal('open'), task: captureToolTaskSchema, source: z.literal('browser').optional() }), z.strictObject({ type: z.literal('close') }),
  z.strictObject({ type: z.literal('sources.list') }),
  z.strictObject({ type: z.literal('screenshot.capture'), sourceId: z.string().max(255).optional() }),
  z.strictObject({ type: z.literal('long.begin'), rect: z.strictObject({ x: z.number().int().nonnegative().max(32768), y: z.number().int().nonnegative().max(32768), width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768) }), sourceId: z.string().max(255).optional() }),
  z.strictObject({ type: z.literal('long.append') }), z.strictObject({ type: z.literal('long.finish') }), z.strictObject({ type: z.literal('long.cancel') }),
  z.strictObject({ type: z.literal('screenshot.copy'), dataUrl: imageData }),
  z.strictObject({ type: z.literal('screenshot.save'), dataUrl: imageData, filename: z.string().max(255).optional(), destination: z.enum(['downloads', 'library']).default('downloads') }),
  z.strictObject({ type: z.literal('screenshot.ask'), id: z.string().min(1).max(100), dataUrl: imageData, messages: z.array(message).min(1).max(40) }),
  z.strictObject({ type: z.literal('selection.ask'), id: z.string().min(1).max(100), selection: selectionText, messages: z.array(message).min(1).max(40) }),
  z.strictObject({ type: z.literal('selection.clipboard') }),
  z.strictObject({ type: z.literal('selection.copy'), text: selectionText }),
  z.strictObject({ type: z.literal('ask.cancel'), id: z.string().max(100) }),
  z.strictObject({ type: z.literal('recording.prepare'), sourceId: z.string().min(1).max(255), format: z.enum(['mp4', 'webm', 'gif']), systemAudio: z.boolean(), microphone: z.boolean(), quality: captureRecordingQualitySchema.optional(),
    rect: z.strictObject({ x: z.number().int().nonnegative().max(32768), y: z.number().int().nonnegative().max(32768), width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768) }).optional() }),
  z.strictObject({ type: z.literal('recording.chunk'), id: z.string().max(100), sequence: z.number().int().nonnegative(), chunk: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= 16 * 1024 * 1024) }),
  z.strictObject({ type: z.literal('recording.finish'), id: z.string().max(100) }),
  z.strictObject({ type: z.literal('recording.cancel'), id: z.string().max(100) }),
  z.strictObject({ type: z.literal('recording.pause'), id: z.string().max(100), paused: z.boolean() }),
  z.strictObject({ type: z.literal('recording.stop') }),
  z.strictObject({ type: z.literal('reveal'), path: z.string().min(1).max(8192) }),
]);
export type CaptureToolsRequest = z.infer<typeof captureToolsRequestSchema>;
export const captureToolsResponseSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), state: captureToolsStateSchema.optional(), source: captureSourceSchema.optional(), sources: z.array(desktopSourceSchema).optional(), recordingControls: captureRecordingControlsSchema.optional(), long: z.object({ frames: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive() }).optional(), id: z.string().optional(), path: z.string().optional(), text: z.string().optional() }), z.object({ ok: z.literal(false), error: z.string().max(2000) })]);
export type CaptureToolsResponse = z.infer<typeof captureToolsResponseSchema>;
export interface WorldlineBoxCaptureToolsApi {
  request(request: CaptureToolsRequest): Promise<CaptureToolsResponse>;
  onChanged(listener: (state: CaptureToolsState) => void): () => void;
  onStopRecording(listener: () => void): () => void;
}
export const CAPTURE_TOOLS_STOP_RECORDING = 'worldlinebox:capture-tools:stop-recording';
