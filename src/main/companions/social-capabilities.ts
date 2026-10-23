import { z } from 'zod';
import { createHash } from 'node:crypto';
import { companionWorldArgumentsSchema } from '../../shared/companion-world-tool';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';

/** Social agency is available to a peer's own brain; no shell, player grant or foreign identity. */
export function companionSocialCapabilities(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>,
  scope: { companionId: string; conversationId: string; beforeSequence?: number; sourceMessageId?: string }, other: CompanionStructuredAgentCapabilities,
  authorize?: (input: { text: string; recipientIds: string[] }, signal?: AbortSignal) => Promise<boolean>): CompanionStructuredAgentCapabilities {
  const actions = new Set(['query', 'inspect', 'introduce', 'message', 'create_group']);
  const schema = z.union(companionWorldArgumentsSchema.options.filter(option => actions.has(option.shape.action.value)));
  const worldTool = other.tools.find(tool => tool.name === 'world');
  const ownParameters = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>; delete ownParameters.$schema;
  const parameters = worldTool ? { type: 'object', anyOf: [worldTool.parameters, ownParameters] } : { type: 'object', ...ownParameters };
  return { tools: [...other.tools.filter(tool => tool.name !== 'world'), { name: 'world', parameters,
    description: `${worldTool?.description ?? ''}\n还可inspect/query(contacts熟人、people公开世界居民、social本人社交)。introduce(targetCompanionId,text)主动自我介绍，message(recipientIds,text)联系熟人，create_group(recipientIds,title,text,includePlayer)与至少两位熟人建群；includePlayer=true邀请真人入群。只发自己的问候或本次公开讨论中的必要邀约，不转发私聊，不替他人接受，不授现实操作权限。待发不等于送达，不能重复创建相同邀请。` }],
    execute: async (call, signal) => {
      signal?.throwIfAborted();
      if (call.name !== 'world') return other.execute(call, signal);
      const value = JSON.parse(call.arguments) as { action?: string };
      if (!actions.has(value.action ?? '')) return other.execute(call, signal);
      const args = companionWorldArgumentsSchema.parse(value);
      if (args.action === 'message' || args.action === 'introduce' || args.action === 'create_group') {
        const recipients = args.action === 'introduce' ? [args.targetCompanionId] : args.recipientIds;
        if (!authorize || !await authorize({ text: args.text, recipientIds: recipients }, signal)) throw new Error('只能以自己的身份发出虚拟社交问候，不能转发私聊或扩大现实任务权限。');
      }
      const command: CompanionStorageCommand = { type: 'world.tool', ...scope, clientId: 'peer_' + createHash('sha256').update(JSON.stringify([scope, call.id, args])).digest('hex').slice(0, 48), arguments: args };
      let result = await request(command);
      // The host completes the natural typing interval. The model receives one
      // real receipt instead of spending inference turns re-sending an invite.
      for (let attempt = 0; result.socialPending && attempt < 54; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150)); signal?.throwIfAborted();
        await request({ type: 'world.tick' }); result = await request(command);
      }
      return result;
    } };
}
