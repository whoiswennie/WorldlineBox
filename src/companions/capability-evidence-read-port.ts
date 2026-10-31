import type { CompanionConnection } from './store';
import type { CompanionStorageCommand } from '../shared/companion-storage';
import { companionLoopCallSchema } from '../shared/companion-loop';
import { companionCapabilityAudience, companionConversationIdentity } from './capability-conversation-scope';
import type { CompanionCapabilityActionView, CompanionCapabilityEvidenceIdentity, CompanionCapabilityLoopView,
  CompanionCapabilityReadResponse } from '../shared/companion-capability-evidence';

type Row = Record<string, unknown>;
const string = (row: Row, field: string): string | undefined => typeof row[field] === 'string' ? row[field] : undefined;
const required = (row: Row, field: string): string => { const value = string(row, field); if (value === undefined) throw new Error('Capability identity metadata is malformed.'); return value; };
const optionalString = (row: Row, field: string): string | undefined => {
  if (row[field] === null || row[field] === undefined) return;
  return required(row, field);
};

/** A projected SQL port for the shared validator, not another validator.
 * Only fields consumed by its rules leave SQLite. Megabytes of saved context,
 * result bodies and provider output are neither decoded nor sent over IPC. */
export function createCompanionCapabilityReadPort(db: CompanionConnection, actions: readonly CompanionCapabilityEvidenceIdentity[],
  fallback: (command: CompanionStorageCommand) => CompanionCapabilityReadResponse) {
  const statements = new Map<string, ReturnType<CompanionConnection['prepare']>>();
  const statement = (sql: string) => { let compiled = statements.get(sql); if (!compiled) { compiled = db.prepare(sql); statements.set(sql, compiled); } return compiled; };
  const loop = (key: string): CompanionCapabilityLoopView | undefined => {
    const value = statement(`SELECT json_extract(value,'$.companionId') AS companionId,json_extract(value,'$.conversationId') AS conversationId,
      json_extract(value,'$.sourceMessageId') AS sourceMessageId,json_extract(value,'$.messageId') AS messageId,
      json_extract(value,'$.invocationKey') AS invocationKey,json_extract(value,'$.status') AS status,
      json_type(value,'$.turns') AS turnsType,json_array_length(value,'$.turns') AS turnCount,
      json_type(value,'$.context') AS contextType,json_type(value,'$.context.user') AS userType,
      CASE WHEN json_valid(json_extract(value,'$.context.user')) THEN
        CASE WHEN json_type(json_extract(value,'$.context.user'))='object'
          THEN json_object('taskRequest',json_extract(json_extract(value,'$.context.user'),'$.taskRequest'))
          ELSE json_extract(value,'$.context.user') END
        ELSE json_extract(value,'$.context.user') END AS contextUser
      FROM metadata WHERE key=?`).get(key) as Row | undefined;
    if (!value) return;
    if (value.turnsType !== 'array' || !Number.isSafeInteger(value.turnCount) || !['running', 'done'].includes(String(value.status))) throw new Error('Capability parent loop metadata is malformed.');
    const turns = Array.from({ length: Number(value.turnCount) }, () => ({ calls: [] as CompanionCapabilityLoopView['turns'][number]['calls'] }));
    const calls = statement(`SELECT CAST(turn.key AS INTEGER) AS step,json_type(turn.value,'$.calls') AS callsType,
      call.key AS callIndex,json_extract(call.value,'$.id') AS id,json_extract(call.value,'$.name') AS name,json_extract(call.value,'$.arguments') AS arguments
      FROM metadata saved,json_each(saved.value,'$.turns') turn LEFT JOIN json_each(turn.value,'$.calls') call ON 1=1
      WHERE saved.key=? ORDER BY CAST(turn.key AS INTEGER),CAST(call.key AS INTEGER)`).all(key) as Row[];
    for (const call of calls) {
      if (call.callsType !== 'array') throw new Error('Capability parent calls are malformed.');
      if (call.callIndex === null) continue;
      const turn = turns[Number(call.step)]; if (!turn || turn.calls.length >= 16) throw new Error('Capability parent call scope is malformed.');
      turn.calls.push(companionLoopCallSchema.parse({ id: call.id, name: call.name, arguments: call.arguments }));
    }
    const messageId = optionalString(value, 'messageId'), invocationKey = optionalString(value, 'invocationKey');
    const result: CompanionCapabilityLoopView = { companionId: required(value, 'companionId'), conversationId: required(value, 'conversationId'), sourceMessageId: required(value, 'sourceMessageId'),
      ...(messageId !== undefined ? { messageId } : {}), ...(invocationKey !== undefined ? { invocationKey } : {}), turns };
    if (value.contextType !== null) {
      if (value.contextType !== 'object' || value.userType !== 'text') throw new Error('Capability parent context metadata is malformed.');
      result.context = { user: required(value, 'contextUser') };
    }
    return result;
  };
  return (command: CompanionStorageCommand): CompanionCapabilityReadResponse => {
    if (command.type === 'action.get') {
      const value = statement(`SELECT json_extract(data,'$.id') AS id,json_extract(data,'$.companionId') AS companionId,json_extract(data,'$.conversationId') AS conversationId,
        json_extract(data,'$.capability') AS capability,json_type(data,'$.contentAvailable') AS availability,
        json_extract(data,'$.sourceMessageId') AS sourceMessageId,json_extract(data,'$.parentMessageId') AS parentMessageId,
        json_extract(data,'$.toolCallId') AS toolCallId,json_extract(data,'$.loopStep') AS loopStep,json_extract(data,'$.authorizationGrantId') AS authorizationGrantId,
        EXISTS(SELECT 1 FROM metadata WHERE key='execution-source-invalid/action/'||json_extract(actions.data,'$.id')) AS invalidated
        FROM actions WHERE id=?`).get(command.id) as Row | undefined;
      if (!value) throw new Error('行动不存在。');
      const action: CompanionCapabilityActionView = { id: required(value, 'id'), companionId: required(value, 'companionId'), conversationId: required(value, 'conversationId'),
        ...(value.capability ? { capability: JSON.parse(String(value.capability)) as CompanionCapabilityActionView['capability'] } : {}) };
      for (const field of ['sourceMessageId', 'parentMessageId', 'toolCallId', 'authorizationGrantId'] as const) { const found = optionalString(value, field); if (found !== undefined) action[field] = found; }
      if (typeof value.loopStep === 'number') action.loopStep = value.loopStep;
      if (value.invalidated || value.availability === 'false') action.contentAvailable = false;
      else if (value.availability === 'true') action.contentAvailable = true;
      else if (value.availability !== null) throw new Error('Capability presentation availability is malformed.');
      if (action.capability) action.capability = { ...action.capability, audience: companionCapabilityAudience(db, action) };
      return { ok: true, action };
    }
    if (command.type === 'state' && command.companionId) {
      const owner = statement(`SELECT json_extract(data,'$.id') AS id FROM companions WHERE id=? AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM companion_creation_operations birth WHERE birth.companion_id=companions.id AND json_extract(birth.data,'$.state')!='committed')`).get(command.companionId) as Row | undefined;
      const ids = [...new Set(actions.filter(action => action.companionId === command.companionId).map(action => action.conversationId))];
      const rooms = ids.flatMap(id => { const room = statement('SELECT id,kind FROM conversations WHERE id=? AND dissolved_at IS NULL').get(id) as { id: string; kind: 'private' | 'group' } | undefined;
        return room ? [companionConversationIdentity(db, room)] : []; });
      return { ok: true, state: { companions: owner ? [{ id: required(owner, 'id') }] : [], conversations: rooms } };
    }
    if (command.type === 'message.get') {
      const message = statement('SELECT id,author_id AS authorId,conversation_id AS conversationId,reply_to_id AS replyToId FROM messages WHERE id=?').get(command.id) as Row | undefined;
      if (!message || !statement('SELECT 1 FROM conversations WHERE id=?').get(required(message, 'conversationId'))) throw new Error('消息不存在。');
      const replyToId = optionalString(message, 'replyToId');
      return { ok: true, message: { id: required(message, 'id'), authorId: required(message, 'authorId'), conversationId: required(message, 'conversationId'),
        ...(replyToId !== undefined ? { replyToId } : {}) } };
    }
    if (command.type === 'loop.for-message') {
      if (!statement('SELECT 1 FROM messages WHERE id=?').get(command.messageId)) throw new Error('消息不存在。');
      return { ok: true, loop: loop('message-loop/' + command.messageId) };
    }
    if (command.type === 'loop.get') return { ok: true, loop: loop(`loop/${command.sourceMessageId}/${command.companionId}` + (command.invocationKey ? '/invocation/' + command.invocationKey : '')) };
    return fallback(command);
  };
}
