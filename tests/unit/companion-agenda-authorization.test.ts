import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../src/main/companions/model', () => ({ generateCompanionStructured: vi.fn() }));
import { authorizeCompanionAgenda } from '../../src/main/companions/agenda-authorization';
import { generateCompanionStructured, type CompanionModelConfig } from '../../src/main/companions/model';
import { messageSchema } from '../../src/shared/companions';
import type { CompanionAgendaPublicCommand } from '../../src/shared/companion-agenda';

const source = messageSchema.parse({ id: 'real-user-source', sequence: 1, conversationId: 'own-room', authorId: 'user', kind: 'text',
  content: '请先暂停这项安排，等我补充材料后再继续。', createdAt: '2026-10-29T10:00:00Z', status: 'sent', attachments: [] });
const command: CompanionAgendaPublicCommand = { type: 'agenda.rule.control', companionId: 'alice', id: 'rule', expectedRevision: 1, operationId: 'operation', action: 'pause' };
const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'fixture-no-provider', apiKey: 'fixture-unused' };
const valid = () => ({ allowed: true, sourceMessageId: source.id, operation: command.type, evidence: ['请先暂停这项安排'], reason: '当前原文明确提出暂停。' });
beforeEach(() => { vi.mocked(generateCompanionStructured).mockReset(); vi.mocked(generateCompanionStructured).mockResolvedValue(valid()); });

it('accepts only an exact current source/operation with verbatim evidence and passes the native schema/config/signal', async () => {
  const controller = new AbortController(), fetchFn = vi.fn<typeof fetch>();
  expect(await authorizeCompanionAgenda({ source, command }, config, controller.signal, { fetchFn })).toBe(true);
  expect(generateCompanionStructured).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ user: expect.any(String), system: expect.stringContaining('当前source.content') }), config, controller.signal, expect.objectContaining({ fetchFn, responseSchema: expect.any(Object) }));
  const request = JSON.parse(vi.mocked(generateCompanionStructured).mock.calls[0]![0].user);
  expect(request.source).toEqual({ id: source.id, content: source.content, authorId: 'user' }); expect(request.proposed).toEqual(command);
});
it.each(['peer-author', 'failed-source', 'draft-source'] as const)('rejects %s before asking the model for authorization', async change => {
  const current = { ...source, ...(change === 'peer-author' ? { authorId: 'bob' } : change === 'failed-source' ? { status: 'failed' as const } : { isReplyDraft: true }) };
  expect(await authorizeCompanionAgenda({ source: current, command }, config)).toBe(false); expect(generateCompanionStructured).not.toHaveBeenCalled();
});
it.each(['denied', 'wrong-source', 'wrong-operation', 'invented-evidence', 'empty-evidence', 'empty-quote', 'malformed'] as const)('rejects %s decisions instead of treating a proposal as authority', async change => {
  const decision: Record<string, unknown> = valid();
  if (change === 'denied') decision.allowed = false;
  if (change === 'wrong-source') decision.sourceMessageId = 'another-source';
  if (change === 'wrong-operation') decision.operation = 'agenda.grant.configure';
  if (change === 'invented-evidence') decision.evidence = ['允许观察我的整个桌面'];
  if (change === 'empty-evidence') decision.evidence = [];
  if (change === 'empty-quote') decision.evidence = [''];
  if (change === 'malformed') decision.allowed = 'true';
  vi.mocked(generateCompanionStructured).mockResolvedValueOnce(decision);
  expect(await authorizeCompanionAgenda({ source, command }, config)).toBe(false);
});
it('rejects a partly fabricated multi-quote explanation and preserves a cancelled or failed model check', async () => {
  vi.mocked(generateCompanionStructured).mockResolvedValueOnce({ ...valid(), evidence: ['请先暂停这项安排', '也允许转发到群聊'] });
  expect(await authorizeCompanionAgenda({ source, command }, config)).toBe(false);
  vi.mocked(generateCompanionStructured).mockRejectedValueOnce(new Error('cancelled model check'));
  await expect(authorizeCompanionAgenda({ source, command }, config)).rejects.toThrow('cancelled model check');
});
