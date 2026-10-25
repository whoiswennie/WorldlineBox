import { z } from 'zod';
import { dshRecordQuerySchema, type DshRecordQuery } from '../../shared/dsh-task-record';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';

const task = z.strictObject({ title: z.string().trim().min(1).max(100), prompt: z.string().trim().min(1).max(16000) });
const run = z.strictObject({ operation: z.literal('run').optional(), tasks: z.array(task).length(1) });
const record = z.strictObject({ operation: z.literal('record'), query: dshRecordQuerySchema });

/** A role's computation extension uses the existing DSH action pipeline.
 * Neither a peer message nor this adapter grants execution tools or a session. */
export function companionThoughtCapabilities(base: CompanionStructuredAgentCapabilities, handlers: {
  run(input: z.infer<typeof task>, effectId: string, signal?: AbortSignal): Promise<unknown>;
  read?(query: DshRecordQuery, signal?: AbortSignal): Promise<unknown>;
}): CompanionStructuredAgentCapabilities {
  if (base.tools.some(tool => tool.name === 'dsh')) throw new Error('当前入口已经绑定DSH能力，不能替换其执行范围。');
  const schema = handlers.read ? z.union([run, record]) : run;
  const parameters = z.toJSONSchema(schema, { io: 'input' }); delete parameters.$schema;
  return { ...base, dshContext: 'thought', tools: [...base.tools, { name: 'dsh',
    description: '独立思考与复核本人当前已获权资料。operation=run，tasks只提交一个title与prompt；宿主使用独立新会话，禁用所有工具、技能、文件、网络和代码执行，不占虚拟电脑。可用于多步分析、检验假设、比较方案或创作，是否需要由本人决定。只返回分析，不能当作实际行动或他人决定。'
      + '宿主会自动附上当前已合法读过的有限消息原文和来源目录；摘录与省略会明确标注，来源陈述不等于事实。需要核对资料冲突时可将问题交给独立分析，不必自行重写或补全全部来源。'
      + (handlers.read ? '结果过长时，用operation=record与query按recordId/start/end/snapshot/textOffset渐进读取本次推理来源的真实记录；遵循nextStart/nextTextOffset，概览截断不是完整结论。' : ''),
    parameters: { type: 'object', ...parameters } }], execute: async (call, signal) => {
    if (call.name !== 'dsh') return base.execute(call, signal);
    signal?.throwIfAborted();
    const input = schema.parse(JSON.parse(call.arguments));
    if ('query' in input) return handlers.read!(input.query, signal);
    return handlers.run(input.tasks[0]!, call.id, signal);
  } };
}
