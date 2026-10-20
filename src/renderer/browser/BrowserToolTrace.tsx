import type { BrowserAiTask } from '../../shared/browser-ai';
import { Icon } from '../Icons';

const titles: Record<string, [string, string]> = {
  browser_search: ['搜索网页', 'Search the web'], browser_fetch: ['抓取网页正文', 'Fetch page content'], browser_source: ['查阅来源', 'Read a source'],
  browser_tabs: ['查看标签页', 'List tabs'], browser_navigate: ['打开网页', 'Open a page'], browser_observe: ['观察页面', 'Observe the page'],
  browser_read: ['阅读页面', 'Read the page'], browser_click: ['点击页面控件', 'Click a control'], browser_fill: ['填写页面', 'Fill a field'],
  browser_select: ['选择选项', 'Select an option'], browser_hover: ['查看悬停内容', 'Hover a control'], browser_key: ['使用页面按键', 'Use a page key'],
  browser_scroll: ['滚动页面', 'Scroll the page'], browser_tab: ['管理标签页', 'Manage a tab'], browser_find: ['查找页面文字', 'Find text'],
  browser_downloads: ['查看下载', 'List downloads'], browser_download_action: ['管理下载', 'Manage a download'], browser_bookmarks: ['管理收藏', 'Manage bookmarks'],
  browser_history: ['查询浏览历史', 'Find browsing history'], browser_page: ['调整页面', 'Page controls'], browser_screenshot: ['保存网页截图', 'Save a page capture'], browser_wait: ['等待页面更新', 'Wait for the page'],
};

export function BrowserToolTrace({ tools, busy, zh }: { tools: BrowserAiTask['tools']; busy: boolean; zh: boolean }) {
  return <details className="browser-ai-tool-trace" open={busy}><summary><Icon name={busy ? 'loader' : 'check'} size={14} /><span>{zh ? '浏览器执行记录' : 'Browser actions'}</span><small>{tools.length}</small></summary>
    <ol>{tools.map(tool => {
      let detail = '';
      try { const input = JSON.parse(tool.input); detail = String(input.query ?? input.url ?? (input.id ? `#${input.id}` : '')).slice(0, 180); } catch { /* Truncated arguments remain in technical details. */ }
      return <li key={tool.id} className={'is-' + tool.status}><div className="browser-tool-heading"><Icon name={tool.status === 'running' ? 'loader' : tool.status === 'failed' ? 'alert-circle' : 'check'} size={13} />
        <strong>{titles[tool.name]?.[zh ? 0 : 1] || (zh ? '浏览器操作' : 'Browser action')}</strong><small>{tool.status === 'running' ? (zh ? '进行中' : 'Running') : tool.status === 'failed' ? (zh ? '未完成' : 'Failed') : (zh ? '已返回' : 'Returned')}</small></div>
        {detail ? <p title={detail}>{detail}</p> : null}
        <details className="browser-tool-technical"><summary>{zh ? '技术详情' : 'Technical details'}</summary><code>{tool.name}</code><pre>{tool.input}</pre>{tool.result ? <pre>{tool.result}</pre> : null}</details>
      </li>;
    })}</ol>
  </details>;
}
