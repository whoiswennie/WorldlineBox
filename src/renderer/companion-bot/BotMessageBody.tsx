import { useEffect, useId, useRef, useState } from 'react';
import type { BotMessage } from '../../shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BrowserMarkdown } from '../browser/BrowserMarkdown';
import { AttachmentKindIcon, BotAttachment } from './BotAttachment';
import { BotAttachmentBundle } from './BotAttachmentBundle';
import { botAttachmentCategoryLabel, botAttachmentDetails, botAttachmentSummary, type BotAttachmentCategory } from './attachment-presentation';
import { formatBotFileSize } from './media-presentation';
import './bot-message-body.css';
import { BotVoiceMessage } from './BotVoiceMessage';
import { BotExecutionDetails, type BotExecutionAnswer, type BotExecutionContinue } from './BotExecutionDetails';
import {botReplyDisplayParts} from '../../shared/companion-bot-reply';

const ignoreLink = () => undefined;
interface Props { message: BotMessage; streamedText?: string; statusText: string; locale: 'zh-CN' | 'en'; mediaApi?: WorldlineBoxBotMediaApi; onOpenUrl?(url: string): void; onAnswer?: BotExecutionAnswer; onContinue?: BotExecutionContinue;embedded?:boolean }
export function BotMessageBody(props: Props) {
  return <MessageBody key={`${props.message.conversationId}:${props.message.id}`} {...props} />;
}
function MessageBody({ message, streamedText, statusText, locale, mediaApi, onOpenUrl = ignoreLink, onAnswer, onContinue,embedded=false }: Props) {
  const zh = locale === 'zh-CN', pending = ['queued', 'running'].includes(message.status), [expanded, setExpanded] = useState(false), id = useId(), contents = useRef<HTMLDivElement>(null);
  const hasText = !!message.content || !!streamedText || ['failed', 'cancelled'].includes(message.status);
  const text = (pending && streamedText) || message.content || statusText;
  const attachments = message.attachments ?? [];
  const stickers = attachments.filter(media => media.kind === 'sticker' && botAttachmentDetails(media).policy.previewEligibility === 'inline');
  const voices = attachments.filter(media => !!media.voice && media.mimeType === 'audio/wav');
  const files = attachments.filter(media => !stickers.includes(media) && !voices.includes(media));
  const collapsible = files.length > 1, summary = botAttachmentSummary(files);
  const common = { api: mediaApi, conversationId: message.conversationId, locale, onOpenUrl };
  useEffect(() => {
    if (!expanded || !contents.current) return;
    const bubble = contents.current.closest('.bot-message-bubble'), transcript = contents.current.closest('.bot-transcript');
    const target = bubble && transcript && bubble.getBoundingClientRect().height <= transcript.clientHeight ? bubble : contents.current;
    target.scrollIntoView?.({ block: 'nearest' });
  }, [expanded]);
  const parts=botReplyDisplayParts(message.parts??[]);
  if(parts.length){
    const covered=new Set(parts.flatMap(part=>part.attachments?.map(file=>file.id)??[])),remaining=attachments.filter(file=>!covered.has(file.id));
    const draft=pending&&streamedText&&!parts.some(part=>part.text===streamedText)?streamedText:undefined;
    const stickerOnly=!pending&&parts.every(part=>part.kind==='media'&&!part.text&&part.attachments?.every(file=>file.kind==='sticker'));
    return <div className={`bot-message-bubble bot-message-ordered${stickerOnly?' is-inline-media-only':''}`}>
      {message.execution&&!stickerOnly&&<BotExecutionDetails execution={message.execution} locale={locale} onAnswer={onAnswer} onContinue={onContinue}/>}
      {parts.map(part=><section className="bot-reply-part" key={part.id} data-reply-kind={part.kind} data-native-order={part.sequence}>
        <MessageBody embedded message={{...message,id:message.id+':'+part.id,status:'sent',parts:undefined,execution:undefined,content:part.text??'',attachments:part.attachments??[]}} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} statusText=""/>
      </section>)}
      {!!remaining.length&&<MessageBody embedded message={{...message,parts:undefined,execution:undefined,status:'sent',content:'',attachments:remaining}} locale={locale} mediaApi={mediaApi} onOpenUrl={onOpenUrl} statusText=""/>}
      {draft&&<div className="bot-message-text bot-reply-draft"><BrowserMarkdown text={draft} pending open={onOpenUrl} linkAppearance="chat" locale={locale}/></div>}
    </div>;
  }
  if (!hasText && !attachments.length && !message.execution) return null;
  return <div className={`${embedded?'bot-message-part':'bot-message-bubble'}${files.length ? ' has-file-summary' : ''}${expanded ? ' is-expanded-files' : ''}${expanded && files.length >= 3 ? ' is-expanded-bundle' : ''}${!hasText && !files.length && !message.execution ? ' is-inline-media-only' : ''}${!hasText && files.length === 1 && !stickers.length && !message.execution ? ' is-single-file-only' : ''}`}>
    {message.execution && <BotExecutionDetails execution={message.execution} locale={locale} onAnswer={onAnswer} onContinue={onContinue} />}
    {hasText && <div className="bot-message-text">{message.senderId === 'user' ? message.content || statusText : <BrowserMarkdown text={text} pending={pending} open={onOpenUrl} linkAppearance="chat" locale={locale} />}</div>}
    {voices.map(media => <BotVoiceMessage key={media.id} media={media} conversationId={message.conversationId} locale={locale} />)}
    {files.length === 1 && <div className="bot-message-single-file"><BotAttachment media={files[0]!} {...common} /></div>}
    {collapsible && <div className="bot-message-file-section">
      <button className="bot-message-file-toggle" type="button" aria-expanded={expanded} aria-controls={id} aria-label={zh ? `${expanded ? '收起' : '展开'} ${files.length} 个附件` : `${expanded ? 'Collapse' : 'Expand'} ${files.length} attachments`} onClick={() => setExpanded(value => !value)}>
        <span className="bot-message-file-icon"><AttachmentKindIcon kind={files.length > 1 ? 'bundle' : botAttachmentDetails(files[0]!).kind} /></span>
        <span className="bot-message-file-summary"><strong title={files.length === 1 ? botAttachmentDetails(files[0]!).name : undefined}>{files.length === 1 ? botAttachmentDetails(files[0]!).name : zh ? `${files.length} 个附件` : `${files.length} attachments`}</strong><small>{files.length === 1 ? `${botAttachmentCategoryLabel(botAttachmentDetails(files[0]!).category, zh)} · ` : (Object.keys(summary.counts) as BotAttachmentCategory[]).filter(kind => summary.counts[kind]).map(kind => `${botAttachmentCategoryLabel(kind, zh)} ${summary.counts[kind]}`).join(' · ') + ' · '}{formatBotFileSize(summary.bytes)}</small></span>
        <span className="bot-message-file-affordance">{expanded ? zh ? '收起' : 'Collapse' : zh ? '展开' : 'Expand'}<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d={expanded ? 'M5 12l5-5 5 5' : 'M5 8l5 5 5-5'} /></svg></span>
      </button>
      <div className="bot-message-attachments bot-message-expanded-files" id={id} ref={contents} hidden={!expanded}>{expanded && <BotAttachmentBundle media={files} {...common} />}</div>
    </div>}
    {!!stickers.length && <div className="bot-message-attachments bot-message-inline-stickers">{stickers.map(media => <BotAttachment key={media.id} media={media} {...common} />)}</div>}
  </div>;
}
