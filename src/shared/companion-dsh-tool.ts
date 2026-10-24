import { z } from 'zod';
import { dshRecordQuerySchema } from './dsh-task-record';
import { dshTaskSpecSchema } from './dsh-task-spec';

export const companionDshRecordArgumentsSchema = dshRecordQuerySchema;
export const companionDshTaskSchema = z.strictObject({
  ...dshTaskSpecSchema.shape,
  title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(16000), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
});
export const companionDshArgumentsSchema = z.strictObject({ tasks: z.array(companionDshTaskSchema).min(1).max(4) });
export const COMPANION_DSH_TOOL = {
  name: 'dsh',
  description: '你的电脑外部执行能力，独立于宿主原生记忆、授权资料阅读和虚拟世界能力。每个 task 运行完整 agent loop，内部规划、调用工具、读取结果、修正并继续，直到完成目标或遇到实际阻碍。提交完整目标与用户限制，不提交孤立 shell 动作。默认新建独立会话和伙伴专属工作目录；session.resume 使用已有收据的 resumeTaskId 续用，同会话保留原工作目录、mode、tools 与 skills。mode、tools、skills 只能选当前能力目录中的名称；省略表示沿用实例组合，空数组表示不启用。instructions 与 context 只传本次需要的要求和资料，不复制你的全部聊天上下文。文件交付应允许 present 工具并让执行器声明实际文件；文本路径不会被补造成交付。delivery.format=json 要求最终回复为有效 JSON。插件、账号、模型由宿主管理。互不依赖的任务可一次提交最多四个并发运行；依赖前一步结果或修改同一资源的动作放在同一个 task 内顺序执行。用户已经提出任务时直接使用，不反问是否使用 DSH，也不要求用户选工具。聊天里自然说“我看看/我来处理”，不提内部执行器名。进度实时展示给界面；默认返回统计摘要、最终回复、交付文件及 recordId（UUID），不返回全部过程。最终回复或结构化结果若截断须调用 dsh(operation=record) 渐进核查，只有实际证据才能说已经完成。',
  parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 4,
    items: { type: 'object', properties: { title: { type: 'string', maxLength: 100 }, prompt: { type: 'string', maxLength: 16000 },
      instructions: { type: 'string', maxLength: 16000 },
      context: { type: 'object', properties: { text: { type: 'string', maxLength: 16000 }, files: { type: 'array', maxItems: 20, items: { type: 'string' } } }, additionalProperties: false },
      mode: { type: 'string', enum: ['native', 'ptc'] }, tools: { type: 'array', maxItems: 100, items: { type: 'string' } }, skills: { type: 'array', maxItems: 30, items: { type: 'string' } },
      session: { type: 'object', properties: { mode: { type: 'string', enum: ['new', 'resume'] }, taskId: { type: 'string', format: 'uuid' } }, required: ['mode'], additionalProperties: false },
      workspace: { type: 'object', properties: { mode: { type: 'string', enum: ['managed', 'existing'] }, path: { type: 'string' } }, required: ['mode'], additionalProperties: false },
      delivery: { type: 'object', properties: { format: { type: 'string', enum: ['text', 'json'] }, requirements: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        jsonSchema: { type: 'object', description: 'Business JSON schema: type, properties, required, additionalProperties, items, enum/const, numeric/string/array bounds. Other assertion keywords are rejected.' },
        artifacts: { type: 'array', maxItems: 100, items: { type: 'object', properties: { path: { type: 'string', maxLength: 4096 },
          minBytes: { type: 'integer', minimum: 0 }, maxBytes: { type: 'integer', minimum: 0 }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          containsText: { type: 'string', maxLength: 16000 } }, required: ['path'], additionalProperties: false } } }, required: ['format'], additionalProperties: false } },
      required: ['title', 'prompt'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
} as const;
