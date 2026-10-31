import { lazy, memo, Suspense, type ReactNode } from 'react';
import { plainMessageParagraphs } from './plain-message';

const RichMessageContent = lazy(() => import('./RichMessageContent').then(module => ({ default: module.RichMessageContent })));

/** Ordinary chat has no Markdown parser/highlighter/math startup cost. Rich
 * messages load that renderer locally while keeping their full text visible. */
export const MessageContent = memo(function MessageContent({ content, onOpenUrl }: { readonly content: string; readonly onOpenUrl?: (url: string) => void }): ReactNode {
  const paragraphs = plainMessageParagraphs(content);
  const plain = <div className="companions-message-content" data-message-format={paragraphs ? 'plain' : 'loading'}>{(paragraphs ?? content.split(/\r?\n\r?\n/gu)).map((text, index) => <p key={index}>{text}</p>)}</div>;
  return paragraphs ? plain : <Suspense fallback={plain}><RichMessageContent content={content} onOpenUrl={onOpenUrl} /></Suspense>;
});
