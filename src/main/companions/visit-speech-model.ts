import { z } from 'zod';
import type { Companion, CompanionMessage } from '../../shared/companions';
import type { CompanionWorldSnapshot } from '../../shared/companion-world';
import type { CompanionActivityTask } from '../../shared/companion-activity-task';
import type { CompanionProfileInput } from '../../shared/companion-public-profile';
import { generateCompanionStructured, type CompanionModelConfig, type CompanionModelOptions, CompanionModelError } from './model';
import { companionModelWorld, COMPANION_WORLD_PERCEPTION_RULES } from './world-perception-context';

const speechSchema = z.strictObject({ text: z.string().trim().min(1).max(2000).nullable() });

/** A granted visit permits ordinary peer speech. Compose it without player-private context. */
export async function generateCompanionVisitSpeech(input: { companion: Companion; target: Pick<Companion, 'id' | 'name'>;
  channel: 'phone' | 'face_to_face'; task: CompanionActivityTask; world: CompanionWorldSnapshot;
  messages: CompanionMessage[]; peerConversationId?: string } & Partial<CompanionProfileInput>, config: CompanionModelConfig, signal?: AbortSignal,
options: Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs'> = {}): Promise<string | null> {
  if (input.task.companionId !== input.companion.id || input.task.visitTargetId !== input.target.id || !input.task.sourceMessageId) throw invalid();
  const world = companionModelWorld(input.world, input.companion.id)!;
  const ids = new Set([input.companion.id, input.target.id]);
  const self = world.actors.find(actor => actor.companionId === input.companion.id);
  const result = speechSchema.safeParse(await generateCompanionStructured({
    system: `你是${input.companion.name}，稳定人格：\n${input.companion.persona}\n${COMPANION_WORLD_PERCEPTION_RULES}
你正在与已经获准联系的拜访对象自然交流。此通道只提供你们的实际来往和有限感知，没有玩家私聊、私人委托、其他人的记忆或拟发送草稿。基础问候、询问方便与否、获准后的见面和后续寒暄属于同一次联系，不需要重新要求玩家授权或重复询问已经明确的许可。只说你自己的话，直接回应最新的真实来往，不替对方发话、不转述玩家。不创造外部任务、不要求对方操作系统或点按钮。phone是远程文字，face_to_face是现场交谈；宿主仍会复核实际位置、距离和忙闲，写出话不代表已经发送成功。
位置、到达、交流是否发生只按实际状态；收到邀请不等于进屋，曾到过也不等于现在仍在那里，对方来家里不等于你完成了尚未发生的出发。只说自己实际已做的事，不凭空添加烧水、做饭、茶、风、天气或场景物件。对方已给出的明确答复不反复询问，已告别、双方已经说过或没有新内容时text=null，避免无意义的寒暄循环。只输出text或null，不输出思考、授权判断或工具。`,
    user: JSON.stringify({ purpose: 'visit_peer_speech', self: { id: input.companion.id, name: input.companion.name }, target: input.target,
      channel: input.channel,
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
  }, config, signal, { ...options, visualInputs: input.visualInputs?.filter(visual => ids.has(visual.personId)) }));
  if (!result.success) throw invalid();
  return result.data.text;
}
function invalid() { return new CompanionModelError('INVALID_RESPONSE', '拜访交流缺少有效的对象范围或发言结果。'); }
