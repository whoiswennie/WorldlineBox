import { useEffect, useId, useRef, useState } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BrowserMarkdown } from '../browser/BrowserMarkdown';
import { AttachmentKindIcon, BotAttachment } from './BotAttachment';
import { BotAttachmentBundle } from './BotAttachmentBundle';
import { botAttachmentCategoryLabel, botAttachmentDetails, botAttachmentSummary, type BotAttachmentCategory } from './attachment-presentation';
import { formatBotFileSize } from './media-presentation';
import './bot-message-body.css';

const ignoreLink = () => undefined;
interface Props { message: BotMessage; streamedText?: string; statusText: string; locale: 'zh-CN' | 'en'; mediaApi?: WorldlineBoxBotMediaApi; onOpenUrl?(url: string): void }
export function BotMessageBody(props: Props) {
  return <MessageBody key={`${props.message.conversationId}:${props.message.id}`} {...props} />;
}
function MessageBody({ message, streamedText, statusText, locale, mediaApi, onOpenUrl = ignoreLink }: Props) {
  const zh = locale === 'zh-CN', pending = ['queued', 'running'].includes(message.status), [expanded, setExpanded] = useState(false), id = useId(), contents = useRef<HTMLDivElement>(null);
  const hasText = !!message.content || !!streamedText || ['failed', 'cancelled'].includes(message.status);
  const text = (pending && streamedText) || message.content || statusText;
  const attachments = message.attachments ?? [];
  const stickers = attachments.filter(media => media.kind === 'sticker' && botAttachmentDetails(media).policy.previewEligibility === 'inline');
  const files = attachments.filter(media => !stickers.includes(media));
  const collapsible = files.length > 0, summary = botAttachmentSummary(files);
  const common = { api: mediaApi, conversationId: message.conversationId, locale, onOpenUrl };
  useEffect(() => {
    if (!expanded || !contents.current) return;
    const bubble = contents.current.closest('.bot-message-bubble'), transcript = contents.current.closest('.bot-transcript');
    const target = bubble && transcript && bubble.getBoundingClientRect().height <= transcript.clientHeight ? bubble : contents.current;
    target.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);
  if (!hasText && !attachments.length) return null;
  return <div className={`bot-message-bubble${collapsible ? ' has-file-summary' : ''}${expanded ? ' is-expanded-files' : ''}${expanded && files.length >= 3 ? ' is-expanded-bundle' : ''}${!hasText && !collapsible ? ' is-inline-media-only' : ''}`}>
    {hasText && <div className="bot-message-text">{message.senderId === 'user' ? message.content || statusText : <BrowserMarkdown text={text} pending={pending} open={onOpenUrl} />}</div>}
    {collapsible && <div className="bot-message-file-section">
      <button className="bot-message-file-toggle" type="button" aria-expanded={expanded} aria-controls={id} aria-label={zh ? `${expanded ? '收起' : '展开'} ${files.length} 个附件` : `${expanded ? 'Collapse' : 'Expand'} ${files.length} attachments`} onClick={() => setExpanded(value => !value)}>
        <span className="bot-message-file-icon"><AttachmentKindIcon kind={files.length > 1 ? 'bundle' : botAttachmentDetails(files[0]!).kind} /></span>
        <span className="bot-message-file-summary"><strong>{zh ? `${files.length} 个附件` : `${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}`}<i />{formatBotFileSize(summary.bytes)}</strong><small>{(Object.keys(summary.counts) as BotAttachmentCategory[]).filter(kind => summary.counts[kind]).map(kind => `${botAttachmentCategoryLabel(kind, zh)} ${summary.counts[kind]}`).join(' · ')}</small></span>
        <span className="bot-message-file-affordance">{expanded ? zh ? '收起' : 'Collapse' : zh ? '展开' : 'Expand'}<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? 'M5 12l5-5 5 5' : 'M5 8l5 5 5-5'} /></svg></span>
      </button>
      <div className="bot-message-attachments bot-message-expanded-files" id={id} ref={contents} hidden={!expanded}>{expanded && <BotAttachmentBundle media={files} {...common} />}</div>
    </div>}
    {!!stickers.length && <div className="bot-message-attachments bot-message-inline-stickers">{stickers.map(media => <BotAttachment key={media.id} media={media} {...common} />)}</div>}
  </div>;
}
