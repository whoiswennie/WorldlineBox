import { z } from 'zod';
export const COMPANION_TOPIC_STATE_WRITE_RECEIPT = { stateStored: true, messageSent: false, recipientAwakened: false,
  notice: '本操作只保存话题状态，未发送消息或唤醒接收者。需要对方处理时，继续发送不含私牌等秘密的真实群通知；私密行动与结果应通过实际单独通信，不能公开给全员。' } as const;
export function companionGameStateHandoffReceipt(gamePort: { conversationId: string; topicId: string }) {
  return { automaticTopicStateTransfer: false as const, gamePort: { conversationId: gamePort.conversationId, topicId: gamePort.topicId },
    notice: '本操作只处理这条真实通信的送达或排队，不会自动把私信正文写入其他入口的游戏工作状态。身份、秘密行动或查验结果需要在此gamePort显式topic.update：主持给真实已加入成员用privateRecipientId+workingState，本人的秘密用自己的workingState；随后另行真实单独通知或发不含秘密的公共提示。不要把私信已送达当成游戏私态已写入，也不要把秘密写shared。' };
}

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const publicationReference = z.strictObject({ messageId: id, contentChecksum: z.string().regex(/^[a-f0-9]{64}$/u), authorId: id });
const publicationViewAvailability = z.enum(['available', 'unavailable', 'legacy_order_unknown', 'none']);
export const companionTopicSchema = z.object({ id, conversationId: id, title: z.string().trim().min(1).max(120),
  kind: z.enum(['discussion', 'game', 'story']), status: z.enum(['active', 'paused', 'closed']), forkedFromTopicId: id.optional(), deletedAt: z.string().optional(),
  participantIds: z.array(id).max(21), invitedIds: z.array(id).max(21), tags: z.array(z.string().trim().min(1).max(80)).max(50), moderatorId: id,
  revision: z.number().int().positive(), formalPublicationRevision: z.number().int().nonnegative().safe().optional(),
  lastPublicationRef: publicationReference.optional(),
  lastPublicationAvailability: z.enum(['available', 'unavailable']).optional(),
  // Read-only views over the existing publication index, never model patches
  // or a second persisted publication ledger. Creation sequence is not order.
  lastNarrativePublicationRef: publicationReference.extend({ publicationRevision: z.number().int().positive().safe() }).optional(),
  lastNarrativePublicationAvailability: publicationViewAvailability.optional(),
  lastInputPublicationRef: publicationReference.extend({ publicationRevision: z.number().int().positive().safe() }).optional(),
  lastInputPublicationAvailability: publicationViewAvailability.optional(),
  createdAt: z.string(), updatedAt: z.string() });
export type CompanionTopic = z.infer<typeof companionTopicSchema>;
export const companionTopicCheckpointInputSchema = z.strictObject({ stage: z.string().max(1000).optional(),
  summary: z.string().max(32000).optional(), state: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 512000).optional(),
  sourceMessageIds: z.array(id).max(256).default([]) });
export const companionTopicCheckpointSchema = companionTopicCheckpointInputSchema.extend({ sourceEventId: id,
  // Host-owned immutable provenance, kept out of the public/model patch schema.
  derivedFromEventIds: z.array(id).max(2).optional(),
  sourceChecksums: z.record(id, z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  updatedAt: z.string(), authorId: id, revision: z.number().int().positive() });
export const companionTopicStateSchema = z.object({ topicId: id, readerId: id,
  shared: companionTopicCheckpointSchema.optional(), workingState: companionTopicCheckpointSchema.optional(),
  trust: z.literal('topic_state_not_real_world_facts') });
export type CompanionTopicState = z.infer<typeof companionTopicStateSchema>;
export const companionTopicPatchSchema = z.strictObject({ title: z.string().trim().min(1).max(120).optional(),
  shared: companionTopicCheckpointInputSchema.optional(), workingState: companionTopicCheckpointInputSchema.optional(),
  privateRecipientId: id.optional(), tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(), invitedIds: z.array(id).max(21).optional() });
const create = z.strictObject({ type: z.literal('topic.create'), conversationId: id, title: z.string().trim().min(1).max(120),
  kind: z.enum(['discussion', 'game', 'story']), participantIds: z.array(id).max(21).optional(), moderatorId: id.optional(), tags: z.array(z.string().trim().min(1).max(80)).max(50).optional() });
const list = z.strictObject({ type: z.literal('topic.list'), conversationId: id, query: z.string().trim().max(200).optional(),
  status: z.enum(['active', 'paused', 'closed']).optional(), tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).optional() });
const read = z.strictObject({ type: z.literal('topic.read'), conversationId: id, topicId: id });
const update = z.strictObject({ type: z.literal('topic.update'), conversationId: id, topicId: id,
  expectedRevision: z.number().int().positive(), patch: companionTopicPatchSchema });
const activate = z.strictObject({ type: z.literal('topic.activate'), conversationId: id, topicId: id.nullable() });
const pause = z.strictObject({ type: z.literal('topic.pause'), conversationId: id, topicId: id, expectedRevision: z.number().int().positive() });
const resume = z.strictObject({ type: z.literal('topic.resume'), conversationId: id, topicId: id, expectedRevision: z.number().int().positive() });
const close = z.strictObject({ type: z.literal('topic.close'), conversationId: id, topicId: id, expectedRevision: z.number().int().positive() });
const reopen = z.strictObject({ type: z.literal('topic.reopen'), conversationId: id, topicId: id, expectedRevision: z.number().int().positive() });
const remove = z.strictObject({ type: z.literal('topic.delete'), conversationId: id, topicId: id, expectedRevision: z.number().int().positive() });
const fork = z.strictObject({ type: z.literal('topic.fork'), conversationId: id, topicId: id, title: z.string().trim().min(1).max(120) });
const join = z.strictObject({ type: z.literal('topic.join'), conversationId: id, topicId: id });
const leave = z.strictObject({ type: z.literal('topic.leave'), conversationId: id, topicId: id });
export const COMPANION_TOPIC_CONTINUITY_RULES = '全新一局、独立故事或新的活动实例使用create，产生全新topicId，不继承旧局身份、规则、私态或摘要。reopen只恢复同一话题的原有进度；fork是从旧档创建续写分支，保留公共快照与分支创建者本人私态，其他成员只受邀且不会继承各自旧私态；二者均不表示全新一局。';
const actionDescriptions: Record<string, string> = {
  create: '创建独立的新话题/新局。产生新topicId，初始公共与私人状态均为空；其他参与者需自愿join。',
  update: '先read取得真实topicId及最新revision。roomId、topicId、expectedRevision与patch同级；patch只含title/shared/workingState/privateRecipientId/tags/invitedIds，自定义活动状态放shared.state或workingState.state。',
  reopen: '恢复同一个已结束话题的既有进度、规则和私态。不是新局；全新一局请create。',
  fork: '基于旧话题快照创建续写分支，保留公共和本人私态。不会复制其他人的私态或原始消息；不是新局。',
};
export const companionTopicPublicCommands = [create, list, read, update, activate, pause, resume, close, reopen, remove, fork, join, leave] as const;
/** The reader is bound by Main; a model never chooses another participant's private state. */
const topicStorageCommandSchemas = [create.extend({ readerId: id }), list.extend({ readerId: id }), read.extend({ readerId: id }),
  z.strictObject({ type: z.literal('topic.compaction.sources'), conversationId: id, topicId: id, readerId: id,
    afterPublicationRevision: z.number().int().nonnegative().safe(), throughPublicationRevision: z.number().int().nonnegative().safe().optional(),
    legacyAfterSequence: z.number().int().nonnegative().safe(), legacyThroughSequence: z.number().int().nonnegative().safe().optional(),
    beforeSequence: z.number().int().nonnegative().safe(), sourceMessageId: id.optional(), sourceChecksum: z.string().regex(/^[a-f0-9]{64}$/u).optional(), limit: z.number().int().min(1).max(100).optional() }),
  update.extend({ readerId: id, maintenance: z.boolean().optional(), compaction: z.strictObject({
    previousWorkingEventId: id.nullable(), sharedEventId: id.nullable(),
    sourceChecksums: z.record(id, z.string().regex(/^[a-f0-9]{64}$/)),
    publicationCoverage: z.strictObject({ expectedFormalPublicationRevision: z.number().int().nonnegative().safe(),
      sourcePublicationRevisions: z.record(id, z.number().int().positive().safe()) }).optional(),
  }).optional() }), activate.extend({ readerId: id }), pause.extend({ readerId: id }), resume.extend({ readerId: id }), close.extend({ readerId: id }),
  reopen.extend({ readerId: id }), remove.extend({ readerId: id }), fork.extend({ readerId: id }), join.extend({ readerId: id }), leave.extend({ readerId: id }),
  z.strictObject({ type: z.literal('topic.sources.valid'), conversationId: id, topicId: id, readerId: id, sourceMessageIds: z.array(id).max(256),
    checkpointEventIds: z.array(id).min(1).max(2).optional() }),
] as const;
type WithOperationId<T extends readonly z.ZodObject[]> = { [K in keyof T]: T[K] extends z.ZodObject<infer Shape>
  ? z.ZodObject<Shape & { operationId: z.ZodOptional<typeof id> }> : never };
/** Host effect identity is independent of provider call IDs and is never model-selectable. */
export const companionTopicStorageCommands = topicStorageCommandSchemas.map(schema => schema.extend({ operationId: id.optional() })) as unknown as WithOperationId<typeof topicStorageCommandSchemas>;
const topicOperationSchemas = companionTopicPublicCommands.map(command => {
  const { type, conversationId: _conversationId, ...shape } = command.shape; void _conversationId;
  const action = type.value.slice('topic.'.length), literal = z.literal(action);
  return z.strictObject({ ...shape, roomId: id.optional().describe('显式管理本人实际参与的目标会话；不改变当前消息入口、身份或权限。省略时使用当前会话。'),
    action: actionDescriptions[action] ? literal.describe(actionDescriptions[action]) : literal });
});
export const companionTopicArgumentsSchema = z.union(topicOperationSchemas as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);

/** Validate a selected operation directly, so union alternatives cannot bury
 * the actual failing field under unrelated create/list/fork requirements. */
export function companionTopicOperationSchema(action: string): z.ZodType | undefined {
  return topicOperationSchemas.find(schema => schema.shape.action.safeParse(action).success);
}

/** Shape examples use placeholders; callers still need real read receipts and
 * the latest revision. These examples never execute or supply authorization. */
export function companionTopicOperationExample(action: string): unknown {
  const parameters: Record<string, unknown> = { action };
  if (action === 'create') Object.assign(parameters, { title: '新话题标题', kind: 'discussion' });
  else if (action === 'list') { /* The actual current room is sufficient. */ }
  else if (['read', 'join', 'leave', 'activate'].includes(action)) parameters.topicId = 'existing_topic';
  else if (action === 'fork') Object.assign(parameters, { topicId: 'existing_topic', title: '续写分支标题' });
  else if (['update', 'pause', 'resume', 'close', 'reopen', 'delete'].includes(action)) {
    Object.assign(parameters, { topicId: 'existing_topic', expectedRevision: 1 });
    if (action === 'update') parameters.patch = { workingState: { summary: '本人本轮已确认的进度', sourceMessageIds: [] } };
  } else return undefined;
  return { action: 'topic', parameters };
}
