import { companionMemorySearchSchema, type CompanionMemoryPage, type CompanionMemorySearch } from '../../shared/companion-memory';
import { companionMemorySelectionSchema, type CompanionMemorySelection } from '../../shared/companion-memory-selection';

/** Describes the actual returned page. No retrieval, ranking, body lookup or
 * claim that earlier pages were read occurs here. */
export function companionMemorySelection(query: CompanionMemorySearch, actual: CompanionMemoryPage): CompanionMemorySelection {
  const input = companionMemorySearchSchema.parse(query);
  const common = { scope: { companionId: input.companionId, conversationId: input.conversationId,
    ...(input.beforeSequence === undefined ? {} : { beforeSequence: input.beforeSequence }) },
  filters: { tags: input.tags, ...(input.diaryName === undefined ? {} : { diaryName: input.diaryName }),
    ...(input.from === undefined ? {} : { from: input.from }), ...(input.to === undefined ? {} : { to: input.to }) },
  page: { cursor: input.cursor ?? 0, limit: input.limit, returned: actual.items.length, hasMore: actual.hasMore,
    ...(actual.nextCursor === undefined ? {} : { nextCursor: actual.nextCursor }) } };
  return companionMemorySelectionSchema.parse(input.query ? { ...common, kind: 'ranked_candidates', query: input.query,
    exhaustive: false, paginationScope: 'same_ranked_candidates', meaning: '本页仅为本次语义排序候选；未返回的日记可能仍存在，hasMore不证明全库已查尽。' }
    : { ...common, kind: 'metadata_directory', paginationScope: 'filtered_directory', directoryEndReached: !actual.hasMore,
      priorPagesReadAttested: false, meaning: '本页是当前获权的筛选目录页；到末尾只表示本次游标后无更多匹配条目，不证明之前各页已读取。' });
}
