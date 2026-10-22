import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionTopicSchema = z.object({ id, conversationId: id, title: z.string().trim().min(1).max(120),
  kind: z.enum(['discussion', 'game', 'story']), status: z.enum(['active', 'paused', 'closed']), forkedFromTopicId: id.optional(), deletedAt: z.string().optional(),
  participantIds: z.array(id).max(21), invitedIds: z.array(id).max(21), tags: z.array(z.string().trim().min(1).max(80)).max(50), moderatorId: id,
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string() });
export type CompanionTopic = z.infer<typeof companionTopicSchema>;
export const companionTopicCheckpointInputSchema = z.strictObject({ stage: z.string().max(1000).optional(),
  summary: z.string().max(32000).optional(), state: z.record(z.string(), z.unknown()).refine(value => JSON.stringify(value).length <= 512000).optional(),
  sourceMessageIds: z.array(id).max(256).default([]) });
export const companionTopicCheckpointSchema = companionTopicCheckpointInputSchema.extend({ sourceEventId: id,
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
export const companionTopicPublicCommands = [create, list, read, update, activate, pause, resume, close, reopen, remove, fork, join, leave] as const;
/** The reader is bound by Main; a model never chooses another participant's private state. */
export const companionTopicStorageCommands = [create.extend({ readerId: id }), list.extend({ readerId: id }), read.extend({ readerId: id }),
  update.extend({ readerId: id, maintenance: z.boolean().optional() }), activate.extend({ readerId: id }), pause.extend({ readerId: id }), resume.extend({ readerId: id }), close.extend({ readerId: id }),
  reopen.extend({ readerId: id }), remove.extend({ readerId: id }), fork.extend({ readerId: id }), join.extend({ readerId: id }), leave.extend({ readerId: id })] as const;
export const companionTopicArgumentsSchema = z.union(companionTopicPublicCommands.map(command => {
  const { type, conversationId: _conversationId, ...shape } = command.shape; void _conversationId;
  return z.strictObject({ ...shape, action: z.literal(type.value.slice('topic.'.length)) });
}) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]]);
