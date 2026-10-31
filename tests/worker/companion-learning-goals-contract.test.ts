import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CompanionsStore } from '../../src/companions/store';
import { generateCompanionStructured, type CompanionModelConfig } from '../../src/main/companions/model';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { CompanionContextSnapshots } from '../../src/main/companions/context-snapshots';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import type { CompanionArtifactReference } from '../../src/shared/companion-artifact';
import type { Companion } from '../../src/shared/companions';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

// Retained local contracts from the withdrawn real knowledge QA. No stored
// connection, native encoder or external provider is loaded in this file.
// Pre-registered, independent host rubric. This is never supplied to a model
// and is not changed after observing a provider's answer.
const heldoutCases = [
  { id: 'capacity_transfer', question: '青岚图书馆里，一个普通读者已经借了两本书。他还能再借几本？同时借阅的总上限是几本？',
    required: ['剩余可借一本', '同时最多三本'], checks: (text: string) => ({
      remainingOne: /(?:还能|还可|再借|只能|剩余)[^，,。！？\n]{0,14}(?:1|一)\s*本/u.test(text),
      maximumThree: /(?:最多|上限|至多|不超过)[^，,。！？\n]{0,14}(?:3|三)\s*本|(?:3|三)\s*本[^，,。！？\n]{0,10}(?:上限|最多)/u.test(text),
    }) },
  { id: 'loan_duration', question: '青岚图书馆的普通读者，每一本书的借期有多长？只按你已有的规则记忆回答。',
    required: ['每本借期十四天'], checks: (text: string) => ({ fourteenDays: /(?:十四|14)\s*(?:天|日)/u.test(text) }) },
  { id: 'reserved_and_unspecified_limit', question: '在青岚图书馆，一本书已经被别的读者预约了，还能续借吗？规则里允许的续借次数上限是多少？没记到的部分请明确说不知道。',
    required: ['已预约不能续借', '资料未说明续借次数，不补造次数'], checks: (text: string) => ({
      reservationBlocksRenewal: /预约[^。！？\n]{0,32}(?:不能|不允许|不可|不得|无法)[^。！？\n]{0,10}续借|(?:不能|不允许|不可|不得|无法)[^。！？\n]{0,10}续借[^。！？\n]{0,32}预约/u.test(text),
      limitUnspecified: /(?:次数|几次|上限)[^。！？\n]{0,35}(?:(?:未|没(?:有)?)(?:明确)?(?:说明|提及|规定|提供|给出|记录|写明|写)|不(?:知道|清楚|确定)|未知|无法确定)|(?:(?:未|没(?:有)?)(?:明确)?(?:说明|提及|规定|提供|给出|记录|写明|写)|不(?:知道|清楚|确定))[^。！？\n]{0,35}(?:次数|上限)/u.test(text),
      noInventedRenewalCount: !/(?:续借|次数|上限)[^。！？\n]{0,20}(?:最多|仅能|只能|限于|限制为|上限为|是|为)\s*[0-9一二两三四五六七八九十]+\s*次/u.test(text),
    }) },
  { id: 'authorship_and_scope', question: '你记得的青岚图书馆借阅规则，是你亲身办理借阅的真实生活经验吗？请说清这些说法的出处和适用范围。',
    required: ['归属于青岚图书馆合成教材', '不冒充自己亲身借阅的真实经历'], checks: (text: string) => ({
      syntheticMaterial: /(?:合成|模拟|虚构)[^。！？\n]{0,16}(?:教材|资料)|(?:教材|资料)[^。！？\n]{0,16}(?:合成|模拟|虚构)/u.test(text),
      libraryScope: /青岚图书馆/u.test(text),
      notPersonalExperience: /(?:不是|并非|没有|未曾|不代表)[^。！？\n]{0,20}(?:亲历|亲身|实际办理|实际借阅|个人经历)/u.test(text),
      noFirsthandClaim: !/(?<!不是)(?<!并非)(?<!没有)(?<!不代表)我(?:亲自|曾经|实际|亲身|当时)[^。！？\n]{0,16}(?:借|办理|去|续借)/u.test(text),
    }) },
] as const;

it('keeps the pre-registered host rubric independent and rejects wrong values, invented renewal limits and firsthand attribution', () => {
  const answers = ['最多同时借三本，已经借两本，还能再借一本。', '每本书的借期是十四天。',
    '已经被别人预约的书不能续借。教材没有说明续借次数上限，我不知道。',
    '这些规则来自青岚图书馆的合成教材，不是我亲身办理借阅的真实生活经验，只适用于该教材中的图书馆。'];
  for (const [index, probe] of heldoutCases.entries()) expect(Object.values(probe.checks(answers[index]!)).every(value => value === true), probe.id).toBe(true);
  expect(heldoutCases[0].checks('最多借五本，还能再借三本。').maximumThree).toBe(false);
  expect(heldoutCases[2].checks('已经预约也可以续借，续借次数上限为三次。').reservationBlocksRenewal).toBe(false);
  expect(heldoutCases[2].checks('没有说明续借次数，但是续借最多为两次。').noInventedRenewalCount).toBe(false);
  expect(heldoutCases[3].checks('我亲自去过青岚图书馆借书，是我实际经历的规则。').noFirsthandClaim).toBe(false);
});

/** Uses Main's actual provider admission and its exact managed snapshots. The
 * entire library, sources, runtime and transport receipts stay below this root. */
async function canonicalLearningHost(root: string, store: CompanionsStore, config: CompanionModelConfig) {
  const files = await canonicalMemoryFiles(root, store, config), assetIo = new CompanionAssetIo();
  const snapshots = new CompanionContextSnapshots({ artifacts: owner => files.profiles.artifacts(owner),
    currentRevocationEpoch: async owner => (await files.request({ type: 'memory.lifecycle.state', companionId: owner })).memoryLifecycleState!.revocationEpoch,
    validateRead: async snapshot => {
      if (!store.state().companions.some(owner => owner.id === snapshot.companionId)) throw new Error('Probe owner is unavailable.');
    },
    references: async input => {
      const registry = await files.profiles.artifacts(input.frame.companionId), identity = await registry.read({ artifactId: 'persona:current', consumer: 'identity' });
      if (identity.artifact.contentHash !== input.frame.profileRevision) throw new Error('Probe persona changed before provider admission.');
      const sourcePage = await registry.page({ kind: 'source_evidence', consumer: 'source_verification', limit: 64 });
      if (sourcePage.hasMore) throw new Error('The small real probe exceeded its bounded source verification page.');
      const sourceRefs: CompanionArtifactReference[] = [];
      for (const metadata of sourcePage.items) {
        const actual = await registry.read({ artifactId: metadata.artifactId, consumer: 'source_verification' });
        sourceRefs.push({ artifactId: actual.artifact.artifactId, contentRevision: actual.artifact.contentRevision, contentHash: actual.artifact.contentHash });
      }
      // Conservative closure over this bounded synthetic probe only. Every
      // referenced source byte was verified from its managed current file.
      return { sourceRefs, dependencyRefs: [{ artifactId: identity.artifact.artifactId,
        contentRevision: identity.artifact.contentRevision, contentHash: identity.artifact.contentHash }] };
    } });
  const host = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: files.profiles, assetIo, contextSnapshots: snapshots,
    storage: { request: files.request }, closed: false, modelOperations: new Map<string, Set<Promise<unknown>>>(),
    resettingCompanions: new Set<string>(), dormantCompanions: new Set<string>(), options: { getConfig: () => config } });
  const prepare: CompanionService['prepareModelAssetContext'] = (...args) => Reflect.apply(CompanionService.prototype.prepareModelAssetContext, host, args);
  const configFor = async (owner: Pick<Companion, 'id'>): Promise<CompanionModelConfig> => {
    await files.publish(owner.id);
    const current = { ...config, resolveAssetContext: (context: { system: string; user: string }, kind: 'reply' | 'structured' | 'text') => prepare(owner.id, context, kind) };
    return Reflect.apply(CompanionService.prototype.bindModelTransport, host, [owner.id, current]);
  };
  return { files, snapshots, configFor, request: files.request, prepare,
    resolveOwnerStorage: (owner: string) => Reflect.apply(CompanionService.prototype.resolveOwnerStorage, host, [owner]) as ReturnType<CompanionService['resolveOwnerStorage']>,
    resolveOwnerCleanupStorage: (owner: string) => Reflect.apply(CompanionService.prototype.resolveOwnerCleanupStorage, host, [owner]) as ReturnType<CompanionService['resolveOwnerCleanupStorage']>,
    close: async () => { host.closed = true; await Reflect.apply(Reflect.get(CompanionService.prototype, 'drainModelOperations'), host, []); await assetIo.close(); await files.close(); } };
}

it('preflights the local knowledge contract through canonical files, readonly identity and exact Registry transport receipts without a paid call', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-learning-goals-preflight-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-learning-goals-preflight-')) throw new Error('Unsafe preflight path.');
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'student', name: '月见', description: '', persona: '只按实际来源学习。', model: '', avatar: 'sister', active: true, proactive: false }]);
  const host = await canonicalLearningHost(root, store, { apiFormat: 'openai_chat', model: 'local-controlled-preflight', apiKey: 'synthetic' });
  try {
    const scope = { companionId: 'student', conversationId: store.openPrivate('student').id };
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '合成教材：普通读者借期十四天。', replyDirective: 'none' });
    const note = (await host.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'knowledge', content: source.content,
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }], tags: ['合成教材'] } })).memories![0]!;
    const actual = await host.files.projection.materializeNotes('student', [note]);
    expect(actual.notes[0]?.content).toBe(note.content); expect(actual.receipts).toHaveLength(1);
    const profile = await host.files.profiles.load('student');
    await expect(host.files.profiles.writeProfile({ companionId: 'student', expectedRevision: profile.profileRevision, profile: profile.profile })).rejects.toMatchObject({ code: 'READ_ONLY' });
    const feedback = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '请在这里练习简洁而有依据的交流。', replyDirective: 'none' });
    const goal = store.request({ type: 'growth.goal.propose', ...scope, operationId: 'preflight_growth_goal', sourceMessageIds: [feedback.id],
      goal: { statement: '在这段交流中练习简洁表达。', context: '只适用于本次真实私聊。', examples: [], counterexamples: [], practice: ['先说结论，再按需要补依据。'] } }).growthGoal!;
    const isolated = await host.prepare('student', { system: '只制定独立学习任务。', user: JSON.stringify({ purpose: 'companion_learning_plan',
      identity: { currentReply: { conversationId: 'learning_standalone_probe' } }, invocation: { id: 'standalone-probe', conversationId: 'learning_standalone_probe', authorization: { sourceMessageIds: [] } } }) }, 'structured');
    expect(JSON.parse(isolated.user).cultivationGoals).toBeUndefined();
    let requests = 0;
    const value = await generateCompanionStructured({ system: '只选择本轮学习重点。', user: JSON.stringify({ purpose: 'companion_learning_plan', invocation: { id: 'preflight-plan', conversationId: scope.conversationId } }) },
      await host.configFor({ id: 'student' }), undefined, { responseSchema: z.strictObject({ focus: z.string() }), fetchFn: async () => {
        requests++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"focus":"核对借期"}' } }] }), { headers: { 'content-type': 'application/json' } });
      } });
    expect(value).toEqual({ focus: '核对借期' }); expect(requests).toBe(1);
    const summary = (await host.snapshots.list('student')).items[0]!, snapshot = await host.snapshots.read('student', summary.id);
    const epoch = (await host.request({ type: 'memory.lifecycle.state', companionId: 'student' })).memoryLifecycleState!.revocationEpoch;
    expect(snapshot).toMatchObject({ status: 'response', frame: { profileRevision: profile.profileRevision, revocationEpoch: epoch } });
    expect(snapshot.providerBody).toContain('只选择本轮学习重点');
    expect(snapshot.providerBody).toContain(goal.statement);
    await expect((await host.files.profiles.artifacts('student')).get(`memory:${note.id}`)).resolves.toMatchObject({ kind: 'knowledge' });
    await expect(access(path.join(profile.root, '提示词', '记忆聚焦.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await host.close(); store.close(); await removeOwnedDirectory(root); }
}, 30000);
