import type { CompanionConversation } from '../../shared/companions';
import type { CompanionTopic } from '../../shared/companion-topic';

export const COMPANION_ROLE_RESOURCE_RULES = `resourceBounds是宿主按当前真实激活目录与实际房间投影的资源上界，不是已报名、愿意抽牌或新的权限。activeCharacterIds包含实际激活的独立伙伴；自己也在其中时只能算一次。已验证game room时，以boundGameRoomMemberIds及actual active成员为当前固定房间上界，不能把群外熟人、别处回信者或别的话题加入者当作本局成员。topicInvitedIds只表示邀请，joinedTopicParticipantIds只表示真实加入，二者都不自动等于愿意坐玩家席。moderatorId只是主持身份，不证明主持本人抽牌；规则说主持不抽牌时必须从抽牌人数扣除，不能让一人占两个位置。真人是否在群或已join单列，也不证明真人同意当玩家，不代玩家报名。hasVerifiedGameRoom=false表示本轮没有取得本局房间证明，不能把当前私聊默认当成已存在的大群或猜别局资料。
原请求未规定人数或角色配置时，自己提出的6/8/12人或某套牌表只是可修改方案，应在当前真实容量与自愿参与者内调整，不能让用户补齐自己设想的条件，不能反复等待不存在的额外资源。原请求明确规定的规模和限制仍须保留，实际资源不足时如实等待真实变化或说明受阻。只依据真实报名/规则证据确定抽牌玩家名单，所分配的身份名额总和必须等于该名单人数。当前完整目标已有固定gamePort时，筹备方案先服从该真实成员上界；确需换一组成员，须合法结束当前筹备episode再建立新端口，不能将旧私态带到新局。消息、计划、工具返回的观察时间流逝和相互说“继续等”都不自动增加演员、报名或游戏进展。`;

/** Shared facts only. The caller obtains the exact port through its existing
 * current-topic or source-bound task/job proof; this function grants nothing. */
export function companionRoleResourceBounds(input: { ownerId: string; activeCharacterIds: readonly string[];
  game?: { conversation: Pick<CompanionConversation, 'id' | 'memberIds' | 'peerOnly'>; topic: CompanionTopic } }) {
  const active = [...new Set(input.activeCharacterIds.filter(id => id !== 'user'))].sort();
  const supplied = input.game;
  const game = supplied?.topic.kind === 'game' && !supplied.topic.deletedAt
    && supplied.topic.conversationId === supplied.conversation.id && supplied.conversation.memberIds.includes(input.ownerId)
    && [...supplied.topic.participantIds, ...supplied.topic.invitedIds].includes(input.ownerId) ? supplied : undefined;
  const members = game ? [...new Set(game.conversation.memberIds.filter(id => id !== 'user'))].sort() : [];
  const available = members.filter(id => active.includes(id));
  return { activeCharacterIds: active, activeCharacterCount: active.length, includesOwner: active.includes(input.ownerId),
    otherActiveCharacterCount: active.filter(id => id !== input.ownerId).length,
    hasVerifiedGameRoom: !!game,
    ...(game ? { boundGameRoomId: game.conversation.id, boundGameTopicId: game.topic.id,
      boundGameRoomMemberCount: members.length, boundGameRoomActiveMemberCount: available.length,
      ownerIsModerator: game.topic.moderatorId === input.ownerId, moderatorId: game.topic.moderatorId,
      moderatorDrawSeat: 'unknown_not_inferred_from_moderator_role' as const,
      humanPlayer: { includedInRoom: game.conversation.peerOnly === undefined ? 'unknown' as const : game.conversation.peerOnly === false,
        invited: game.topic.invitedIds.includes('user'), joined: game.topic.participantIds.includes('user'),
        drawSeatConsent: 'not_inferred_from_invitation_or_join' as const } } : {}),
    boundGameRoomMemberIds: members, boundGameRoomActiveMemberIds: available,
    topicInvitedIds: game ? [...game.topic.invitedIds] : [], joinedTopicParticipantIds: game ? [...game.topic.participantIds] : [],
    trust: 'host_activated_capacity_not_acquaintance_consent_or_draw_player_count' as const };
}
export type CompanionRoleResourceBounds = ReturnType<typeof companionRoleResourceBounds>;
