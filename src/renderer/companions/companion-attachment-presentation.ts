import type { CompanionAttachment } from '../../shared/companions';

export function companionAttachmentSource(attachment: CompanionAttachment) {
  return attachment.url || `worldlinebox-companion://attachment/${encodeURIComponent(attachment.id)}`;
}
/** A registered source is re-authorized before the host returns one static
 * image frame. Do not append a thumbnail query to arbitrary external URLs. */
export function companionAttachmentCoverSource(attachment: CompanionAttachment) {
  return `worldlinebox-companion://attachment/${encodeURIComponent(attachment.id)}?cover=1`;
}
export function companionAttachmentSize(value: number) {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
}
export function companionAttachmentKind(attachment: Pick<CompanionAttachment, 'mime' | 'name'>) {
  if (attachment.mime.startsWith('image/')) return 'image';
  if (attachment.mime.startsWith('audio/')) return 'audio';
  if (attachment.mime.startsWith('video/')) return 'video';
  if (attachment.mime === 'application/pdf') return 'pdf';
  if (attachment.mime.startsWith('text/') || /\.(?:md|markdown|json|csv|log|ya?ml)$/iu.test(attachment.name)) return 'text';
  return 'file';
}
export const attachmentKindLabels = { image: '图片', audio: '音频', video: '视频', pdf: 'PDF 文档', text: '文本文件', file: '文件' } as const;
export function animatedAttachment(attachment: CompanionAttachment) { return /^image\/(?:gif|apng)(?:;|$)/iu.test(attachment.mime) || /\.(?:gif|apng)$/iu.test(attachment.name); }
export function attachmentCollectionSummary(attachments: readonly CompanionAttachment[]) {
  const counts = new Map<string, number>();
  for (const attachment of attachments) { const kind = animatedAttachment(attachment) ? '动图' : attachmentKindLabels[companionAttachmentKind(attachment)]; counts.set(kind, (counts.get(kind) ?? 0) + 1); }
  return [...counts].map(([kind, count]) => `${count} 个${kind}`).join(' · ');
}
