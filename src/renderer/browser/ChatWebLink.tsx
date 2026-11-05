import { Children, createContext, isValidElement, useContext, type ReactNode } from 'react';
import './chat-web-link.css';

export const StandaloneChatLink = createContext(false);
function labelText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child)
    : isValidElement<{ children?: ReactNode }>(child) ? labelText(child.props.children) : '').join('');
}
export function ChatWebLink({ href, children, open, locale }: { href: string; children: ReactNode; open(url: string): void; locale: 'zh-CN' | 'en' }) {
  const standalone = useContext(StandaloneChatLink), address = new URL(href), zh = locale === 'zh-CN';
  const label = labelText(children).trim(), raw = /^https?:\/\//iu.test(label), site = address.hostname.replace(/^www\./iu, '');
  const video = /(^|\.)(bilibili\.com|youtube\.com|youtu\.be)$/iu.test(site);
  const title = raw ? video ? zh ? '视频链接' : 'Video link' : zh ? '网页链接' : 'Web link' : label;
  const path = address.pathname === '/' && !address.search ? site : address.pathname + address.search + address.hash;
  return <button type="button" className={`browser-markdown-link browser-chat-link${standalone ? ' browser-markdown-link-card' : ''}`} title={href}
    aria-label={standalone ? `${title} · ${site} · ${zh ? '在内置浏览器打开' : 'Open in built-in browser'}` : `${label} · ${href}`} onClick={() => open(href)}>
    {standalone ? <><span className="browser-link-symbol" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={video ? 'M4 5h16v14H4zM10 9l5 3-5 3z' : 'M14 3h7v7M21 3l-9 9M10 4H4v16h16v-6'} /></svg></span>
      <span className="browser-link-caption"><strong>{title}</strong><small>{path}</small><span className="browser-link-footer"><span>{site}</span><span>{zh ? '内置浏览器打开' : 'Open in browser'} <i aria-hidden="true">↗</i></span></span></span></>
      : <>{children}<span className="browser-link-inline-arrow" aria-hidden="true">↗</span></>}
  </button>;
}
