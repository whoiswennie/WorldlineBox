import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import { companionAcceptedPeerActivitySchema, companionPeerResponsibilitySchema, type CompanionPeerResponsibility } from '../shared/companion-peer-activity';

type Scope = { companionId: string; conversationId: string };
type Input = Scope & { id?: string; sourceMessageId?: string; title: string; goal: string; peerResponsibility?: CompanionPeerResponsibility };
export const companionPeerActivitySourceChecksum = (source: CompanionMessage): string => createHash('sha256').update(JSON.stringify([
  source.id, source.conversationId, source.topicId, source.authorId, source.content, source.status, source.replyToId,
])).digest('hex');

/** A social chain may naturally finish while the accepted responsibility
 * continues. Check its source lineage, never its message/round budget. */
function chainSourceValid(db: CompanionConnection, visible: (scope: Scope, ids: string[]) => CompanionMessage[], chainId: string | undefined): boolean {
  if (!chainId) return false;
  const linked = db.prepare('SELECT origin_id,data FROM companion_social_chain_origins WHERE chain_id=?').get(chainId) as { origin_id: string | null; data: string } | undefined;
  if (!linked) return false;
  const origin = JSON.parse(linked.data) as { initiatorKind?: string; ownerId?: string; initiatorId?: string };
  if (!linked.origin_id) return origin.initiatorKind === 'companion';
  if (origin.initiatorKind !== 'human_player' || origin.initiatorId !== 'user') return false;
  const row = db.prepare("SELECT data FROM companion_social_delegations WHERE id=? AND status='active'").get(linked.origin_id) as { data: string } | undefined;
  if (!row) return false;
  const delegation = JSON.parse(row.data) as { companionId: string; conversationId: string; sourceMessageId: string; checksum: string };
  if (origin.ownerId !== delegation.companionId || db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + delegation.conversationId)) return false;
  const source = visible({ companionId: delegation.companionId, conversationId: delegation.conversationId }, [delegation.sourceMessageId])[0];
  return !!source && source.authorId === 'user' && source.status === 'sent' && !source.isReplyDraft && !source.replyDraft
    && createHash('sha256').update(JSON.stringify([source.id, source.conversationId, source.authorId, source.content, source.status, source.replyToId])).digest('hex') === delegation.checksum;
}

/** Creation alone may use the actual live social lease. Every later read or
 * execution requires its durable done/accepted marker and the exact source. */
export function companionPeerActivitySourceValid(db: CompanionConnection,
  visible: (scope: Scope, ids: string[]) => CompanionMessage[], input: Input, creating?: { leaseToken: string }): boolean {
  const origin = companionPeerResponsibilitySchema.safeParse(input.peerResponsibility);
  if (!origin.success || !input.sourceMessageId || ['user', 'system', input.companionId].includes(origin.data.publisherId)) return false;
  const row = db.prepare('SELECT companion_id,conversation_id,status,lease_until,data FROM companion_social_jobs WHERE id=?')
    .get(origin.data.jobId) as { companion_id: string; conversation_id: string; status: string; lease_until: string | null; data: string } | undefined;
  if (!row || row.companion_id !== input.companionId || row.conversation_id !== input.conversationId) return false;
  const job = JSON.parse(row.data) as { id?: string; companionId?: string; conversationId?: string; sourceMessageId?: string; status?: string; chainId?: string;
    leaseToken?: string; readSet?: Array<{ id: string; checksum: string }>; acceptedActivity?: unknown };
  if (job.id !== origin.data.jobId || job.companionId !== input.companionId || job.conversationId !== input.conversationId
    || job.sourceMessageId !== input.sourceMessageId || job.status !== row.status || !Array.isArray(job.readSet) || !job.readSet.length) return false;
  if (!chainSourceValid(db, visible, job.chainId)) return false;
  const sources = new Map(visible({ companionId: input.companionId, conversationId: input.conversationId }, job.readSet.map(read => read.id)).map(source => [source.id, source]));
  if (job.readSet.some(read => !sources.has(read.id) || companionPeerActivitySourceChecksum(sources.get(read.id)!) !== read.checksum)) return false;
  const source = sources.get(input.sourceMessageId);
  if (!source || source.conversationId !== input.conversationId || source.authorId !== origin.data.publisherId || source.status !== 'sent'
    || source.isReplyDraft || source.replyDraft) return false;
  const accepted = companionAcceptedPeerActivitySchema.safeParse(job.acceptedActivity);
  if (creating && row.status === 'running' && job.leaseToken === creating.leaseToken && !!row.lease_until
    && Date.parse(row.lease_until) > Date.now() && job.acceptedActivity === undefined) return true;
  return row.status === 'done' && accepted.success && !!input.id && accepted.data.taskId === input.id
    && accepted.data.sourceMessageId === source.id && accepted.data.publisherId === source.authorId
    && accepted.data.title === input.title && accepted.data.instruction === input.goal
    && accepted.data.sourceChecksum === companionPeerActivitySourceChecksum(source);
}
