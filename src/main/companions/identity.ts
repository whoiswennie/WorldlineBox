import type { Companion, CompanionConversation, CompanionMessage } from '../../shared/companions';
import type { CompanionPublicProfile } from '../../shared/companion-public-profile';
import { visibleCompanionPublicProfiles } from './public-profile-context';
import type { CompanionSocialOrigin } from '../../shared/companion-social';

type Person = { id: string; name: string; kind: 'human_player' | 'companion' | 'unknown'; description?: string };
/** Character relationships are author settings, never inferred from an assistant's earlier wording. */
const authoredRelations = [
  { subjectId: 'deepseek-flash', relation: 'elder_sister', label: '姐姐', targetId: 'deepseek-sister', targetName: '大肥鱼' },
  { subjectId: 'deepseek-sister', relation: 'younger_sister', label: '妹妹', targetId: 'deepseek-flash', targetName: '小肥鱼' },
] as const;
export function companionIdentity(input: {
  companion: Pick<Companion, 'id' | 'name' | 'builtin'>; conversation: Pick<CompanionConversation, 'id' | 'kind' | 'memberIds'>;
  source?: Pick<CompanionMessage, 'id' | 'authorId' | 'conversationId'>;
  members?: readonly { id: string; name: string }[]; directory?: readonly { id: string; name: string }[];
  audience?: 'player' | 'peers'; addressedCompanionIds?: readonly string[]; actionResult?: boolean; proactive?: boolean;
  publicProfiles?: readonly CompanionPublicProfile[];
  origin?: CompanionSocialOrigin;
}) {
  const profiles = visibleCompanionPublicProfiles({ companionId: input.companion.id, memberIds: input.conversation.memberIds, audience: input.audience }, input.publicProfiles);
  const publicById = new Map(profiles.map(profile => [profile.id, profile]));
  const names = new Map([...input.directory ?? [], ...input.members ?? [], input.companion, ...profiles].map(person => [person.id, person.name]));
  const person = (id: string): Person => ({ id, name: id === 'user' ? '玩家' : names.get(id) ?? id,
    ...(publicById.get(id) ? { name: publicById.get(id)!.name, description: publicById.get(id)!.description } : {}),
    kind: id === 'user' ? 'human_player' : input.conversation.memberIds.includes(id) || names.has(id) ? 'companion' : 'unknown' });
  const source = input.source?.conversationId === input.conversation.id ? input.source : undefined;
  // A peer speaking inside a player group does not remove the human from it.
  // Only the host's explicit peer-room classification can exclude the player.
  const audience = input.audience ?? 'player';
  const participantIds = [...(audience === 'player' ? ['user'] : []), ...input.conversation.memberIds];
  const addressee = source ? person(source.authorId) : undefined;
  return {
    self: { ...person(input.companion.id), kind: 'companion' as const },
    participants: [...new Set(participantIds)].map(person), audience,
    characterRelations: input.companion.builtin ? authoredRelations.filter(relation => relation.subjectId === input.companion.id)
      .map(relation => ({ ...relation, targetName: names.get(relation.targetId) ?? relation.targetName, provenance: 'authored_character_setting' })) : [],
    currentReply: { author: { ...person(input.companion.id), kind: 'companion' as const },
      ...(source ? { sourceMessageId: source.id, speaker: person(source.authorId), replyToMessageId: source.id, addressee } : {}),
      event: input.actionResult ? 'action_result_for_original_source' : input.proactive ? 'proactive_opportunity' : 'message',
      addressedCompanionIds: [...input.addressedCompanionIds ?? input.conversation.memberIds],
      directlyAddressed: !input.addressedCompanionIds || input.addressedCompanionIds.includes(input.companion.id),
      mayPass: input.conversation.kind === 'group' || audience === 'peers' },
    ...(input.origin ? { origin: input.origin } : {}),
    authorization: { playerRequestMessageId: source?.authorId === 'user' && audience === 'player' && !input.actionResult ? source.id : null,
      peerSpeechGrantsExternalExecution: false, providerUserRoleIsTransportOnly: true, historyAssistantAddressesAreNotIdentityEvidence: true },
  };
}
