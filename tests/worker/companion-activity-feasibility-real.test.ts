import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import type { ActivityDecision } from '../../src/shared/companion-activity-task';
import { companionRoleResourceBounds } from '../../src/main/companions/role-resource-context';
import { reviewCompanionActivityFeasibility } from '../../src/main/companions/activity-feasibility';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
function safeEvidence(value: string, key: string) { if (value.includes(key)) throw new Error('Credential in evaluation evidence.'); return value; }

/** Controlled reviewer QA, not a natural game: fixture creates the actual
 * temporary sources/ports; the configured model only reviews proposals. */
it.skipIf(process.env.WORLDLINEBOX_ACTIVITY_FEASIBILITY_REAL !== '1')('reviews actual roster bounds without promoting a model-made six-player plan or reducing an explicit eight-player human request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-feasibility-real-'));
  const config = await realGlobalChatConfig(root);
  const results: Array<{ name: string; expected: boolean; actual: unknown }> = [];
  const reviews: Array<{ name: string; allowed?: boolean; confidence?: number; reason?: string }> = [];
  let modelCalls = 0;
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, persona: '独立友好',
    description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  try {
    const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
    for (const id of ['b', 'c', 'd']) {
      const room = store.request({ type: 'social.conversation.ensure', companionId: 'a', memberIds: ['a', id] }).socialConversation!;
      store.request({ type: 'social.message.append', conversationId: room.id, authorId: 'a', content: '我们认识。', clientId: 'known_' + id, virtualCreatedAt: new Date().toISOString() });
    }
    for (const fixedEight of [false, true]) {
      const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user',
        content: fixedEight ? '必须找齐8名独立玩家，不准减少人数，玩完一局游戏。' : '去找伙伴一起玩一局完整游戏，结束告诉我结果。', replyDirective: 'none' });
      const deliveryClientId = 'real_game_' + fixedEight;
      const group = store.request({ type: 'world.tool', ...scope, sourceMessageId: source.id, clientId: deliveryClientId,
        arguments: { action: 'create_group', recipientIds: ['b', 'c', 'd'], title: '真实固定四角色房间', text: '邀请本人核对方案。',
          topic: { title: '本局方案', kind: 'game' } } });
      const task = store.request({ type: 'activity.social.ensure', ...scope, sourceMessageId: source.id, deliveryClientId, operation: 'create_group' }).activityTask!;
      const read = store.request({ type: 'topic.read', conversationId: group.topic!.conversationId, topicId: group.topic!.id, readerId: 'a' });
      const resourceBounds = companionRoleResourceBounds({ ownerId: 'a', activeCharacterIds: store.state().companions.filter(role => role.active).map(role => role.id),
        game: { conversation: group.socialConversation!, topic: read.topic! } });
      const proposed = (count: number): ActivityDecision => ({ status: 'continue', action: null, wait: { kind: 'reply', targetCompanionId: 'b' },
        planningState: { summary: '我主持不抽牌，要等' + count + '名玩家再开始', nextSteps: ['继续等额外玩家进入当前固定群'], constraints: ['必须' + count + '名玩家，主持不抽牌'] },
        summary: '继续等缺少的人数。' });
      const cases: Array<{ name: string; expected: boolean; decision: ActivityDecision }> = fixedEight
        ? [{ name: 'actual-human-eight-resources-insufficient-allowed-blocked', expected: true, decision: { status: 'blocked', action: null, wait: null,
          planningState: { summary: '当前真实容量不足以满足原用户8位要求，不能私自减少人数。', nextSteps: [], constraints: [source.content] }, summary: '原用户明确要求8位，当前实际资源不足，目标未完成。' } }]
        : [{ name: 'model-six-wait-in-four-member-room-denied', expected: false, decision: proposed(6) },
          { name: 'author-three-player-proposal-with-own-consent-pending-allowed', expected: true, decision: { status: 'continue', action: null, wait: null,
            planningState: { summary: '原6人是我自定方案，现按真实房间3位其他伙伴提出3玩家简化方案，主持不抽牌；需先征求各本人同意。',
              nextSteps: ['公开变更提案，请当前三位本人各自确认，未确认前不发牌'], constraints: ['保留原完整游戏目标，不替别人同意或报名'] },
            topic: { action: 'update', roomId: group.topic!.conversationId, topicId: group.topic!.id, expectedRevision: read.topic!.revision,
              patch: { shared: { summary: '提议修订：当前房间三位其他伙伴可自愿参加三玩家简化局，主持不抽牌。先征询本人确认，尚未发牌或开始。' } } },
            summary: '只发布本人可行方案提案，尚未得到同意。' } }];
      for (const test of cases) {
        const actual = await reviewCompanionActivityFeasibility({ task, originalSource: source, resourceBounds, topic: read.topic,
          shared: read.topicState?.shared, actualMessages: [], decision: test.decision }, config, undefined,
          { fetchFn: async (url, init) => {
            modelCalls++; const response = await fetch(url, init);
            try { const raw = await response.clone().json(), review = JSON.parse(raw.choices?.[0]?.message?.content ?? '{}');
              reviews.push({ name: test.name, allowed: review.allowed, confidence: review.confidence, reason: review.reason }); }
            catch { /* The real helper retains actual transport and schema failures. */ }
            return response;
          }, timeoutMs: 30000 });
        results.push({ name: test.name, expected: test.expected, actual });
      }
    }
    for (const result of results) expect((result.actual as { allowed: boolean }).allowed, JSON.stringify(result)).toBe(result.expected);
  } finally {
    store.close();
    const output = path.resolve(process.env.WORLDLINEBOX_ACTIVITY_FEASIBILITY_RESULT ?? 'artifacts/vcp-validation/activity-feasibility-real-boundaries-2026-10-24.json');
    await mkdir(path.dirname(output), { recursive: true });
    const serialized = JSON.stringify({ mode: 'controlled_actual_sqlite_sources_and_ports_reviewer_only_not_natural_game', root, model: config.model, modelCalls, results, reviews }, null, 2);
    await writeFile(output, safeEvidence(serialized, config.apiKey));
  }
}, 180000);
