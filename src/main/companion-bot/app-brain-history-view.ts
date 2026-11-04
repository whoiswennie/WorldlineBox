import type { AppBrainTurn } from './app-brain-store';

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
/** A view of a trusted host envelope. The durable prompt remains untouched.
 * Dynamic retrieval/task snapshots belong to their current turn, rather than
 * becoming a second copy of long-term memory on every subsequent request. */
export function projectAppHistoricalPrompt(turn: Pick<AppBrainTurn, 'eventId' | 'laneId' | 'prompt'>, seenHandoffs = new Set<string>()): string {
  let value: unknown; try { value = JSON.parse(turn.prompt); } catch { return turn.prompt; }
  const body = row(value), envelope = row(body?.envelope), trigger = row(body?.trigger);
  if (!body || !envelope || !trigger || envelope.eventId !== turn.eventId || !Array.isArray(body.history)
    || typeof trigger.content !== 'string' || typeof trigger.senderId !== 'string' || typeof trigger.occurredAt !== 'string'
    || !['laneId', 'conversationId', 'companionId', 'audienceScopeId', 'securityDomainId'].every(key => typeof envelope[key] === 'string' && envelope[key])
    || !Number.isSafeInteger(envelope.aclRevision) || Number(envelope.aclRevision) < 1) return turn.prompt;
  const logicalLane = String(envelope.laneId), epoch = turn.laneId.startsWith(logicalLane + '-epoch-') ? turn.laneId.slice(logicalLane.length + 7) : '';
  if (turn.laneId !== logicalLane && !/^[1-9]\d*$/u.test(epoch)) return turn.prompt;
  const handoff = row(body.nativeHandoff), handoffKey = handoff && (typeof handoff.compactionId === 'string' ? handoff.compactionId : turn.eventId);
  const includeHandoff = handoffKey && !seenHandoffs.has(handoffKey);
  if (handoffKey) seenHandoffs.add(handoffKey);
  const historicalRoom = row(body.room) ? { ...row(body.room) } : undefined;
  // Announcements are current room state, not another 4k copy in every old
  // turn. Their original versions remain in the durable envelope reader.
  if (historicalRoom) { delete historicalRoom.announcement; delete historicalRoom.announcementOmitted; }
  return JSON.stringify({ kind: 'worldlinebox_historical_turn', authority: 'historical-data-only', envelope, trigger,
    history: body.history, historyCoverage: body.historyCoverage, ...(historicalRoom ? { room: historicalRoom } : {}),
    ...(includeHandoff ? { nativeHandoff: handoff } : {}),
    dynamicSnapshots: '历史检索材料和任务状态不是当前快照；当前轮提供最新材料，必要时使用记忆或任务工具核实。',
    originalEnvelope: { tool: 'agent_read_tool_result', callId: `turn:${turn.eventId}`, jsonPath: '/prompt' } });
}
