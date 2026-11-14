import { useId, useState } from 'react';
import type { BotMediaRef, WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { AttachmentKindIcon } from './BotAttachment';
import { BotIcon } from './BotIcon';
import { BotMediaPreview } from './BotMediaPreview';
import { botAttachmentDetails } from './attachment-presentation';
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
  const id = useId(), zh = locale === 'zh-CN';
  const overflow = attachments.length > 2;
  const preview = selection?.conversationId === conversationId ? attachments.find(item => item.id === selection.id) : undefined;
  const previewDetails = preview && botAttachmentDetails(preview, !!mediaApi);
  const visible = expanded ? attachments : attachments.slice(0, 2);
  return <section className="bot-draft-attachments" aria-label={zh ? '待发送附件' : 'Draft attachments'}>
    <ul id={id} className={expanded && overflow ? 'is-expanded' : ''} tabIndex={expanded && overflow ? 0 : undefined}>
      {visible.map(media => {
        const { name, kind, extension, canPreview } = botAttachmentDetails(media, !!mediaApi);
        const label = extension === 'FILE' ? (zh ? '文件' : 'File') : extension;
        const details = <><DraftThumbnail src={media.previewUrl} kind={kind} /><span className="bot-draft-file-info">
          <strong title={name}>{name}</strong><small>{label} · {formatBotFileSize(media.size)}</small>
        </span></>;
        return <li key={media.id} className="bot-draft-file">
          {canPreview ? <button type="button" className="bot-draft-file-main" title={name} aria-label={`${zh ? '预览' : 'Preview'} ${name}`} onClick={() => setSelection({ id: media.id, conversationId })}>{details}</button>
            : <div className="bot-draft-file-main">{details}</div>}
          <button type="button" className="bot-draft-remove" title={zh ? '移除附件' : 'Remove attachment'}
            aria-label={`${zh ? '移除' : 'Remove'} ${name}`} onClick={() => removeFile(media.id)}><BotIcon name="close" /></button>
        </li>;
      })}
    </ul>
    {overflow && <button type="button" className="bot-draft-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      {expanded ? (zh ? '收起附件' : 'Collapse attachments') : (zh ? `查看全部 ${attachments.length} 个附件` : `View all ${attachments.length} attachments`)}<BotIcon name="chevron-down" />
    </button>}
    {addingFiles && <small className="bot-draft-importing" role="status">{zh ? '正在添加文件…' : 'Adding files…'}</small>}
    {attachments.length > 16 && <small className="bot-attachment-limit" role="alert">{zh ? '每条消息最多 16 个附件，请移除多余附件后分批发送。' : 'Up to 16 attachments per message. Remove extras and send them separately.'}</small>}
    {preview && previewDetails?.canPreview && previewDetails.kind !== 'file' && <BotMediaPreview
      media={preview} api={mediaApi} conversationId={conversationId} locale={locale} kind={previewDetails.kind} imageUrl={previewDetails.imageUrl}
      onClose={() => setSelection(undefined)} />}
  </section>;
}
