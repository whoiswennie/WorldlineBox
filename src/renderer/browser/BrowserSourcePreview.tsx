import Markdown from 'react-markdown';

/** Search providers return a mixture of legacy HTML and Markdown. Extract
 * inert text first; never mount provider HTML or load its images/links. */
export function sourcePreviewText(value: string): string {
  let text = value.slice(0, 6000);
  for (let pass = 0; pass < 2; pass++) {
    // Template contents are inert: no scripts, subframes or image downloads.
    // Never attach this tree to a document; only extract text, which React
    // escapes and the inline Markdown renderer treats as non-HTML content.
    const template = document.createElement('template');
    template.innerHTML = text.replace(/<\/(?:p|div|h[1-6]|li)>|<br\s*\/?\s*>/gi, '\n');
    template.content.querySelectorAll('script,style,template,noscript,iframe,object,embed,svg,math').forEach(node => node.remove());
    text = template.content.textContent ?? '';
  }
  return text.replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '').replace(/\s+/g, ' ').trim();
}

export function sourcePreviewDate(value: string | undefined, zh: boolean): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return;
  const date = new Date(value); if (!Number.isFinite(date.getTime())) return;
  return new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric',
    ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? { timeZone: 'UTC' } : {}) }).format(date);
}

/** Compact inline typography for previews; full page Markdown stays in the
 * explicit reader. Nested links, images and blocks cannot change card layout. */
export function BrowserSourcePreview({ text }: { text: string }) {
  return <Markdown skipHtml allowedElements={['p', 'strong', 'em', 'del', 'code']} unwrapDisallowed components={{
    p: ({ children }) => <span>{children}</span>,
  }}>{text}</Markdown>;
}
