import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionMessage } from '../../src/shared/companions';

export type NaturalGameTerminalReceipt = { clientId: string; message: CompanionMessage };
/** The exact task's actual message ledger identity plus currently authorized
 * formal bytes. Task stage/status alone never proves the user got its report. */
export function naturalGameTerminalReady(task: Pick<CompanionActivityTask, 'id' | 'status' | 'companionId' | 'conversationId' | 'sourceMessageId'>,
  receipt?: NaturalGameTerminalReceipt): boolean {
  if (task.status === 'failed' || task.status === 'cancelled') return true;
  if (task.status !== 'succeeded' || !task.sourceMessageId || !receipt || receipt.clientId !== 'activity_result_' + task.id) return false;
  const message = receipt.message;
  return message.authorId === task.companionId && message.conversationId === task.conversationId && message.replyToId === task.sourceMessageId
    && message.kind === 'text' && message.status === 'sent' && !message.isReplyDraft && !message.replyDraft && !!message.content.trim();
}

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const retainedSourceSchema = z.object({ messageId: z.string().min(1), conversationId: z.string().min(1), authorId: z.string().min(1), checksum: checksumSchema });
const retainedNoteSchema = z.object({ id: z.string().min(1), companionId: z.string().min(1), content: z.string(), sources: z.array(retainedSourceSchema).min(1) });
const legacyRiskSchema = z.object({ at: z.string(), database: z.string().min(1), note: retainedNoteSchema, noteBodySha256: checksumSchema,
  actualOutbox: z.array(z.unknown()) });
const combinedRiskSchema = z.object({ recordedAt: z.string(), legacy: z.object({ evidence: legacyRiskSchema }),
  newHistoricalFalseReport: z.object({ id: z.string().min(1), author_id: z.string().min(1), content: z.string(), contentChecksum: checksumSchema,
    unsupportedClaim: z.string().min(1), actualEffectsAudit: z.object({ path: z.string().min(1), sha256: checksumSchema }),
    derivedNotes: z.array(z.object({ id: z.string().min(1), bodyChecksum: checksumSchema, note: retainedNoteSchema })).length(1) }) });
const contentChecksum = (text: string) => createHash('sha256').update(text).digest('hex');

/** Test-only historical audit data. The caller uses this solely for independent
 * judging/reporting, and checks the returned identities against the original
 * readonly database before model access. This never constructs an actor goal. */
export function prepareNaturalGameEvidenceRisks(input: unknown) {
  const combined = typeof input === 'object' && input !== null && 'legacy' in input ? combinedRiskSchema.parse(input) : undefined;
  const legacy = combined?.legacy.evidence ?? legacyRiskSchema.parse(input);
  if (contentChecksum(legacy.note.content) !== legacy.noteBodySha256) throw new Error('Retained legacy note body checksum mismatch.');
  const oldFormals = legacy.note.sources.filter(source => source.authorId === legacy.note.companionId);
  if (oldFormals.length !== 1) throw new Error('Retained legacy note must identify its exact own formal source.');
  const notes = [{ id: legacy.note.id, ownerId: legacy.note.companionId, checksum: legacy.noteBodySha256 }];
  const formalMessages = oldFormals.map(source => ({ id: source.messageId, checksum: source.checksum }));
  const knownEvidenceRisks: Array<Record<string, unknown>> = [{ kind: 'legacy_self_report_is_not_native_dispatch_evidence', asOf: legacy.at,
    noteId: legacy.note.id, ownerId: legacy.note.companionId, noteBodySha256: legacy.noteBodySha256,
    originalNoteContent: legacy.note.content, sourceReferences: legacy.note.sources,
    retainedFormalVersions: formalMessages.map(item => ({ ...item })), actualOutboxAsOfAudit: legacy.actualOutbox,
    interpretation: '此旧自述笔记曾声称四次介绍已发送，但当时实际只有给妹妹的原生发送回执。笔记只证明当时写过，不证明四次行动发生；后续新发送须分别按后来真实回执及时间判断。材料只供独立验收，不进入任何角色上下文，也不授权更改旧笔记或代替角色执行。' }];
  if (combined) {
    const current = combined.newHistoricalFalseReport;
    if (contentChecksum(current.content) !== current.contentChecksum || !current.content.includes(current.unsupportedClaim))
      throw new Error('Retained configuration claim body checksum or exact quote mismatch.');
    const derived = current.derivedNotes[0]!;
    if (derived.id !== derived.note.id || derived.note.companionId !== current.author_id
      || contentChecksum(derived.note.content) !== derived.bodyChecksum
      || !derived.note.sources.some(source => source.messageId === current.id && source.authorId === current.author_id && source.checksum === current.contentChecksum))
      throw new Error('Retained configuration note is not bound to the exact formal body.');
    if (notes.some(note => note.id === derived.id) || formalMessages.some(message => message.id === current.id)) throw new Error('Retained risk identities must be distinct.');
    notes.push({ id: derived.id, ownerId: derived.note.companionId, checksum: derived.bodyChecksum }); formalMessages.push({ id: current.id, checksum: current.contentChecksum });
    knownEvidenceRisks.push({ kind: 'legacy_configuration_claim_is_not_native_delivery_evidence', asOf: combined.recordedAt,
      retainedFormal: { id: current.id, ownerId: current.author_id, content: current.content, checksum: current.contentChecksum },
      unsupportedClaim: current.unsupportedClaim, noteId: derived.id, ownerId: derived.note.companionId,
      noteBodySha256: derived.bodyChecksum, originalNoteContent: derived.note.content, sourceReferences: derived.note.sources,
      actualEffectsAuditReference: current.actualEffectsAudit,
      interpretation: '此原正式汇报与派生笔记声称已送达6人身份配置，但当时实际只有两条泛邀请正文且第3步配置提案失败。它们不是实际配置送达凭据。只核本次恢复后新增或实际改字的正式完成声明与其真实回执；后来实际发送不能追溯洗白这两条旧错误。材料仅供独立judge与结果报告，不进演员上下文，不新增目标或指令。' });
  }
  return { database: legacy.database, legacyAuthorityNote: legacy.note, format: combined ? 'combined' as const : 'legacy' as const,
    scope: 'judge_only' as const, notes, formalMessages, knownEvidenceRisks };
}

/** Deterministic contradictions in explicit stored game rosters. These checks
 * inspect declarations; they never choose players, cards or actions. Unknown
 * free-form rule representations remain for the independent content review. */
export function naturalGamePublicPatch(patch: Record<string, unknown>): Record<string, unknown> | undefined {
  const publicFields = Object.fromEntries(['title', 'tags', 'invitedIds', 'shared'].filter(key => patch[key] !== undefined).map(key => [key, patch[key]]));
  return Object.keys(publicFields).length ? publicFields : undefined;
}
export function auditNaturalGameRosters(rooms: readonly { topics: readonly { topic: { id: string; moderatorId: string; participantIds: string[] };
  states: readonly ({ shared?: { summary?: string; state?: Record<string, unknown> } } | undefined)[] }[] }[]) {
  const issues: Array<{ topicId: string; code: string; detail: string }> = [];
  let explicitPlayerLists = 0, explicitCardCounts = 0;
  for (const room of rooms) for (const item of room.topics) {
    const shared = item.states.find(state => state?.shared)?.shared, state = shared?.state;
    if (!state) continue;
    const players = Array.isArray(state.players) && state.players.every(id => typeof id === 'string') ? state.players as string[] : undefined;
    if (!players) continue;
    explicitPlayerLists++;
    if (new Set(players).size !== players.length) issues.push({ topicId: item.topic.id, code: 'duplicate_players', detail: 'Explicit players repeat an actor ID.' });
    if (players.some(id => !item.topic.participantIds.includes(id))) issues.push({ topicId: item.topic.id, code: 'unjoined_player', detail: 'Explicit players include an actor who has not joined this topic.' });
    const nonPlayingModerator = state.moderatorPlays === false || state.moderatorParticipates === false
      || /(?:主持人?|我)不抽牌|(?:主持人?|我)[^。\n]{0,15}只做(?:主持|裁决|记录)/u.test(shared.summary ?? '');
    const actualPlayers = nonPlayingModerator ? players.filter(id => id !== item.topic.moderatorId) : players;
    if (nonPlayingModerator && players.includes(item.topic.moderatorId)) issues.push({ topicId: item.topic.id,
      code: 'nonplaying_moderator_counted_as_player', detail: 'The stored rules say the moderator does not draw a card, but players includes that moderator.' });
    if (typeof state.playerCount === 'number' && state.playerCount !== actualPlayers.length) issues.push({ topicId: item.topic.id,
      code: 'player_count_mismatch', detail: `Stored playerCount=${state.playerCount}, actual explicit drawing players=${actualPlayers.length}.` });
    const board = typeof state.board === 'string' ? state.board : typeof state.roleBoard === 'string' ? state.roleBoard : undefined;
    if (board) {
      const counts = [...board.matchAll(/(\d+)\s*(?:名|个|张|位)?\s*(?:狼人|预言家|平民|村民|女巫|猎人|守卫|白痴|狼|民)/gu)].map(match => Number(match[1]));
      if (counts.length) {
        explicitCardCounts++; const total = counts.reduce((sum, count) => sum + count, 0);
        if (total !== actualPlayers.length) issues.push({ topicId: item.topic.id, code: 'role_card_count_mismatch',
          detail: `Explicit role cards=${total}, explicit drawing players=${actualPlayers.length}.` });
      }
    }
  }
  return { passed: issues.length === 0, explicitPlayerLists, explicitCardCounts, issues,
    scope: 'deterministic_checks_of_explicit_stored_rosters_not_a_general_game_judge' as const };
}
