import { memo, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { MessageCodeBlock } from './MessageCodeBlock';
import { MessageDiagram } from './MessageDiagram';

/** CommonMark + GFM + math. Raw HTML stays inert; links are user initiated. */
export const MessageContent = memo(function MessageContent({ content, onOpenUrl }: { readonly content: string; readonly onOpenUrl?: (url: string) => void }): ReactNode {
  const url = (value: string): string => {
    if (value.startsWith('#')) return value;
    try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''; }
    catch { return ''; }
  };
  return <div className="companions-message-content"><Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false, maxExpand: 1000 }]]} urlTransform={url}
    components={{
      pre: ({ children }) => <>{children}</>,
      code: ({ className, children }) => {
        const source = String(children), language = /language-([^\s]+)/.exec(className ?? '')?.[1];
        if (!language && !source.includes('\n')) return <code>{children}</code>;
        const code = source.replace(/\n$/u, '');
        return language?.toLowerCase() === 'mermaid' ? <MessageDiagram source={code} /> : <MessageCodeBlock code={code} language={language || 'text'} />;
      },
      table: ({ children }) => <div className="companions-message-table"><table>{children}</table></div>,
      th: ({ children, style, align }) => <th style={{ ...style, textAlign: align === 'center' || align === 'left' || align === 'right' ? align : style?.textAlign }}>{children}</th>,
      td: ({ children, style, align }) => <td style={{ ...style, textAlign: align === 'center' || align === 'left' || align === 'right' ? align : style?.textAlign }}>{children}</td>,
      a: ({ href, children }) => !href ? <span>{children}</span> : href.startsWith('#') ? <a href={href}>{children}</a>
        : onOpenUrl ? <button type="button" className="companions-message-link" title={href} onClick={() => onOpenUrl(href)}>{children}</button> : <span className="companions-message-link">{children}</span>,
      img: ({ src, alt }) => typeof src !== 'string' || !src ? <span>{alt}</span> : onOpenUrl ? <button type="button" className="companions-message-link" title={src} onClick={() => onOpenUrl(src)}>{alt || '查看图片'}</button> : <span>{alt}</span>,
    }}>{content}</Markdown></div>;
});
