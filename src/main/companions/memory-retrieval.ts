import type { CompanionMemoryPage } from '../../shared/companion-memory';
import type { CompanionMemoryRetrieval } from '../../shared/companion-memory-retrieval';
import type { VcpMemorySearchResult } from '../vcp-memory/contracts';

/** Human-readable projection of one actual candidate request and its separate context request. */
export function projectCompanionMemoryRetrieval(input: {
  mode: 'active' | 'passive'; observedAt: string; documentCount: number;
  result?: VcpMemorySearchResult; hits: CompanionMemoryPage['items']; contextText: string;
}): CompanionMemoryRetrieval {
  const { result, hits, documentCount, mode } = input, trace = result?.retrieval, counts = trace?.counts;
  const empty = documentCount === 0, degraded = result?.degraded === true;
  const fact = (label: string, value: string | number) => ({ label, value: String(value).slice(0, 1000) });
  const present = (label: string, value: number | undefined) => value === undefined ? [] : [fact(label, value)];
  const nativeHits = new Map(trace?.hits.map(hit => [hit.id, hit]) ?? []);
  const matches = hits.slice(0, 12).map(hit => {
    const native = nativeHits.get(hit.memory.id), score = hit.scoreDetails;
    const details = [
      ...present('原生排序', score?.nativeRank ?? score?.rank), ...present('最终排序分', score?.finalScore),
      ...present('基础分', score?.baseScore), ...present('拓扑加成', score?.topologyBonus), ...present('锚点加成', score?.anchorBonus),
      ...present('接触的种子数', native?.anchor?.contactedSeeds), ...present('精确接触数', native?.anchor?.exactContacts),
      ...present('语义接触数', native?.anchor?.semanticContacts), ...present('锚点可靠性', native?.anchor?.anchorReliability),
    ];
    return { memoryId: hit.memory.id, ...(score?.nativeRank ?? score?.rank ? { rank: score?.nativeRank ?? score?.rank } : {}),
      ...(native?.sourcePath ? { sourcePath: native.sourcePath } : {}),
      ...(native?.text ? { excerpt: native.text.slice(0, 300) } : {}), facts: details.slice(0, 12),
      tags: (score?.coreTagsMatched?.length ? score.coreTagsMatched : score?.matchedTags ?? []).filter(tag => tag.length <= 100).slice(0, 8) };
  });
  const stage = (value: CompanionMemoryRetrieval['stages'][number]) => value;
  return { mode, observedAt: input.observedAt, engine: empty ? 'none' : degraded || hits.some(hit => hit.scoreDetails?.engine === 'knn') ? 'knn' : 'river',
    resultCount: hits.length, candidateQuerySeparateFromContext: true, stages: [
      stage({ id: 'scope', title: '确认可用记忆', state: 'completed', description: empty ? '当前没有这位伙伴获权使用的记忆，本次不会启动向量模型。' : '先核对伙伴归属、来源授权和当前修订，再准备本次检索范围。',
        facts: [fact('获权记忆文档', documentCount), ...present('检索日记本', trace?.diaryCount)], tags: [], matches: [] }),
      stage({ id: 'embedding', title: '理解这次提问', state: empty ? 'skipped' : trace ? 'completed' : 'not_observed', description: trace ? '已通过内置模型生成本次查询向量，交给 VCP 原生检索。' : '本次没有返回查询向量的执行凭证。',
        facts: present('实际向量维度', trace?.embeddingDimension), tags: [], matches: [] }),
      stage({ id: 'sensing', title: '唤起话题线索', state: empty ? 'skipped' : trace && !degraded ? 'completed' : 'not_observed',
        description: degraded ? '本次已降级为向量检索，未提供 River 话题感知与关系传播凭证。' : '这里展示原生查询实际返回的标签线索与关系图规模；关联文档仅列出与核心标签有交集的返回结果。',
        facts: [...present('关系图节点', counts?.artifactNodes), ...present('关系图连接', counts?.artifactEdges), ...(trace?.coreTagsMatched.length ? [fact('核心标签', trace.coreTagsMatched.join('、'))] : [])],
        tags: (trace?.matchedTags ?? []).filter(tag => tag.length <= 100).slice(0, 30), matches: matches.filter(match => !!nativeHits.get(match.memoryId)?.coreTagsMatched.length)
          .map(({ memoryId, rank, tags }) => ({ memoryId, ...(rank ? { rank } : {}), tags, facts: [] })) }),
      stage({ id: 'candidates', title: '寻找相关片段', state: empty ? 'skipped' : counts && Object.keys(counts).length ? degraded ? 'degraded' : 'completed' : 'not_observed',
        description: '数字来自本次原生候选处理记录。未返回的候选正文和淘汰原因不可见，不会用最终命中补造整个候选池。',
        facts: [...present('进入原生候选池', counts?.offeredCandidates), ...present('完成投影', counts?.projectedCandidates), ...present('进入选择', counts?.selectedCandidates), ...present('参与排序', counts?.rankedCandidates)], tags: [], matches: [] }),
      stage({ id: 'ranking', title: '核对并排列记忆', state: empty ? 'skipped' : result ? degraded ? 'degraded' : 'completed' : 'not_observed',
        description: '沿用 VCP 实际返回顺序，每篇文档保留首先命中的片段。基础分、关系加成和锚点凭证只在引擎确实提供时显示；分数不是记忆真实性的概率。',
        facts: [...present('原生返回片段', counts?.returnedCandidates), fact('本页获权记忆', hits.length)], tags: [], matches }),
      stage({ id: 'context', title: mode === 'passive' ? '聚焦本轮回忆' : '返回主动回忆', state: empty ? 'skipped' : 'completed',
        description: mode === 'passive' ? '原版 RAGDiary / AIMemo 在独立的原有调用中生成本轮聚焦正文。上方候选查询用于核对，不代表其中每条都注入；聚焦调用没有提供完整逐阶段引用轨迹。'
          : '原版 LightMemo 在独立的原有调用中生成工具实际返回的正文。上方候选查询用于核对，不把候选排序冒充工具正文的逐条引用。',
        facts: empty ? [] : [fact('实际返回正文字符', input.contextText.length), fact('逐条聚焦引用轨迹', '原版接口未提供')], tags: [], matches: [] }),
    ] };
}
