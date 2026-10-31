import { useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionReplyMemory } from '../../shared/companion-reply-memory';
import { Icon } from '../Icons';

export type ReplyMemoryScope = { companionId: string; conversationId: string; messageId: string; socialJobId?: string };
function dateLabel(value: string) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录';
}

/** The raw host-supplied context stays literal, including newlines and spacing.
 * Only a bounded page is mounted, even when one recalled passage is very long. */
function ContextReading({ text, truncated, total, offset, page, hasPrevious, nextOffset, onPrevious, onNext }: {
  text: string; truncated: boolean; total: number; offset: number; page: number; hasPrevious: boolean; nextOffset?: number;
  onPrevious(): void; onNext(offset: number): void;
}) {
  return <section className="reply-memory-context" aria-label="实际注入的记忆原文">
    <div className="reply-memory-section-title"><Icon name="layers" size={14} /><h4>实际注入的记忆原文</h4><small>{total.toLocaleString('zh-CN')} 字符</small></div>
    <pre data-reply-memory-context>{text}</pre>
    {(hasPrevious || nextOffset !== undefined) && <nav aria-label="记忆原文分页"><button type="button" disabled={!hasPrevious} onClick={onPrevious}>上一段</button><span>第 {page} 段 · {offset + 1}—{offset + text.length}</span><button type="button" disabled={nextOffset === undefined} onClick={() => { if (nextOffset !== undefined) onNext(nextOffset); }}>下一段</button></nav>}
    {truncated && <p className="reply-memory-note">原文按段加载，可切换查看完整注入内容。</p>}
  </section>;
}

/** Mounted only after the user opens one reply. No diary bodies are copied into
 * the chat list, and every reopen or storage change revalidates the receipt. */
export function CompanionReplyMemoryDetails(props: { scope: ReplyMemoryScope; api?: WorldlineBoxCompanionsApi; refreshKey?: string; replyRunning?: boolean }) {
  return <CompanionReplyMemoryBody key={JSON.stringify(props.scope)} {...props} />;
}
function CompanionReplyMemoryBody({ scope, refreshKey, replyRunning, api = (window as Window & { worldlinebox?: { companions?: WorldlineBoxCompanionsApi } }).worldlinebox?.companions }: { scope: ReplyMemoryScope; api?: WorldlineBoxCompanionsApi; refreshKey?: string; replyRunning?: boolean }) {
  const [receipt, setReceipt] = useState<CompanionReplyMemory>(), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [offsets, setOffsets] = useState<number[]>([0]); const contextOffset = offsets.at(-1)!;
  const [reload, setReload] = useState(0), serial = useRef({ epoch: 0 });
  useEffect(() => {
    const requests = serial.current;
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, corpusStamp: string | undefined;
    const deadlines = new Set<ReturnType<typeof setTimeout>>();
    async function withinReadDeadline<T>(promise: Promise<T>): Promise<T> {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('记忆详情暂时没能读取完成，可以重新查看或关闭详情。')), 10_000); deadlines.add(deadline);
      })]); }
      finally { if (deadline !== undefined) { clearTimeout(deadline); deadlines.delete(deadline); } }
    }
    const invalidate = () => { requests.epoch++; setReceipt(undefined); setError(''); setLoading(true); };
    const read = async () => {
      if (document.visibilityState === 'hidden') return;
      const epoch = ++requests.epoch; setReceipt(undefined); setError(''); setLoading(true);
      try {
        if (!api) throw new Error('记忆详情暂时无法读取。');
        const [result, state] = await withinReadDeadline(Promise.all([
          api.request(scope.socialJobId
            ? { type: 'social.reply.memory.inspect', companionId: scope.companionId, conversationId: scope.conversationId, jobId: scope.socialJobId, contextOffset, contextLimit: 8192 }
            : { type: 'reply.memory.inspect', companionId: scope.companionId, conversationId: scope.conversationId, messageId: scope.messageId, contextOffset, contextLimit: 8192 }),
          api.request({ type: 'memory.recall.state', companionId: scope.companionId }),
        ]));
        if (!alive || epoch !== requests.epoch) return;
        if (!result.ok || !result.replyMemory) throw new Error(result.error || '这条回复还没有可核验的记忆详情。');
        if (!state.ok || !state.memoryCorpusStamp) throw new Error(state.error || '当前记忆状态暂时无法核验。');
        const value = result.replyMemory;
        if (value.companionId !== scope.companionId || value.conversationId !== scope.conversationId || value.messageId !== scope.messageId || value.state === 'ready' && value.contextOffset !== contextOffset) throw new Error('记忆详情的归属未能核实，请重新读取。');
        corpusStamp = state.memoryCorpusStamp; setReceipt(value);
      } catch (cause) { if (alive && epoch === requests.epoch) { setReceipt(undefined); setError(cause instanceof Error ? cause.message : '记忆详情暂时无法读取。'); } }
      finally { if (alive && epoch === requests.epoch) setLoading(false); }
    };
    void read();
    const checkState = async () => {
      if (!api || !corpusStamp || document.visibilityState === 'hidden') return;
      const epoch = requests.epoch;
      try {
        const state = await withinReadDeadline(api.request({ type: 'memory.recall.state', companionId: scope.companionId }));
        if (!alive || epoch !== requests.epoch) return;
        if (!state.ok || !state.memoryCorpusStamp) throw new Error(state.error || '当前记忆状态暂时无法核验。');
        if (state.memoryCorpusStamp !== corpusStamp) { corpusStamp = undefined; invalidate(); void read(); }
      } catch (cause) { if (alive && epoch === requests.epoch) { corpusStamp = undefined; setReceipt(undefined); setError(cause instanceof Error ? cause.message : '当前记忆状态暂时无法核验。'); setLoading(false); } }
    };
    const unsubscribe = api?.onChanged(() => { if (!timer && document.visibilityState !== 'hidden') timer = setTimeout(() => { timer = undefined; void checkState(); }, 750); });
    const visibility = () => { corpusStamp = undefined; invalidate(); if (timer) { clearTimeout(timer); timer = undefined; } if (document.visibilityState !== 'hidden') void read(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { alive = false; requests.epoch++; if (timer) clearTimeout(timer); for (const deadline of deadlines) clearTimeout(deadline); unsubscribe?.(); document.removeEventListener('visibilitychange', visibility); };
  }, [api, reload, refreshKey, contextOffset, scope.companionId, scope.conversationId, scope.messageId, scope.socialJobId]);
  const current = receipt?.companionId === scope.companionId && receipt.conversationId === scope.conversationId && receipt.messageId === scope.messageId && (receipt.state !== 'ready' || receipt.contextOffset === contextOffset) ? receipt : undefined;
  // A withdrawn/unavailable receipt is metadata only. Even a malformed response
  // must never cause a cached excerpt to reappear in the rendered body.
  const verified = current?.state === 'ready' ? current : undefined;
  return <div className="companions-reply-memory-details" aria-label="本轮回忆详情" aria-busy={loading}>
    <header><span><Icon name="sparkles" size={15} /><strong>这次回复的回忆</strong></span><button type="button" aria-label="重新核验本轮回忆" disabled={loading} onClick={() => setReload(value => value + 1)}><Icon name="refresh" size={13} />重新读取</button></header>
    {loading ? <p role="status" className="reply-memory-note">正在读取这次回复用到的记忆…</p> : error ? <p role="alert" className="reply-memory-note">{error}</p> : current && <>
      <p className={'reply-memory-note' + (current.state === 'withdrawn' ? ' is-withdrawn' : '')}>{replyRunning && current.state === 'unavailable' ? '本条回复仍在进行，记忆上下文尚未完成保存。完成后可查看实际收到的记忆与来源。' : current.explanation}</p>
      {current.pending && <p className="reply-memory-status"><Icon name="clock" size={13} />部分来源仍在收录或建立索引，本轮回忆可能尚未包含这些内容。</p>}
      {current.degraded && <p className="reply-memory-status"><Icon name="alert-circle" size={13} />本轮召回发生降级，请结合原文核对。</p>}
      {verified && <>
        {verified.query && <details className="reply-memory-query"><summary>这次在回想什么</summary><p>{verified.query}</p></details>}
        {verified.contextText ? <ContextReading text={verified.contextText} truncated={verified.contextTruncated} total={verified.contextCharacters} offset={verified.contextOffset} page={offsets.length} hasPrevious={offsets.length > 1} nextOffset={verified.nextContextOffset}
          onPrevious={() => setOffsets(value => value.slice(0, -1))} onNext={offset => setOffsets(value => [...value, offset])} /> : <p className="reply-memory-empty"><Icon name="search" size={14} />这轮没有注入长期记忆原文。</p>}
        {!!verified.candidates.length && <details className="reply-memory-candidates"><summary>候选记忆与来源 <span>{verified.candidates.length}</span></summary><p className="reply-memory-note">候选是检索命中的资料；实际进入本轮上下文的内容以上方原文为准。</p><ol>{verified.candidates.map(candidate => <li key={candidate.id + ':' + candidate.version} data-recall-candidate={candidate.id}>
          <div className="reply-memory-candidate-heading"><h5>{candidate.title}</h5><span>版本 {candidate.version}</span></div>
          <p className="reply-memory-candidate-body">{candidate.content}</p>{candidate.contentTruncated && <small>记忆摘录，非完整正文</small>}
          <div className="reply-memory-candidate-meta"><time dateTime={candidate.createdAt}>{dateLabel(candidate.createdAt)}</time>{candidate.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>
          <details className="reply-memory-sources"><summary><Icon name="link" size={12} />来源凭证 · {candidate.sourceCount} 项</summary>{candidate.sources.map(source => <blockquote key={source.messageId}><time dateTime={source.createdAt}>{dateLabel(source.createdAt)}</time><p>{source.excerpt}</p><details><summary>来源编号</summary><code>{source.conversationId} / {source.messageId}</code></details></blockquote>)}{candidate.sourceCount > candidate.sources.length && <p className="reply-memory-note">本处展示 {candidate.sources.length} 项来源摘录。</p>}</details>
        </li>)}</ol></details>}
        <footer><Icon name="shield" size={12} />已核验本条回复的伙伴与聊天范围<time dateTime={verified.observedAt}>{dateLabel(verified.observedAt)}</time></footer>
      </>}
    </>}
  </div>;
}
