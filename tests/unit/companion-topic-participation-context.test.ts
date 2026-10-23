import { expect, it } from 'vitest';
import { companionTopicParticipation, COMPANION_TOPIC_PARTICIPATION_RULES } from '../../src/main/companions/topic-participation-context';
import type { CompanionTopic } from '../../src/shared/companion-topic';

const ids = ['host', 'alice', 'bob', 'carol', 'dave', 'erin'];
const topic: CompanionTopic = { id: 'game', conversationId: 'group', title: '狼人杀', kind: 'game', status: 'active', participantIds: ids,
  invitedIds: ['user'], moderatorId: 'host', tags: [], revision: 1, createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' };
const input = { topic, conversationId: 'group', companionId: 'host', audience: 'player' as const, memberIds: ids,
  names: ids.map(id => ({ id, name: id === 'host' ? '主持伙伴' : id })) };

it('reports six real companion readers and an unjoined invited human without inventing a seventh player or assigning host cards', () => {
  const roster = companionTopicParticipation(input)!;
  expect(roster.counts).toEqual({ joinedReaders: 6, joinedCompanions: 6, joinedHumans: 0, invitedNotJoined: 1 });
  expect(roster.human).toEqual({ inConversation: true, joinedTopic: false, invitedOnly: true });
  expect(roster.joinedReaders.map(person => person.id)).toEqual(ids);
  expect(roster.invitedNotJoined).toEqual([{ id: 'user', name: '真人玩家', kind: 'human_player' }]);
  expect(roster.topicModerator).toMatchObject({ id: 'host' });
  expect(roster.gameParticipation).toMatchObject({ joinedTopicIsNotGameRegistration: true, moderatorIsNotAutomaticallyGameHost: true, hostDoesNotAutomaticallyDrawACard: true });
  expect(roster).not.toHaveProperty('playerCount'); expect(roster).not.toHaveProperty('cards');
  expect(COMPANION_TOPIC_PARTICIPATION_RULES).toContain('数量之和与实际参加该轮的玩家人数相等');
});
it('rebuilds the roster after an independent join without treating old invitation metadata as the current state', () => {
  const before = companionTopicParticipation(input)!;
  const after = companionTopicParticipation({ ...input, topic: { ...topic, participantIds: [...ids, 'user'], invitedIds: [], revision: 2 } })!;
  expect(before.human.joinedTopic).toBe(false); expect(after.human.joinedTopic).toBe(true);
  expect(after.counts.joinedHumans).toBe(1); expect(after.counts.joinedReaders).toBe(7);
  expect(after.invitedNotJoined).toEqual([]);
});
it('does not add a phantom human to peer-only groups or expose another conversation, uninvited reader or deleted topic', () => {
  const peers = companionTopicParticipation({ ...input, audience: 'peers' })!;
  expect(peers.human).toEqual({ inConversation: false, joinedTopic: false, invitedOnly: false });
  expect(peers.invitedNotJoined).toEqual([]);
  expect(companionTopicParticipation({ ...input, conversationId: 'unrelated' })).toBeUndefined();
  expect(companionTopicParticipation({ ...input, companionId: 'outsider' })).toBeUndefined();
  expect(companionTopicParticipation({ ...input, topic: { ...topic, deletedAt: topic.updatedAt } })).toBeUndefined();
});
