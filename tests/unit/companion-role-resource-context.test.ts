import { describe, expect, it } from 'vitest';
import type { CompanionTopic } from '../../src/shared/companion-topic';
import { companionRoleResourceBounds } from '../../src/main/companions/role-resource-context';
import { companionMainVirtualMutation, companionNativeSocialClientId, resolveCompanionActivityHandoff } from '../../src/main/companions/activity-handoff';

const topic: CompanionTopic = { id: 'game', conversationId: 'room', title: '真实对局', kind: 'game', status: 'active',
  participantIds: ['host', 'a'], invitedIds: ['host', 'a', 'b', 'user'], moderatorId: 'host', tags: [], revision: 1,
  createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' };
const room = { id: 'room', memberIds: ['host', 'a', 'b'], peerOnly: true };
describe('actual role capacity shared by Main, peer and activity frames', () => {
  it('separates activated capacity, actual room, invitations, joins and unknown draw consent', () => {
    const facts = companionRoleResourceBounds({ ownerId: 'host', activeCharacterIds: ['host', 'a', 'c', 'a', 'user'], game: { conversation: room, topic } });
    expect(facts).toMatchObject({ activeCharacterIds: ['a', 'c', 'host'], activeCharacterCount: 3, otherActiveCharacterCount: 2,
      includesOwner: true, hasVerifiedGameRoom: true, boundGameRoomMemberIds: ['a', 'b', 'host'], boundGameRoomMemberCount: 3,
      boundGameRoomActiveMemberIds: ['a', 'host'], boundGameRoomActiveMemberCount: 2, ownerIsModerator: true,
      moderatorDrawSeat: 'unknown_not_inferred_from_moderator_role', topicInvitedIds: ['host', 'a', 'b', 'user'], joinedTopicParticipantIds: ['host', 'a'],
      humanPlayer: { includedInRoom: false, invited: true, joined: false, drawSeatConsent: 'not_inferred_from_invitation_or_join' } });
  });
  it('counts actual human room membership separately without assuming a player seat', () => {
    const facts = companionRoleResourceBounds({ ownerId: 'host', activeCharacterIds: ['host', 'a'],
      game: { conversation: { ...room, peerOnly: false }, topic: { ...topic, participantIds: ['host', 'a', 'user'] } } });
    expect(facts.humanPlayer).toEqual({ includedInRoom: true, invited: true, joined: true, drawSeatConsent: 'not_inferred_from_invitation_or_join' });
    expect(facts.boundGameRoomMemberCount).toBe(3);
    expect(companionRoleResourceBounds({ ownerId: 'host', activeCharacterIds: ['host'],
      game: { conversation: { id: room.id, memberIds: room.memberIds }, topic } }).humanPlayer?.includedInRoom).toBe('unknown');
  });
  it.each(['wrong-room', 'foreign-owner', 'deleted', 'non-game'] as const)('does not project a supposed game without an actual matching port: %s', invalid => {
    const facts = companionRoleResourceBounds({ ownerId: invalid === 'foreign-owner' ? 'c' : 'host', activeCharacterIds: ['host', 'c'], game: {
      conversation: room, topic: { ...topic, ...(invalid === 'wrong-room' ? { conversationId: 'elsewhere' } : {}),
        ...(invalid === 'deleted' ? { deletedAt: topic.updatedAt } : {}), ...(invalid === 'non-game' ? { kind: 'discussion' as const } : {}) } } });
    expect(facts.hasVerifiedGameRoom).toBe(false); expect(facts.boundGameRoomMemberIds).toEqual([]);
    expect(facts).not.toHaveProperty('boundGameRoomId'); expect(facts).not.toHaveProperty('moderatorId');
  });
  it('only gates virtual mutations and keeps stable native effect identities exact', () => {
    for (const action of ['message', 'create_group', 'visit', 'move']) expect(companionMainVirtualMutation('world', { action })).toBe(true);
    expect(companionMainVirtualMutation('topic', { action: 'update' })).toBe(true);
    for (const [name, action] of [['world', 'inspect'], ['topic', 'read'], ['topic', 'list'], ['activity', 'cancel'], ['dsh', 'run'], ['collaborate', 'request']])
      expect(companionMainVirtualMutation(name!, { action })).toBe(false);
    expect(companionNativeSocialClientId('actual_call')).toBe(companionNativeSocialClientId('actual_call'));
    expect(companionNativeSocialClientId('other_call')).not.toBe(companionNativeSocialClientId('actual_call'));
  });
  it('cannot use a peer or draft source to request a host handoff', async () => {
    const request = () => { throw new Error('must not dispatch'); };
    const source = { id: 'source', conversationId: 'room', authorId: 'peer', status: 'sent' as const, kind: 'text' as const,
      attachments: [], content: '继续', sequence: 1, createdAt: topic.createdAt };
    expect(await resolveCompanionActivityHandoff(request, { companionId: 'host', conversationId: 'room', source })).toBeUndefined();
    expect(await resolveCompanionActivityHandoff(request, { companionId: 'host', conversationId: 'room', source: { ...source, authorId: 'user', isReplyDraft: true } })).toBeUndefined();
  });
});
