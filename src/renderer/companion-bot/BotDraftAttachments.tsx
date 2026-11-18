import { useLayoutEffect, useRef, useState } from 'react';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { AttachmentKindIcon } from './BotAttachment';
import { AttachmentExplorer } from './BotAttachmentBundle';
import { BotIcon } from './BotIcon';
import { BotMediaPreview } from './BotMediaPreview';
import { botAttachmentCategoryLabel, botAttachmentDetails, botAttachmentSummary, type BotAttachmentCategory } from './attachment-presentation';
import { formatBotFileSize } from './media-presentation';
import './bot-draft-attachments.css';

function DraftThumbnail({ src, kind }: { src?: string; kind: ReturnType<typeof botAttachmentDetails>['kind'] }) {
  const [failed, setFailed] = useState(false);
  return <span className="bot-draft-cover" data-kind={kind}>{src && !failed
    ? <img src={src} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)} />
    : <AttachmentKindIcon kind={kind} />}</span>;
}

export function BotDraftAttachments({ attachments, addingFiles, removeFile, locale, mediaApi, conversationId }: {
  attachments: readonly BotMediaRef[]; addingFiles: boolean; removeFile(id: string): void;
  locale: 'zh-CN' | 'en'; mediaApi?: WorldlineBoxBotMediaApi; conversationId: string;
}) {
  const [expanded, setExpanded] = useState(false), [selection, setSelection] = useState<{ id: string; conversationId: string }>();
  const zh = locale === 'zh-CN';
  const tray = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(2);
  useLayoutEffect(() => {
    const node = tray.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setColumns(Math.min(3, Math.max(1, Math.floor((entry.contentRect.width + 6) / 198))));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const overflow = attachments.length > columns;
  const counts = botAttachmentSummary(attachments).counts;
  const preview = selection?.conversationId === conversationId ? attachments.find(item => item.id === selection.id) : undefined;
  const previewDetails = preview && botAttachmentDetails(preview, !!mediaApi);
  const renderFile = (media: BotMediaRef) => {
    const { name, kind, extension, canPreview } = botAttachmentDetails(media, !!mediaApi);
    const label = extension === 'FILE' ? (zh ? '文件' : 'File') : extension;
    const details = <><DraftThumbnail src={media.previewUrl} kind={kind} /><span className="bot-draft-file-info">
      <strong title={name}>{name}</strong><small>{label} · {formatBotFileSize(media.size)}</small>
    </span></>;
    return <div className="bot-draft-file">
      {canPreview ? <button type="button" className="bot-draft-file-main" title={name} aria-label={`${zh ? '预览' : 'Preview'} ${name}`} onClick={() => setSelection({ id: media.id, conversationId })}>{details}</button>
        : <div className="bot-draft-file-main">{details}</div>}
      <button type="button" className="bot-draft-remove" title={zh ? '移除附件' : 'Remove attachment'}
        aria-label={`${zh ? '移除' : 'Remove'} ${name}`} onClick={() => removeFile(media.id)}><BotIcon name="close" /></button>
    </div>;
  };
  return <section ref={tray} className="bot-draft-attachments" aria-label={zh ? '待发送附件' : 'Draft attachments'}>
    <ul>
      {attachments.slice(0, columns).map(media => <li key={media.id}>{renderFile(media)}</li>)}
    </ul>
    {overflow && <div className="bot-draft-overflow"><button type="button" className="bot-draft-toggle" aria-haspopup="dialog" onClick={() => setExpanded(true)}>
      {zh ? `查看全部 ${attachments.length} 个附件` : `View all ${attachments.length} attachments`}<BotIcon name="chevron-right" />
    </button><small>{(Object.keys(counts) as BotAttachmentCategory[]).filter(type => counts[type]).map(type =>
      `${botAttachmentCategoryLabel(type, zh)} ${counts[type]}`).join(' · ')}</small></div>}
    {addingFiles && <small className="bot-draft-importing" role="status">{zh ? '正在添加文件…' : 'Adding files…'}</small>}
    {attachments.length > 16 && <small className="bot-attachment-limit" role="alert">{zh ? '每条消息最多 16 个附件，请移除多余附件后分批发送。' : 'Up to 16 attachments per message. Remove extras and send them separately.'}</small>}
    {expanded && <AttachmentExplorer media={attachments} locale={locale} title={zh ? '待发送附件' : 'Draft attachments'}
      renderItem={renderFile} onClose={() => setExpanded(false)} />}
    {preview && previewDetails?.canPreview && previewDetails.kind !== 'file' && <BotMediaPreview
      media={preview} api={mediaApi} conversationId={conversationId} locale={locale} kind={previewDetails.kind} imageUrl={previewDetails.imageUrl}
      onClose={() => setSelection(undefined)} />}
  </section>;
}
