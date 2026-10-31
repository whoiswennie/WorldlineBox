import { expect, it, vi } from 'vitest';
import { CompanionAgendaStore } from '../../src/companions/agenda-store';
import { runCompanionAgentKernel } from '../../src/main/companions/agent-kernel';
import { generateCompanionReply } from '../../src/main/companions/model';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import { companionAgendaModelView } from '../../src/main/companions/agenda-model-view';
import { companionAgendaToolArgumentsSchema, companionAgendaToolCommand } from '../../src/shared/companion-agenda-tool';
import type { CompanionAgendaCommand } from '../../src/shared/companion-agenda';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';
import { messageSchema, type Companion } from '../../src/shared/companions';
import { nodeCompanionConnection } from '../fixtures/node-companion-connection';

it('completes the normal chat native agenda/read result pair and its actual reviewer with the controlled Main-style response script', async () => {
  const { db, connection } = nodeCompanionConnection();
  try {
    db.exec(`CREATE TABLE companions(id TEXT PRIMARY KEY,data TEXT,deleted_at TEXT);CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO companions VALUES('alice','{"active":true}',NULL);`);
    const store = new CompanionAgendaStore(connection); store.initialize();
    store.execute({ type: 'agenda.rule.create', companionId: 'alice', operationId: 'original', authority: { kind: 'system' }, rule: {
      title: '回看自己的安排', intent: '看看当前还有什么值得继续', kind: 'self', executor: 'brain', referenceId: 'system_self_wake_v1',
      trigger: { kind: 'at', at: '2026-10-29T10:00:00.000Z', timeZone: 'UTC' }, reason: '真实的初始安排' } } as CompanionAgendaCommand);
    const companion: Companion = { id: 'alice', name: '小澄', description: '', persona: '平静、认真，先核对自己的真实安排。', model: '', avatar: 'sister',
      builtin: false, proactive: false, active: true, createdAt: '2026-10-29T08:00:00.000Z' };
    const source = messageSchema.parse({ id: 'source', sequence: 1, conversationId: 'own_room', authorId: 'user', content: '你今天有什么打算？',
      kind: 'text', status: 'sent', attachments: [], createdAt: companion.createdAt });
    const input = { companion, conversation: { id: 'own_room', kind: 'private' as const, memberIds: ['alice'], title: '本人私聊', pinned: false, muted: false,
      unread: 0, lastMessage: source.content, updatedAt: source.createdAt }, messages: [source], memories: [] };
    const state: { status: 'running' | 'done'; turns: CompanionLoopTurn[] } = { status: 'running', turns: [] }, snapshots: typeof state[] = [];
    const config = { apiFormat: 'openai_chat' as const, baseUrl: 'https://never-contacted.invalid', model: 'synthetic-only', apiKey: 'unused' };
    const response = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { headers: { 'Content-Type': 'application/json' } });
    const reviewFetch = vi.fn<typeof fetch>(async () => response({ supported: true, correction: '' }));
    const chatFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      expect(wire.tools.map((tool: { function: { name: string } }) => tool.function.name)).toContain('agenda');
      const tools = wire.messages.filter((message: { role: string }) => message.role === 'tool');
      if (!tools.length) return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ id: 'calendar_query', type: 'function',
        function: { name: 'agenda', arguments: '{"action":"read"}' } }] } }] }));
      expect(tools.at(-1).tool_call_id).toBe('calendar_query');
      expect(JSON.parse(tools.at(-1).content).agenda.rules.map((rule: { referenceId: string }) => rule.referenceId)).toContain('system_self_wake_v1');
      return response({ text: '我回看了自己的真实日程，今天会按安排交流、阅读和休息。', memories: [] });
    });
    const fetchFn: typeof fetch = (url, init) => {
      const purpose = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).purpose;
      return purpose === 'companion_social_progress_review' ? reviewFetch(url, init) : chatFetch(url, init);
    };
    await runCompanionAgentKernel({ state, save: async () => { snapshots.push(structuredClone(state)); },
      infer: async () => {
        const reply = await generateCompanionReply(input, config, undefined, { fetchFn, loop: true, turns: state.turns });
        if (reply.turn!.text.trim()) expect(await reviewCompanionSocialProgress(reply.turn!.text, [], config, undefined,
          { fetchFn, requireReview: true, sourceInputs: [source.content], turns: state.turns })).toBeUndefined();
        return reply.turn!;
      },
      execute: async turn => Promise.all(turn.calls.map(async call => {
        const command = companionAgendaToolCommand(companionAgendaToolArgumentsSchema.parse(JSON.parse(call.arguments)), 'alice', 'fixture_' + call.id);
        const result = store.execute(command as CompanionAgendaCommand)!;
        return { callId: call.id, content: JSON.stringify(companionAgendaModelView(result, { conversationId: 'own_room', allowPrivate: true })) };
      })), finish: async () => undefined });
    expect(state.status).toBe('done'); expect(state.turns).toHaveLength(2);
    expect(state.turns[0]!.results![0]!.callId).toBe('calendar_query'); expect(chatFetch).toHaveBeenCalledTimes(2); expect(reviewFetch).toHaveBeenCalledTimes(1);
    expect(snapshots.some(saved => saved.status === 'running' && !!saved.turns[0]?.results)).toBe(true); expect(snapshots.at(-1)!.status).toBe('done');
  } finally { db.close(); }
});
