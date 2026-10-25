import { useState } from 'react';
import { CompanionInlineMedia } from './CompanionMediaPlayer';
import { COMPANION_MEDIA_PREVIEW_MAX_BYTES, COMPANION_IMAGE_PREVIEW_MAX_BYTES } from '../../shared/companion-media';
import type { CompanionAttachment } from '../../shared/companions';
import { Icon } from '../Icons';
import './companion-attachments.css';

export function companionAttachmentSource(attachment: CompanionAttachment) {
  return attachment.url || `worldlinebox-companion://attachment/${encodeURIComponent(attachment.id)}`;
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
const labels = { image: '图片', audio: '音频', video: '视频', pdf: 'PDF 文档', text: '文本文件', file: '文件' } as const;

function MediaAttachment({ attachment, onOpen, ownerId, conversationId }: { attachment: CompanionAttachment; onOpen: (attachment: CompanionAttachment) => void; ownerId?: string; conversationId?: string }) {
  const kind = companionAttachmentKind(attachment), large = attachment.size > COMPANION_MEDIA_PREVIEW_MAX_BYTES;
  const [error, setError] = useState('');
  const launch = () => { void (window as unknown as { worldlinebox?: { companions?: { request(input: { type: 'attachment.launch'; id: string }): Promise<{ ok: boolean; error?: string }> } } }).worldlinebox?.companions?.request({ type: 'attachment.launch', id: attachment.id }).then(result => { if (!result.ok) setError(result.error ?? '系统应用暂时无法打开此文件。'); }).catch(() => setError('系统应用暂时无法打开此文件。')); };
  return <section className={`companions-media-attachment is-${kind}`} aria-label={`${labels[kind]}：${attachment.name}`}>
    <header><span className="companions-attachment-format"><Icon name={kind === 'audio' ? 'music' : 'activity'} />{labels[kind]}</span><span>{companionAttachmentSize(attachment.size)}</span></header>
    {large ? <p className="companions-media-error">文件超过 256 MB 内置播放上限，可使用系统应用播放原文件。</p> : <CompanionInlineMedia attachment={attachment} ownerId={ownerId} conversationId={conversationId} />}
    {error && <p role="alert">{error}</p>}
    <footer><strong title={attachment.name}>{attachment.name}</strong><button type="button" aria-label={`使用系统应用打开：${attachment.name}`} onClick={launch}><Icon name="arrow-up-right" /><span>系统打开</span></button><button type="button" aria-label={`查看文件位置：${attachment.name}`} onClick={() => onOpen(attachment)}><Icon name="folder" /></button></footer>
  </section>;
}

export function CompanionAttachments({ attachments, onOpen, ownerId, conversationId }: {
  attachments: readonly CompanionAttachment[];
  ownerId?: string; conversationId?: string;
  onOpen: (attachment: CompanionAttachment, images?: readonly CompanionAttachment[]) => void;
}) {
  const images = attachments.filter(attachment => companionAttachmentKind(attachment) === 'image' && attachment.size <= COMPANION_IMAGE_PREVIEW_MAX_BYTES);
  return <div className="companions-message-attachments">
    {!!images.length && <div className={`companions-attachment-images${images.length === 1 ? ' is-single' : ''}`} aria-label={`${images.length} 张图片`}>{images.map(attachment => <button type="button" className="companions-attachment is-image" key={attachment.id} onClick={() => onOpen(attachment, images)} aria-label={`预览图片：${attachment.name}`}><img loading="lazy" src={companionAttachmentSource(attachment)} alt={attachment.name} /><span><strong>{attachment.name}</strong><small>{companionAttachmentSize(attachment.size)} · 查看大图</small></span></button>)}</div>}
    {attachments.filter(attachment => !images.includes(attachment)).map(attachment => {
      const kind = companionAttachmentKind(attachment);
      return kind === 'audio' || kind === 'video' ? <MediaAttachment key={attachment.id} attachment={attachment} onOpen={onOpen} ownerId={ownerId} conversationId={conversationId} />
        : <button type="button" className={`companions-attachment is-${kind}`} key={attachment.id} onClick={() => onOpen(attachment)} aria-label={`${kind === 'pdf' || kind === 'text' ? '预览文件' : '查看文件位置'}：${attachment.name}`}><span className="companions-attachment-file-icon"><Icon name={kind === 'text' ? 'code' : 'file'} /><small>{kind === 'pdf' ? 'PDF' : kind === 'text' ? 'TEXT' : 'FILE'}</small></span><span className="companions-attachment-file-details"><strong>{attachment.name}</strong><small>{labels[kind]} · {companionAttachmentSize(attachment.size)}</small></span><Icon name="folder" /></button>;
    })}
  </div>;
}
