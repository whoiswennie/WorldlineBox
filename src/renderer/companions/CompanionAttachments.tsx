import { useEffect, useRef, useState } from 'react';
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

function MediaAttachment({ attachment, onOpen }: { attachment: CompanionAttachment; onOpen: (attachment: CompanionAttachment) => void }) {
  const [failed, setFailed] = useState(false), kind = companionAttachmentKind(attachment), source = companionAttachmentSource(attachment);
  const media = useRef<HTMLMediaElement | null>(null);
  useEffect(() => { const element = media.current; return () => { element?.pause(); element?.removeAttribute('src'); element?.load(); }; }, []);
  return <section className={`companions-media-attachment is-${kind}`} aria-label={`${labels[kind]}：${attachment.name}`}>
    <header><span className="companions-attachment-format">{kind === 'audio' ? <Icon name="music" /> : <Icon name="activity" />}{labels[kind]}</span><span>{companionAttachmentSize(attachment.size)}</span></header>
    {failed ? <p className="companions-media-error" role="status"><Icon name="broken-file" />此媒体暂时无法播放，可在文件位置查看原件。</p> : kind === 'audio'
      ? <audio ref={element => { media.current = element; }} controls preload="metadata" src={source} aria-label={`播放音频：${attachment.name}`} onError={() => setFailed(true)} />
      : <video ref={element => { media.current = element; }} controls playsInline preload="metadata" src={source} aria-label={`播放视频：${attachment.name}`} onError={() => setFailed(true)} />}
    <footer><strong title={attachment.name}>{attachment.name}</strong><button type="button" aria-label={`查看文件位置：${attachment.name}`} onClick={() => onOpen(attachment)}><Icon name="folder" /><span>文件位置</span></button></footer>
  </section>;
}

export function CompanionAttachments({ attachments, onOpen }: {
  attachments: readonly CompanionAttachment[];
  onOpen: (attachment: CompanionAttachment, images?: readonly CompanionAttachment[]) => void;
}) {
  const images = attachments.filter(attachment => companionAttachmentKind(attachment) === 'image');
  return <div className="companions-message-attachments">
    {!!images.length && <div className={`companions-attachment-images${images.length === 1 ? ' is-single' : ''}`} aria-label={`${images.length} 张图片`}>{images.map(attachment => <button type="button" className="companions-attachment is-image" key={attachment.id} onClick={() => onOpen(attachment, images)} aria-label={`预览图片：${attachment.name}`}><img loading="lazy" src={companionAttachmentSource(attachment)} alt={attachment.name} /><span><strong>{attachment.name}</strong><small>{companionAttachmentSize(attachment.size)} · 查看大图</small></span></button>)}</div>}
    {attachments.filter(attachment => companionAttachmentKind(attachment) !== 'image').map(attachment => {
      const kind = companionAttachmentKind(attachment);
      return kind === 'audio' || kind === 'video' ? <MediaAttachment key={attachment.id} attachment={attachment} onOpen={onOpen} />
        : <button type="button" className={`companions-attachment is-${kind}`} key={attachment.id} onClick={() => onOpen(attachment)} aria-label={`查看文件位置：${attachment.name}`}><span className="companions-attachment-file-icon"><Icon name={kind === 'text' ? 'code' : 'file'} /><small>{kind === 'pdf' ? 'PDF' : kind === 'text' ? 'TEXT' : 'FILE'}</small></span><span className="companions-attachment-file-details"><strong>{attachment.name}</strong><small>{labels[kind]} · {companionAttachmentSize(attachment.size)}</small></span><Icon name="folder" /></button>;
    })}
  </div>;
}
