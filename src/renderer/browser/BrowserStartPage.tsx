import { useState } from 'react';
import type { BrowserState } from '../../shared/browser';
import type { BrowserAiRequest } from '../../shared/browser-ai';
import { Icon, type IconName } from '../Icons';
import { useLocale } from '../i18n';
import { BrowserSourceCard } from './BrowserSourceCard';
import brandLogo from '../../../assets/icons/startup-logo.png';

export function BrowserStartPage({ state, navigate, start, settings }: { state: BrowserState; navigate(url: string): void;
  start(mode: Extract<BrowserAiRequest, { type: 'ai.start' }>['mode'], query: string): void; settings(): void }) {
  const zh = useLocale().locale === 'zh-CN';
  const [query, setQuery] = useState(''); const [mode, setMode] = useState<'browse' | 'search' | 'research' | 'fetch'>('search');
  const page = state.ai?.page; const working = ['running', 'approval'].includes(state.ai?.task?.status ?? '');
  const submit = () => { if (!query.trim()) return; if (mode === 'browse') navigate(query.trim()); else start(mode, query.trim()); };
  const modes: Array<{ id: typeof mode; title: string; icon: IconName }> = zh ? [{ id: 'search', title: '网页搜索', icon: 'search' }, { id: 'research', title: 'AI 联网研究', icon: 'sparkles' },
    { id: 'fetch', title: '抓取阅读', icon: 'file-text' }, { id: 'browse', title: '直接浏览', icon: 'globe' }]
    : [{ id: 'search', title: 'Web search', icon: 'search' }, { id: 'research', title: 'AI research', icon: 'sparkles' }, { id: 'fetch', title: 'Fetch & read', icon: 'file-text' }, { id: 'browse', title: 'Browse', icon: 'globe' }];
  return <div className={'browser-start' + (page ? ' has-results' : '')}>
    <header className="browser-start-masthead"><span><img className="browser-brand-mark" src={brandLogo} alt="" /> WORLDLINEBOX <b>Browser</b></span>
      <button type="button" onClick={settings}><span className={'browser-ai-dot' + (state.ai?.config.hasSearchKey ? ' is-ready' : '')} />{state.ai?.config.hasSearchKey ? 'DeepSeek Search' : zh ? '配置 AI 搜索' : 'Set up AI search'}<Icon name="settings" size={14} /></button>
    </header>
    <div className="browser-start-content">
      {!page ? <div className="browser-start-intro"><span className="browser-start-symbol"><img src={brandLogo} alt="WorldlineBox" /></span>
        <p>{zh ? '从一个问题，发现更多。' : 'A question opens a world.'}</p><h1>{zh ? '探索网络，连接思考。' : 'Explore. Understand. Connect.'}</h1>
        <span>{zh ? '原生搜索、网页阅读与 AI，一起留在你的浏览器里。' : 'Search, read and think with AI, right in your browser.'}</span></div> : null}
      <form className="browser-start-search" onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="browser-start-modes" aria-label={zh ? '搜索方式' : 'Search mode'}>{modes.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id}
          onClick={() => setMode(item.id)}><Icon name={item.icon} size={15} />{item.title}</button>)}</div>
        <div className="browser-start-input"><Icon name={mode === 'research' ? 'sparkles' : mode === 'fetch' ? 'link' : 'search'} size={21} />
          <input aria-label={zh ? '开始探索' : 'Start exploring'} value={query} maxLength={mode === 'search' ? 128 : 8000} onChange={event => setQuery(event.target.value)}
            placeholder={mode === 'fetch' ? zh ? '粘贴网页链接，提取可阅读的正文…' : 'Paste a page URL to read its content…' : mode === 'research' ? zh ? '提出问题，让 AI 搜索、阅读并核实来源…' : 'Ask AI to search, read and verify sources…' : zh ? '搜索你想了解的内容…' : 'What would you like to explore?'} />
          <button type="submit" aria-label={zh ? '开始' : 'Go'} disabled={!query.trim() || working && mode !== 'browse'}>{working && mode !== 'browse' ? <Icon name="loader" size={17} /> : (zh ? mode === 'research' ? '研究' : mode === 'fetch' ? '抓取' : mode === 'browse' ? '前往' : '搜索' : mode === 'research' ? 'Ask AI' : mode === 'fetch' ? 'Fetch' : mode === 'browse' ? 'Go' : 'Search')}</button>
        </div><div className="browser-start-search-note"><span>{mode === 'research' ? zh ? '全局模型 · 可多轮追问 · 实际工具执行' : 'Global model · Follow-up chat · Real tools'
          : mode === 'fetch' ? zh ? 'DeepSeek Fetch · Markdown 正文' : 'DeepSeek Fetch · Markdown content' : mode === 'search' ? zh ? 'DeepSeek Search · 支持站点、语言与日期筛选语法' : 'DeepSeek Search · Domain, language and date operators' : zh ? '使用浏览器默认搜索引擎' : 'Uses your default search engine'}</span><kbd>Enter ↵</kbd></div>
      </form>
      {state.ai?.task?.error && ['search', 'fetch'].includes(state.ai.task.mode) ? <p className="browser-ai-error" role="alert">{state.ai.task.error}</p> : null}
      {!page ? <div className="browser-start-features"><article><Icon name="search" size={19} /><strong>{zh ? '找到可信来源' : 'Find the source'}</strong><p>{zh ? '筛选站点与时间，搜索结果可以直接打开。' : 'Filter domains and dates. Open real results.'}</p></article>
          <article><Icon name="file-text" size={19} /><strong>{zh ? '把网页读清楚' : 'Read with clarity'}</strong><p>{zh ? '提取正文、整理要点，区分摘要与原文。' : 'Extract content and distinguish snippets from pages.'}</p></article>
          <article><Icon name="sparkles" size={19} /><strong>{zh ? '边浏览，边思考' : 'Think as you browse'}</strong><p>{zh ? '右侧 AI 可以操作网页，执行过程清晰可见。' : 'The sidebar assistant acts on real pages, visibly.'}</p></article></div> :
        <section className="browser-search-results" aria-label={zh ? '原生搜索结果' : 'Native search results'}><header><div><span>{zh ? '探索结果' : 'RESULTS'}</span><h1>{page.query}</h1></div><small>{page.sources.length} {zh ? '个来源' : 'sources'}</small></header>
          {!page.sources.length ? <p className="browser-ai-empty">{zh ? '没有找到结果。试着缩短搜索词或调整站点、时间筛选。' : 'No results. Try broader terms or different filters.'}</p> : page.sources.map(source => <BrowserSourceCard key={source.id} source={source} open={navigate} zh={zh} />)}
        </section>}
      <footer className="browser-start-footer"><Icon name="shield" size={13} />{zh ? '由你决定搜索什么、打开什么。登录与浏览数据保存在独立的本机资料中。' : 'You choose what to search and open. Browsing data stays in your local profile.'}</footer>
    </div>
  </div>;
}
