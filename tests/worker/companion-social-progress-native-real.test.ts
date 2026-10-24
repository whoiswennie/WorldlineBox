import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionMessage } from '../../src/shared/companions';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

/** Real saved failed run, real reviewer, no new user instruction, social send,
 * game state, or edit to its failed report. Paired truthful controls use exactly
 * the same actual receipt set rather than granting their proposed effects. */
it.skipIf(process.env.WORLDLINEBOX_SOCIAL_PROGRESS_NATIVE_REAL !== '1')('checks actual handoff failures and truthful controls against native receipt metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-social-native-controls-'));
  const config = await realGlobalChatConfig(root);
  const sourcePaths = ['src/main/companions/social-progress-evidence.ts', 'src/main/companions/social-progress-review.ts',
    'src/main/companions/model.ts', 'src/shared/companion-capability-tools.ts', 'src/shared/companion-storage.ts',
    'tests/worker/companion-social-progress-native-real.test.ts'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async filename =>
    [filename, createHash('sha256').update(await readFile(path.resolve(filename))).digest('hex')])));
  const sourceFingerprints = await fingerprints();
  const source = path.resolve('artifacts/vcp-validation/unified-real-natural-werewolf-2026-10-24-protected-publication-resumed.json');
  const bytes = await readFile(source), prior = JSON.parse(bytes.toString()) as {
    ownerLoop: CompanionLoopCheckpoint; persistentTasks: CompanionActivityTask[];
  };
  const loop = prior.ownerLoop, tasks = prior.persistentTasks;
  const replies = (JSON.parse(loop.context?.user ?? '{}') as { currentGoalReplies?: Array<{ messages: CompanionMessage[] }> })
    .currentGoalReplies?.flatMap(item => item.messages) ?? [];
  const names = [{ id: 'deepseek-sister', name: '大肥鱼' }, { id: 'deepseek-flash', name: '小肥鱼' },
    ...['grok', 'kimi', 'qwen', 'gugugaga'].map(id => ({ id, name: id }))];
  const complete = loop.turns.map(turn => turn.text).filter(Boolean).join('\n\n');
  const cases = [
    { id: 'actual_entire_failed_bubble', text: complete, rejected: true },
    { id: 'actual_bad_tool_paragraph', text: '消息和自我介绍都发出去了。已经联络了小肥鱼，也给 grok、kimi、qwen 发了自我介绍。', rejected: true },
    { id: 'truthful_same_receipts', text: '我已经给小肥鱼发出邀请。其余四位目前没有实际发信回执，联系工作仍由已保存的后台任务继续安排。', rejected: false },
    { id: 'future_proposal_is_not_delivery', text: '我打算联系Grok和Kimi，目前没有他们的实际发送回执，还不能说已经发出邀请。', rejected: false },
  ];
  const evidence: unknown[] = [], startedAt = new Date().toISOString();
  let status = 'failed';
  try {
    for (const item of cases) {
      const correction = await reviewCompanionSocialProgress(item.text, tasks, config, undefined, {
        turns: loop.turns, names, replies,
        fetchFn: async (input, init) => {
          const request = JSON.parse(String(init?.body));
          const response = await fetch(input, init);
          evidence.push({ case: item.id, frame: JSON.parse(request.messages[1].content), result: await response.clone().json() });
          return response;
        },
      });
      evidence.push({ case: item.id, expectedRejected: item.rejected, correction: correction ?? null });
      expect(!!correction, item.id).toBe(item.rejected);
    }
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'));
    status = 'passed';
  } finally {
    const finishedSourceFingerprints = await fingerprints();
    await writeFile(path.resolve(process.env.WORLDLINEBOX_SOCIAL_PROGRESS_NATIVE_RESULT
      ?? 'artifacts/vcp-validation/social-progress-native-real-controls-2026-10-24.json'), JSON.stringify({ status, root, startedAt,
      finishedAt: new Date().toISOString(), model: config.model, source, sourceChecksum: createHash('sha256').update(bytes).digest('hex'),
      sourceFingerprints, finishedSourceFingerprints, sourceFilesUnchanged: JSON.stringify(sourceFingerprints) === JSON.stringify(finishedSourceFingerprints),
      calls: evidence.filter(item => typeof item === 'object' && item && 'frame' in item).length, evidence }, null, 2));
  }
}, 180000);
