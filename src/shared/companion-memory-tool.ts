import { z } from 'zod';
import {
  companionMemoryCandidateSchema, companionMemoryForgetSchema, companionMemorySearchSchema,
  companionMemoryTagSchema,
} from './companion-memory';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const memoryToolCandidateSchema = companionMemoryCandidateSchema.superRefine((candidate, context) => {
  if (candidate.sourceMessageIds.some(sourceId => !candidate.evidence.some(evidence => evidence.sourceMessageId === sourceId))) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: '每个记忆来源都需要原文证据。' });
  }
});
// Scope comes from the host, never from model-generated arguments.
export const companionMemoryToolArgumentsSchemas = {
  'memory.search': companionMemorySearchSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).strict(),
  'memory.read': z.strictObject({ id, sourceLimit: z.number().int().min(1).max(100).default(30), sourceCursor: z.number().int().nonnegative().optional() }),
  'memory.record': z.strictObject({ candidate: memoryToolCandidateSchema }),
  'memory.revise': z.strictObject({ id, expectedVersion: z.number().int().positive(), candidate: memoryToolCandidateSchema }),
  'memory.organize': z.strictObject({ ids: z.array(id).min(1).max(100), tags: z.array(companionMemoryTagSchema).max(30).default([]), eventId: id.optional() }),
  'memory.forget': companionMemoryForgetSchema.omit({ companionId: true, conversationId: true, beforeSequence: true }).extend({ requestMessageId: id }).strict(),
} as const;
export type CompanionMemoryToolName = keyof typeof companionMemoryToolArgumentsSchemas;

const descriptions: Record<CompanionMemoryToolName, string> = {
  'memory.search': '自动查找自己的可见记忆。按当前问题的主体、事实键、事件、标签/别名、关键词和时间检索。includeHistory用于历史问题。返回来源、版本和继续读取游标；无结果不代表历史从未发生，可读原始来源。身份、聊天范围和消息位置由宿主绑定。',
  'memory.read': '读取已检索记忆的当前或历史版本与真实来源窗口。sourceCursor继续展开来源；只按实际证据回答，不把旧任务重新执行。',
  'memory.record': '记录新的事实、偏好、经历、约定、经验或自己的感想。candidate必须包含真实sourceMessageIds和逐字evidence，每个来源有证据。subject/factKey用于稳定事实，eventStatus区分计划和实际结果。先查旧记忆/标签，沿用稳定ID。主观感想标subjective，猜测标hypothesis；不能制造用户事实、承诺或完成成果。',
  'memory.revise': '带新的真实来源补充或纠正已有记忆。expectedVersion必须来自读取结果；冲突后重新读取，不能宣称已更新。correction仅用于真实纠正，限定条件不同的说法分别保留。旧版本保持可查询。',
  'memory.organize': '把已读取记录归类到来源支持的规范标签或同一事件；沿用标签ID/名称与别名，保持原始记录和历史。不能凭联想添加用户事实、混合同名实体、改权限或删除历史。',
  'memory.forget': '落实用户明确的遗忘要求，requestMessageId必须是实际请求来源。可指定记录、来源、主体事实键或主题；persistent仅用于用户要求以后持续不记录。宿主过滤衍生内容与原文再召回，不能以不常用为由自行遗忘。',
};

/** Provider function names cannot contain dots; persisted dispatch uses canonical names. */
export function providerCompanionMemoryToolName(name: string): string {
  return name.startsWith('memory.') ? name.replace('.', '_') : name;
}
export function normalizeCompanionMemoryToolName(name: string): string {
  const canonical = name.startsWith('memory_') ? name.replace('memory_', 'memory.') : name;
  return canonical in companionMemoryToolArgumentsSchemas ? canonical : name;
}
export const COMPANION_MEMORY_TOOLS = (Object.keys(companionMemoryToolArgumentsSchemas) as CompanionMemoryToolName[]).map(name => ({
  name: providerCompanionMemoryToolName(name), description: descriptions[name],
  parameters: providerParameters(companionMemoryToolArgumentsSchemas[name]),
}));

function providerParameters(schema: z.ZodType): Record<string, unknown> {
  const parameters = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  // Provider parameter schemas are embedded, so a document-level $schema is invalid.
  delete parameters.$schema;
  return parameters;
}
