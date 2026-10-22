import { useEffect, useMemo, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryProbe } from '../../shared/companion-memory-probe';
import type { ScheduleRequest } from './companion-schedules';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import { memoryReadingEnd } from './companion-memory-presentation';
import { memoryDisplayTitle, memorySourcePathKey, memoryToolPresentation, memoryToolSourceBlocks, nativeMemoryScore, type MemoryToolSourceBlock } from './companion-memory-tool-presentation';
import { CompanionMemoryRetrievalFlow } from './CompanionMemoryRetrievalFlow';
import './companion-memory-probe.css';

type Mode = CompanionMemoryProbe['mode'];
type Props = { companion: Companion; request: ScheduleRequest; api?: WorldlineBoxCompanionsApi; active?: boolean; initialQuery?: string;
  onClose(): void; onOpenNote?(noteId: string): void };
function dateLabel(value: string) { return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '时间未记录'; }
function titleFor(memory: CompanionMemoryProbe['memories'][number]['memory']) {
  const title = memory.metadata?.title;
  return memoryDisplayTitle(typeof title === 'string' && title.trim() ? title : memory.content.replace(/^#{1,6}\s*/u, '').split(/[\r\n]/u)[0]?.slice(0, 60) || memory.diaryName || '记忆片段');
}
function ProbeText({ text, label }: { text: string; label: string }) {
  const [offsets, setOffsets] = useState([0]); const offset = offsets.at(-1)!, end = memoryReadingEnd(text, offset, 8192);
  return <><pre aria-label={label} data-probe-characters={end - offset}>{text.slice(offset, end)}</pre>{(offset > 0 || end < text.length) && <nav className="memory-probe-pagination" aria-label={label + '分页'}><button type="button" disabled={!offset} onClick={() => setOffsets(value => value.slice(0, -1))}>上一段</button><span>第 {offsets.length} 段 · 共 {text.length.toLocaleString('zh-CN')} 字符</span><button type="button" disabled={end >= text.length} onClick={() => setOffsets(value => [...value, end])}>下一段</button></nav>}</>;
}
function ToolSourceBlock({ block, note, first, onOpenNote }: { block: MemoryToolSourceBlock; note?: CompanionMemoryProbe['memories'][number]; first: boolean; onOpenNote?(id: string): void }) {
  const [open, setOpen] = useState(first), [metadataOpen, setMetadataOpen] = useState(false);
  return <article className="memory-probe-source-block"><details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><Icon name="file-text" size={15} /><span><strong>{note ? titleFor(note.memory) : block.author ? memoryDisplayTitle(block.author + '的记录') : '相关回忆'}</strong>{block.date && <small>{block.date} {block.time}</small>}</span></summary>{open && <div>{note && onOpenNote && <button type="button" className="memory-probe-source-open" aria-label={'打开回忆来源 ' + note.memory.id} onClick={() => onOpenNote(note.memory.id)}>打开来源文档<Icon name="arrow-up-right" size={12} /></button>}<ProbeText text={block.body} label="回忆来源正文" />{!!block.tags.length && <div className="memory-probe-note-tags">{block.tags.slice(0, 50).map((tag, index) => <span key={index}>#{memoryDisplayTitle(tag, 100)}</span>)}</div>}{block.tags.length > 50 && <p className="memory-probe-source-overflow">另有 {block.tags.length - 50} 个标签，完整标签保留在原始工具回执中。</p>}<details className="memory-probe-evidence" onToggle={event => setMetadataOpen(event.currentTarget.open)}><summary>来源位置与原始标记</summary>{metadataOpen && <><ProbeText text={'来源：' + block.source + (block.path ? '\n位置：' + block.path : '') + '\n工具原始相关性：' + block.relevance + '。这不是记忆真实性的概率。'} label="回忆来源元数据" />{block.path && note && onOpenNote && <button type="button" onClick={() => onOpenNote(note.memory.id)}>打开该位置对应的文档</button>}</>}</details></div>}</details></article>;
}
function RecallContext({ text, mode, memories, retrieval, onOpenNote }: { text: string; mode: Mode; memories: CompanionMemoryProbe['memories']; retrieval?: CompanionMemoryProbe['memoryRetrieval']; onOpenNote?(id: string): void }) {
  const presentation = useMemo(() => mode === 'active' ? memoryToolPresentation(text) : { text, decoded: false }, [text, mode]);
  const blocks = useMemo(() => mode === 'active' ? memoryToolSourceBlocks(presentation.text) : undefined, [mode, presentation.text]);
  const paths = useMemo(() => {
    const notes = new Map(memories.map(hit => [hit.memory.id, hit])); const found = new Map<string, CompanionMemoryProbe['memories'][number]>(); const ambiguous = new Set<string>();
    const add = (id: string, sourcePath?: string) => { const note = notes.get(id), key = sourcePath ? memorySourcePathKey(sourcePath) : ''; if (!note || !key || ambiguous.has(key)) return; if (found.has(key) && found.get(key)!.memory.id !== id) { found.delete(key); ambiguous.add(key); } else found.set(key, note); };
    for (const note of memories) add(note.memory.id, note.memory.sourceFile);
    for (const stage of retrieval?.stages ?? []) for (const match of stage.matches) add(match.memoryId, match.sourcePath);
    return found;
  }, [memories, retrieval]);
  const [rawOpen, setRawOpen] = useState(false);
  return <>{blocks ? <div className="memory-probe-context-sources" aria-label="工具返回的回忆片段">{blocks.map((block, index) => <ToolSourceBlock key={index} block={block} note={block.path ? paths.get(memorySourcePathKey(block.path)) : undefined} first={index === 0} onOpenNote={onOpenNote} />)}</div> : <ProbeText text={presentation.text} label="VCP上下文原文" />}{(presentation.decoded || blocks) && <div className="memory-probe-tool-receipt"><p><Icon name="check" size={12} />{blocks ? '按工具返回的来源分段展示，完整原文保留在回执中。' : '已展开工具回执中的文本原文，内容与原始回执一致。'}</p><details onToggle={event => setRawOpen(event.currentTarget.open)}><summary>原始工具回执</summary>{rawOpen && <ProbeText text={text} label="原始工具回执原文" />}</details></div>}</>;
}
function NativeScoreEvidence({ hit }: { hit: CompanionMemoryProbe['memories'][number] }) {
  const details = hit.scoreDetails; if (!details) return null;
  const scores: Array<[string, number | undefined]> = [['最终评分', details.finalScore], ['初始候选分', details.originalScore], ['向量分', details.vectorScore], ['连续场与闭合基础分', details.baseScore], ['拓扑增益', details.topologyBonus], ['锚点增益', details.anchorBonus], ['河网可观测性 Ω', details.omega]];
  return <section className="memory-probe-native-scores" aria-label="原生VCP评分"><header><strong>{details.engine === 'river' ? 'RiverMemo' : '向量检索'}原生评分</strong><span>原生结果顺位 #{details.nativeRank ?? details.rank}</span></header><dl>{scores.filter(([, score]) => Number.isFinite(score)).map(([label, score]) => <div key={label}><dt>{label}</dt><dd>{nativeMemoryScore(score!)}</dd></div>)}</dl><p>保留引擎原始排序与分值。各项仅在 VCP 实际返回时展示，分数与 Ω 均不是记忆真实性的置信度。</p><details><summary>排序依据与原生凭证</summary><dl>{details.algorithmVersion && <div><dt>算法</dt><dd>{details.algorithmVersion}</dd></div>}{details.queryMode && <div><dt>查询模式</dt><dd>{details.queryMode}</dd></div>}{details.role && <div><dt>角色</dt><dd>{details.role}</dd></div>}{details.riverRegime && <div><dt>河流状态</dt><dd>{details.riverRegime}</dd></div>}{!!details.matchedTags?.length && <div><dt>命中标签</dt><dd>{details.matchedTags.join('、')}</dd></div>}{!!details.coreTagsMatched?.length && <div><dt>核心标签</dt><dd>{details.coreTagsMatched.join('、')}</dd></div>}{!!details.candidateSources?.length && <div><dt>候选入口</dt><dd>{details.candidateSources.join('、')}</dd></div>}</dl></details></section>;
}

export function CompanionMemoryProbeWorkspace(props: Props) {
  return <CompanionMemoryProbeBody key={props.companion.id} {...props} />;
}
function CompanionMemoryProbeBody({ companion, request, api, active = true, initialQuery = '', onClose, onOpenNote }: Props) {
  const [query, setQuery] = useState(initialQuery), [mode, setMode] = useState<Mode>('active');
  const [probe, setProbe] = useState<CompanionMemoryProbe>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const [view, setView] = useState<'context' | 'candidate'>('context'), [selectedId, setSelectedId] = useState<string>();
  const [wasActive, setWasActive] = useState(active);
  const epoch = useRef({ value: 0 }), alive = useRef(false);
  if (wasActive !== active) { setWasActive(active); setProbe(undefined); setBusy(false); setStale(false); setError(''); }
  useEffect(() => {
    const reads = epoch.current; alive.current = active;
    if (!active) return;
    return () => { alive.current = false; reads.value++; };
  }, [active]);
  const corpusStamp = probe?.corpusStamp;
  useEffect(() => {
    if (!active || !api || !corpusStamp) return;
    let listening = true, timer: ReturnType<typeof setTimeout> | undefined, checkEpoch = 0;
    const check = async () => {
      const turn = ++checkEpoch;
      try {
        const result = await request({ type: 'memory.recall.state', companionId: companion.id });
        if (!listening || turn !== checkEpoch) return;
        if (!result?.ok || !result.memoryCorpusStamp) throw new Error(result?.error || '当前记忆状态暂时无法核验，请重新回忆。');
        if (result.memoryCorpusStamp !== corpusStamp) { setProbe(undefined); setStale(true); }
      } catch (cause) { if (listening && turn === checkEpoch) { setProbe(undefined); setError(cause instanceof Error ? cause.message : '当前记忆状态暂时无法核验。'); } }
    };
    const unsubscribe = api.onChanged(() => { if (!timer) timer = setTimeout(() => { timer = undefined; void check(); }, 750); });
    return () => { listening = false; checkEpoch++; if (timer) clearTimeout(timer); unsubscribe(); };
  }, [active, api, corpusStamp, companion.id, request]);
  const clear = () => { epoch.current.value++; setProbe(undefined); setError(''); setBusy(false); setStale(false); };
  async function run() {
    const text = query.trim(); if (!text || busy || !active) return;
    const turn = ++epoch.current.value; setBusy(true); setProbe(undefined); setError(''); setStale(false);
    try {
      const result = await request({ type: 'memory.recall.test', companionId: companion.id, query: text, mode, limit: 8 });
      if (!alive.current || turn !== epoch.current.value) return;
      if (!result?.ok || !result.memoryProbe) throw new Error(result?.error || '这次回忆还没有完成，请稍后重试。');
      const value = result.memoryProbe;
      if (value.companionId !== companion.id || value.query !== text || value.mode !== mode || value.memories.some(hit => hit.memory.companionId !== companion.id)) throw new Error('检索结果的伙伴或查询范围未能核实，请重新回忆。');
      const notes = new Set(value.memories.map(hit => hit.memory.id));
      if (value.memoryRetrieval && (value.memoryRetrieval.mode !== mode || value.memoryRetrieval.stages.some(stage => stage.matches.some(match => !notes.has(match.memoryId))))) throw new Error('这次回忆的处理记录与来源不一致，请重新回忆。');
      setProbe(value); setSelectedId(value.memories[0]?.memory.id); setView('context'); setStale(false);
    } catch (cause) { if (alive.current && turn === epoch.current.value) { setProbe(undefined); setError(cause instanceof Error ? cause.message : '这次回忆还没有完成。'); } }
    finally { if (alive.current && turn === epoch.current.value) setBusy(false); }
  }
  const current = probe?.companionId === companion.id && probe.mode === mode && probe.query === query.trim() ? probe : undefined;
  const selected = current?.memories.find(hit => hit.memory.id === selectedId);
  return <section className="companions-memory-probe" aria-label="伙伴回忆" hidden={!active}>
    <header className="memory-probe-header"><div><Avatar companion={companion} showPresence={false} /><span><small>{companion.name}的个人记忆</small><h2>回忆</h2></span></div><button type="button" aria-label="返回记忆库" onClick={onClose}><Icon name="close" size={18} /></button></header>
    <div className="memory-probe-scroll"><div className="memory-probe-paper">
      <form className="memory-probe-query" onSubmit={event => { event.preventDefault(); void run(); }}><label htmlFor={'memory-probe-query-' + companion.id}>此刻，想让{companion.name}回忆什么？</label><textarea id={'memory-probe-query-' + companion.id} aria-label="想回忆的事" placeholder="例如：我们第一次认识时，我介绍了什么？" rows={3} maxLength={16000} value={query} onChange={event => { clear(); setQuery(event.target.value); }} /><div className="memory-probe-query-controls"><div role="tablist" aria-label="回忆方式"><button type="button" role="tab" aria-selected={mode === 'active'} onClick={() => { clear(); setMode('active'); }}><Icon name="search" size={14} />主动回忆<span>主动查找</span></button><button type="button" role="tab" aria-selected={mode === 'passive'} onClick={() => { clear(); setMode('passive'); }}><Icon name="sparkles" size={14} />被动回忆<span>随话题想起</span></button></div><button type="submit" className="memory-probe-run" disabled={busy || !query.trim()}><Icon name={busy ? 'clock' : 'play'} size={14} />{busy ? '回忆中…' : '开始回忆'}</button></div><p>从这位伙伴自己的经历与知识中，寻找和话题有关的回忆。{mode === 'active' ? '主动查找这位伙伴已经留下的记忆。' : '看看伙伴回答前，会自然想起哪些经历。'}</p></form>
      {error && <p className="memory-probe-notice is-error" role="alert"><Icon name="alert-circle" size={15} />{error}</p>}
      {stale && !busy && <p className="memory-probe-notice" role="status"><Icon name="refresh" size={14} />记忆数据已更新，请点击“开始回忆”重新查看。</p>}
      {busy && <p className="memory-probe-empty" role="status"><Icon name="sparkles" size={22} />正在使用本地向量模型与 VCP 检索记忆…</p>}
      {!current && !busy && !error && !stale && <div className="memory-probe-empty"><Icon name="search" size={25} /><strong>看看一段经历，怎样被想起来</strong><p>输入一个话题，沿着线索看看伙伴想起了什么。这里也能查阅每段回忆的来源。</p></div>}
      {current && <div className="memory-probe-result" aria-label="本次回忆结果"><div className="memory-probe-result-meta"><span><Icon name={current.degraded ? 'alert-circle' : 'check'} size={14} />{current.degraded ? '召回已降级' : '本次检索已完成'}</span><time dateTime={current.observedAt}>{dateLabel(current.observedAt)}</time></div><details className="memory-probe-explanation"><summary><Icon name="info" size={12} />检索说明</summary><p>{current.explanation}</p></details>{current.pending && <p className="memory-probe-notice"><Icon name="clock" size={14} />部分来源仍在收录或建立索引，可能尚未出现在这次结果中。</p>}
        <CompanionMemoryRetrievalFlow key={current.observedAt} retrieval={current.memoryRetrieval} memories={current.memories} onSelectNote={id => { setSelectedId(id); setView('candidate'); }} onOpenNote={onOpenNote} /><div className="memory-probe-result-grid"><aside aria-label="VCP候选记忆"><header><h3>找到的记忆</h3><span>{current.memories.length} 条</span></header>{!current.memories.length ? <p className="memory-probe-no-hit">本次没有命中相关记忆。</p> : <ol>{current.memories.map(hit => <li key={hit.memory.id}><button type="button" data-probe-note={hit.memory.id} aria-pressed={view === 'candidate' && selectedId === hit.memory.id} onClick={() => { setSelectedId(hit.memory.id); setView('candidate'); }}><strong>{titleFor(hit.memory)}</strong>{hit.scoreDetails && <span className="memory-probe-native-rank"><b>#{hit.scoreDetails.nativeRank ?? hit.scoreDetails.rank}</b>{Number.isFinite(hit.scoreDetails.finalScore) && <em>{nativeMemoryScore(hit.scoreDetails.finalScore!)}</em>}<i>{hit.scoreDetails.engine === 'river' ? 'VCP 最终分' : '向量分'}</i></span>}<span>{hit.memory.content.slice(0, 160)}</span><small>版本 {hit.memory.version} · {hit.memory.tags.slice(0, 3).map(tag => '#' + tag).join(' ')}</small></button></li>)}</ol>}<p className="memory-probe-list-hint">候选是检索命中的记忆，实际返回的片段请查看“回忆内容”。</p></aside>
          <article className="memory-probe-inspector"><div role="tablist" aria-label="召回结果内容"><button type="button" role="tab" aria-selected={view === 'context'} onClick={() => setView('context')}>回忆内容</button><button type="button" role="tab" disabled={!selected} aria-selected={view === 'candidate'} onClick={() => setView('candidate')}>相关经历</button></div>{view === 'context' ? <section aria-label="本次召回上下文"><h3>{mode === 'active' ? '想起的片段' : '随话题想起的内容'}</h3><p>找到的记忆不一定都会出现在这次回忆里，以这里返回的内容为准。</p>{current.contextText ? <RecallContext key={current.observedAt + ':context'} text={current.contextText} mode={mode} memories={current.memories} retrieval={current.memoryRetrieval} onOpenNote={onOpenNote} /> : <div className="memory-probe-no-hit">这次检索没有返回可注入的记忆原文。</div>}</section> : selected && <section aria-label="候选记忆与来源"><div className="memory-probe-note-heading"><h3>{titleFor(selected.memory)}</h3>{onOpenNote && <button type="button" onClick={() => onOpenNote(selected.memory.id)}>打开记忆文档<Icon name="arrow-up-right" size={13} /></button>}</div><div className="memory-probe-note-meta"><span>版本 {selected.memory.version}</span><time dateTime={selected.memory.updatedAt}>{dateLabel(selected.memory.updatedAt)}</time>{Number.isFinite(selected.score) && <span>召回分数 {nativeMemoryScore(selected.score!, 3)}</span>}</div>{selected.scoreDetails && <details className="memory-probe-score-evidence"><summary>查看 VCP 排序依据与评分</summary><NativeScoreEvidence hit={selected} /></details>}<ProbeText key={selected.memory.id + ':' + selected.memory.version} text={selected.memory.content} label="候选记忆正文" /><div className="memory-probe-note-tags">{selected.memory.tags.map(tag => <span key={tag}>#{tag}</span>)}</div><details className="memory-probe-evidence"><summary><Icon name="link" size={13} />来源凭证 · {selected.memory.sources.length} 项</summary>{selected.memory.sources.slice(0, 3).map(source => <div key={source.messageId}><time dateTime={source.createdAt}>{dateLabel(source.createdAt)}</time><code>{source.conversationId} / {source.messageId}</code><span>来源修订 {source.revision}</span></div>)}{selected.memory.sources.length > 3 && <p>此处展示前 3 项。可打开记忆文档继续查阅完整来源。</p>}</details>{!!selected.reasons.length && <details className="memory-probe-evidence"><summary>VCP检索凭证</summary>{selected.reasons.map((reason, index) => <p key={index}>{reason}</p>)}</details>}</section>}</article>
        </div>
      </div>}
    </div></div>
  </section>;
}
