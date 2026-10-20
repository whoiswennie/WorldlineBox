import { memo, useId } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { MessageCodeBlock } from '../companions/MessageCodeBlock';
import { MessageDiagram } from '../companions/MessageDiagram';
import './browser-markdown.css';
import type { BrowserAiSource } from '../../shared/browser-ai';

/** Full CommonMark/GFM, math, highlighted code and deferred safe Mermaid. */
export const BrowserMarkdown = memo(function BrowserMarkdown({ text, pending = false, open, sources = [] }: {
  text: string; pending?: boolean; open(url: string): void; sources?: BrowserAiSource[];
}) {
  const prefix = useId().replace(/[^a-z0-9]/gi, '') + '-browser-';
  const url = (value: string) => {
    if (value.startsWith('#')) return value;
    try { const parsed = new URL(value); return value.length <= 8192 && ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : ''; } catch { return ''; }
  };
  return <div className="browser-markdown" onClick={event => {
    const anchor = (event.target as Element).closest('a[href^="#"]');
    if (!anchor) return; event.preventDefault();
    try { const id = decodeURIComponent(anchor.getAttribute('href')!.slice(1)); event.currentTarget.querySelector('#' + CSS.escape(id))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* Invalid fragment is inert. */ }
  }}><Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]} remarkRehypeOptions={{ clobberPrefix: prefix }}
    rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false, maxExpand: 1000 }]]} urlTransform={url} components={{
      pre: ({ children }) => <>{children}</>,
      code: ({ className, children }) => {
        const source = String(children), language = /language-([^\s]+)/.exec(className ?? '')?.[1];
        if (!language && !source.includes('\n')) return <code>{children}</code>;
        const code = source.replace(/\n$/, '');
        return language?.toLowerCase() === 'mermaid' && !pending ? <MessageDiagram source={code} /> : <MessageCodeBlock code={code} language={language || 'text'} />;
      },
      table: ({ children }) => <div className="browser-markdown-table"><table>{children}</table></div>,
      a: ({ href, children }) => {
        if (!href) return <span>{children}</span>;
        if (href.startsWith('#')) return <a href={href}>{children}</a>;
        const source = sources.find(source => source.url === href && String(source.id) === String(children));
        return <button type="button" className={source ? 'browser-markdown-link browser-citation' : 'browser-markdown-link'} title={source ? `${source.title}\n${source.url}` : href}
          aria-label={source ? `${source.id} · ${source.title}` : undefined} onClick={() => open(href)}>{children}</button>;
      },
      img: ({ src, alt }) => typeof src === 'string' && src ? <button type="button" className="browser-markdown-link" title={src} onClick={() => open(src)}>{alt || src}</button> : <span>{alt}</span>,
    }}>{text}</Markdown></div>;
}, (previous, next) => previous.text === next.text && previous.pending === next.pending && previous.open === next.open
  && (previous.sources?.length ?? 0) === (next.sources?.length ?? 0)
  && (previous.sources ?? []).every((source, index) => {
    const other = next.sources?.[index]; return other?.id === source.id && other.url === source.url && other.title === source.title;
  }));
