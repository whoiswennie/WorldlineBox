import { z } from 'zod';
import { companionTopicArgumentsSchema, companionTopicOperationSchema, companionTopicOperationExample, COMPANION_TOPIC_CONTINUITY_RULES, COMPANION_TOPIC_STATE_WRITE_RECEIPT } from '../../shared/companion-topic';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';
import type { CompanionGameTopicUpdate, CompanionGameTopicPrivacyReview } from './game-topic-privacy';
import type { CompanionTopicModeratorTransferApproval } from '../../shared/companion-topic';
import type { CompanionTopicModeratorTransfer } from './topic-moderator-transfer';

/** Self-managed topics can explicitly target a real member room without
 * changing the current message port or choosing another reader's identity. */
export function companionTopicCapabilities(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>,
  scope: { companionId: string; conversationId: string }, other?: CompanionStructuredAgentCapabilities,
  options: { reviewUpdate?(command: CompanionGameTopicUpdate, signal?: AbortSignal): Promise<CompanionGameTopicPrivacyReview>;
    reviewTransfer?(command: CompanionTopicModeratorTransfer, signal?: AbortSignal): Promise<CompanionTopicModeratorTransferApproval> } = {}): CompanionStructuredAgentCapabilities {
  const schema = z.strictObject({ action: z.literal('topic'), parameters: companionTopicArgumentsSchema });
  const parameters = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>; delete parameters.$schema;
  const worldTools = (other?.tools ?? []).filter(tool => tool.name === 'world');
  const combinedParameters = worldTools.length ? { type: 'object', anyOf: [...worldTools.map(tool => tool.parameters), parameters] } : { type: 'object', ...parameters };
  return { journal: other?.journal, replaySafe: other?.replaySafe ?? true, continuityRequest: request,
    tools: [...(other?.tools ?? []).filter(tool => tool.name !== 'world'), { name: 'world', parameters: combinedParameters,
    description: worldTools.map(tool => tool.description).join('\n') + '\n管理本人在当前真实会话的话题。action=topic，parameters.action=create/list/read/join/leave/activate/update/transfer_moderator/pause/resume/close/reopen/fork/delete。topic.create可在创建时指定moderatorId；创建只代表本人加入，其他成员必须自愿join；当前主持可用transfer_moderator向本话题已加入且公开自愿主持的成员交接，sourceMessageIds填写对方本人真实同意的本话题公开发言，先read使用真实expectedRevision；移交不复制任何私态。activate与pause仅替换本人上下文。update先read取得真实topicId和最新revision；parameters.roomId/topicId/expectedRevision与parameters.patch同级，绝不能塞进patch。patch只含title/shared/workingState/privateRecipientId/tags/invitedIds；活动自定义字段放patch.shared.state或patch.workingState.state，来源ID放相应sourceMessageIds。update只能更新本人workingState，主持人可管理shared与分发私态；不能越过宿主ACL。话题是可持续压缩的工作上下文，游戏/小说不写成全局现实事实。' + COMPANION_TOPIC_CONTINUITY_RULES }],
    execute: async (call, signal) => {
      signal?.throwIfAborted();
      if (call.name !== 'world') { if (!other) throw new Error('当前没有该能力。'); return other.execute(call, signal); }
      let body: unknown;
      try { body = JSON.parse(call.arguments); }
      catch { return { ok: false, error: '话题调用必须是合法JSON，外层action=topic，具体操作放parameters.action。',
        argumentIssues: [{ path: '$', code: 'invalid_json', message: '请修正JSON语法后重试。' }] }; }
      if (body && typeof body === 'object' && 'action' in body && body.action !== 'topic') {
        if (other) return other.execute(call, signal);
        throw new Error('当前入口没有提供此世界能力。');
      }
      const envelope = z.strictObject({ action: z.literal('topic'), parameters: z.record(z.string(), z.unknown()) }).safeParse(body);
      const feedback = (issues: readonly z.core.$ZodIssue[], action?: string, prefix: string[] = []) => {
        const argumentIssues = issues.flatMap(issue => {
          const base = [...prefix, ...issue.path.map(String)];
          const paths = issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...base, key]) : [base];
          return paths.map(parts => {
            const path = parts.join('.') || '$', field = parts.at(-1);
            let message = issue.message;
            if (parts[0] === 'parameters' && parts[1] === 'patch' && ['roomId', 'topicId', 'expectedRevision'].includes(field ?? '')) message = `${field}属于parameters.${field}，须与parameters.patch同级。`;
            else if (path === 'parameters.expectedRevision') message = 'expectedRevision必须为该话题read返回的最新正整数revision。';
            else if (path === 'parameters.patch.state') message = '自定义状态应放parameters.patch.shared.state或parameters.patch.workingState.state。';
            return { path, code: issue.code, message };
          });
        }).slice(0, 12);
        return { ok: false, error: '话题参数无效：' + argumentIssues.map(issue => `${issue.path}: ${issue.message}`).join('；'), argumentIssues,
          minimumExample: action ? companionTopicOperationExample(action) : undefined };
      };
      if (!envelope.success) return feedback(envelope.error.issues);
      const operation = envelope.data.parameters.action;
      const operationSchema = typeof operation === 'string' ? companionTopicOperationSchema(operation) : undefined;
      if (!operationSchema) return { ok: false, error: 'parameters.action必须选择create/list/read/join/leave/activate/update/transfer_moderator/pause/resume/close/reopen/fork/delete。',
        argumentIssues: [{ path: 'parameters.action', code: 'invalid_value', message: '请选择一个受支持的话题操作。' }] };
      const parsed = operationSchema.safeParse(envelope.data.parameters);
      if (!parsed.success) return feedback(parsed.error.issues, String(operation), ['parameters']);
      const args = parsed.data as z.infer<typeof companionTopicArgumentsSchema>;
      const { action, roomId, ...payload } = args;
      let command = { type: 'topic.' + action, ...payload, conversationId: roomId ?? scope.conversationId,
        readerId: scope.companionId, operationId: 'brain_' + call.id } as CompanionStorageCommand;
      if (command.type === 'topic.update' && options.reviewUpdate) {
        const review = await options.reviewUpdate(command, signal);
        if (!review.allowed) return { ok: false, error: '游戏话题公开载荷未通过隐私核验，未写入。' + (review.reason ?? '请修订公开字段，秘密保存到正确私态。') };
      }
      if (command.type === 'topic.transfer_moderator') {
        if (!options.reviewTransfer) return { ok: false, error: '当前入口没有主持移交的真实同意核验能力，未更换主持。' };
        const moderatorTransferApproval = await options.reviewTransfer(command, signal);
        signal?.throwIfAborted();
        command = { ...command, moderatorTransferApproval };
      }
      const result = await request(command);
      if (action === 'join' && result.ok && result.topic?.participantIds.includes(scope.companionId)) {
        const adopted = await request({ type: 'activity.port.adopt_candidate', companionId: scope.companionId,
          conversationId: result.topic.conversationId, topicId: result.topic.id });
        if (adopted.activityTask) return { ...result, activityTask: adopted.activityTask };
      }
      return action === 'update' && result.ok ? { ...result, topicDelivery: COMPANION_TOPIC_STATE_WRITE_RECEIPT } : result;
    } };
}
