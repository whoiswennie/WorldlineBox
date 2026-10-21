import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { BrowserState, BrowserRequest } from '../../shared/browser';
import { BROWSER_AI_DEFAULT_CONTEXT_TOKENS } from '../../shared/browser-ai';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';
import { BrowserMarkdown } from './BrowserMarkdown';
import { BrowserSources } from './BrowserSourceCard';
import { BrowserToolTrace } from './BrowserToolTrace';
import { BrowserContextUsage } from './BrowserContextUsage';
import { SiteMark } from './BrowserBookmarks';
import brandLogo from '../../../assets/icons/startup-logo.png';

export function BrowserAiPanel({ state, run, settings, close, input, setInput }: { state: BrowserState; run(request: BrowserRequest): unknown; settings(): void; close(): void;
  input: string; setInput(value: string): void }) {
  const zh = useLocale().locale === 'zh-CN'; const task = state.ai?.task;
  const composer = useRef<HTMLTextAreaElement>(null); const conversation = useRef<HTMLDivElement>(null); const followBottom = useRef(true);
  useLayoutEffect(() => { const element = composer.current; if (element) { element.style.height = 'auto'; element.style.height = Math.min(160, element.scrollHeight) + 'px'; } }, [input]);
  const busy = task?.status === 'running' || task?.status === 'approval';
  const tab = state.tabs.find(item => item.id === state.activeTabId); const hasPage = !!tab?.url.match(/^https?:\/\//);
  let host = ''; try { if (hasPage) host = new URL(tab!.url).hostname.replace(/^www\./, ''); } catch { /* Only display validated page hosts. */ }
  const suggest = (text: string) => { setInput(text); composer.current?.focus(); };
  const send = (text: string, mode: 'followup' | 'page' = 'followup') => {
    if (!text.trim() || !state.activeTabId || busy) return;
    void run({ type: 'ai.start', tabId: state.activeTabId, mode, query: text.trim() }); setInput(''); followBottom.current = true;
  };
  useEffect(() => { if (followBottom.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight; }, [task?.answer, task?.status, task?.messages.length, task?.tools.length]);
  const open = useCallback((url: string) => { void run({ type: 'tab.new', url }); }, [run]);
  return <div className="browser-ai-chat">
    <header className="browser-ai-chat-toolbar"><img className="browser-ai-header-logo" src={brandLogo} alt="" /><div className="browser-ai-heading"><h2>{zh ? '浏览器 AI' : 'Browser AI'}</h2>
      <span title={state.ai?.config.model}><i className={'browser-ai-dot' + (state.ai?.config.hasModel ? ' is-ready' : '')} />{state.ai?.config.model || (zh ? '配置模型以开始' : 'Set up a model to begin')}</span></div>
      <div className="browser-ai-header-actions"><button type="button" title={zh ? '新会话' : 'New conversation'} aria-label={zh ? '新会话' : 'New conversation'} disabled={busy} onClick={() => { setInput(''); if (state.activeTabId) void run({ type: 'ai.clear', tabId: state.activeTabId }); }}><Icon name="plus" size={16} /></button>
      <button type="button" title={zh ? 'AI 设置' : 'AI settings'} aria-label={zh ? 'AI 设置' : 'AI settings'} onClick={settings}><Icon name="settings" size={15} /></button>
      <button type="button" title={zh ? '收起 AI 侧栏' : 'Close AI sidebar'} aria-label={zh ? '收起 AI 侧栏' : 'Close AI sidebar'} onClick={close}><Icon name="panel-right-close" size={16} /></button></div></header>
    <div className={'browser-ai-conversation' + (!task ? ' is-empty' : '')} ref={conversation} onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!task ? <div className="browser-ai-welcome"><div className="browser-ai-welcome-kicker"><span />{zh ? '你的浏览助手' : 'YOUR BROWSING ASSISTANT'}</div><h2>{zh ? '从当前页面，开始探索。' : 'Start with the page in front of you.'}</h2>
        <p>{zh ? '读懂内容、寻找答案，也可以把网页操作交给我。' : 'Understand a page, find an answer, or let me handle a browser task.'}</p>
        <div className={'browser-ai-page-preview' + (!hasPage ? ' is-blank' : '')}>
          {hasPage ? <SiteMark url={tab!.url} /> : <Icon name="globe" size={18} />}<div><small>{zh ? '当前网页' : 'CURRENT PAGE'}</small><strong title={hasPage ? tab!.title : undefined}>{hasPage ? tab!.title || host : zh ? '打开网页，或直接提问' : 'Open a page, or ask anything'}</strong>{host ? <span>{host}</span> : null}</div></div>
        <div className="browser-ai-quick-actions">
          <button type="button" onClick={() => suggest(zh ? '总结当前网页，并列出关键内容与需要核实的信息。' : 'Summarize this page and list key facts and open questions.')}><span><Icon name="file-text" size={17} /></span><strong>{zh ? '总结页面' : 'Summarize'}</strong><small>{zh ? '快速抓住核心内容' : 'Get the key ideas'}</small></button>
          <button type="button" onClick={() => suggest(zh ? '请搜索并核实以下问题，优先查阅可靠来源：' : 'Search and verify the following using reliable sources: ')}><span><Icon name="search" size={17} /></span><strong>{zh ? '搜索查证' : 'Research'}</strong><small>{zh ? '带着来源寻找答案' : 'Find answers with sources'}</small></button>
          <button type="button" onClick={() => suggest(zh ? '从当前网页提取关键信息，整理成清晰的表格。' : 'Extract the important details from this page into a clear table.')}><span><Icon name="scan-text" size={17} /></span><strong>{zh ? '提取信息' : 'Extract details'}</strong><small>{zh ? '把零散资料理清楚' : 'Organize the details'}</small></button>
          <button type="button" onClick={() => suggest(zh ? '请帮我操作当前网页：' : 'Help me with this browser task: ')}><span><Icon name="smart" size={17} /></span><strong>{zh ? '操作网页' : 'Page actions'}</strong><small>{zh ? '描述你想完成的事' : 'Describe your task'}</small></button>
        </div>
        {!state.ai?.config.hasModel ? <button type="button" className="browser-ai-setup-link" onClick={settings}><Icon name="settings" size={13} />{zh ? '配置全局模型，开始使用' : 'Set up your global model to begin'}</button> : null}</div> : <>
        {task.messages.map((message, index) => <article className={'browser-ai-message is-' + message.role} key={index}><div className="browser-ai-message-label"><span className="browser-ai-avatar">{message.role === 'user' ? <Icon name="user" size={13} /> : <img src={brandLogo} alt="" />}</span><span>{message.role === 'user' ? zh ? '你' : 'You' : 'AI'}</span></div>
          {message.role === 'assistant' ? <BrowserMarkdown text={message.content} sources={task.sources} open={open} /> : <p>{message.content}</p>}</article>)}
        {task.tools.length ? <BrowserToolTrace tools={task.tools} busy={busy} zh={zh} /> : null}
        {busy ? <article className="browser-ai-message is-assistant"><div className="browser-ai-message-label"><span className="browser-ai-avatar"><img src={brandLogo} alt="" /></span> AI <small>{task.stage}</small></div><BrowserMarkdown text={task.answer || (zh ? '正在处理…' : 'Working…')} sources={task.sources} pending={busy} open={open} /></article> : null}
        {task.approval ? <div className="browser-ai-approval"><strong>{zh ? '请确认这次网页操作' : 'Confirm this page action'}</strong><p>{task.approval.description}</p><div><button type="button" onClick={() => void run({ type: 'ai.approve', taskId: task.id, actionId: task.approval!.id, allow: false })}>{zh ? '不执行' : 'Decline'}</button><button type="button" onClick={() => void run({ type: 'ai.approve', taskId: task.id, actionId: task.approval!.id, allow: true })}>{zh ? '允许这次操作' : 'Allow this action'}</button></div></div> : null}
        {task.error ? <p className="browser-ai-error" role="alert">{task.error}</p> : null}
        {task.sources.length ? <BrowserSources sources={task.sources} open={open} zh={zh} /> : null}
      </>}
    </div>
    <form className="browser-ai-composer" onSubmit={event => { event.preventDefault(); send(input); }}>
      <div className="browser-ai-composer-context"><Icon name={hasPage ? 'globe' : 'message-circle'} size={12} /><span title={hasPage ? tab!.title : undefined}>{hasPage ? host : zh ? '自由提问' : 'Ask anything'}</span>{hasPage ? <small>{zh ? '当前网页' : 'Current page'}</small> : null}</div>
      <textarea ref={composer} aria-label={zh ? '与浏览器 AI 对话' : 'Message browser AI'} value={input} maxLength={8000} rows={2}
      placeholder={zh ? '提问，或描述你想完成的操作…' : 'Ask a question, or describe a browser task…'} onChange={event => setInput(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(input); } }} />
      <div className="browser-ai-composer-actions"><button type="button" className="browser-ai-summarize" title={zh ? '总结当前网页' : 'Summarize this page'} disabled={busy || !hasPage || !state.ai?.config.hasModel} onClick={() => send(zh ? '阅读并总结当前网页，保留关键事实及来源。' : 'Read and summarize this page with sources.', 'page')}><Icon name="file-text" size={14} /><span>{zh ? '总结' : 'Summarize'}</span></button>
        <BrowserContextUsage used={task?.contextTokensUsed ?? 0} budget={state.ai?.config.contextTokens ?? BROWSER_AI_DEFAULT_CONTEXT_TOKENS} compacted={task?.compacted ?? 0} zh={zh} settings={settings} />
        {busy ? <button type="button" className="browser-ai-send" aria-label={zh ? '停止浏览器 AI' : 'Stop browser AI'} onClick={() => task && void run({ type: 'ai.cancel', tabId: task.tabId, taskId: task.id })}>{zh ? '停止' : 'Stop'}</button>
          : <button type="submit" className="browser-ai-send" aria-label={zh ? '发送给浏览器 AI' : 'Send to browser AI'} disabled={!input.trim() || !state.ai?.config.hasModel}>{zh ? '发送' : 'Send'}</button>}</div>
    </form><div className="browser-ai-footer"><span title={zh ? '会话仅在本次使用中保留，关闭软件后清除' : 'Chat is temporary and cleared when the app closes'}><Icon name="shield" size={11} />{zh ? '临时会话' : 'Temporary chat'}</span><span>{zh ? 'Enter 发送 · Shift + Enter 换行' : 'Enter to send · Shift + Enter for a new line'}</span></div>
  </div>;
}
