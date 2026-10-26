import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const scope = z.strictObject({ companionId: id, conversationId: id, beforeSequence: z.number().int().nonnegative().optional() });
const filters = z.strictObject({ tags: z.array(z.string().min(1).max(100)).max(50), diaryName: z.string().max(160).optional(),
  from: z.string().max(100).optional(), to: z.string().max(100).optional() });
const page = z.strictObject({ cursor: z.number().int().nonnegative(), limit: z.number().int().min(1).max(100),
  returned: z.number().int().nonnegative(), hasMore: z.boolean(), nextCursor: z.number().int().nonnegative().optional() })
  .refine(value => value.returned <= value.limit && value.hasMore === (value.nextCursor !== undefined)
    && (!value.hasMore || value.nextCursor! > value.cursor), '页范围或续页游标不一致。');

/** Host output facts only. This is not accepted by any model tool argument. */
export const companionMemorySelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ranked_candidates'), scope, filters, page, query: z.string().trim().min(1).max(16000),
    exhaustive: z.literal(false), paginationScope: z.literal('same_ranked_candidates'),
    meaning: z.literal('本页仅为本次语义排序候选；未返回的日记可能仍存在，hasMore不证明全库已查尽。') }),
  z.strictObject({ kind: z.literal('metadata_directory'), scope, filters, page, paginationScope: z.literal('filtered_directory'),
    directoryEndReached: z.boolean(), priorPagesReadAttested: z.literal(false),
    meaning: z.literal('本页是当前获权的筛选目录页；到末尾只表示本次游标后无更多匹配条目，不证明之前各页已读取。') }),
]).refine(value => value.kind !== 'metadata_directory' || value.directoryEndReached === !value.page.hasMore,
  '目录末尾状态必须来自实际分页结果。');
export type CompanionMemorySelection = z.output<typeof companionMemorySelectionSchema>;
