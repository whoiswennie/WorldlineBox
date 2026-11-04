import { botMediaPreviewPolicy, normalizeBotMediaMime, type BotMediaRef } from '../../shared/companion-bot-media';

export type BotAttachmentKind = 'image' | 'video' | 'audio' | 'text' | 'file';
export type BotAttachmentCategory = 'image' | 'video' | 'audio' | 'document';
export function botAttachmentDetails(media: BotMediaRef, hasApi = false) {
  const name = media.originalName ?? media.name, mimeType = normalizeBotMediaMime(name, media.mimeType), policy = botMediaPreviewPolicy({ name, mimeType, size: media.size });
  const kind: BotAttachmentKind = policy.previewEligibility === 'text' ? 'text' : mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'file';
  const canPreview = policy.previewEligibility === 'inline' && kind !== 'file' || policy.previewEligibility === 'text' && hasApi;
  return { name, mimeType, kind, category: (kind === 'file' || kind === 'text' ? 'document' : kind) as BotAttachmentCategory, canPreview, policy,
    extension: name.includes('.') ? name.split('.').at(-1)!.slice(0, 6).toUpperCase() : 'FILE',
    imageUrl: /^image\/(?:png|jpeg|gif|webp|avif|bmp|apng|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i.test(mimeType) ? media.url : media.previewUrl ?? media.url };
}
export function botAttachmentSummary(media: readonly BotMediaRef[]) {
  const counts: Record<BotAttachmentCategory, number> = { image: 0, video: 0, audio: 0, document: 0 };
  let bytes = 0;
  for (const item of media) { counts[botAttachmentDetails(item).category]++; bytes += item.size; }
  return { count: media.length, bytes, counts };
}
export function botAttachmentCategoryLabel(kind: BotAttachmentCategory, zh: boolean) {
  return ({ image: zh ? '图片' : 'Images', video: zh ? '视频' : 'Video', audio: zh ? '音频' : 'Audio', document: zh ? '文件' : 'Files' })[kind];
}
