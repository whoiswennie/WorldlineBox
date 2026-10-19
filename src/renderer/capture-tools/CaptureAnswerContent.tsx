import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon } from '../Icons';
import { useLocale } from '../i18n';
import './capture-answer-content.css';

function safeWebUrl(value: string): string {
  if (value.length > 8192) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

/** Provider output stays inert until a user explicitly opens an HTTP(S) link. */
const AnswerMarkdown = memo(function AnswerMarkdown({ text, onOpenLink, imageLabel }: {
  text: string;
  onOpenLink?: (url: string) => void;
  imageLabel: string;
}) {
  return <div className="capture-answer-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeWebUrl} components={{
    a: ({ href, children }) => href && onOpenLink
      ? <button type="button" className="capture-answer-link" title={href} onClick={() => onOpenLink(href)}>{children}</button>
      : <span>{children}</span>,
    // Model supplied images must never fetch remote URLs on their own.
    img: ({ src, alt }) => typeof src === 'string' && src && onOpenLink
      ? <button type="button" className="capture-answer-link capture-answer-image-link" title={src} onClick={() => onOpenLink(src)}><Icon name="external-link" size={13} />{alt || imageLabel}</button>
      : <span>{alt || imageLabel}</span>,
    table: ({ children }) => <div className="capture-answer-table"><table>{children}</table></div>,
    th: ({ children, align }) => <th style={{ textAlign: align === 'left' || align === 'center' || align === 'right' ? align : undefined }}>{children}</th>,
    td: ({ children, align }) => <td style={{ textAlign: align === 'left' || align === 'center' || align === 'right' ? align : undefined }}>{children}</td>,
  }}>{text}</Markdown></div>;
});

export const CaptureAnswerContent = memo(function CaptureAnswerContent({ text, reasoning = '', pending = false, onOpenLink }: {
  text: string;
  reasoning?: string;
  pending?: boolean;
  onOpenLink?: (url: string) => void;
}) {
  const zh = useLocale().locale === 'zh-CN';
  const reasoningText = reasoning.trim();
  const status = pending ? (!text.trim() ? (zh ? '正在思考…' : 'Thinking…') : (zh ? '正在输出…' : 'Writing…')) : (zh ? '已完成' : 'Complete');
  return <div className="capture-answer-content" aria-busy={pending}>
    {reasoningText ? <details className="capture-answer-reasoning">
      <summary><Icon name="sparkles" size={13} /><span>{zh ? '思考过程' : 'Reasoning'}</span><small>{status}</small><Icon name="chevron-right" size={12} /></summary>
      <div className="capture-answer-reasoning-body"><AnswerMarkdown text={reasoningText} onOpenLink={onOpenLink} imageLabel={zh ? '查看图片链接' : 'Open image link'} /></div>
    </details> : null}
    {text ? <AnswerMarkdown text={text} onOpenLink={onOpenLink} imageLabel={zh ? '查看图片链接' : 'Open image link'} /> : null}
    {pending ? <div className="capture-answer-pending" role="status"><Icon name="loader" size={12} /><span>{status}</span></div> : null}
  </div>;
});
