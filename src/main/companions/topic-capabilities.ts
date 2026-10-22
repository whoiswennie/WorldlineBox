import { z } from 'zod';
import { companionTopicArgumentsSchema } from '../../shared/companion-topic';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';

/** Self-managed topics are available in peer cognition as well as player chat.
 * No model-supplied reader or conversation can escape this actual message port. */
export function companionTopicCapabilities(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>,
  scope: { companionId: string; conversationId: string }, other?: CompanionStructuredAgentCapabilities): CompanionStructuredAgentCapabilities {
  const schema = z.strictObject({ action: z.literal('topic'), parameters: companionTopicArgumentsSchema });
  const parameters = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>; delete parameters.$schema;
  return { tools: [...(other?.tools ?? []), { name: 'world', parameters: { type: 'object', ...parameters },
    description: '管理本人在当前真实会话的话题。action=topic，parameters.action=create/list/read/join/leave/activate/update/pause/resume/close/reopen/fork/delete。创建只代表本人加入，其他成员必须自愿join；activate与pause仅替换本人上下文。update只能更新本人workingState，主持人可管理shared与分发私态；不能越过宿主ACL。话题是可持续压缩的工作上下文，游戏/小说不写成全局现实事实。' }],
    execute: async (call, signal) => {
      signal?.throwIfAborted();
      if (call.name !== 'world') { if (!other) throw new Error('当前没有该能力。'); return other.execute(call, signal); }
      const { parameters: args } = schema.parse(JSON.parse(call.arguments));
      const { action, ...payload } = args;
      return request({ type: 'topic.' + action, ...payload, conversationId: scope.conversationId,
        readerId: scope.companionId } as CompanionStorageCommand);
    } };
}
