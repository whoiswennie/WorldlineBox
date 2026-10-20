import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BrowserState, BrowserRequest } from '../../shared/browser';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';
import { BrowserMarkdown } from './BrowserMarkdown';
import { BrowserSources } from './BrowserSourceCard';
import { BrowserToolTrace } from './BrowserToolTrace';
import brandLogo from '../../../assets/icons/startup-logo.png';

export function BrowserAiPanel({ state, run, settings }: { state: BrowserState; run(request: BrowserRequest): unknown; settings(): void }) {
  const zh = useLocale().locale === 'zh-CN'; const task = state.ai?.task;
  const [input, setInput] = useState(''); const composer = useRef<HTMLTextAreaElement>(null); const conversation = useRef<HTMLDivElement>(null); const followBottom = useRef(true);
  useLayoutEffect(() => { const element = composer.current; if (element) { element.style.height = 'auto'; element.style.height = Math.min(180, element.scrollHeight) + 'px'; } }, [input]);
  const busy = task?.status === 'running' || task?.status === 'approval';
  const send = (text: string, mode: 'followup' | 'page' = 'followup') => {
    if (!text.trim() || !state.activeTabId || busy) return;
    void run({ type: 'ai.start', tabId: state.activeTabId, mode, query: text.trim() }); setInput(''); followBottom.current = true;
  };
  useEffect(() => { if (followBottom.current && conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight; }, [task?.answer, task?.status, task?.messages.length, task?.tools.length]);
  const open = useCallback((url: string) => { void run({ type: 'tab.new', url }); }, [run]);
  return <div className="browser-ai-chat">
    <div className="browser-ai-chat-toolbar"><span className={'browser-ai-dot' + (state.ai?.config.hasModel ? ' is-ready' : '')} /><span title={state.ai?.config.model}>{state.ai?.config.model || (zh ? '未配置全局模型' : 'No global model')}</span>
      <button type="button" title={zh ? '新会话' : 'New conversation'} aria-label={zh ? '新会话' : 'New conversation'} disabled={busy} onClick={() => state.activeTabId && void run({ type: 'ai.clear', tabId: state.activeTabId })}><Icon name="plus" size={16} /></button>
      <button type="button" title={zh ? 'AI 设置' : 'AI settings'} aria-label={zh ? 'AI 设置' : 'AI settings'} onClick={settings}><Icon name="settings" size={15} /></button></div>
    <div className="browser-ai-conversation" ref={conversation} onScroll={event => { const element = event.currentTarget; followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>
      {!task ? <div className="browser-ai-welcome"><span><img className="browser-brand-mark" src={brandLogo} alt="WorldlineBox" /></span><h2>{zh ? '一起，把网页看明白。' : 'Make sense of the web.'}</h2>
        <p>{zh ? '提问、查证、比较，也可以让我操作左侧的浏览器。每次执行都有记录。' : 'Ask, verify, compare, or let me operate the browser on the left. Every tool action is visible.'}</p>
        <button type="button" onClick={() => send(zh ? '总结当前网页，并列出关键内容与需要核实的信息。' : 'Summarize this page and list key facts and open questions.', 'page')}><Icon name="file-text" size={16} />{zh ? '总结当前网页' : 'Summarize this page'}</button>
        <button type="button" onClick={() => send(zh ? '请解释你的浏览器工具、搜索语法和操作范围。' : 'Explain your browser tools, search syntax and scope.')}><Icon name="search" size={16} />{zh ? '了解搜索与操作能力' : 'Explore browser tools'}</button>
        {!state.ai?.config.hasModel || !state.ai.config.hasSearchKey ? <button type="button" onClick={settings}><Icon name="settings" size={16} />{zh ? '配置模型与搜索服务' : 'Set up model & search'}</button> : null}</div> : <>
        {task.messages.map((message, index) => <article className={'browser-ai-message is-' + message.role} key={index}><div className="browser-ai-message-label"><span className="browser-ai-avatar">{message.role === 'user' ? <Icon name="user" size={13} /> : <img src={brandLogo} alt="" />}</span><span>{message.role === 'user' ? zh ? '你' : 'You' : 'AI'}</span></div>
          {message.role === 'assistant' ? <BrowserMarkdown text={message.content} sources={task.sources} open={open} /> : <p>{message.content}</p>}</article>)}
        {task.tools.length ? <BrowserToolTrace tools={task.tools} busy={busy} zh={zh} /> : null}
        {busy ? <article className="browser-ai-message is-assistant"><div className="browser-ai-message-label"><span className="browser-ai-avatar"><img src={brandLogo} alt="" /></span> AI <small>{task.stage}</small></div><BrowserMarkdown text={task.answer || (zh ? '正在处理…' : 'Working…')} sources={task.sources} pending={busy} open={open} /></article> : null}
        {task.approval ? <div className="browser-ai-approval"><strong>{zh ? '请确认这次网页操作' : 'Confirm this page action'}</strong><p>{task.approval.description}</p><div><button type="button" onClick={() => void run({ type: 'ai.approve', taskId: task.id, actionId: task.approval!.id, allow: false })}>{zh ? '不执行' : 'Decline'}</button><button type="button" onClick={() => void run({ type: 'ai.approve', taskId: task.id, actionId: task.approval!.id, allow: true })}>{zh ? '允许这次操作' : 'Allow this action'}</button></div></div> : null}
        {task.error ? <p className="browser-ai-error" role="alert">{task.error}</p> : null}
        {task.sources.length ? <BrowserSources sources={task.sources} open={open} zh={zh} /> : null}
        {task.compacted ? <p className="browser-ai-memory-note"><Icon name="layers" size={12} />{zh ? `已压缩 ${task.compacted} 次早期上下文；网页状态以实时观察为准。` : `Earlier context compacted ${task.compacted} times. Page state comes from live observations.`}</p> : null}
      </>}
    </div>
    <form className="browser-ai-composer" onSubmit={event => { event.preventDefault(); send(input); }}><textarea ref={composer} aria-label={zh ? '与浏览器 AI 对话' : 'Message browser AI'} value={input} maxLength={8000} rows={3}
      placeholder={zh ? '提问，或告诉我想在网页上做什么…' : 'Ask a question, or tell me what to do on the page…'} onChange={event => setInput(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(input); } }} />
      <div><button type="button" disabled={busy} onClick={() => send(zh ? '阅读并总结当前网页，保留关键事实及来源。' : 'Read and summarize this page with sources.', 'page')}><Icon name="file-text" size={13} />{zh ? '总结网页' : 'Summarize'}</button>
        <span title={zh ? '包含工具说明、对话和网页资料的保守估算；另外保留模型回复空间' : 'Conservative estimate including tools, chat and evidence; output capacity is reserved separately'}>≈{Math.ceil(task?.contextTokensUsed ?? 0).toLocaleString()} / {(state.ai?.config.contextTokens ?? 16000).toLocaleString()}</span>
        {busy ? <button type="button" className="browser-ai-send" aria-label={zh ? '停止浏览器 AI' : 'Stop browser AI'} onClick={() => task && void run({ type: 'ai.cancel', tabId: task.tabId, taskId: task.id })}>{zh ? '停止' : 'Stop'}</button>
          : <button type="submit" className="browser-ai-send" aria-label={zh ? '发送给浏览器 AI' : 'Send to browser AI'} disabled={!input.trim() || !state.ai?.config.hasModel}>{zh ? '发送' : 'Send'}</button>}</div>
    </form><p className="browser-ai-footer">{zh ? '临时会话 · 关闭软件后清除 · 请核对来源' : 'Temporary chat · Cleared when the app closes · Verify sources'}</p>
  </div>;
}
