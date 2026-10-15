import { expect, it } from 'vitest';
import { authorizeCompanionManagement } from '../../src/main/companions/management-authorization';
import type { CompanionMessage } from '../../src/shared/companions';
const source: CompanionMessage = { id: 'current', conversationId: 'room', sequence: 3, authorId: 'user', kind: 'text', content: '请暂停整理照片这份工作，原文件不要删除。', createdAt: '2026-10-15T00:00:00Z', status: 'sent', attachments: [] };
const input = { companionId: 'sister', source, tool: 'work' as const, action: 'pause', targetId: 'actual_order', requested: { action: 'pause', paused: true }, previous: { id: 'actual_order', title: '整理照片' } };
const config = { apiFormat: 'openai_chat' as const, model: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.invalid' };
const decision = { allowed: true, confidence: .98, sourceMessageId: source.id, tool: 'work', action: 'pause', targetId: 'actual_order', evidence: ['请暂停整理照片这份工作'] };
function response(value: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { headers: { 'Content-Type': 'application/json' } }); }
it('provides the exact real instruction, target and requested change to a no-tool semantic authority check', async () => {
  expect(await authorizeCompanionManagement(input, config, undefined, { fetchFn: async (_url, init) => {
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    expect(body.tools).toBeUndefined(); expect(data).toMatchObject({ purpose: 'companion_management_authorization', companionId: 'sister', source: { id: source.id, authorId: 'user', content: source.content }, tool: 'work', action: 'pause', targetId: 'actual_order', requested: { paused: true }, previous: { title: '整理照片' } });
    return response(decision);
  } })).toBe(true);
});
it.each([{ allowed: false }, { sourceMessageId: 'history' }, { targetId: 'another_order' }, { action: 'cancel' }, { evidence: ['从未说过的授权'] }, { confidence: .89 }])('rejects mismatched or uncertain authorization %j', async patch => {
  expect(await authorizeCompanionManagement(input, config, undefined, { fetchFn: async () => response({ ...decision, ...patch }) })).toBe(false);
});
it('does not treat a peer or unfinished draft as a human instruction', async () => {
  for (const extra of [{ authorId: 'sister' }, { isReplyDraft: true }]) expect(await authorizeCompanionManagement({ ...input, source: { ...source, ...extra } }, config, undefined, { fetchFn: async () => { throw new Error('Must not call model'); } })).toBe(false);
});
