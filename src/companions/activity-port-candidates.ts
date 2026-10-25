import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionConnection } from './store';
import type { CompanionSocialStore } from './social-store';
import { companionSocialDelegatedPortOrigin, type CompanionDelegatedPortOrigin } from './social-goal-origin';

type Visible = (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[];
type Root = { companionId: string; conversationId: string; sourceMessageId: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const checksum = (message: CompanionMessage) => createHash('sha256').update(message.content).digest('hex');
const id = z.string().min(1).max(200), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const candidateSchema = z.strictObject({ id, rootCompanionId: id, rootConversationId: id, rootSourceMessageId: id,
  rootSourceChecksum: sha, creatorCompanionId: id, creationSource: z.strictObject({ id, conversationId: id, checksum: sha }),
  originId: id, chainId: id, jobId: id, deliveryClientId: id, conversationId: id, topicId: id, memberIds: z.array(id).min(3).max(20), includePlayer: z.boolean() });
export type CompanionActivityPortCandidateProof = z.infer<typeof candidateSchema>;
const rootKey = (root: Root) => 'activity-port-candidate-root/' + hash([root.companionId, root.conversationId, root.sourceMessageId]);
const topicKey = (owner: string, room: string, topic: string) => 'activity-port-candidate-topic/' + hash([owner, room, topic]);
const recordKey = (candidateId: string) => 'activity-port-candidate/' + candidateId;
function indexedIds(value?: string): string[] {
  if (!value) return [];
  // The initial implementation stored a single ID; accepting that host record
  // does not pick a winner when a later index contains several real ports.
  return /^[a-f0-9]{64}$/u.test(value) ? [value] : z.array(sha).max(32).parse(JSON.parse(value));
}
function uniquePort(proofs: CompanionActivityPortCandidateProof[]) {
  const ports = new Set(proofs.map(proof => JSON.stringify([proof.conversationId, proof.topicId])));
  return ports.size === 1 ? proofs.sort((a, b) => a.id.localeCompare(b.id))[0] : undefined;
}

export function publicCompanionActivityPortCandidate(proof: CompanionActivityPortCandidateProof) {
  return { id: proof.id, conversationId: proof.conversationId, topicId: proof.topicId, creatorCompanionId: proof.creatorCompanionId,
    requiresJoin: true as const, notice: '原目标的真实通信已产生此话题；尚未自动加入或切换任务。请本人读取并自主加入，已有活动端口须先明确关闭。' };
}
function load(db: CompanionConnection, social: CompanionSocialStore, visible: Visible, candidateId: string, includeClosed = false): CompanionActivityPortCandidateProof | undefined {
  const stored = db.prepare('SELECT value FROM metadata WHERE key=?').get(recordKey(candidateId)) as { value: string } | undefined;
  if (!stored) return;
  const parsed = candidateSchema.safeParse(JSON.parse(stored.value)); if (!parsed.success) return;
  const proof = parsed.data;
  if (proof.id !== candidateId || proof.id !== hash([proof.rootCompanionId, proof.rootConversationId, proof.rootSourceMessageId,
    proof.creatorCompanionId, proof.deliveryClientId, proof.conversationId, proof.topicId])) return;
  const human = visible({ companionId: proof.rootCompanionId, conversationId: proof.rootConversationId }, [proof.rootSourceMessageId])[0];
  const source = visible({ companionId: proof.creatorCompanionId, conversationId: proof.creationSource.conversationId }, [proof.creationSource.id])[0];
  if (!human || human.authorId !== 'user' || human.status !== 'sent' || human.isReplyDraft || checksum(human) !== proof.rootSourceChecksum
    || !source || checksum(source) !== proof.creationSource.checksum) return;
  const origin = companionSocialDelegatedPortOrigin(db, social, visible, proof.creatorCompanionId, source);
  if (!origin || origin.companionId !== proof.rootCompanionId || origin.conversationId !== proof.rootConversationId
    || origin.sourceMessageId !== proof.rootSourceMessageId || origin.checksum !== proof.rootSourceChecksum
    || origin.originId !== proof.originId || origin.chainId !== proof.chainId || origin.jobId !== proof.jobId) return;
  const outbox = db.prepare('SELECT companion_id,conversation_id,status,data FROM companion_social_outbox WHERE client_id=?')
    .get(proof.deliveryClientId) as { companion_id: string; conversation_id: string; status: string; data: string } | undefined;
  if (!outbox || !['pending', 'sent'].includes(outbox.status) || outbox.companion_id !== proof.creatorCompanionId || outbox.conversation_id !== proof.conversationId) return;
  const send = JSON.parse(outbox.data) as { companionId: string; conversationId: string; topicId?: string; agentSource?: { conversationId: string; messageId: string } };
  if (send.companionId !== proof.creatorCompanionId || send.conversationId !== proof.conversationId || send.topicId !== proof.topicId
    || send.agentSource?.messageId !== proof.creationSource.id || send.agentSource.conversationId !== proof.creationSource.conversationId) return;
  const storedTopic = db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(proof.topicId, proof.conversationId) as { data: string } | undefined;
  const topic = storedTopic ? JSON.parse(storedTopic.data) as { kind: string; status: string; deletedAt?: string; participantIds: string[] } : undefined;
  if (!topic || topic.kind !== 'game' || !includeClosed && topic.status === 'closed' || topic.deletedAt || !topic.participantIds.includes(proof.creatorCompanionId)) return;
  const members = (db.prepare('SELECT m.companion_id FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND c.dissolved_at IS NULL ORDER BY m.companion_id')
    .all(proof.conversationId) as Array<{ companion_id: string }>).map(member => member.companion_id);
  if (!members.includes(proof.rootCompanionId) || JSON.stringify(members) !== JSON.stringify([...proof.memberIds].sort())) return;
  const socialRoom = db.prepare('SELECT member_key FROM companion_social_conversations WHERE id=?').get(proof.conversationId) as { member_key: string } | undefined;
  if (!socialRoom || socialRoom.member_key.startsWith('player') !== proof.includePlayer) return;
  return proof;
}
export function findCompanionActivityPortCandidate(db: CompanionConnection, social: CompanionSocialStore, visible: Visible, root: Root) {
  return uniquePort(listCompanionActivityPortCandidates(db, social, visible, root));
}
export function listCompanionActivityPortCandidates(db: CompanionConnection, social: CompanionSocialStore, visible: Visible, root: Root) {
  const index = db.prepare('SELECT value FROM metadata WHERE key=?').get(rootKey(root)) as { value: string } | undefined;
  return indexedIds(index?.value).flatMap(candidateId => {
    const proof = load(db, social, visible, candidateId);
    return proof && proof.rootCompanionId === root.companionId && proof.rootConversationId === root.conversationId
      && proof.rootSourceMessageId === root.sourceMessageId ? [proof] : [];
  });
}
export function findJoinedCompanionActivityPortCandidate(db: CompanionConnection, social: CompanionSocialStore, visible: Visible,
  input: { companionId: string; conversationId: string; topicId: string }, options: { includeClosed?: boolean } = {}) {
  const index = db.prepare('SELECT value FROM metadata WHERE key=?').get(topicKey(input.companionId, input.conversationId, input.topicId)) as { value: string } | undefined;
  const proof = uniquePort(indexedIds(index?.value).flatMap(candidateId => {
    const found = load(db, social, visible, candidateId, options.includeClosed); return found ? [found] : [];
  }));
  if (!proof || proof.rootCompanionId !== input.companionId || proof.conversationId !== input.conversationId || proof.topicId !== input.topicId) return;
  const stored = db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(proof.topicId, proof.conversationId) as { data: string };
  return (JSON.parse(stored.data) as { participantIds: string[] }).participantIds.includes(input.companionId) ? proof : undefined;
}
export function registerCompanionActivityPortCandidate(db: CompanionConnection, social: CompanionSocialStore, visible: Visible,
  input: { origin: CompanionDelegatedPortOrigin; creatorCompanionId: string; source: CompanionMessage; deliveryClientId: string;
    conversationId: string; topicId: string; memberIds: string[]; includePlayer: boolean }): CompanionActivityPortCandidateProof {
  const proof = candidateSchema.parse({ id: hash([input.origin.companionId, input.origin.conversationId, input.origin.sourceMessageId,
    input.creatorCompanionId, input.deliveryClientId, input.conversationId, input.topicId]), rootCompanionId: input.origin.companionId,
    rootConversationId: input.origin.conversationId, rootSourceMessageId: input.origin.sourceMessageId, rootSourceChecksum: input.origin.checksum,
    creatorCompanionId: input.creatorCompanionId, creationSource: { id: input.source.id, conversationId: input.source.conversationId, checksum: checksum(input.source) },
    originId: input.origin.originId, chainId: input.origin.chainId, jobId: input.origin.jobId,
    deliveryClientId: input.deliveryClientId, conversationId: input.conversationId, topicId: input.topicId, memberIds: [...input.memberIds].sort(), includePlayer: input.includePlayer });
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(recordKey(proof.id), JSON.stringify(proof));
  if (!load(db, social, visible, proof.id)) throw new Error('新话题未具有完整有效的原目标创建出处，不能登记接力。');
  for (const key of [rootKey({ companionId: proof.rootCompanionId, conversationId: proof.rootConversationId, sourceMessageId: proof.rootSourceMessageId }),
    topicKey(proof.rootCompanionId, proof.conversationId, proof.topicId)]) {
    const prior = db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as { value: string } | undefined;
    const ids = [...new Set([...indexedIds(prior?.value).filter(candidateId => !!load(db, social, visible, candidateId)), proof.id])];
    if (ids.length > 32) throw new Error('同一原目标的有效候选过多，不能继续创建或猜测活动端口。');
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(ids));
  }
  return proof;
}
