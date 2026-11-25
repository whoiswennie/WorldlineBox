import { z } from 'zod';
import { SPEECH_MAX_WAV_BYTES, SPEECH_RECORDING_SECONDS, type LocalSpeechTranscript } from './local-speech';

export const BOT_MEDIA_CHANNEL = 'companion-bot-media:request';
export const BOT_MEDIA_CLIPBOARD_CHANNEL = 'companion-bot-media:clipboard-files';
export const BOT_PRESENCE_ACTIVITY_CHANNEL = 'companion-bot-media:presence-activity';
/** Classify a declared MP4 container without reading or probing its bytes. */
export function normalizeBotMediaMime(name: string, mimeType: string): string {
  if (mimeType === 'application/mp4') return /\.m4a$/i.test(name) ? 'audio/mp4' : /\.(mp4|m4v)$/i.test(name) ? 'video/mp4' : mimeType;
  return mimeType;
}
export const BOT_MEDIA_PREVIEW_MAX_BYTES=200*1024*1024;
export const BOT_MEDIA_AUTOMATIC_IMAGE_LIMITS = { bytes: 8 * 1024 * 1024, pixels: 20_000_000 } as const;
export function botImageNeedsConversion(mimeType: string) {
  return /^image\/(?:tiff?|hei[cf](?:-sequence)?)$/i.test(mimeType);
}
export const BOT_MEDIA_PREVIEW_LIMITS={image:BOT_MEDIA_PREVIEW_MAX_BYTES,video:BOT_MEDIA_PREVIEW_MAX_BYTES,audio:BOT_MEDIA_PREVIEW_MAX_BYTES,text:BOT_MEDIA_PREVIEW_MAX_BYTES} as const;
export const BOT_MEDIA_TEXT_PAGE_BYTES=64*1024;
export const BOT_MEDIA_TEXT_PAGE_MAX_BYTES=256*1024;
export const BOT_TEXT_EDIT_BYTES = 2 * 1024 * 1024;
export const cropRatios = { original: 0, square: 1, landscape: 16 / 9, portrait: 3 / 4 } as const;
const fraction = z.number().min(0).max(1);
const cropRegion = z.strictObject({ x: fraction, y: fraction, right: fraction, bottom: fraction })
  .refine(r => r.right > r.x && r.bottom > r.y);
export type CropRegion = z.infer<typeof cropRegion>;
export function imageCropArea(width: number, height: number, edit: ImageEdit) {
  if (edit.crop === 'custom' && edit.region) {
    const left = Math.min(width - 1, Math.round(edit.region.x * width)), top = Math.min(height - 1, Math.round(edit.region.y * height));
    return { left, top, width: Math.max(1, Math.round(edit.region.right * width) - left), height: Math.max(1, Math.round(edit.region.bottom * height) - top) };
  }
  const ratio = edit.crop === 'custom' ? 0 : cropRatios[edit.crop];
  const w = ratio ? Math.max(1, Math.min(width, Math.round(height * ratio))) : width;
  const h = ratio ? Math.max(1, Math.min(height, Math.round(width / ratio))) : height;
  return { left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), width: w, height: h };
}
const attachmentEdit = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('image'), turns: z.number().int().min(0).max(3), mirror: z.boolean(), crop: z.enum(['original', 'square', 'landscape', 'portrait', 'custom']), region: cropRegion.optional() })
    .refine(edit => edit.crop !== 'custom' || !!edit.region),
  z.strictObject({ kind: z.literal('text'), content: z.string().max(BOT_TEXT_EDIT_BYTES) }),
  z.strictObject({ kind: z.literal('clip'), start: z.number().nonnegative(), end: z.number().positive() }).refine(clip => clip.end > clip.start),
]);
export type AttachmentEdit = z.infer<typeof attachmentEdit>;
export type ImageEdit = Extract<AttachmentEdit, { kind: 'image' }>;
export function officeFormat(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return ext === 'docx' || ext === 'pptx' || ext === 'xlsx' ? ext : undefined;
}
export function botMediaTextFormat(input:{name?:string;mimeType:string}):'text'|'markdown'|undefined{
  const extension=input.name?.split('.').at(-1)?.toLowerCase();
  if(extension&&['md','markdown','mdown','mkd'].includes(extension))return'markdown';
  if(extension&&['txt','text','log','csv','tsv','json','jsonl','ndjson','yaml','yml','toml','ini','conf','cfg','xml'].includes(extension))return'text';
  if(!input.name&&/^text\/(?:plain|markdown)(?:;|$)/i.test(input.mimeType))return input.mimeType.startsWith('text/markdown')?'markdown':'text';
  return undefined;
}
export type BotMediaPreviewPolicy={previewEligibility:'inline'|'text'|'file-only'|'external-only';previewLimitReason?:string};
/** Metadata only: this policy never sniffs or decodes the original file. */
export function botMediaPreviewPolicy(input:{name?:string;mimeType:string;size:number}):BotMediaPreviewPolicy{
  const kind=input.mimeType.startsWith('image/')?'image':input.mimeType.startsWith('video/')?'video':input.mimeType.startsWith('audio/')?'audio':undefined;
  const limit=kind?BOT_MEDIA_PREVIEW_LIMITS[kind]:BOT_MEDIA_PREVIEW_LIMITS.video;
  if(input.size>limit)return{previewEligibility:'external-only',previewLimitReason:kind?`${kind==='image'?'图片':kind==='video'?'视频':'音频'}超过 ${limit/1024/1024}MB，仅支持系统软件打开。`:'大文件仅登记原文件引用，使用系统软件打开。'};
  return{previewEligibility:kind?'inline':botMediaTextFormat(input)?'text':'file-only'};
}
export interface BotMediaTextPage {content:string;offset:number;nextOffset?:number;totalBytes:number;name:string;format:'text'|'markdown';encoding:'utf-8'|'utf-16le'|'utf-16be'}
export interface BotMediaRef {
  voice?: { durationSeconds: number };
  transcript?: LocalSpeechTranscript;
  id: string; name: string; mimeType: string; size: number; sha256?: string; url: string;
  kind: 'file' | 'sticker'; packId?: string; animated?: boolean; width?: number; height?: number;
  previewUrl?:string;
  originalName?:string; tags?:string[]; description?:string;
  storage?:'managed'|'external';analysisBlocked?:boolean;
  previewEligibility?:BotMediaPreviewPolicy['previewEligibility'];previewLimitReason?:string;
}
export interface BotStickerPack { id: string; name: string; builtin: boolean; count: number; cover?: BotMediaRef }
const id = z.string().min(1).max(160).refine(value => !/[\0/\\]/.test(value));
const filePath = z.string().min(1).max(32768).refine(value => !value.includes('\0'));
export const BOT_DESKTOP_AUDIO_SECONDS = 10;
export const BOT_DESKTOP_MIN_SECONDS = 3;
export const BOT_DESKTOP_MAX_SECONDS = SPEECH_RECORDING_SECONDS;
export const BOT_DESKTOP_VIDEO_CHUNK_BYTES = 2 * 1024 * 1024;
export const BOT_DESKTOP_HOST_EVENT = 'worldlinebox:agent-desktop-recording';
export const BOT_DESKTOP_AGENT_EVENT = 'worldlinebox:companion-desktop-capture';
export const botPresenceEnergy = z.enum(['low', 'balanced', 'active']);
export type BotPresenceEnergy = z.infer<typeof botPresenceEnergy>;
export type BotPresenceCapture = 'screen' | 'video';
export type BotDesktopActivity = 'recording' | 'screenshot' | 'captured' | 'observing' | 'listening';
export const BOT_PRESENCE_ARCHIVE_LIMIT = 50;
export const BOT_PRESENCE_ROUND_PAGE = 24;
export const BOT_PRESENCE_ROUND_LIMIT = 4096;
export const BOT_PRESENCE_ROUND_DAYS = 3;
export const BOT_PRESENCE_TASK_TIMEOUT_MS = 150_000;
export const BOT_PRESENCE_CLIP_SECONDS = 16;
export const BOT_PRESENCE_MAX_CLIP_BYTES = 10 * 1024 * 1024;
export const BOT_PRESENCE_CAPTURE_EDGE = 2560;
export interface BotPresenceStatus {
  revision?: number;
  nextAt?: number; thinking: boolean; vision: boolean; error?: string;
  capture: BotPresenceCapture; cycle: number; flushCycle?: number; capturePaused?: boolean;
  waitingForPartner?: boolean;
  phase?: 'sealing' | 'preparing' | 'observing';
  screenshot?: 'capturing' | 'just-captured';
  last?: { at: number; outcome: 'responded' | 'observed' | 'failed' | 'interrupted' };
}
export interface BotPresenceRecording {
  id: string; name: string; at: number; startedAt: number; kind: BotPresenceCapture; size: number;
  status: 'pending' | 'processing' | 'archived';
}
export type BotHeartbeatState = 'sealing' | 'preparing' | 'observing' | 'completed' | 'empty' | 'interrupted' | 'failed';
export interface BotHeartbeatRound {
  id: number; at: number; waitMs: number; state: BotHeartbeatState; finishedAt?: number; error?: string;
  inputs: Pick<BotPresenceRecording, 'id' | 'kind' | 'name' | 'startedAt' | 'at'>[];
}
export const botDesktopCaptureDuration = z.number().int().min(BOT_DESKTOP_MIN_SECONDS).max(BOT_DESKTOP_MAX_SECONDS);
export const botDesktopCaptureToolArguments = z.strictObject({
  operation: z.enum(['screen', 'watch', 'listen']), seconds: botDesktopCaptureDuration.optional(),
});
const captureRequest = { conversationId: id, requestId: z.uuid(), surface: z.enum(['chat', 'pet']) };
export interface BotDesktopCaptureScope { conversationId: string; requestId: string; surface: 'chat' | 'pet' }
export interface BotPresenceActivity extends BotDesktopCaptureScope { status: BotPresenceStatus }
export type BotDesktopCaptureToolArguments = z.infer<typeof botDesktopCaptureToolArguments>;
export type BotDesktopAgentCommand = BotDesktopCaptureScope & (BotDesktopCaptureToolArguments | { operation: 'cancel' });
const desktopWave = z.string().min(60).max(Math.ceil(SPEECH_MAX_WAV_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u);
export const botMediaRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type:z.literal('desktop.failed'), ...captureRequest, error: z.string().min(1).max(500) }),
  z.strictObject({ type:z.literal('desktop.screen'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.audio.begin'), ...captureRequest, seconds:botDesktopCaptureDuration.default(BOT_DESKTOP_AUDIO_SECONDS) }),
  z.strictObject({ type:z.literal('desktop.audio.finish'), ...captureRequest, audio:desktopWave }),
  z.strictObject({ type:z.literal('desktop.audio.activity'), ...captureRequest, active:z.boolean() }),
  z.strictObject({ type:z.literal('desktop.video.begin'), ...captureRequest, seconds:botDesktopCaptureDuration }),
  z.strictObject({ type:z.literal('desktop.video.chunk'), ...captureRequest, sequence:z.number().int().min(0).max(300), bytes:z.instanceof(Uint8Array).refine(bytes => bytes.length > 0 && bytes.length <= BOT_DESKTOP_VIDEO_CHUNK_BYTES) }),
  z.strictObject({ type:z.literal('desktop.video.finish'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.video.activity'), ...captureRequest, active:z.boolean() }),
  z.strictObject({ type:z.literal('desktop.surface.ready'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.surface.closed'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.presence.start'), ...captureRequest, sessionId:z.uuid(), energy:botPresenceEnergy, meeting:z.boolean().optional(), interacting:z.boolean().optional() }),
  z.strictObject({ type:z.literal('desktop.presence.status'), ...captureRequest, recordingCycle:z.number().int().nonnegative().optional(), recording:z.boolean().optional(), interacting:z.boolean().optional() }),
  z.strictObject({ type:z.literal('desktop.presence.recording'), ...captureRequest, cycle:z.number().int().nonnegative(), recording:z.boolean() }),
  z.strictObject({ type:z.literal('desktop.presence.energy'), ...captureRequest, energy:botPresenceEnergy }),
  z.strictObject({ type:z.literal('desktop.presence.flushed'), ...captureRequest, cycle:z.number().int().nonnegative() }),
  z.strictObject({ type:z.literal('desktop.presence.interrupt'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.presence.archive.list'), ...captureRequest, show: z.boolean().optional(), before: z.number().int().positive().optional() }),
  z.strictObject({ type:z.literal('desktop.presence.archive.read'), ...captureRequest, id: z.uuid() }),
  z.strictObject({ type:z.literal('desktop.presence.archive.clear'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.presence.clip'), ...captureRequest,
    cycle:z.number().int().nonnegative().optional(),
    startedAt:z.number().int().nonnegative(), endedAt:z.number().int().nonnegative(),
    bytes:z.instanceof(Uint8Array).refine(bytes => bytes.length > 32 && bytes.length <= BOT_PRESENCE_MAX_CLIP_BYTES) }),
  z.strictObject({ type:z.literal('desktop.transcribe'), ...captureRequest }),
  z.strictObject({ type:z.literal('desktop.cancel'), ...captureRequest }),
  z.strictObject({ type:z.literal('packs.list'), conversationId:id }),
  z.strictObject({ type:z.literal('stickers.list'), conversationId:id, packId:id }),
  z.strictObject({ type:z.literal('media.list'), conversationId:id }),
  z.strictObject({ type:z.literal('files.pick'), conversationId:id }),
  z.strictObject({ type:z.literal('files.paste'), conversationId:id }),
  z.strictObject({ type:z.literal('files.import'), conversationId:id, paths:z.array(filePath).min(1).max(64) }),
  z.strictObject({ type:z.literal('pack.pick'), conversationId:id }),
  z.strictObject({ type:z.literal('pack.import'), conversationId:id, directory:filePath }),
  z.strictObject({ type:z.literal('attachment.save'), conversationId:id, id }),
  z.strictObject({ type: z.literal('attachment.export'), conversationId: id, id, edit: attachmentEdit, exportId: z.uuid() }),
  z.strictObject({ type: z.literal('attachment.export.cancel'), conversationId: id, id, exportId: z.uuid() }),
  z.strictObject({ type: z.literal('media.office.read'), conversationId: id, id }),
  z.strictObject({ type:z.literal('attachment.open'), conversationId:id, id }),
  z.strictObject({ type:z.literal('media.text.read'), conversationId:id, id, offset:z.number().int().min(0).max(BOT_MEDIA_PREVIEW_MAX_BYTES).optional(), limit:z.number().int().min(4).max(BOT_MEDIA_TEXT_PAGE_MAX_BYTES).optional() }),
]);
export type BotMediaRequest=z.infer<typeof botMediaRequestSchema>;
export interface BotMediaResponse { ok:boolean; error?:string; cancelled?:boolean; media?:BotMediaRef[]; packs?:BotStickerPack[]; pack?:BotStickerPack; savedPath?:string;textPage?:BotMediaTextPage; officeParts?: Record<string, string>; transcript?:string; durationSeconds?:number;
  presence?: BotPresenceStatus; recordings?: BotPresenceRecording[]; recordingBytes?: Uint8Array; rounds?: BotHeartbeatRound[]; olderRounds?: boolean }
export interface WorldlineBoxBotMediaApi {
  readonly desktopCaptureSupported?: boolean;
  onPresenceActivity?(listener: (event: BotPresenceActivity) => void): () => void;
  request(input:BotMediaRequest):Promise<BotMediaResponse>;
  /** Bounded native file-list probe; never returns paths or reads file contents. */
  hasClipboardFiles?(conversationId:string):boolean;
  /** Only actual File objects from the desktop drop/picker can yield OS paths. */
  getDroppedFilePaths(files:File[]):string[];
}
