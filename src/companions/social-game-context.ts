import { createHash } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionSocialGameContextSchema, type CompanionSocialGameContext, type CompanionSocialJob } from '../shared/companion-social';
import { companionExecutionReadsetSchema } from '../shared/companion-execution-evidence';
import { executionMessageReadsetKey } from './execution-source-access';

type Input = Extract<CompanionStorageCommand, { type: 'social.job.game_context' }>;
type Job = CompanionSocialJob & { readSet?: Array<{ id: string; checksum: string }> };
type Port = { conversationId: string; topicId: string; deliveryClientId: string };
type Task = { id: string; companionId: string; conversationId: string; sourceMessageId?: string; sourceChecksum?: string; status: string; gamePort?: Port };
type Dependencies = {
  visible(scope: { companionId: string; conversationId: string }, ids: string[]): CompanionMessage[];
  validRead(job: Job): boolean;
  sourceGoal?(owner: string, source: CompanionMessage): { companionId: string; conversationId: string; sourceMessageId: string; checksum: string } | undefined;
  topicExecute?(command: Extract<CompanionStorageCommand, { type: `topic.${string}` }>): CompanionStorageResponse | undefined;
  activityTaskValid?(id: string, owner: string, conversationId: string): boolean;
};
const parse = <T>(value: string | undefined): T | undefined => { try { return value ? JSON.parse(value) as T : undefined; } catch { return; } };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const socialChecksum = (m: CompanionMessage) => sha(JSON.stringify([m.id, m.conversationId, m.topicId, m.authorId, m.content, m.status, m.replyToId]));
const originChecksum = (m: CompanionMessage) => sha(JSON.stringify([m.id, m.conversationId, m.authorId, m.content, m.status, m.replyToId]));

type Reservation = { companionId: string; sourceChecksum: string; conversationId: string; topicId: string;
  send: { clientId: string; companionId: string; conversationId: string; topicId?: string | null; content: string;
    sourceMessageId?: string; authorizationMessageId?: string; replyToId?: string; agentSource?: { conversationId: string; messageId: string } } };

/** The initial create and a later task bind can be different real messages.
 * Validate each receipt independently rather than equating their client IDs. */
function reservationValid(db: CompanionConnection, value: Reservation, original: CompanionMessage, deps: Dependencies): boolean {
  const send = value.send;
  if (!send || send.companionId !== value.companionId || send.conversationId !== value.conversationId || send.topicId !== value.topicId) return false;
  const row = db.prepare('SELECT companion_id,conversation_id,status,message_id,data FROM companion_social_outbox WHERE client_id=?').get(send.clientId) as
    { companion_id: string; conversation_id: string; status: string; message_id?: string; data: string } | undefined;
  const receipt = parse<Reservation['send'] & { fingerprint: string; sourceChecksum?: string; authorizationChecksum?: string; agentChecksum?: string }>(row?.data);
  if (!row || !receipt || !['pending', 'sent'].includes(row.status) || row.companion_id !== value.companionId || row.conversation_id !== value.conversationId
    || receipt.companionId !== value.companionId || receipt.conversationId !== value.conversationId || receipt.topicId !== value.topicId
    || receipt.fingerprint !== sha(JSON.stringify(send))) return false;
  const sourceFields = ['type', 'clientId', 'companionId', 'conversationId', 'topicId', 'content', 'channel', 'urgent', 'shareAddress',
    'sourceMessageId', 'authorizationMessageId', 'replyToId', 'agentSource', 'executionReadset'];
  if (sourceFields.some(key => JSON.stringify((receipt as unknown as Record<string, unknown>)[key])
    !== JSON.stringify((send as unknown as Record<string, unknown>)[key]))) return false;
  const read = (room: string, id: string, expected: string | undefined) => {
    const source = deps.visible({ companionId: value.companionId, conversationId: room }, [id])
      .find(message => message.id === id && message.conversationId === room);
    return source && expected === socialChecksum(source) ? source : undefined;
  };
  const peer = send.sourceMessageId ? read(send.conversationId, send.sourceMessageId, receipt.sourceChecksum) : undefined;
  const authorization = send.authorizationMessageId ? read(original.conversationId, send.authorizationMessageId, receipt.authorizationChecksum) : undefined;
  const agent = send.agentSource ? read(send.agentSource.conversationId, send.agentSource.messageId, receipt.agentChecksum) : undefined;
  if (send.sourceMessageId && (!peer || peer.authorId === 'user' || peer.authorId === 'system')
    || send.authorizationMessageId && (!authorization || authorization.authorId !== 'user' || authorization.id !== original.id)
    || send.agentSource && !agent) return false;
  const source = agent ?? authorization ?? peer;
  const goal = source ? deps.sourceGoal?.(value.companionId, source) : undefined;
  if (!goal || goal.companionId !== value.companionId || goal.conversationId !== original.conversationId
    || goal.sourceMessageId !== original.id || goal.checksum !== sha(original.content)) return false;
  if (row.status === 'sent') {
    const published = row.message_id ? deps.visible({ companionId: value.companionId, conversationId: value.conversationId }, [row.message_id])[0] : undefined;
    if (!published || published.id !== row.message_id || published.authorId !== value.companionId || published.conversationId !== value.conversationId
      || published.topicId !== value.topicId || published.content !== send.content) return false;
  }
  return true;
}

/** A human request can start another episode. Only the actual incoming
 * message's immutable proof may select a game; a current reservation cannot. */
function sourceGamePort(db: CompanionConnection, sourceId: string): { conversationId: string; topicId: string } | undefined {
  const pending = [sourceId], seen = new Set<string>(), found = new Map<string, { conversationId: string; topicId: string }>();
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const stored = db.prepare('SELECT value FROM metadata WHERE key=?').get(executionMessageReadsetKey(id)) as { value: string } | undefined;
    const parsed = companionExecutionReadsetSchema.safeParse(parse(stored?.value));
    if (!parsed.success || !parsed.data.complete) continue;
    for (const topic of parsed.data.topics) {
      const row = db.prepare('SELECT data FROM companion_topics WHERE id=? AND conversation_id=?').get(topic.topicId, topic.conversationId) as { data: string } | undefined;
      if (parse<{ kind: string }>(row?.data)?.kind === 'game') found.set(`${topic.conversationId}/${topic.topicId}`, { conversationId: topic.conversationId, topicId: topic.topicId });
    }
    if (id === sourceId && found.size) return found.size === 1 ? [...found.values()][0] : undefined;
    pending.push(...parsed.data.sources.map(item => item.id));
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}

/** Resolves only an actual leased inbound job's durable game. It neither reads
 * another player's private state nor exports the human delegation's contents. */
export function companionSocialGameContext(db: CompanionConnection, input: Input, deps: Dependencies): CompanionSocialGameContext | undefined {
  try { return resolveGameContext(db, input, deps); } catch { return; }
}

function resolveGameContext(db: CompanionConnection, input: Input, deps: Dependencies): CompanionSocialGameContext | undefined {
  const stored = db.prepare('SELECT companion_id,conversation_id,status,lease_until,data FROM companion_social_jobs WHERE id=?').get(input.id) as
    { companion_id: string; conversation_id: string; status: string; lease_until: string | null; data: string } | undefined;
  const job = parse<Job>(stored?.data);
  if (!stored || !job || stored.companion_id !== input.companionId || stored.conversation_id !== input.conversationId
    || stored.status !== 'running' || job.status !== 'running' || job.id !== input.id || job.leaseToken !== input.leaseToken
    || job.companionId !== input.companionId || job.conversationId !== input.conversationId || job.sourceMessageId !== input.sourceMessageId
    || !Number.isFinite(Date.parse(stored.lease_until ?? '')) || Date.parse(stored.lease_until!) <= Date.now()) return;
  const source = deps.visible({ companionId: input.companionId, conversationId: input.conversationId }, [input.sourceMessageId])[0];
  if (!source || source.id !== input.sourceMessageId || source.conversationId !== input.conversationId || source.status !== 'sent'
    || source.isReplyDraft || source.replyDraft || source.authorId === 'user' || source.authorId === 'system' || source.authorId === input.companionId
    || sha(source.content) !== input.sourceChecksum || !job.readSet?.some(read => read.id === source.id && read.checksum === socialChecksum(source))
    || !deps.validRead(job)) return;
  const episode = sourceGamePort(db, source.id);
  if (!episode) return;
  const chain = db.prepare("SELECT origin_id,data FROM companion_social_chain_origins WHERE chain_id=?").get(job.chainId) as { origin_id?: string; data: string } | undefined;
  const origin = parse<{ id: string; ownerId: string; initiatorId: string; initiatorKind: string }>(chain?.data);
  if (!chain?.origin_id || !origin || origin.id !== chain.origin_id || origin.initiatorKind !== 'human_player' || origin.initiatorId !== 'user') return;
  const delegationRow = db.prepare("SELECT companion_id,source_message_id,data FROM companion_social_delegations WHERE id=? AND status='active'").get(chain.origin_id) as
    { companion_id: string; source_message_id: string; data: string } | undefined;
  const delegation = parse<{ companionId: string; conversationId: string; sourceMessageId: string; checksum: string; recipientIds: string[] }>(delegationRow?.data);
  if (!delegationRow || !delegation || delegation.companionId !== origin.ownerId || delegationRow.companion_id !== origin.ownerId
    || delegationRow.source_message_id !== delegation.sourceMessageId) return;
  const original = deps.visible({ companionId: origin.ownerId, conversationId: delegation.conversationId }, [delegation.sourceMessageId])[0];
  if (!original || original.id !== delegation.sourceMessageId || original.conversationId !== delegation.conversationId || original.authorId !== 'user'
    || original.status !== 'sent' || original.isReplyDraft || original.replyDraft || originChecksum(original) !== delegation.checksum) return;
  const tasks = db.prepare("SELECT data FROM companion_activity_tasks WHERE companion_id=? AND conversation_id=? AND source_message_id=? AND status IN('queued','running','waiting')")
    .all(origin.ownerId, delegation.conversationId, delegation.sourceMessageId) as Array<{ data: string }>;
  const ports = new Map<string, Port>();
  for (const row of tasks) {
    const task = parse<Task>(row.data), port = task?.gamePort;
    if (!task || !port || task.companionId !== origin.ownerId || task.conversationId !== delegation.conversationId
      || task.sourceMessageId !== original.id || task.sourceChecksum !== sha(original.content) || !['queued', 'running', 'waiting'].includes(task.status)
      || !deps.activityTaskValid?.(task.id, task.companionId, task.conversationId)) continue;
    ports.set(`${port.conversationId}/${port.topicId}`, port);
  }
  if (ports.size !== 1) return;
  const port = [...ports.values()][0]!;
  if (port.conversationId !== episode.conversationId || port.topicId !== episode.topicId) return;
  const reservationRow = db.prepare('SELECT value FROM metadata WHERE key=?').get(`world-goal-game-port/${origin.ownerId}/${original.id}`) as { value: string } | undefined;
  const reservation = parse<Reservation>(reservationRow?.value);
  // Staged native topic creation can bind a real task port through its actual
  // outbound receipt without going through WorldStore's create-group replay
  // reservation. The validated task is the authority, never a guessed current
  // room. An existing reservation must still agree exactly; malformed records
  // are not treated as absent and no creation history is synthesized here.
  if (reservationRow && (!reservation || reservation.companionId !== origin.ownerId || reservation.sourceChecksum !== sha(original.content)
    || reservation.conversationId !== port.conversationId || reservation.topicId !== port.topicId || !reservationValid(db, reservation, original, deps))) return;
  const current = deps.topicExecute?.({ type: 'topic.read', conversationId: port.conversationId, topicId: port.topicId, readerId: input.companionId });
  if (!current?.topic || !current.topicState || current.topic.kind !== 'game' || current.topic.status !== 'active' || current.topic.deletedAt
    || current.topic.id !== port.topicId || current.topic.conversationId !== port.conversationId
    || current.topicState.readerId !== input.companionId || current.topicState.topicId !== port.topicId) return;
  const readers = [...new Set([input.companionId, ...(input.recipientIds ?? [])])];
  if (readers.some(id => !current.topic!.participantIds.includes(id)
    || !db.prepare('SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id WHERE m.conversation_id=? AND m.companion_id=? AND c.dissolved_at IS NULL').get(port.conversationId, id)
    || db.prepare("SELECT 1 FROM companion_topic_participation WHERE topic_id=? AND reader_id=? AND status IN('left','paused')").get(port.topicId, id))) return;
  return companionSocialGameContextSchema.parse({ gamePort: { conversationId: port.conversationId, topicId: port.topicId },
    topic: current.topic, topicState: current.topicState,
    binding: { jobId: job.id, companionId: input.companionId, sourceMessageId: source.id, sourceConversationId: source.conversationId, sourceChecksum: input.sourceChecksum },
    trust: 'actual_job_same_game_reference_not_source_or_human_authority' });
}
