import { companionBehaviorSystem } from './asset-behavior-defaults';
import { z } from 'zod';
import type { Companion, CompanionMessage } from '../../shared/companions';
import type { CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';
import { type CompanionModelConfig, type CompanionModelOptions, CompanionModelError } from './model';
import { runCompanionStructuredAgent, companionTaskConversation } from './structured-agent';
import { companionModelWorld, COMPANION_WORLD_PERCEPTION_RULES } from './world-perception-context';
import { companionRuntimeBehavior, companionVisibleRuntimeState, currentCompanionCharacterDevelopment } from './context';
import type { CompanionRuntimeState } from '../../shared/companion-state';
import type { CompanionCharacterDevelopment } from '../../shared/companion-character-development';

const speechSchema = z.strictObject({ text: z.string().trim().min(1).max(2000).nullable() });

/** A granted visit permits ordinary peer speech. Compose it without player-private context. */
export async function generateCompanionVisitSpeech(input: { companion: Companion; target: Pick<Companion, 'id' | 'name'>;
  channel: 'phone' | 'face_to_face'; task: CompanionActivityTask; world: CompanionWorldSnapshot;
  messages: CompanionMessage[]; peerConversationId?: string; runtimeState?: CompanionRuntimeState; characterDevelopment?: CompanionCharacterDevelopment } & Partial<CompanionProfileInput>, config: CompanionModelConfig, signal?: AbortSignal,
options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs'> = {}): Promise<string | null> {
  if (input.task.companionId !== input.companion.id || input.task.visitTargetId !== input.target.id || !input.task.sourceMessageId) throw invalid();
  const world = companionModelWorld(input.world, input.companion.id)!;
  const ids = new Set([input.companion.id, input.target.id]);
  const self = world.actors.find(actor => actor.companionId === input.companion.id);
  // The private task planner can know private causes; peer speech only gets the
  // current public expression and a profile re-read for the actual peer room.
  const runtimeState = companionVisibleRuntimeState(input.runtimeState ? { ...input.runtimeState, sourceConversationId: undefined } : undefined,
    input.companion.id, { id: input.peerConversationId ?? 'peer_unbound', kind: 'group' });
  const conversationId = input.peerConversationId ?? 'peer_unbound';
  const messages = input.messages.filter(message => message.conversationId === conversationId && ids.has(message.authorId)
    && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft);
  const source = messages.findLast(message => message.authorId === input.target.id);
  const result = speechSchema.safeParse(await runCompanionStructuredAgent({ frame: { companion: input.companion,
    conversation: companionTaskConversation(conversationId, input.companion.id, input.task.updatedAt, [...ids]),
    messages, sourceMessage: source, memories: [], audience: 'peers', publicProfiles: input.publicProfiles,
    runtimeState, characterDevelopment: input.characterDevelopment,
    members: [{ ...input.target, description: '' }],
    invocation: { id: input.task.id + ':speech', kind: 'peer', companionId: input.companion.id, conversationId,
      goal: '根据实际拜访状态与对方自然交流。', status: 'running', createdAt: input.task.createdAt,
      messagePort: { kind: 'conversation' }, authorization: { kind: 'peer', sourceMessageIds: source ? [source.id] : [], externalActions: false } } }, context: {
    system: companionBehaviorSystem(config, 'visit_peer_speech', `【宿主拜访通信合同】只说当前self的话，仅使用这个peer入口的获权来往和本轮有限感知；不引用玩家私聊或其他人的私态，不替对方发言/许可或创造外部任务。
${COMPANION_WORLD_PERCEPTION_RULES}
phone/face_to_face的实际发送、位置、距离和许可仍由宿主核验，提案不能代替身体行动。只按schema返回{text:string|null}，不输出思考或工具。`, input.companion),
    user: JSON.stringify({ purpose: 'visit_peer_speech', self: { id: input.companion.id, name: input.companion.name }, target: { id: input.target.id, name: input.target.name },
      channel: input.channel, runtimeState, runtimeBehavior: runtimeState ? companionRuntimeBehavior(runtimeState) : undefined,
      characterDevelopment: input.peerConversationId ? currentCompanionCharacterDevelopment(input.characterDevelopment, input.companion.id, input.peerConversationId) : undefined,
      progress: { arrived: !!input.task.visitArrivedAt, exchangedInPerson: !!input.task.visitInteractionAt },
      world: { clock: world.clock, environment: world.environment,
        self: self ? { companionId: self.companionId, sceneId: self.sceneId, position: self.position, activity: self.activity,
          ...('route' in self ? { travel: self.travel, route: self.route, routinePhase: self.routinePhase } : {}) } : undefined,
        people: world.perception?.people.filter(person => ids.has(person.companionId)),
        visits: world.visits.filter(visit => visit.guestId === input.companion.id && visit.hostId === input.target.id)
          .map(visit => ({ id: visit.id, status: visit.status, destination: visit.destination })) },
      messages: input.messages.filter(message => input.peerConversationId && message.conversationId === input.peerConversationId
        && ids.has(message.authorId) && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft)
        .slice(-20).map(message => ({ authorId: message.authorId, content: message.content.slice(0, 2000), sequence: message.sequence })),
      publicProfiles: input.publicProfiles?.filter(profile => ids.has(profile.id)),
      outputSchema: z.toJSONSchema(speechSchema, { io: 'input' }) }),
  } }, config, signal, { ...options, visualInputs: input.visualInputs?.filter(visual => ids.has(visual.personId)) }));
  if (!result.success) throw invalid();
  return result.data.text;
}
function invalid() { return new CompanionModelError('INVALID_RESPONSE', '拜访交流缺少有效的对象范围或发言结果。'); }
