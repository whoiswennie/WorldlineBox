import { z } from 'zod';

export const BOT_MEDIA_CHANNEL = 'companion-bot-media:request';
/** Classify a declared MP4 container without reading or probing its bytes. */
export function normalizeBotMediaMime(name: string, mimeType: string): string {
  if (mimeType === 'application/mp4') return /\.m4a$/i.test(name) ? 'audio/mp4' : /\.(mp4|m4v)$/i.test(name) ? 'video/mp4' : mimeType;
  return mimeType;
}
export const BOT_MEDIA_PREVIEW_MAX_BYTES=200*1024*1024;
export const BOT_MEDIA_PREVIEW_LIMITS={image:BOT_MEDIA_PREVIEW_MAX_BYTES,video:BOT_MEDIA_PREVIEW_MAX_BYTES,audio:BOT_MEDIA_PREVIEW_MAX_BYTES,text:BOT_MEDIA_PREVIEW_MAX_BYTES} as const;
export const BOT_MEDIA_TEXT_PAGE_BYTES=64*1024;
export const BOT_MEDIA_TEXT_PAGE_MAX_BYTES=256*1024;
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
export const botMediaRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type:z.literal('packs.list'), conversationId:id }),
  z.strictObject({ type:z.literal('stickers.list'), conversationId:id, packId:id }),
  z.strictObject({ type:z.literal('media.list'), conversationId:id }),
  z.strictObject({ type:z.literal('files.pick'), conversationId:id }),
  z.strictObject({ type:z.literal('files.import'), conversationId:id, paths:z.array(filePath).min(1).max(64) }),
  z.strictObject({ type:z.literal('pack.pick'), conversationId:id }),
  z.strictObject({ type:z.literal('pack.import'), conversationId:id, directory:filePath }),
  z.strictObject({ type:z.literal('attachment.save'), conversationId:id, id }),
  z.strictObject({ type:z.literal('attachment.open'), conversationId:id, id }),
  z.strictObject({ type:z.literal('media.text.read'), conversationId:id, id, offset:z.number().int().min(0).max(BOT_MEDIA_PREVIEW_MAX_BYTES).optional(), limit:z.number().int().min(4).max(BOT_MEDIA_TEXT_PAGE_MAX_BYTES).optional() }),
]);
export type BotMediaRequest=z.infer<typeof botMediaRequestSchema>;
export interface BotMediaResponse { ok:boolean; error?:string; cancelled?:boolean; media?:BotMediaRef[]; packs?:BotStickerPack[]; pack?:BotStickerPack; savedPath?:string;textPage?:BotMediaTextPage }
export interface WorldlineBoxBotMediaApi {
  request(input:BotMediaRequest):Promise<BotMediaResponse>;
  /** Only actual File objects from the desktop drop/picker can yield OS paths. */
  getDroppedFilePaths(files:File[]):string[];
}
