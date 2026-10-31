import Ajv from 'ajv';
import { z } from 'zod';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { generateCompanionReply, type CompanionReplyInput } from '../../src/main/companions/model';
import { COMPANION_AGENDA_TOOL, companionAgendaToolArgumentsSchema, companionAgendaToolCommand } from '../../src/shared/companion-agenda-tool';
import { companionProviderToolParameters } from '../../src/shared/companion-tool-json-schema';
import type { CompanionAgendaCommand } from '../../src/shared/companion-agenda';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

const now = '2026-10-29T08:00:00.000Z', due = '2026-10-29T08:01:00.000Z';
const input: CompanionReplyInput = {
  companion: { id: 'alice', name: '小澄', persona: '认真核对真实安排。', description: '', model: '', avatar: 'sister', active: true,
    builtin: false, proactive: false, createdAt: now },
  conversation: { id: 'own_room', kind: 'private', title: '本人私聊', memberIds: ['alice'], pinned: false, muted: false, unread: 0, lastMessage: '', updatedAt: now },
  messages: [], memories: [],
};
const reminder = { action: 'rule.create', rule: { title: '喝水提醒', intent: '提醒用户喝水。', kind: 'reminder', executor: 'reminder',
  flexible: false, conversationId: 'own_room', trigger: { kind: 'at', at: due, timeZone: 'UTC' }, reason: '用户在当前私聊明确要求一分钟后提醒喝水。' } };
afterEach(() => vi.useRealTimers());

function providerRoot(schema: Record<string, unknown>) {
  expect(schema.type).toBe('object');
  for (const key of ['anyOf', 'oneOf', 'allOf', '$schema']) expect(schema).not.toHaveProperty(key);
  expect(schema.properties).toBeTruthy();
  const ajv = new Ajv({ unknownFormats: 'ignore', logger: false });
  expect(ajv.validateSchema(schema)).toBe(true);
  return ajv.compile(schema);
}

it('projects the actual Zod action union to a provider object while retaining strict local action validation', () => {
  const original = z.toJSONSchema(companionAgendaToolArgumentsSchema, { io: 'input' });
  expect(original.anyOf ?? original.oneOf).toBeTruthy();
  const validate = providerRoot(COMPANION_AGENDA_TOOL.parameters);
  expect(validate(reminder)).toBe(true);
  expect(validate({ action: 'rule.create', rule: { title: 'missing real fields' } })).toBe(false);
  expect(companionAgendaToolArgumentsSchema.safeParse({ action: 'read', rule: reminder.rule }).success).toBe(false);
  expect(companionProviderToolParameters(COMPANION_AGENDA_TOOL.parameters)).toEqual(COMPANION_AGENDA_TOOL.parameters);
});

it('preserves task queries and explicit partner responses through the real public command translator', () => {
  const translate = (value: unknown) => companionAgendaToolCommand(companionAgendaToolArgumentsSchema.parse(value), 'alice', 'actual_tool_call');
  expect(translate({ action: 'tasks.read' })).toEqual({ type: 'agenda.tasks.read', companionId: 'alice', limit: 30, executionStatus: 'active' });
  const taskResponse = { decision: 'negotiate', message: '我想改在清醒时研究，能安排在九点吗？' };
  for (const kind of ['rule', 'goal']) expect(translate({ action: kind + '.control', id: 'actual_task', expectedRevision: 2, transition: 'pause', taskResponse }))
    .toMatchObject({ type: 'agenda.' + kind + '.control', id: 'actual_task', expectedRevision: 2, action: 'pause', taskResponse, operationId: 'actual_tool_call' });
  expect(companionAgendaToolArgumentsSchema.safeParse({ ...reminder, rule: { ...reminder.rule, category: 'event' } }).success).toBe(false);
});

it.each(['openai_chat', 'openai_responses', 'anthropic'] as const)('exports compatible actual %s native tool request bodies, not a separate test schema', async apiFormat => {
  const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    for (const wrapped of body.tools) {
      const tool = apiFormat === 'openai_chat' ? wrapped.function : wrapped;
      const schema = apiFormat === 'anthropic' ? tool.input_schema : tool.parameters;
      const validate = providerRoot(schema);
      if (tool.name === 'agenda') expect(validate(reminder)).toBe(true);
      if (apiFormat !== 'anthropic') expect(tool.strict).toBe(false);
    }
    const text = JSON.stringify({ text: '我会以实际登记结果为准。', memories: [] });
    return new Response(JSON.stringify(apiFormat === 'openai_responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : apiFormat === 'anthropic' ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  const reply = await generateCompanionReply(input, { apiFormat, model: 'synthetic-protocol', baseUrl: 'https://never-contacted.invalid', apiKey: 'unused' },
    undefined, { fetchFn, loop: true });
  expect(reply.text).toBe('我会以实际登记结果为准。'); expect(fetchFn).toHaveBeenCalledOnce();
});

it('persists the provider-valid one-minute reminder and claims its exact original occurrence only at the due instant', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const { db, connection } = nodeCompanionConnection();
  try {
    db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE conversation_members(conversation_id TEXT,companion_id TEXT);CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,author_id TEXT,status TEXT,kind TEXT,request_fingerprint TEXT);
      INSERT INTO companions VALUES('alice','{"active":true}',NULL);INSERT INTO conversation_members VALUES('own_room','alice');
      INSERT INTO messages VALUES('source','own_room','user','sent','text',NULL);`);
    const store = new CompanionAgendaStore(connection); store.initialize();
    expect(providerRoot(COMPANION_AGENDA_TOOL.parameters)(reminder)).toBe(true);
    const command = companionAgendaToolCommand(companionAgendaToolArgumentsSchema.parse(reminder), 'alice', 'one_minute_reminder');
    const request = { ...command, authority: { kind: 'user', sourceMessageId: 'source' } } as CompanionAgendaCommand;
    const saved = store.execute(request)!.agendaRule!;
    expect(saved).toMatchObject({ origin: 'user', executor: 'reminder', trigger: { kind: 'at', at: due }, nextAt: due });
    expect(store.execute(request)!.agendaRule!.id).toBe(saved.id);
    const tick = (at: string) => store.execute({ type: 'agenda.tick', companionId: 'alice', now: at, facts: {} });
    const claim = (at: string) => store.execute({ type: 'agenda.claim', companionId: 'alice', now: at, leaseMs: 30000, limit: 1, excludedOwners: [] })!;
    tick('2026-10-29T08:00:59.999Z'); expect(claim('2026-10-29T08:00:59.999Z').agendaClaims).toHaveLength(0);
    tick(due); const receipt = claim(due).agendaClaim!;
    expect(receipt.rule.id).toBe(saved.id); expect(receipt.occurrence.scheduledAt).toBe(due);
    store.execute({ type: 'agenda.run.settle', companionId: 'alice', id: receipt.run.id, leaseToken: receipt.leaseToken, now: due,
      outcome: 'completed', result: '已完成本次提醒投递的受控回执。' });
    tick('2026-10-29T08:02:00.000Z'); expect(claim('2026-10-29T08:02:00.000Z').agendaClaims).toHaveLength(0);
    expect(store.execute({ type: 'agenda.event.read', companionId: 'alice', id: saved.id })!.agendaEvent!.runs).toHaveLength(1);
  } finally { db.close(); }
});

it('keeps safe provider schema-rejection details without persisting provider prose or retrying HTTP 400', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_function_parameters',
    param: 'tools[3].function.parameters', message: 'Invalid schema: root anyOf is not allowed. PRIVATE_REQUEST_CONTENT sk-secret' } }), { status: 400 }));
  const failed = await generateCompanionReply(input, { apiFormat: 'openai_chat', model: 'synthetic', baseUrl: 'https://never-contacted.invalid', apiKey: 'unused' },
    undefined, { fetchFn, loop: true }).catch(error => error);
  expect(failed).toMatchObject({ code: 'CONFIG' });
  expect(failed.message).toContain('tools[3].function.parameters'); expect(failed.diagnostic).toContain('invalid_function_parameters');
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_REQUEST_CONTENT'); expect(JSON.stringify(failed)).not.toContain('sk-secret');
  expect(fetchFn).toHaveBeenCalledOnce();
});
