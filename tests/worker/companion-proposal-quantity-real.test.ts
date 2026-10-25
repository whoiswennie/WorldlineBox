import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { reviewCompanionProposalQuantities, validateProposalQuantityRelations } from '../../src/main/companions/proposal-quantity-review';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
const reservedProposal = { summary: '五份材料，四位接收者每人一份，明确留一份备用，不把备用分给任何接收者。',
  recipients: ['a', 'b', 'c', 'd'], total: 5, perRecipient: 1, reserved: 1 };

/** Opt-in read-only content QA. This neither runs nor repairs the original
 * activity: the formal source and its previous failure remain untouched. */
it.skipIf(process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_REAL !== '1')('checks the actual failed proposal and an explicit reserve without selecting a variant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-quantity-review-'));
  const config = await realGlobalChatConfig(root);
  const report = JSON.parse(await readFile(process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_SOURCE!, 'utf8')) as {
    rooms: Array<{ messages: Array<{ id: string; content: string }> }>;
  };
  const original = report.rooms.flatMap(room => room.messages).find(message => message.id === 'db624297-e9cb-4405-83d4-3dddd8c1502c');
  expect(original).toBeDefined();
  const plan = { summary: '四位参与者各抽一张，五份全部分完，正好对应，没有剩余。',
    state: { recipients: ['a', 'b', 'c', 'd'], parts: { alpha: 2, beta: 1, gamma: 2, total: 5 } } };
  const cases = [
    { name: 'actual-unmodified-formal-proposal', input: { proposal: original!.content }, expected: false },
    { name: 'adopt-an-old-contradiction-without-new-numerals', input: { proposal: '现在按这份已确认安排完整分配。', adoptedPlan: plan }, expected: false },
    { name: 'explicit-reserve-is-a-valid-different-plan', input: { proposal: reservedProposal }, expected: true },
  ];
  const results: Array<{ name: string; expected: boolean; actual?: { allowed: boolean; reason?: string }; error?: string }> = [], reviews: unknown[] = [];
  let modelRequests = 0;
  try {
    for (const test of cases) {
      try {
        const result = await reviewCompanionProposalQuantities(test.input, config, undefined, { timeoutMs: 30000,
        fetchFn: async (url, init) => {
          modelRequests++; const response = await fetch(url, init);
          try { const body = await response.clone().json(); reviews.push({ name: test.name,
            raw: JSON.parse(body.choices?.[0]?.message?.content ?? '{}') }); } catch { /* The actual helper owns transport/format failures. */ }
          return response;
        } });
        results.push({ name: test.name, expected: test.expected, actual: result });
      } catch (error) { results.push({ name: test.name, expected: test.expected, error: error instanceof Error ? error.message : String(error) }); }
    }
    for (const result of results) expect(result.actual?.allowed, JSON.stringify(result)).toBe(result.expected);
  } finally {
    const evidence = JSON.stringify({ mode: 'read_only_controlled_review_not_game_acceptance', model: config.model,
      originalMessageId: original!.id, originalContent: original!.content, modelRequests, results, reviews }, null, 2);
    await writeFile(process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_RESULT!, evidence.replaceAll(config.apiKey, '[REDACTED]'));
  }
}, 180000);

it.skipIf(!process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_REPLAY)('accepts the unchanged original correct reserve response after fixing the scalar-fact contract', async () => {
  const bytes = await readFile(process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_REPLAY!, 'utf8');
  const report = JSON.parse(bytes) as { reviews: Array<{ name: string; raw: unknown }> };
  const index = report.reviews.findIndex(item => item.name === 'explicit-reserve-is-a-valid-different-plan');
  expect(index).toBeGreaterThanOrEqual(0);
  const originalResponse = report.reviews[index]!.raw;
  const result = validateProposalQuantityRelations({ proposal: reservedProposal }, originalResponse);
  await writeFile(process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_REPLAY_RESULT!, JSON.stringify({
    mode: 'unchanged_original_response_replay_not_new_model_acceptance', sourceReport: process.env.WORLDLINEBOX_PROPOSAL_QUANTITY_REPLAY,
    sourceReportSha256: createHash('sha256').update(bytes).digest('hex'), originalResponseIndex: index,
    originalResponseSha256: createHash('sha256').update(JSON.stringify(originalResponse)).digest('hex'),
    modelRequests: 0, result }, null, 2));
  expect(result).toEqual({ allowed: true });
});
