import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
export const companionResetCleanupStageSchema = z.enum(['stop', 'knowledge', 'native-records', 'documents', 'asset-index', 'credentials', 'profile']);
export const COMPANION_RESET_CLEANUP_LABELS = { stop: '正在停止旧任务', knowledge: '正在清理知识索引',
  'native-records': '正在清理原生任务记录', documents: '正在清理旧记忆文件', 'asset-index': '正在更新资产索引', credentials: '正在移除专属连接配置', profile: '正在移除伙伴档案' } as const;
export const companionRetirePhaseSchema = z.enum(['stopping', 'rooms', 'journals', 'owner-records', 'metadata', 'select-messages', 'message-links', 'social-rooms', 'messages', 'actions', 'attachments', 'files', 'finish', 'completed']);
export const COMPANION_RETIRE_PHASE_LABELS = {
  stopping: '停止任务与隔离旧身份', rooms: '退出会话与社交空间', journals: '清理日记与个人记忆',
  'owner-records': '清理知识、成长与生活记录', metadata: '清理个人运行记录', 'select-messages': '核对需要删除的发言',
  'message-links': '撤回发言的引用与关联', 'social-rooms': '清理伙伴间的私人会话', messages: '删除本人的聊天记录',
  actions: '清理任务与执行记录', attachments: '核对个人附件', files: '删除受管的个人文件', finish: '确认身份与记录已清理', completed: '删除完成',
} as const satisfies Record<z.infer<typeof companionRetirePhaseSchema>, string>;
export const companionResetSchema = z.strictObject({
  operation: z.literal('retire_identity'),
  id, companionId: id, scope: z.literal('all'), status: z.enum(['running', 'completed', 'failed']),
  phase: companionRetirePhaseSchema, processed: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(), error: z.string().max(1000).optional(),
  cleanupStage: companionResetCleanupStageSchema.optional(),
});
export type CompanionReset = z.infer<typeof companionResetSchema>;
export const companionResetCommands = [
  z.strictObject({ type: z.literal('companion.retire'), id, scope: z.literal('all'), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ type: z.literal('companion.retire.status'), id }),
] as const;
