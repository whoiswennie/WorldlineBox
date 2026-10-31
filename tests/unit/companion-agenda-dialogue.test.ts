import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { runCompanionStructuredAgent } from '../../src/main/companions/structured-agent';
import { authorizeCompanionAgenda } from '../../src/main/companions/agenda-authorization';
import { COMPANION_AGENDA_TOOL, companionAgendaToolArgumentsSchema, companionAgendaToolCommand } from '../../src/shared/companion-agenda-tool';
import { companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaPublicCommand } from '../../src/shared/companion-agenda';
import { messageSchema, type Companion } from '../../src/shared/companions';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

// These are mocked provider protocol transcripts against real SQL/tool/auth
// paths. They do not measure an actual LLM's personality or judgement quality.
const close: Array<() => void> = [], at = '2026-10-29T08:00:00.000Z';
afterEach(() => { for (const finish of close.splice(0)) finish(); });
const config = { apiFormat: 'openai_chat' as const, baseUrl: 'https://never-contacted.invalid/v1', model: 'scripted-protocol-fixture', apiKey: 'unused-synthetic-only' };
const companion: Companion = { id: 'alice', name: '小澄', persona: '喜欢清醒时阅读，调整计划时会说明理由，也会提出适合自己的替代时间。', description: '',
  model: '', avatar: 'sister', active: true, proactive: false, builtin: false, createdAt: at };
const shape = z.strictObject({ answer: z.string(), changed: z.boolean() });
function fixture(content: string) {
  const { db, connection } = nodeCompanionConnection(); close.push(() => db.close());
  db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,author_id TEXT,status TEXT,kind TEXT,request_fingerprint TEXT);
    INSERT INTO companions VALUES('alice','{"active":true}',NULL);INSERT INTO conversation_members VALUES('private_alice','alice');
    INSERT INTO messages VALUES('current_source','private_alice','user','sent','text',NULL);`);
  const store = new CompanionAgendaStore(connection); store.initialize();
  const send = (command: CompanionAgendaCommand) => store.execute(command)!;
  const initial = companionAgendaRuleDraftSchema.parse({ title: '上午阅读', intent: '安静阅读并记录仍不理解的问题', kind: 'research', executor: 'brain',
    trigger: { kind: 'at', at: '2026-10-29T10:00:00.000Z', timeZone: 'UTC' }, flexible: true, reason: '本人的初始安排' });
  const rule = send({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'original', authority: { kind: 'system' }, rule: initial }).agendaRule!;
  const source = messageSchema.parse({ id: 'current_source', sequence: 1, conversationId: 'private_alice', authorId: 'user', status: 'sent',
    kind: 'text', content, createdAt: at, attachments: [] });
  const mutationReceipts: unknown[] = [], commands: CompanionAgendaPublicCommand[] = [];
  const authorization = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ allowed: true,
    sourceMessageId: source.id, operation: 'agenda.rule.update', evidence: [source.content], reason: '当前真实要求允许协商此安排。' }) } }] })));
  const authorize = async (command: CompanionAgendaPublicCommand) => authorizeCompanionAgenda({ source, command }, config, undefined, { fetchFn: authorization });
  let beforeMutation: (() => void) | undefined;
  const execute = vi.fn(async (call: { id: string; name: string; arguments: string }) => {
    const command = companionAgendaToolCommand(companionAgendaToolArgumentsSchema.parse(JSON.parse(call.arguments)), companion.id, 'dialogue_' + call.id);
    commands.push(command);
    if (!['agenda.read', 'agenda.event.read', 'agenda.goals.read', 'agenda.grants.read'].includes(command.type)) {
      if (!await authorize(command)) return { ok: false, error: '当前要求未授权这个操作。' };
      beforeMutation?.(); beforeMutation = undefined;
      try { const result = send({ ...command, authority: { kind: 'user', sourceMessageId: source.id } } as CompanionAgendaCommand); mutationReceipts.push(result); return result; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : '操作未确认' }; }
    }
    return send(command as CompanionAgendaCommand);
  });
  type Script = (wire: { messages: Array<{ role: string; content: string }> }) => { answer: string; changed: boolean } | { call: Record<string, unknown> };
  async function run(script: Script[]) {
    let step = 0;
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)); expect(JSON.stringify(wire.messages)).toContain(companion.persona);
      const next = script[step++]!(wire);
      const message = 'call' in next ? { content: '', tool_calls: [{ id: 'call_' + step, type: 'function', function: { name: 'agenda', arguments: JSON.stringify(next.call) } }] }
        : { content: JSON.stringify(next) };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    });
    const output = await runCompanionStructuredAgent({ context: { system: '通过实际日程工具查询和协商安排。可以接受、拒绝或提出替代方案；没有成功回执不能声称改好了。只输出JSON。',
      user: JSON.stringify({ purpose: 'dialogue_protocol_fixture', requested: source.content }) }, responseSchema: shape,
      frame: { companion, conversation: { id: source.conversationId, kind: 'private', title: '与小澄交谈', memberIds: [companion.id],
        pinned: false, muted: false, unread: 0, lastMessage: source.content, updatedAt: at }, messages: [source], memories: [] },
      capabilities: { tools: [COMPANION_AGENDA_TOOL], execute } }, config, undefined, { fetchFn });
    return { output: shape.parse(output), fetchFn };
  }
  return { send, rule, initial, source, run, authorize, commands, authorization, mutationReceipts, set beforeMutation(value: () => void) { beforeMutation = value; } };
}

it('[mocked protocol] answers a conversational calendar query from an actual agenda.read result', async () => {
  const f = fixture('你今天有什么打算？');
  const result = await f.run([() => ({ call: { action: 'read' } }), wire => {
    expect(wire.messages.filter(message => message.role === 'tool').at(-1)!.content).toContain(f.rule.id);
    expect(wire.messages.filter(message => message.role === 'tool').at(-1)!.content).toContain('上午阅读');
    return { answer: '我上午十点打算阅读，整理仍不理解的问题。', changed: false };
  }]);
  expect(result.output.changed).toBe(false); expect(f.commands.map(command => command.type)).toEqual(['agenda.read']);
  expect(f.mutationReceipts).toEqual([]); expect(f.authorization).not.toHaveBeenCalled();
});

it('[mocked protocol] applies an accepted negotiated time change only through an authorized matching CAS receipt', async () => {
  const f = fixture('你愿意把今天的阅读提前到九点吗？可以按你自己的情况商量。');
  const revised = { ...f.initial, trigger: { kind: 'at', at: '2026-10-29T09:00:00.000Z', timeZone: 'UTC', repeat: 'once' } };
  const result = await f.run([() => ({ call: { action: 'read' } }), () => ({ call: { action: 'rule.update', id: f.rule.id, expectedRevision: 1, rule: revised } }), wire => {
    expect(wire.messages.filter(message => message.role === 'tool').at(-1)!.content).toContain('"revision":2');
    return { answer: '可以，我也想趁清醒时读；已调整到九点。', changed: true };
  }]);
  expect(result.output.changed).toBe(true); expect(f.mutationReceipts).toHaveLength(1);
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: f.rule.id }).agendaEvent!.rule).toMatchObject({ revision: 2, trigger: { at: '2026-10-29T09:00:00.000Z' } });
});

it('[mocked protocol] permits a reasoned refusal or counteroffer without mutating an otherwise authorized request', async () => {
  const f = fixture('你愿意把阅读改成凌晨两点吗？你可以拒绝，也可以提别的时间。');
  const proposed = companionAgendaToolCommand(companionAgendaToolArgumentsSchema.parse({ action: 'rule.update', id: f.rule.id, expectedRevision: 1,
    rule: { ...f.initial, trigger: { kind: 'at', at: '2026-10-30T02:00:00.000Z', timeZone: 'UTC' } } }), 'alice', 'authorized_proposal');
  expect(await f.authorize(proposed)).toBe(true);
  const result = await f.run([() => ({ call: { action: 'read' } }), () => ({ answer: '我想保留清醒时阅读的习惯，凌晨两点不太合适。我们考虑九点好吗？', changed: false })]);
  expect(result.output.changed).toBe(false); expect(f.commands.every(command => command.type === 'agenda.read')).toBe(true);
  expect(f.mutationReceipts).toEqual([]); expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: f.rule.id }).agendaEvent!.rule.revision).toBe(1);
});

it('[mocked protocol] surfaces a stale CAS failure without claiming the negotiated change happened', async () => {
  const f = fixture('我们把阅读改到九点吧。');
  f.beforeMutation = () => { f.send({ type: 'agenda.rule.update', companionId: 'alice', id: f.rule.id, expectedRevision: 1,
    operationId: 'concurrent_owner_change', authority: { kind: 'system' }, rule: { ...f.initial, title: '已经更新的阅读安排' } }); };
  const result = await f.run([() => ({ call: { action: 'read' } }), () => ({ call: { action: 'rule.update', id: f.rule.id, expectedRevision: 1,
    rule: { ...f.initial, trigger: { kind: 'at', at: '2026-10-29T09:00:00.000Z', timeZone: 'UTC' } } } }), wire => {
    expect(wire.messages.filter(message => message.role === 'tool').at(-1)!.content).toContain('AGENDA_CONFLICT');
    return { answer: '刚才安排已有变化，这次改动没有提交成功，我需要先重新核对。', changed: false };
  }]);
  expect(result.output.changed).toBe(false); expect(f.mutationReceipts).toHaveLength(0);
  expect(f.send({ type: 'agenda.event.read', companionId: 'alice', id: f.rule.id }).agendaEvent!.rule).toMatchObject({ revision: 2, title: '已经更新的阅读安排', trigger: { at: '2026-10-29T10:00:00.000Z' } });
});
