import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionFileReader } from '../../src/main/companions/file-reader';
import { createCompanionLearningGoalService } from '../../src/main/companions/learning-goal-integration';
import { generateCompanionText } from '../../src/main/companions/model';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionLearningGoalRound } from '../../src/shared/companion-learning-goals';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Explicit opt-in content acceptance: actual configured chat, bundled Gemma and unchanged VCP. */
it.skipIf(process.env.WORLDLINEBOX_LEARNING_GOALS_REAL !== '1')('completes two sourced, recall-based learning rounds while the ongoing goal remains active', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-learning-goals-real-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-learning-goals-real-')) throw new Error('Unsafe fixture path.');
  const config = await realGlobalChatConfig(root), errors: string[] = []; let policyGateCalls = 0;
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'student', name: '月见', description: '',
    persona: '你是月见，学习时认真核对来源，不把资料当亲历。未知就承认，不把自测当客观权威考试。', model: '', avatar: 'sister', active: true, proactive: false }]);
  const native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { timeoutMs: 90000 }));
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => store.request(command);
  const memory = new CompanionMemoryService({ request, configFor: async () => config, runtime: native.runtime, cacheRoot: path.join(root, 'views'),
    fetchFn: fetch, busy: () => false, blocked: () => false, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const files = new CompanionFileReader({ root, request });
  const attachmentId = 'learning_material_fixture', relativePath = 'attachments/' + attachmentId + '.txt', source = path.join(root, relativePath);
  await mkdir(path.dirname(source), { recursive: true });
  const material = '这是合成学习教材，不是真实人物经历。\n青岚图书馆的借阅规则：普通读者最多同时借三本书，每本借期十四天。续借需要在到期前申请，若已有其他读者预约则不能续借。\n核对来源的方法：先记下规则的出处和适用范围，再用具体案例检查自己的理解；遇到资料矛盾时标记待核实，不凭直觉补造规则。\n例题：已经借了两本书的普通读者，只能再借一本；已被预约的书不允许续借。';
  await writeFile(source, material);
  store.request({ type: 'attachment.register', stored: { attachment: { id: attachmentId, name: '青岚图书馆合成教材.txt', mime: 'text/plain', size: Buffer.byteLength(material) }, relativePath } });
  const learning = createCompanionLearningGoalService({ request, configFor: async () => config,
    assets: { catalog: async () => [], grant: async () => { throw new Error('No asset grants in this fixture.'); }, page: async () => ({ assets: [], hasMore: false }), read: async () => { throw new Error('No assets.'); } },
    files, attachmentPath: async relative => { if (relative !== relativePath) throw new Error('Unexpected fixture attachment.'); return source; },
    memory, validateWrite: async command => {
      policyGateCalls++;
      command.expectedProhibitionRevision = (await request({ type: 'memory.prohibitions', companionId: command.companionId, conversationId: command.conversationId,
        ...(command.type === 'memory.revise' ? { noteId: command.id } : { sourceMessageIds: command.candidate.sourceMessageIds }) })).memoryProhibitionRevision;
    }, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const proof: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', realChatModel: config.model,
    realBundledEmbedding: native.profile.modelName, nativeVcpUnchanged: true, syntheticTemporaryLibraryOnly: true, material, errors };
  const rounds: CompanionLearningGoalRound[] = [];
  try {
    const goal = store.request({ type: 'learning.goals.create', companionId: 'student',
      text: '持续学习青岚图书馆合成教材的借阅规则。每轮读实际文件，整理有出处的知识，再通过自己的VCP记忆回答两至三道具体应用自测题。复盘不足并在下一轮改进，即便熟悉规则也不要自动停止。',
      materials: [{ kind: 'file', attachmentId }], allowWeb: false, schedule: { intervalMinutes: 5, windows: [], timeZone: 'UTC' } }).learningGoal!;
    for (let ordinal = 1; ordinal <= 2; ordinal++) {
      if (ordinal > 1) store.request({ type: 'learning.goals.run', companionId: 'student', id: goal.id, expectedRevision: goal.revision });
      await learning.tick(); const deadline = Date.now() + 300000;
      let round: CompanionLearningGoalRound | undefined;
      while (Date.now() < deadline) {
        round = store.request({ type: 'learning.goals.rounds', companionId: 'student', id: goal.id, limit: 1 }).learningRounds?.items[0];
        if (round?.ordinal === ordinal && round.status === 'completed') break;
        if (round?.ordinal === ordinal && ['failed', 'deferred'].includes(round.status)) throw new Error(round.error ?? 'Actual learning round did not complete.');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(round?.status, round?.error ?? errors.join('\n')).toBe('completed');
      expect(round!.reads.some(read => read.kind === 'file' && read.excerpt.includes('十四天') && !!read.sourceMessageId)).toBe(true);
      expect(round!.memoryIds.length).toBeGreaterThan(0); expect(round!.selfTest?.questions.length).toBeGreaterThan(0);
      expect(round!.selfTest?.recall?.contextCharacters).toBeGreaterThan(0);
      expect(round!.nextPlan.length).toBeGreaterThan(0); expect(round!.selfTest?.disclaimer).toContain('模型自测与自评');
      for (const id of round!.memoryIds) expect(store.request({ type: 'memory.library.read', companionId: 'student', id }).memoryRead?.memory).toMatchObject({ status: 'indexed', metadata: { learningGoalId: goal.id } });
      rounds.push(round!); await learning.drain('student');
    }
    const current = store.request({ type: 'learning.goals.list', companionId: 'student' }).learningGoals!.items[0]!;
    expect(current.state).toBe('active'); expect(current.totalRounds).toBe(2); expect(Date.parse(current.nextAt)).toBeGreaterThan(Date.now());
    expect(native.gateway.cacheSnapshot().vectors).toBeGreaterThan(0);
    proof.goal = current; proof.rounds = rounds; proof.notes = store.listMemory('student'); proof.actualEmbeddingCache = native.gateway.cacheSnapshot(); proof.policyGateCalls = policyGateCalls; proof.status = 'passed';
  } catch (error) { proof.status = 'failed'; proof.error = error instanceof Error ? error.message : String(error); proof.rounds = rounds;
    proof.currentGoals = store.request({ type: 'learning.goals.list', companionId: 'student' }).learningGoals; throw error; }
  finally {
    await learning.close(); await memory.close(); await native.close(); store.close(); proof.finishedAt = new Date().toISOString();
    const output = path.resolve(process.env.WORLDLINEBOX_LEARNING_GOALS_OUTPUT ?? 'artifacts/vcp-validation/learning-goals-real.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(proof, null, 2)); await removeOwnedDirectory(root);
  }
}, 720000);
