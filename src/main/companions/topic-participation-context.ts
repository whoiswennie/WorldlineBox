import type { CompanionTopic } from '../../shared/companion-topic';

/** Only public membership facts. Joining a discussion does not assign a game
 * role, accept a seat, prove physical presence or reveal another reader's card. */
export function companionTopicParticipation(input: {
  topic?: CompanionTopic; conversationId: string; companionId: string; audience: 'player' | 'peers';
  memberIds: readonly string[]; names?: readonly { id: string; name: string }[];
}) {
  const topic = input.topic;
  if (!topic || topic.deletedAt || topic.conversationId !== input.conversationId
    || ![...topic.participantIds, ...topic.invitedIds].includes(input.companionId)) return undefined;
  const roomIds = new Set([...input.memberIds, ...(input.audience === 'player' ? ['user'] : [])]);
  const names = new Map(input.names?.map(person => [person.id, person.name]) ?? []);
  const person = (id: string) => ({ id, name: id === 'user' ? names.get(id) ?? '真人玩家' : names.get(id) ?? id,
    kind: id === 'user' ? 'human_player' as const : 'companion' as const });
  const joinedIds = [...new Set(topic.participantIds)].filter(id => roomIds.has(id));
  const joined = new Set(joinedIds);
  const invitedIds = [...new Set(topic.invitedIds)].filter(id => roomIds.has(id) && !joined.has(id));
  return {
    topicId: topic.id, conversationId: input.conversationId, kind: topic.kind,
    joinedReaders: joinedIds.map(person), invitedNotJoined: invitedIds.map(person),
    counts: { joinedReaders: joinedIds.length, joinedCompanions: joinedIds.filter(id => id !== 'user').length,
      joinedHumans: Number(joined.has('user')), invitedNotJoined: invitedIds.length },
    human: { inConversation: roomIds.has('user'), joinedTopic: joined.has('user'), invitedOnly: invitedIds.includes('user') },
    topicModerator: roomIds.has(topic.moderatorId) ? person(topic.moderatorId) : undefined,
    gameParticipation: { registration: 'must_be_confirmed_in_public_topic_state_or_sourced_dialogue',
      moderatorIsNotAutomaticallyGameHost: true, hostDoesNotAutomaticallyDrawACard: true,
      joinedTopicIsNotGameRegistration: true, chatMembershipIsNotPhysicalPresence: true },
    visibility: 'public_membership_only_no_private_roles',
  };
}

export const COMPANION_TOPIC_PARTICIPATION_RULES = `topicParticipation是宿主本轮重新核对的公开话题成员事实：joinedReaders只证明已加入这段讨论，invitedNotJoined只是受邀。真人在群里不等于已报名或已经加入游戏话题；未回应的真人或伙伴不能算进已报名人数，加入讨论也不自动等于接受抽牌席位。topicModerator只管理话题，不自动成为游戏裁判或必然不抽牌。游戏、比赛、协作活动需要先依据本话题真实报名/明确同意和持久shared公开状态，分别确认参与者、主持/裁判与实际玩家，不能替别人答应。统计时不能忽略本轮已读消息中其他人明确说出的同意；自己本轮明确报名时，也要把自己计入本轮报名合计。未看到其他人回复只能说在本轮可见消息中尚未确认，不能断言全群没有人报名。主持人是否同时参加必须明确约定；若主持不参与抽牌，就从抽牌玩家数中排除。确认规则时逐项核对所有角色/名额/卡牌数量之和与实际参加该轮的玩家人数相等，区分建议方案与已确认规则；人数不符先修改或指出缺口，不能机械采纳别人的提议或用未报名者补数。不读取、列出、猜测或公开任何人的私牌。尚未完成报名、确认规则和实际开局步骤时，只能如实说正在邀约/筹备，不能说已经开始、已经发牌或已组成完整对局。`;
