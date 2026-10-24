import { z } from 'zod';
import { createHash } from 'node:crypto';
import { companionWorldArgumentsSchema } from '../../shared/companion-world-tool';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';
import { companionSocialDeliveryReceipt } from './social-continuation';
import { companionGameStateHandoffReceipt } from '../../shared/companion-topic';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';

/** Social agency is available to a peer's own brain; no shell, player grant or foreign identity. */
export function companionSocialCapabilities(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>,
  scope: { companionId: string; conversationId: string; beforeSequence?: number; sourceMessageId?: string }, other: CompanionStructuredAgentCapabilities,
  authorize?: (input: { text: string; recipientIds: string[]; action: 'message' | 'introduce' | 'create_group' }, signal?: AbortSignal) => Promise<boolean>,
  options: { gamePort?: { conversationId: string; topicId: string }; executionReadset?(): CompanionExecutionReadset | undefined } = {}): CompanionStructuredAgentCapabilities {
  const actions = new Set(['query', 'inspect', 'introduce', 'message', 'create_group']);
  const schema = z.union(companionWorldArgumentsSchema.options.filter(option => actions.has(option.shape.action.value)));
  const worldTool = other.tools.find(tool => tool.name === 'world');
  const ownParameters = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>; delete ownParameters.$schema;
  const parameters = worldTool ? { type: 'object', anyOf: [worldTool.parameters, ownParameters] } : { type: 'object', ...ownParameters };
  return { journal: other.journal, replaySafe: other.replaySafe, continuityRequest: other.continuityRequest,
    tools: [...other.tools.filter(tool => tool.name !== 'world'), { name: 'world', parameters,
    description: `${worldTool?.description ?? ''}\n还可inspect/query(contacts熟人、people公开世界居民、social本人社交)。introduce(targetCompanionId,text)主动自我介绍，message(recipientIds,text)联系熟人，create_group(recipientIds,title,text,includePlayer)与至少两位熟人建群；includePlayer=true邀请真人入群。只发自己的问候或本次公开讨论中的必要邀约；宿主已核验的同局game reference允许本人必要游戏通信，仍按实际收件人保护秘密。不转发无关私聊，不替他人接受，不授现实操作权限。待发不等于送达，不能重复创建相同邀请。` }],
    execute: async (call, signal) => {
      signal?.throwIfAborted();
      if (call.name !== 'world') return other.execute(call, signal);
      const value = JSON.parse(call.arguments) as { action?: string };
      if (!actions.has(value.action ?? '')) return other.execute(call, signal);
      const args = companionWorldArgumentsSchema.parse(value);
      if (args.action === 'message' || args.action === 'introduce' || args.action === 'create_group') {
        const recipients = args.action === 'introduce' ? [args.targetCompanionId] : args.recipientIds;
        if (!authorize || !await authorize({ text: args.text, recipientIds: recipients, action: args.action }, signal)) throw new Error('只能以自己的身份发出当前获准的虚拟通信，不能转发私聊或扩大现实任务权限。');
      }
      const clientId = 'peer_' + createHash('sha256').update(JSON.stringify([scope, call.id, args])).digest('hex').slice(0, 48);
      let command: CompanionStorageCommand;
      if (args.action === 'message') {
        await request({ type: 'social.contact.check', companionId: scope.companionId, recipientIds: args.recipientIds });
        const peer = (await request({ type: 'social.conversation.ensure', companionId: scope.companionId,
          memberIds: [scope.companionId, ...args.recipientIds], ...(args.roomId ? { roomId: args.roomId } : {}) })).socialConversation;
        if (!peer) throw new Error('实际社交会话不可访问，未发送。');
        const readset = options.executionReadset?.();
        command = { type: 'social.send', companionId: scope.companionId, conversationId: peer.id, content: args.text,
          channel: 'phone', clientId, ...(args.topicId !== undefined ? { topicId: args.topicId } : {}), urgent: args.urgent,
          ...(scope.sourceMessageId ? { agentSource: { conversationId: scope.conversationId, messageId: scope.sourceMessageId } } : {}),
          ...(readset ? { executionReadset: { ...readset, conversationId: peer.id } } : {}) };
      } else command = { type: 'world.tool', ...scope, clientId, arguments: args };
      let result = await request(command);
      // The host completes the natural typing interval. The model receives one
      // real receipt instead of spending inference turns re-sending an invite.
      for (let attempt = 0; result.socialPending && attempt < 54; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150)); signal?.throwIfAborted();
        await request({ type: 'world.tick' }); result = await request(command);
      }
      if (args.action === 'create_group' && result.ok && result.topic?.kind === 'game' && scope.sourceMessageId) {
        const bound = await request({ type: 'activity.social.bind_peer_port', companionId: scope.companionId,
          conversationId: scope.conversationId, sourceMessageId: scope.sourceMessageId, deliveryClientId: result.socialDeliveryClientId ?? clientId });
        return { ...result, ...(bound.activityTask ? { activityTask: bound.activityTask } : { activityBinding: { bound: false, reason: bound.error } }),
          socialDelivery: companionSocialDeliveryReceipt(args.action, {}) };
      }
      return args.action === 'message' || args.action === 'introduce' || args.action === 'create_group'
        ? { ...result, socialDelivery: companionSocialDeliveryReceipt(args.action, {}), ...(args.action === 'message' && options.gamePort
          ? { gameStateHandoff: companionGameStateHandoffReceipt(options.gamePort) } : {}) } : result;
    } };
}
