import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionConnection } from './store';
import type { CompanionSocialStore } from './social-store';

type Visible = (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[];
export type CompanionDelegatedPortOrigin = { companionId: string; conversationId: string; sourceMessageId: string; checksum: string;
  originId: string; chainId: string; jobId: string };

/** Cross-owner lineage is only a port candidate, never an execution grant or
 * permission to read the original owner's private request in a peer prompt. */
export function companionSocialDelegatedPortOrigin(db: CompanionConnection, social: CompanionSocialStore, visible: Visible,
  owner: string, source: CompanionMessage): CompanionDelegatedPortOrigin | undefined {
  const current = visible({ companionId: owner, conversationId: source.conversationId }, [source.id])[0];
  if (!current || current.status !== 'sent' || current.isReplyDraft || current.authorId === owner || ['user', 'system'].includes(current.authorId)
    || current.content !== source.content || current.authorId !== source.authorId || current.topicId !== source.topicId) return;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const peerChecksum = digest(JSON.stringify([current.id, current.conversationId, current.topicId, current.authorId,
    current.content, current.status, current.replyToId]));
  const jobs = db.prepare("SELECT id,data FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.sourceMessageId')=? AND status IN('running','done')")
    .all(owner, current.conversationId, current.id) as Array<{ id: string; data: string }>;
  const roots = new Map<string, CompanionDelegatedPortOrigin>();
  for (const row of jobs) {
    const job = JSON.parse(row.data) as { chainId: string; readSet?: Array<{ id: string; checksum: string }> };
    const origin = social.continuity.forChain(job.chainId);
    if (!origin || origin.initiatorKind !== 'human_player' || origin.initiatorId !== 'user' || origin.ownerId === owner
      || !social.continuity.validOrigin(origin.id) || !job.readSet?.some(ref => ref.id === current.id && ref.checksum === peerChecksum)) continue;
    const stored = db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND companion_id=? AND status='active'")
      .get(origin.id, origin.ownerId) as { data: string } | undefined;
    if (!stored) continue;
    const delegation = JSON.parse(stored.data) as { conversationId: string; sourceMessageId: string };
    const human = visible({ companionId: origin.ownerId, conversationId: delegation.conversationId }, [delegation.sourceMessageId])[0];
    if (!human || human.authorId !== 'user' || human.status !== 'sent' || human.isReplyDraft) continue;
    roots.set(JSON.stringify([origin.ownerId, human.conversationId, human.id]), { companionId: origin.ownerId,
      conversationId: human.conversationId, sourceMessageId: human.id, checksum: digest(human.content),
      originId: origin.id, chainId: job.chainId, jobId: row.id });
  }
  if (roots.size > 1) throw new Error('当前建群通信对应多个原目标，不能猜测应接力哪一个。');
  return [...roots.values()][0];
}
/** Resolve actual host lineage, never a model's claimed goal or a member/title
 * similarity. Several origin records for the same human request are harmless;
 * distinct human sources are ambiguous and cannot coordinate an effect. */
export function companionSocialGoalOrigin(db: CompanionConnection, social: CompanionSocialStore, visible: Visible,
  owner: string, source: CompanionMessage): { companionId: string; conversationId: string; sourceMessageId: string; checksum: string; originId?: string } | undefined {
  if (source.status !== 'sent' || source.isReplyDraft || source.authorId === 'system') return;
  const current = visible({ companionId: owner, conversationId: source.conversationId }, [source.id])[0];
  if (!current || current.content !== source.content || current.authorId !== source.authorId || current.topicId !== source.topicId) return;
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  if (source.authorId === 'user') return { companionId: owner, conversationId: source.conversationId, sourceMessageId: source.id, checksum: digest(source.content) };
  if (source.authorId === owner) return;
  const jobs = db.prepare("SELECT data FROM companion_social_jobs WHERE companion_id=? AND conversation_id=? AND json_extract(data,'$.sourceMessageId')=? AND status IN('running','done')")
    .all(owner, source.conversationId, source.id) as Array<{ data: string }>;
  const found = new Map<string, { companionId: string; conversationId: string; sourceMessageId: string; checksum: string; originId: string }>();
  let humanLineage = false;
  const peerDigest = digest(JSON.stringify([source.id, source.conversationId, source.topicId, source.authorId, source.content, source.status, source.replyToId]));
  for (const row of jobs) {
    const job = JSON.parse(row.data) as { chainId: string; readSet?: Array<{ id: string; checksum: string }> };
    const storedOrigin = db.prepare('SELECT data FROM companion_social_chain_origins WHERE chain_id=?').get(job.chainId) as { data: string } | undefined;
    const declared = storedOrigin ? JSON.parse(storedOrigin.data) as { initiatorKind?: string; ownerId?: string } : undefined;
    if (declared?.initiatorKind === 'human_player' && declared.ownerId === owner) humanLineage = true;
    const origin = social.continuity.forChain(job.chainId);
    if (!origin || origin.initiatorKind !== 'human_player' || origin.ownerId !== owner || origin.initiatorId !== 'user'
      || !social.continuity.validOrigin(origin.id) || !job.readSet?.some(item => item.id === source.id && item.checksum === peerDigest)) continue;
    const delegation = db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND companion_id=? AND status='active'").get(origin.id, owner) as { data: string } | undefined;
    if (!delegation) continue;
    const original = JSON.parse(delegation.data) as { conversationId: string; sourceMessageId: string };
    const human = visible({ companionId: owner, conversationId: original.conversationId }, [original.sourceMessageId])[0];
    if (!human || human.authorId !== 'user' || human.status !== 'sent' || human.isReplyDraft) continue;
    found.set(original.conversationId + '/' + original.sourceMessageId, { companionId: owner, conversationId: original.conversationId,
      sourceMessageId: original.sourceMessageId, checksum: digest(human.content), originId: origin.id });
  }
  if (found.size > 1 || humanLineage && !found.size) throw new Error('当前伙伴通信缺少唯一且仍有效的原玩家目标出处，不能据此创建或复活持续活动。');
  return found.size === 1 ? [...found.values()][0] : undefined;
}
