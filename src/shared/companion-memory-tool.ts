import { z } from 'zod';
import { companionKnowledgeCommandSchema } from './companion-knowledge-store';
import { companionWorldQuerySchema } from './companion-knowledge';
import { companionMemoryCandidateSchema, companionMemoryForgetSchema, companionMemorySearchSchema, companionMemoryTagSchema, companionMemoryConsolidateSchema } from './companion-memory';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const COMPANION_MEMORY_SEARCH_CONTRACT = 'search的query省略或为空字符串时，按tags/diaryName/from/to有界浏览本人当前获权、未归档的日记目录，不运行语义排序或去重。每页由limit限制；memoryPage.hasMore=true时用nextCursor作为cursor，在同一筛选条件下续读。非空query返回语义候选，首个候选或首遍未召回不能证明全库不存在。read可展开实际正文与原始来源。待发布、待索引或回忆不可用时，按真实回执说明本次覆盖，不把暂不可读当成没有记忆。写入回执memoryFilesPending=true只确认同一id及修订已存入待发布队列，尚不代表正式收录、可召回或已经学会；后台会继续处理，不为等待文件重复record同一内容。普通主被动回忆使用原版检索与实际格式器正文，默认不额外调用聚焦模型。确需模型聚焦多条资料时先确认retrieval_modes的focus可用，再显式填写retrievalOptions:{focus:true}调用原版AIMemo+；此选项额外消耗模型生成时间，不必每轮开启。';
// Scope comes from the host, never from model arguments.
export const companionMemoryToolArgumentsSchemas = {
    'memory.world_query': companionWorldQuerySchema,
    'memory.search': companionMemorySearchSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).strict(),
    'memory.retrieval_modes': z.strictObject({}),
    'memory.read': z.strictObject({ id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }),
    'memory.record': z.strictObject({ candidate: companionMemoryCandidateSchema }),
    'memory.revise': z.strictObject({ id, expectedVersion: z.number().int().positive(), candidate: companionMemoryCandidateSchema }),
    'memory.organize': z.strictObject({ ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(50).default([]) }),
    'memory.consolidate': companionMemoryConsolidateSchema,
    'memory.knowledge': z.strictObject(Object.fromEntries(Object.entries(companionKnowledgeCommandSchema.shape)
      .filter(([key]) => !['type', 'companionId', 'conversationId', 'beforeSequence'].includes(key))) as Omit<typeof companionKnowledgeCommandSchema.shape, 'type' | 'companionId' | 'conversationId' | 'beforeSequence'>),
    'memory.forget': companionMemoryForgetSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).extend({ requestMessageId: id }).strict(),
} as const;
export type CompanionMemoryToolName = keyof typeof companionMemoryToolArgumentsSchemas;
