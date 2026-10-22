import { useState } from 'react';
import type { CompanionMemoryRetrieval } from '../../shared/companion-memory-retrieval';
import type { CompanionMemoryProbe } from '../../shared/companion-memory-probe';
import { Icon, type IconName } from '../Icons';
import { memoryDisplayTitle, readableMemoryExcerpt } from './companion-memory-tool-presentation';

type Stage = CompanionMemoryRetrieval['stages'][number];
const labels: Record<Stage['id'], [string, IconName]> = { scope: ['记忆范围', 'shield'], embedding: ['理解话题', 'message-circle'], sensing: ['唤起线索', 'sparkles'], candidates: ['寻找片段', 'search'], ranking: ['筛选回忆', 'layers'], context: ['整理内容', 'file-text'] };
const states: Record<Stage['state'], string> = { completed: '已完成', not_observed: '细节未提供', degraded: '已降级', skipped: '本次未执行' };
function brief(stage: Stage): string {
  if (stage.state === 'not_observed') return '这次没有提供这个环节的完整记录。';
  if (stage.state === 'skipped') return '本次没有执行这一步。';
  if (stage.state === 'degraded') return '这一步使用了备用检索方式，可以展开记录核对。';
  return { scope: '只从这位伙伴可以使用的记忆中查找。', embedding: '已通过本地模型理解这次的问题。', sensing: '已查看和这个话题有关的线索。', candidates: '已从相关经历中查找可能有用的片段。', ranking: '已按本次问题的相关程度整理回忆。', context: '已得到这次回忆实际返回的内容。' }[stage.id];
}
function noteTitle(hit: CompanionMemoryProbe['memories'][number]) {
  return memoryDisplayTitle(typeof hit.memory.metadata?.title === 'string' ? hit.memory.metadata.title : hit.memory.content.replace(/^#{1,6}\s*/u, '').split(/[\r\n]/u)[0]?.slice(0, 60) || '相关记忆');
}
function missingMatches(stage: Stage): string {
  if (stage.state === 'not_observed') return '原版未提供这个环节的逐条文档命中记录。';
  if (stage.state === 'skipped') return '本次没有执行此环节，也没有该环节的命中记录。';
  return { scope: '这个环节只确认可用范围，不产生文档命中。', embedding: '这个环节生成查询向量，不产生文档命中。', sensing: '这一步未提供可逐条查阅的关联文档。', candidates: '原版未提供逐条候选正文，处理计数可在记录中查阅。', ranking: '这次排序未返回文档级命中。', context: '实际返回内容见下方；原版未提供逐条聚焦引用轨迹。' }[stage.id];
}
export function CompanionMemoryRetrievalFlow({ retrieval, memories, onSelectNote, onOpenNote }: {
  retrieval?: CompanionMemoryRetrieval; memories: CompanionMemoryProbe['memories']; onSelectNote(id: string): void; onOpenNote?(id: string): void;
}) {
  const [stageId, setStageId] = useState<Stage['id']>('ranking');
  if (!retrieval?.stages.length) return <p className="memory-retrieval-unavailable"><Icon name="info" size={14} />这次回忆没有提供分步记录。可以直接查阅返回的内容与来源。</p>;
  const stage = retrieval.stages.find(item => item.id === stageId) ?? retrieval.stages.at(-1);
  const notes = new Map(memories.map(hit => [hit.memory.id, hit]));
  return <section className="memory-retrieval-flow" aria-label="本次回忆的处理过程">
    <header><h3>这次是怎样想起来的</h3><span>点击环节，查阅实际处理记录</span></header>
    <label className="memory-retrieval-mobile">回忆环节<select aria-label="选择回忆环节" value={stage?.id} onChange={event => setStageId(event.target.value as Stage['id'])}>{retrieval.stages.map(item => <option key={item.id} value={item.id}>{labels[item.id][0]} · {states[item.state]}</option>)}</select></label>
    <div className="memory-retrieval-layout"><div className="memory-retrieval-steps" role="tablist" aria-label="回忆流程" aria-orientation="vertical">{retrieval.stages.map(item => <button type="button" key={item.id} role="tab" aria-selected={stage?.id === item.id} data-retrieval-stage={item.id} data-stage-state={item.state} onClick={() => setStageId(item.id)}><span className="memory-retrieval-step-icon"><Icon name={labels[item.id][1]} size={17} /></span><strong>{labels[item.id][0]}</strong><small>{states[item.state]}</small></button>)}</div>
    {stage && <div className="memory-retrieval-stage" aria-label={stage.title}><header><h4>{stage.title}</h4><span data-stage-state={stage.state}>{states[stage.state]}</span></header><p>{brief(stage)}</p>
      <details className="memory-retrieval-more"><summary>处理说明与记录{stage.facts.length ? ` · ${stage.facts.length} 项` : ''}</summary><p>{stage.description}</p>{!!stage.facts.length && <dl className="memory-retrieval-facts">{stage.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl>}</details>
      {!!stage.tags.length && <div className="memory-retrieval-tags" aria-label="本环节唤起的话题标签">{stage.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}
      {!!stage.matches.length && <ol className="memory-retrieval-matches" aria-label="本环节关联的记忆">{stage.matches.map(match => { const hit = notes.get(match.memoryId); if (!hit) return null; const excerpt = match.excerpt ? readableMemoryExcerpt(match.excerpt) : ''; return <li key={match.memoryId} data-retrieval-memory={match.memoryId}><div><button type="button" onClick={() => onSelectNote(match.memoryId)}>{match.rank !== undefined && <small>#{match.rank}</small>}<strong>{noteTitle(hit)}</strong><Icon name="chevron-right" size={13} /></button>{onOpenNote && <button type="button" className="memory-retrieval-document-link" onClick={() => onOpenNote(match.memoryId)}>查看文档<Icon name="arrow-up-right" size={12} /></button>}</div>{match.excerpt && (excerpt ? <p>{excerpt}</p> : <p>原版摘录仅包含记录标记，可打开文档查看正文。</p>)}{match.excerpt && excerpt !== match.excerpt && <details className="memory-retrieval-more"><summary>原始片段记录</summary><pre>{match.excerpt}</pre></details>}{!!match.tags.length && <div className="memory-retrieval-tags">{match.tags.map((tag, index) => <span key={index}>#{tag}</span>)}</div>}{!!match.facts.length && <details className="memory-retrieval-more"><summary>这段记忆的匹配线索</summary><dl className="memory-retrieval-facts">{match.facts.map((fact, index) => <div key={index}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}</dl></details>}</li>; })}</ol>}
      {!stage.matches.length && <p className="memory-retrieval-empty-matches">{missingMatches(stage)}</p>}
      {stage.state === 'not_observed' && <p className="memory-retrieval-unknown"><Icon name="info" size={12} />原版接口未提供这一环节的完整细节。</p>}
    </div>}</div>
    <details className="memory-retrieval-boundary"><summary>这份记录的范围</summary><p>候选检索与最终回忆内容分别保留原版流程；逐条注入关系未提供时，不推断它们一一对应。</p></details>
  </section>;
}
