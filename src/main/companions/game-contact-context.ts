import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../../shared/companions';
import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { companionStorageResponseSchema, type CompanionStorageCommand, type CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionTopic, CompanionTopicState } from '../../shared/companion-topic';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import { companionSocialGameContextSchema, type CompanionSocialJob, type CompanionSocialGameContext } from '../../shared/companion-social';
import { captureCompanionExecutionReadset } from './execution-evidence';

const verified = new WeakSet<object>();
const verifiedInitiatives = new WeakSet<object>();
const checksum = (text: string) => createHash('sha256').update(text).digest('hex');
type Scope = { companionId: string; conversationId: string };
export interface CompanionGameInitiativeContext {
  actorId: string; sourceMessageId: string; sourceChecksum: string; topic: CompanionTopic; ownState: CompanionTopicState;
  delivery: { recipientIds: string[]; audience: 'individual' | 'multiple_participants' };
  trust: 'actual_joined_game_own_virtual_communication_not_human_execution_authority';
}
export const isVerifiedCompanionGameInitiativeContext = (value: CompanionGameInitiativeContext | undefined): boolean => !!value && verifiedInitiatives.has(value);
/** The worker selects this reference from the exact leased delivery lineage.
 * Neither a supplied topic ID nor a peer's claim can select a different game. */
export async function loadCompanionGameCommunication(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  job: CompanionSocialJob; source: CompanionMessage; recipientIds?: string[];
}): Promise<CompanionSocialGameContext | undefined> {
  const { job, source } = input;
  if (!job.leaseToken || job.sourceMessageId !== source.id || job.conversationId !== source.conversationId) return;
  const response = await request({ type: 'social.job.game_context', id: job.id, leaseToken: job.leaseToken,
    companionId: job.companionId, conversationId: job.conversationId, sourceMessageId: source.id,
    sourceChecksum: checksum(source.content), recipientIds: input.recipientIds ?? [] });
  const parsed = companionSocialGameContextSchema.safeParse(response.socialGameContext);
  if (!response.ok || !parsed.success) return;
  const value = parsed.data;
  if (value.binding.jobId !== job.id || value.binding.companionId !== job.companionId || value.binding.sourceMessageId !== source.id
    || value.binding.sourceConversationId !== source.conversationId || value.binding.sourceChecksum !== checksum(source.content)) return;
  return value;
}
/** A participant may communicate its own game actions. Only the actual source
 * topic admits this context; a peer's words never create player authority. */
export async function resolveCompanionGameInitiativeContext(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  scope: Scope; source: CompanionMessage; recipientIds: string[]; job?: CompanionSocialJob;
}): Promise<CompanionGameInitiativeContext | undefined> {
  const { scope, source } = input;
  if (source.conversationId !== scope.conversationId || !input.recipientIds.length
    || input.recipientIds.includes(scope.companionId)) return;
  const sourceNow = async () => (await request({ type: 'memory.sources.filter', ...scope, ids: [source.id] })).memorySources?.find(item => item.id === source.id);
  const before = await sourceNow();
  if (!before || before.status !== 'sent' || before.topicId !== source.topicId || before.conversationId !== source.conversationId
    || before.authorId !== source.authorId || checksum(before.content) !== checksum(source.content)) return;
  const bridge = !source.topicId && input.job ? await loadCompanionGameCommunication(request, { job: input.job, source, recipientIds: input.recipientIds }) : undefined;
  if (!source.topicId && !bridge) return;
  const port = bridge?.gamePort ?? { conversationId: scope.conversationId, topicId: source.topicId! };
  const read = bridge ? { ok: true, topic: bridge.topic, topicState: bridge.topicState }
    : await request({ type: 'topic.read', conversationId: port.conversationId, topicId: port.topicId, readerId: scope.companionId });
  if (!read.ok || read.topic?.kind !== 'game' || read.topic.id !== port.topicId || read.topic.conversationId !== port.conversationId || read.topic.status !== 'active' || read.topic.deletedAt
    || read.topicState?.readerId !== scope.companionId || read.topicState.topicId !== port.topicId || !read.topic.participantIds.includes(scope.companionId)
    || input.recipientIds.some(id => !read.topic!.participantIds.includes(id))) return;
  const after = await sourceNow();
  if (!after || after.status !== 'sent' || after.conversationId !== before.conversationId || checksum(after.content) !== checksum(before.content)
    || after.topicId !== before.topicId || after.authorId !== before.authorId) return;
  const context: CompanionGameInitiativeContext = { actorId: scope.companionId, sourceMessageId: source.id, sourceChecksum: checksum(source.content),
    topic: read.topic, ownState: read.topicState, delivery: { recipientIds: [...input.recipientIds], audience: input.recipientIds.length === 1 ? 'individual' : 'multiple_participants' },
    trust: 'actual_joined_game_own_virtual_communication_not_human_execution_authority' };
  verifiedInitiatives.add(context); return context;
}
export interface CompanionGameContactContext {
  kind: 'game'; topicId: string; conversationId: string; topicRevision: number; status: CompanionTopic['status'];
  ownerId: string; ownerRole: 'moderator' | 'participant'; moderatorId: string; participantIds: string[];
  sourceMessageId: string; sourceConversationId: string; sourceChecksum: string;
  provenance: 'current_source_topic' | 'current_invocation_created_group' | 'current_source_activity_port' | 'current_invocation_read_topic';
  scope: 'only_necessary_communication_with_actual_participants_of_this_game';
  permissions: { realExecution: false; privateConversationForwarding: false };
  sharedStage?: string; sharedSummary?: string;
  sharedRules?: CompanionTopicState['shared']; ownPrivateState?: CompanionTopicState['workingState'];
  delivery: { channel: 'phone' | 'face_to_face'; requestedRoomId?: string; requestedTopicId?: string | null;
    actualRecipientIds: string[]; audience: 'individual' | 'multiple_participants'; privateStateMechanism: 'topic.update.patch.privateRecipientId_and_workingState' };
}

/** A creation receipt, rather than a global group search, binds the new port to
 * the current invocation. Never infer a destination from titles or member overlap. */
export function createdInvocationTopicPorts(turns: readonly CompanionLoopTurn[], owner: string) {
  const ports = new Map<string, { roomId: string; topicId: string }>();
  for (const turn of turns) for (const call of turn.calls) {
    try {
      const normalized = normalizeCompanionCapabilityCall(call), args = JSON.parse(normalized.arguments);
      if (normalized.name !== 'world' || args.action !== 'create_group') continue;
      const result = turn.results?.find(item => item.callId === call.id);
      const parsed = result && companionStorageResponseSchema.safeParse(JSON.parse(result.content));
      if (!parsed?.success || !parsed.data.ok) continue;
      const room = parsed.data.socialConversation, topic = parsed.data.topic;
      if (!room || !topic || topic.conversationId !== room.id || !room.memberIds.includes(owner)
        || JSON.stringify([...room.memberIds].sort()) !== JSON.stringify([owner, ...args.recipientIds].sort())) continue;
      ports.set(topic.id, { roomId: room.id, topicId: topic.id });
    } catch { /* Unsuccessful, external or malformed lookalikes are not host ports. */ }
  }
  return [...ports.values()];
}

/** A successful read supplies context only. Its explicit destination must
 * match this send; the current source still supplies all semantic authority. */
function readInvocationTopicPort(turns: readonly CompanionLoopTurn[], scope: Scope,
  delivery: { roomId?: string; topicId?: string | null } | undefined) {
  if (!delivery?.roomId || !delivery.topicId) return;
  for (const turn of turns) for (const call of turn.calls) {
    try {
      const normalized = normalizeCompanionCapabilityCall(call), args = JSON.parse(normalized.arguments);
      if (normalized.name !== 'topic' || args.action !== 'read' || args.roomId !== delivery.roomId || args.topicId !== delivery.topicId) continue;
      const result = turn.results?.find(result => result.callId === call.id);
      const parsed = result && companionStorageResponseSchema.safeParse(JSON.parse(result.content));
      if (!parsed?.success || !parsed.data.ok) continue;
      const topic = parsed.data.topic, state = parsed.data.topicState;
      if (topic?.id === delivery.topicId && topic.conversationId === delivery.roomId && topic.kind === 'game'
        && topic.status === 'active' && !topic.deletedAt && topic.participantIds.includes(scope.companionId)
        && state?.readerId === scope.companionId && state.topicId === topic.id)
        return { roomId: topic.conversationId, topicId: topic.id };
    } catch { /* An unmatched, textual or foreign tool result confers no context. */ }
  }
}

/** Resolve only an already proven source port; this is routing, never an ACL grant. */
export function createdInvocationTopicPort(turns: readonly CompanionLoopTurn[], owner: string, topicId?: string) {
  const ports = createdInvocationTopicPorts(turns, owner);
  return topicId ? ports.find(port => port.topicId === topicId) : ports.length === 1 ? ports[0] : undefined;
}

export async function resolveCompanionInvocationTopicPort(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  scope: Scope; turns: readonly CompanionLoopTurn[]; topicId: string; sourceMessageId?: string;
}) {
  const created = createdInvocationTopicPort(input.turns, input.scope.companionId, input.topicId);
  if (created) return created;
  if (!input.sourceMessageId) return;
  const tasks = (await request({ type: 'activity.list', ...input.scope, limit: 50 })).activityTasks ?? [];
  const ports = tasks.filter(task => task.sourceMessageId === input.sourceMessageId && task.companionId === input.scope.companionId
    && task.conversationId === input.scope.conversationId && task.historyAvailable === true && !['failed', 'cancelled'].includes(task.status))
    .flatMap(task => task.gamePort?.topicId === input.topicId ? [{ roomId: task.gamePort.conversationId, topicId: task.gamePort.topicId }]
      : task.peerTopicId === input.topicId && task.peerConversationId ? [{ roomId: task.peerConversationId, topicId: task.peerTopicId }] : []);
  const unique = [...new Map(ports.map(port => [port.roomId, port])).values()];
  return unique.length === 1 ? unique[0] : undefined;
}

/** The result is created only after current source, exact group and per-reader
 * game ACL reads. A model-supplied JSON object cannot mark itself verified. */
export async function resolveCompanionGameContactContext(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, input: {
  scope: Scope; source: CompanionMessage; recipientIds: readonly string[]; turns: readonly CompanionLoopTurn[]; beforeSequence?: number;
  delivery?: { roomId?: string; topicId?: string | null; channel: 'phone' | 'face_to_face' };
}): Promise<CompanionGameContactContext | undefined> {
  const { scope, source, recipientIds } = input;
  if (source.authorId !== 'user' || source.status !== 'sent' || source.isReplyDraft || source.replyDraft
    || source.conversationId !== scope.conversationId || !recipientIds.length || new Set(recipientIds).size !== recipientIds.length) return;
  const current = (await request({ type: 'memory.sources.filter', ...scope, beforeSequence: input.beforeSequence, ids: [source.id] })).memorySources?.find(item => item.id === source.id);
  if (!current || current.content !== source.content || current.conversationId !== source.conversationId || current.topicId !== source.topicId) return;
  const candidates: Array<{ roomId: string; topicId: string; provenance: CompanionGameContactContext['provenance'] }> = [];
  if (source.topicId) candidates.push({ roomId: source.conversationId, topicId: source.topicId, provenance: 'current_source_topic' });
  candidates.push(...createdInvocationTopicPorts(input.turns, scope.companionId).map(port => ({ ...port, provenance: 'current_invocation_created_group' as const })));
  const tasks = (await request({ type: 'activity.list', ...scope, limit: 50 })).activityTasks ?? [];
  for (const task of tasks) if (task.companionId === scope.companionId && task.conversationId === source.conversationId
    && task.sourceMessageId === source.id && task.historyAvailable === true && !['failed', 'cancelled'].includes(task.status)) {
      if (task.gamePort) candidates.push({ roomId: task.gamePort.conversationId, topicId: task.gamePort.topicId, provenance: 'current_source_activity_port' });
      else if (task.peerConversationId && task.peerTopicId) candidates.push({ roomId: task.peerConversationId, topicId: task.peerTopicId, provenance: 'current_source_activity_port' });
    }
  const readPort = readInvocationTopicPort(input.turns, scope, input.delivery);
  if (readPort) candidates.push({ ...readPort, provenance: 'current_invocation_read_topic' });
  const contexts: CompanionGameContactContext[] = [];
  for (const candidate of candidates) {
    if (contexts.some(context => context.topicId === candidate.topicId)) continue;
    try {
      const read = await request({ type: 'topic.read', conversationId: candidate.roomId, topicId: candidate.topicId, readerId: scope.companionId });
      const topic = read.topic, state = read.topicState;
      if (!read.ok || !topic || topic.kind !== 'game' || topic.status !== 'active' || topic.conversationId !== candidate.roomId || topic.deletedAt
        || !topic.participantIds.includes(scope.companionId) || !recipientIds.every(id => topic.participantIds.includes(id))
        || !state || state.readerId !== scope.companionId || state.topicId !== topic.id) continue;
      const context: CompanionGameContactContext = { kind: 'game', topicId: topic.id, conversationId: topic.conversationId,
        topicRevision: topic.revision, status: topic.status, ownerId: scope.companionId,
        ownerRole: topic.moderatorId === scope.companionId ? 'moderator' : 'participant', moderatorId: topic.moderatorId,
        participantIds: [...topic.participantIds], sourceMessageId: source.id, sourceConversationId: source.conversationId,
        sourceChecksum: checksum(source.content), provenance: candidate.provenance,
        scope: 'only_necessary_communication_with_actual_participants_of_this_game',
        permissions: { realExecution: false, privateConversationForwarding: false },
        ...(state.shared?.stage ? { sharedStage: state.shared.stage } : {}),
        ...(state.shared?.summary ? { sharedSummary: state.shared.summary.slice(0, 8000) } : {}),
        ...(state.shared ? { sharedRules: state.shared } : {}), ...(state.workingState ? { ownPrivateState: state.workingState } : {}),
        delivery: { channel: input.delivery?.channel ?? 'phone', actualRecipientIds: [...recipientIds],
          ...(input.delivery?.roomId ? { requestedRoomId: input.delivery.roomId } : {}),
          ...(input.delivery?.topicId !== undefined ? { requestedTopicId: input.delivery.topicId } : {}),
          audience: recipientIds.length === 1 ? 'individual' : 'multiple_participants',
          privateStateMechanism: 'topic.update.patch.privateRecipientId_and_workingState' } };
      contexts.push(context);
    } catch { /* A stale, foreign or withdrawn port cannot supply game context. */ }
  }
  // Several simultaneous games require an explicit current source port. Never
  // choose a convenient game by member overlap.
  if (contexts.length !== 1) return;
  const after = (await request({ type: 'memory.sources.filter', ...scope, beforeSequence: input.beforeSequence, ids: [source.id] })).memorySources?.find(item => item.id === source.id);
  if (!after || after.content !== source.content || after.topicId !== source.topicId) return;
  verified.add(contexts[0]!); return contexts[0];
}

export function isVerifiedCompanionGameContactContext(context: unknown, source: CompanionMessage, recipientIds: readonly string[]): context is CompanionGameContactContext {
  if (!context || typeof context !== 'object' || !verified.has(context)) return false;
  const value = context as CompanionGameContactContext;
  return value.sourceMessageId === source.id && value.sourceConversationId === source.conversationId && value.sourceChecksum === checksum(source.content)
    && recipientIds.every(id => value.participantIds.includes(id))
    && JSON.stringify([...recipientIds].sort()) === JSON.stringify([...value.delivery.actualRecipientIds].sort());
}

/** References only; the sender's private checkpoint body never crosses into
 * the recipient's context. Storage binds this proof to the actual send. */
export function companionGameContactExecutionReadset(context: CompanionGameContactContext | undefined, source: CompanionMessage,
  recipientIds: readonly string[], outboundConversationId: string) {
  if (!isVerifiedCompanionGameContactContext(context, source, recipientIds)) return;
  return captureCompanionExecutionReadset({ companionId: context.ownerId, conversationId: outboundConversationId }, {
    context: { user: JSON.stringify({ topic: { id: context.topicId, conversationId: context.conversationId },
      topicState: { topicId: context.topicId, readerId: context.ownerId, shared: context.sharedRules, workingState: context.ownPrivateState } }) },
  });
}
