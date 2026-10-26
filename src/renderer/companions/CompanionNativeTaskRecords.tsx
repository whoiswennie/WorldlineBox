import { useEffect, useState } from 'react';
import type { DshRecordPage, DshRecordQuery } from '../../shared/dsh-task-record';
import { dshRecordQuerySchema } from '../../shared/dsh-task-record';
import type { CompanionRequest } from './CompanionDialogs';
import { createCoalescedRefresh } from './coalesced-refresh';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const names: Record<string, string> = { text: '内容', content: '正文', query: '查询', url: '页面地址', path: '文件位置', name: '名称',
  command: '命令', code: '脚本', arguments: '参数', result: '返回结果', output: '输出', summary: '摘要', error: '问题说明', ok: '是否成功',
  preparing: '准备工具环境', starting: '启动执行', tool_prepare: '准备工具', tool_start: '开始调用工具', tool_end: '工具已返回',
  session: '建立会话', turn_start: '开始处理', turn_end: '本轮处理结束', step_start: '开始步骤', step_end: '步骤已结束',
  completed: '执行完成', failed: '执行未完成', message: '执行消息', input: '输入', status: '状态', operation: '操作' };
function StructuredText({ text, truncated }: { text: string; truncated: boolean }) {
  const [page, setPage] = useState(0);
  let value: unknown;
  try { value = JSON.parse(text); } catch { /* A plain document or one bounded slice of a longer object. */ }
  if (value && typeof value === 'object') {
    const leaves: Array<[string, string]> = [];
    const walk = (value: unknown, path: string, depth: number) => {
      if (leaves.length >= 2048 || depth > 128) return;
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (/api.?key|leaseToken|thoughtSignature/iu.test(key)) continue;
        walk(child, [path, names[key] ?? key].filter(Boolean).join(' / '), depth + 1);
      } else leaves.push([path, value === true ? '是' : value === false ? '否' : value == null ? '无' : String(value)]);
    };
    walk(value, '', 0);
    const offset = Math.min(page * 20, Math.max(0, Math.ceil(leaves.length / 20) - 1) * 20);
    return <><dl className="task-native-fields">{leaves.slice(offset, offset + 20).map(([name, value], index) => <div key={index}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>{leaves.length > 20 && <div className="task-inspector-pagination"><span>{offset + 1}–{Math.min(offset + 20, leaves.length)} / {leaves.length} 个字段</span><button disabled={offset === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>前一组字段</button><button disabled={offset + 20 >= leaves.length} onClick={() => setPage(value => value + 1)}>后一组字段</button></div>}{!leaves.length && <div className="task-record-text">返回了空结构。</div>}</>;
  }
  if (truncated && (text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) return <details className="task-native-fragment"><summary>较长的结构化返回 · 查看这一段内容</summary><pre>{text}</pre></details>;
  return <div className="task-record-text"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt || '图片'}</span>, a: ({ children, href }) => <span className="task-record-link" title={href}>{children}</span> }}>{text}</Markdown></div>;
}

/** Native archives use their existing source-checked seek API. Twenty entries
 * and one text slice replace the old page, even for very long tool sessions. */
export function CompanionNativeTaskRecords({ actionId, recordId, request, active, api }: { actionId: string; recordId: string; request: CompanionRequest;
  active: boolean; api?: Pick<WorldlineBoxCompanionsApi, 'onChanged'> }) {
  const [opened, setOpened] = useState(false), [query, setQuery] = useState<DshRecordQuery>({ recordId, start: 1 });
  const [page, setPage] = useState<DshRecordPage>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    const reads = createCoalescedRefresh(async () => {
      const response = await request({ type: 'action.record', id: actionId, query: dshRecordQuerySchema.parse(query) });
      if (cancelled) return;
      setBusy(false);
      if (!response?.taskRecord) { setPage(undefined); setError(response?.error ?? '完整记录暂时无法读取。'); }
      else { setError(''); setPage(response.taskRecord); }
    }, () => { if (!cancelled) { setBusy(false); setPage(undefined); setError('读取失败，请重试。'); } }, 1500);
    void reads.trigger();
    const live = active && query.snapshot === undefined;
    const timer = live ? setInterval(() => void reads.trigger(), 1500) : undefined;
    const unsubscribe = api?.onChanged(() => { if (live) void reads.trigger(); });
    return () => { cancelled = true; reads.dispose(); if (timer) clearInterval(timer); unsubscribe?.(); };
  }, [opened, actionId, query, request, active, api]);
  const read = (query: DshRecordQuery) => { setBusy(true); setError(''); setQuery(query); };
  return <section className="task-native-records" aria-label="完整工具输入与返回">
    <button type="button" className="task-native-toggle" aria-expanded={opened} onClick={() => { setOpened(value => !value); setBusy(!opened); }}>完整工具记录<span>输入与返回 · 按段读取</span></button>
    {opened && <div aria-busy={busy}>
      <div className="task-inspector-pagination"><span>{page ? `${page.overview.recordCount} 条记录${page.overview.storageLimited ? ' · 已达到归档存储上限' : page.overview.complete ? ' · 已归档' : ' · 持续记录中'}` : '正在读取完整记录…'}</span><button type="button" disabled={busy} onClick={() => read({ recordId, start: 1 })}>刷新</button></div>
      {error && <p role="alert" className="task-inspector-empty">{error}</p>}
      {page?.entries.map(entry => <article key={`${entry.number}:${entry.textOffset}`} className="task-record"><header><h5>#{entry.number} · {entry.event.toolName || names[entry.event.stage ?? entry.event.type] || '执行步骤'}</h5><span>{entry.event.contentKind === 'input' ? '工具输入' : entry.event.contentKind === 'output' ? '工具返回' : '宿主记录'}{entry.event.outputState === 'abandoned' ? ' · 已丢弃' : entry.event.outputState === 'draft' ? ' · 草稿' : ''}</span><time title={entry.event.receivedAt}>{new Date(entry.event.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></header>
        {entry.event.summary && <p className="task-native-summary">{entry.event.summary}</p>}
        {entry.event.text && <StructuredText text={entry.event.text} truncated={entry.truncated} />}
        {(entry.truncated || entry.textOffset > 0) && <footer>{entry.textOffset > 0 && <button disabled={busy} onClick={() => read({ recordId, start: entry.number, end: entry.number, snapshot: page.snapshot })}>返回本条开头</button>}{entry.truncated && <button disabled={busy} onClick={() => read({ recordId, start: entry.number, end: entry.number, textOffset: entry.nextTextOffset, snapshot: page.snapshot })}>继续读取本条</button>}</footer>}
      </article>)}
      {page && !page.entries.length && !busy && !error && <p className="task-inspector-empty">尚无已归档的工具步骤。</p>}
      {page && <footer className="task-inspector-pagination">{page.entries[0] && page.entries[0].number > 1 && <button disabled={busy} onClick={() => read({ recordId, start: Math.max(1, page.entries[0]!.number - 20), end: page.entries[0]!.number - 1, snapshot: page.snapshot })}>前一页</button>}{page.hasMore && <button disabled={busy} onClick={() => read({ recordId, start: page.nextStart, snapshot: page.snapshot })}>后一页</button>}{page.overview.finalRecord && <button disabled={busy} onClick={() => read({ recordId, start: page.overview.finalRecord, end: page.overview.finalRecord })}>最终交付</button>}</footer>}
    </div>}
  </section>;
}
