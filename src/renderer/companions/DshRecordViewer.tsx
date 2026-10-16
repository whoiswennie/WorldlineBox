import { useState } from 'react';
import type { DshRecordPage, DshRecordQuery } from '../../shared/dsh-task-record';
import { MessageContent } from './MessageContent';
import { companionTimestamp } from '../../shared/companion-time';

/** Explicit pages replace each other; a large transcript never becomes one giant DOM. */
export function DshRecordViewer({ recordId, read, onOpenUrl }: { recordId: string; read(query: DshRecordQuery): Promise<DshRecordPage | undefined>; onOpenUrl?: (url: string) => void }) {
  const [page, setPage] = useState<DshRecordPage>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [start, setStart] = useState('1');
  async function load(query: DshRecordQuery) {
    if (busy) return;
    setBusy(true); setError('');
    try { const value = await read(query); if (!value) throw new Error('任务记录读取失败。'); setPage(value); }
    catch (error) { setError(error instanceof Error ? error.message : '任务记录读取失败。'); }
    finally { setBusy(false); }
  }
  return <section className="companions-record-viewer" aria-label="完整执行记录">
    <div className="companions-record-toolbar"><button type="button" disabled={busy} onClick={() => void load({ recordId })}>查看记录概览</button>
      <label>起始条目<input aria-label="起始记录编号" type="number" min="1" max="100000" value={start} onChange={event => setStart(event.target.value)} /></label>
      <button type="button" disabled={busy || !Number.isSafeInteger(Number(start)) || Number(start) < 1 || Number(start) > 100000} onClick={() => void load({ recordId, start: Number(start) })}>{busy ? '正在读取…' : '读取 20 条'}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {page && <><p className="companions-record-notice">共 {page.overview.recordCount} 条 · {page.overview.complete ? '已保存' : page.overview.status === 'running' ? '持续记录中' : '部分记录'} · 每条最多 2,000 字符{page.overview.storageLimited ? ' · 已达存储保护上限' : ''}</p>
      {!page.entries.length && <p>这是记录概览。输入起始编号分段查看过程。</p>}
      <div className="companions-record-entries">{page.entries.map(entry => <article key={entry.number}>
        <header><strong>#{entry.number} · {entry.event.toolName || entry.event.stage || entry.event.type}</strong><time>{companionTimestamp(entry.event.receivedAt)}</time></header>
        {entry.event.summary && <p>{entry.event.summary}</p>}
        {entry.event.text && (entry.event.contentKind === 'message' || entry.event.type === 'final' ? <MessageContent content={entry.event.text} onOpenUrl={onOpenUrl} /> : <pre>{entry.event.text}</pre>)}
        {entry.truncated && <button type="button" disabled={busy} onClick={() => void load({ recordId, start: entry.number, end: entry.number, textOffset: entry.nextTextOffset, snapshot: page.snapshot })}>继续读本条 · {entry.textOffset + (entry.event.text?.length ?? 0)} / {entry.textChars} 字符</button>}
      </article>)}</div>
      <div className="companions-record-toolbar">{page.entries[0] && page.entries[0].number > 1 && <button type="button" disabled={busy} onClick={() => void load({ recordId, start: Math.max(1, page.entries[0]!.number - 20), end: page.entries[0]!.number - 1, snapshot: page.snapshot })}>前一段</button>}
        {page.hasMore && <button type="button" disabled={busy} onClick={() => void load({ recordId, start: page.nextStart, snapshot: page.snapshot })}>下一段 · 从 #{page.nextStart} 开始</button>}
        {page.overview.finalRecord && <button type="button" disabled={busy} onClick={() => void load({ recordId, start: page.overview.finalRecord, end: page.overview.finalRecord })}>定位最终回复</button>}
      </div>
    </>}
  </section>;
}
