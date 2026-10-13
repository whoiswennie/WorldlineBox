import { z } from 'zod';

export const companionDshTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(16000), companionId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
});
export const companionDshArgumentsSchema = z.strictObject({ tasks: z.array(companionDshTaskSchema).min(1).max(4) });
export const COMPANION_DSH_TOOL = {
  name: 'dsh',
  description: '你的唯一行动能力。每个 task 启动独立的完整 agent loop，内部自行规划、调用文件/终端/搜索等工具、读取结果、修正并继续，直到完成目标或遇到实际阻碍。提交完整目标与用户限制，不提交孤立 shell 动作。互不依赖的任务可一次提交最多四个并发运行；依赖前一步结果或修改同一资源的动作放在同一个 task 内顺序执行。用户已经提出任务时直接使用，不反问是否使用 DSH，也不要求用户选工具。聊天里自然说“我看看/我来处理”，不提内部执行器名。进度实时返回；只有实际证据才能说已经完成。',
  parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 1, maxItems: 4,
    items: { type: 'object', properties: { title: { type: 'string', maxLength: 100 }, prompt: { type: 'string', maxLength: 16000 } },
      required: ['title', 'prompt'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
} as const;
