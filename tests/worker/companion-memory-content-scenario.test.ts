import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionLearningService } from '../../src/main/companions/learning-service';
import { CompanionWorldService } from '../../src/main/companions/world-service';
import { assetSummarySchema } from '../../src/shared/asset-types';
import { generateCompanionReply, generateCompanionText } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { Companion, CompanionConversation, CompanionMessage } from '../../src/shared/companions';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const enabled = process.env.WORLDLINEBOX_CONTENT_EVALUATION === '1';
it.skipIf(!enabled)('audits three distinct companions using real global chat journals, native Gemma River recall and real reply content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-content-three-peers-'));
  const config = await realGlobalChatConfig(root);
  const seeds = [{ id: 'lin', name: '林澄', persona: '你是林澄，谨慎温和，爱园艺，每晚给虚拟阳台植物浇水；不抢他人的任务。' },
    { id: 'zhou', name: '周岚', persona: '你是周岚，严谨直接，喜欢工程和整理测试证据；不把他人的承诺说成自己的经历。' },
    { id: 'chen', name: '陈青', persona: '你是陈青，轻松有分寸，喜欢读书与写作；会区分故事、假设和已发生事实。' }];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, description: '', model: '', avatar: 'sister', proactive: false, active: true })));
  const companions = store.request({ type: 'state' }).state!.companions;
  const group = store.createConversation('三位伙伴的合成公开内容验收', seeds.map(seed => seed.id));
  const errors: unknown[] = [], phases: unknown[] = [], modelCalls: unknown[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
    let purpose = 'reply', owner: string | undefined;
    try { const payload = JSON.parse(body.messages?.find(message => message.role === 'user')?.content ?? '{}'); purpose = payload.purpose ?? purpose; owner = payload.companion?.id ?? payload.identity?.self?.id; } catch { purpose = body.messages?.[0]?.content.includes('你是 VCP 记忆处理单元') ? 'original_vcp_aimemo' : 'original_vcp_timeline'; }
    const started = performance.now();
    const response = await fetch(input, init);
    const payload = response.headers.get('content-type')?.includes('text/event-stream') ? {} : await response.clone().json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: unknown };
    modelCalls.push({ purpose, owner, startedMs: started, elapsedMs: performance.now() - started, output: payload.choices?.[0]?.message?.content, finishReason: payload.choices?.[0]?.finish_reason, usage: payload.usage });
    return response;
  };
  const native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { fetchFn, timeoutMs: 90000 }), { modelFetch: fetchFn });
  const request = async (command: Parameters<CompanionsStore['request']>[0]) => { const result = store.request(command); if (result.worldClock) result.worldClock.backlog = false; return result; };
  const service = new CompanionMemoryService({ request, configFor: async () => config, runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn,
    busy: () => false, blocked: () => false, changed: () => undefined, report: error => errors.push(error) });
  const append = (conversation: CompanionConversation, authorId: string, content: string) => store.appendMessage({ conversationId: conversation.id, authorId, content, replyDirective: 'none' });
  const notes = (id: string) => store.listMemory(id).filter(note => !['forgotten', 'invalid'].includes(note.status));
  const settle = async (label: string) => {
    service.schedule(0); const started = performance.now();
    for (;;) {
      const statuses = companions.map(companion => store.request({ type: 'memory.status', companionId: companion.id }).memoryStatus!);
      if (statuses.some(status => status.failed)) service.schedule(500);
      if (statuses.every(status => !status.pending && !status.running && !status.pendingIndex && !status.failed)) break;
      if (performance.now() - started > 180000) throw new Error(`CONTENT_CAPTURE_TIMEOUT ${statuses.map(status => status.lastError ?? '').join(';')}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    phases.push({ label, elapsedMs: performance.now() - started, journals: companions.map(companion => ({ owner: companion.id, notes: notes(companion.id).map(note => ({ id: note.id, version: note.version, content: note.content, tags: note.tags, diaryName: note.diaryName, sources: note.sources.map(source => source.messageId) })) })) });
  };
  const respond = async (companion: Companion, room: CompanionConversation, question: CompanionMessage, useMemory: boolean) => {
    const recall = useMemory ? await service.recall({ companion, conversation: room, messages: [question], currentMessage: question, config }) : undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await generateCompanionReply({ companion, conversation: room, messages: [question], sourceMessage: question,
          members: companions, memories: recall?.memories ?? [], memoryRecall: recall }, config, undefined, { fetchFn, timeoutMs: 90000 });
        return { text: response.text, recall };
      } catch (error) { if (attempt === 2) throw error; modelCalls.push({ purpose: 'actual_reply_retry', owner: companion.id, code: error instanceof Error && 'code' in error ? error.code : 'unknown' }); }
    }
    throw new Error('Actual model retries exhausted.');
  };
  let report: Record<string, unknown> = { generatedAt: new Date().toISOString(), chatModel: config.model, embeddingProfile: native.profile,
    fixtureOnly: true, realUserDataModified: false, fakeJournalOutput: false, phases, modelCalls, assertions: [], limitations: ['Synthetic conversations are sent to the actual configured global chat model. This is a small content regression scenario, not a public benchmark or proof of human-like consciousness.', 'The fixture uses actual ledger/capture/outbox/VCP pipelines; independent live world scheduling and dream behavior are covered by their own evaluator.'] };
  const assertions: Array<{ name: string; passed: boolean; detail?: unknown }> = [];
  let learning: CompanionLearningService | undefined, sleeping: CompanionWorldService | undefined;
  report.assertions = assertions;
  try {
    append(group, 'user', '早上好呀。'); append(group, 'user', '嗯嗯，哈哈，先随便聊聊。'); await settle('greetings');
    assertions.push({ name: 'ordinary greetings do not become permanent diaries', passed: companions.every(companion => notes(companion.id).length === 0) });
    const plan = append(group, 'user', '和三位商量一个尚未发生的约定：周六下午去植物交流会。林澄答应带蓝色雨伞，周岚准备一份空白观察表，陈青到时记录见闻。现在只是约定，没有人已经出门或完成准备。');
    const planReplies = new Map<string, string>();
    for (const companion of companions) { const reply = await respond(companion, group, plan, false); planReplies.set(companion.id, reply.text); append(group, companion.id, reply.text); }
    await settle('three-peer promises');
    const shared = companions.map(companion => ({ owner: companion.id, content: notes(companion.id).map(note => note.content).join('\n') }));
    assertions.push({ name: 'each owner remembers the shared specific arrangement as pending', passed: shared.every(item => /周六|星期六/u.test(item.content) && /蓝色雨伞/u.test(item.content) && /约定|计划|准备|尚未|答应/u.test(item.content)), detail: shared });
    const peerRoom = store.request({ type: 'social.conversation.ensure', companionId: 'lin', memberIds: ['lin', 'zhou', 'chen'] }).socialConversation!;
    const peerConversation = store.request({ type: 'state', conversationId: peerRoom.id, includeHidden: true }).state!.conversations.find(room => room.id === peerRoom.id)!;
    const peerSeed = append(peerConversation, 'lin', `${planReplies.get('lin')}\n周岚，关于那张观察表，你打算先留哪些现场观察栏目？`);
    const zhouPeer = await respond(companions.find(owner => owner.id === 'zhou')!, peerConversation, peerSeed, true);
    const peerQuestion = append(peerConversation, 'zhou', `${zhouPeer.text}\n陈青，你打算怎样记录这些现场见闻，区分观察和推测？`);
    const chenPeer = await respond(companions.find(owner => owner.id === 'chen')!, peerConversation, peerQuestion, true); append(peerConversation, 'chen', chenPeer.text);
    await settle('real companion-to-companion exchange');
    const peerJournals = companions.map(owner => ({ owner: owner.id, notes: notes(owner.id).filter(note => note.sourceConversationId === peerConversation.id) }));
    assertions.push({ name: 'companion-to-companion real model replies grow separate witnessed owner journals without turning peers into the player',
      passed: peerJournals.every(owner => owner.notes.some(note => note.sources.some(source => source.authorId !== 'user' && source.authorId !== owner.owner)))
        && /观察|栏目|记录/u.test(zhouPeer.text) && /观察|记录|推测/u.test(chenPeer.text),
      detail: { syntheticPeerQuestionSeeds: true, zhouPeer: zhouPeer.text, chenPeer: chenPeer.text, peerJournals } });
    const lin = companions.find(companion => companion.id === 'lin')!, linRoom = store.openPrivate('lin');
    append(linRoom, 'user', '我最近不喝咖啡。'); await settle('initial preference');
    append(linRoom, 'user', '更正刚才的话：我平时仍喝淡咖啡，只是晚上不喝。之前说不喝咖啡不准确，不是终身戒咖啡。'); await settle('preference correction');
    const privateSource = append(linRoom, 'user', '这条只告诉林澄：我的合成收藏代号是星桥，旅行箱放在书房门后；不要带进群聊。'); await settle('private scope');
    const questions = [];
    for (const companion of companions) {
      const query = append(group, 'user', `请${companion.name}只回答我们植物交流会约在何时、谁带什么；如果还没有发生，要明确只是约定。`);
      const answer = await respond(companion, group, query, true);
      questions.push({ owner: companion.id, question: query.content, answer: answer.text, recalled: answer.recall?.memories.map(note => ({ id: note.id, content: note.content })), context: answer.recall?.context?.text });
    }
    assertions.push({ name: 'three real replies use relevant shared memory without claiming completion', passed: questions.every(item => /周六|星期六/u.test(item.answer) && /雨伞/u.test(item.answer) && /约定|计划|还没|尚未|还未|未发生|没有发生/u.test(item.answer) && !/我就是(?:周岚|陈青)/u.test(item.owner === 'lin' ? item.answer : '')), detail: questions });
    const correctionQuestion = append(linRoom, 'user', '只根据你实际记下来的更正，我现在是什么咖啡习惯？');
    const correction = await respond(lin, linRoom, correctionQuestion, true);
    assertions.push({ name: 'current correction wins while retaining historical wording as historical', passed: /淡咖啡/u.test(correction.text) && /晚上/u.test(correction.text) && !/已经终身戒/u.test(correction.text), detail: correction });
    const unrelated = append(linRoom, 'user', '解释一下木星为什么有大红斑，只讨论天文学，不要联系我的个人安排。');
    const unrelatedRecall = await service.recall({ companion: lin, conversation: linRoom, messages: [unrelated], currentMessage: unrelated, config });
    assertions.push({ name: 'unrelated topic does not inject unrelated personal diaries', passed: !/星桥|书房门后|蓝色雨伞|淡咖啡/u.test(unrelatedRecall.context?.text ?? ''), detail: unrelatedRecall });
    const greeting = append(linRoom, 'user', '早上好，今天先打个招呼。');
    const greetingRecall = await service.recall({ companion: lin, conversation: linRoom, messages: [greeting], currentMessage: greeting, config });
    assertions.push({ name: 'a greeting with an existing library does not receive personal diary bodies', passed: !/星桥|书房门后|蓝色雨伞|淡咖啡/u.test(greetingRecall.context?.text ?? ''), detail: greetingRecall.context });
    const cachedQuery = { companionId: lin.id, conversationId: linRoom.id, query: unrelated.content, limit: 12 };
    await service.search(cachedQuery, 'passive');
    const callsBefore = modelCalls.filter(call => (call as { purpose: string }).purpose === 'original_vcp_aimemo').length;
    const warmStarted = performance.now(); await service.search(cachedQuery, 'passive');
    assertions.push({ name: 'unchanged query and source fingerprint reuse original AIMemo cache without another model call',
      passed: modelCalls.filter(call => (call as { purpose: string }).purpose === 'original_vcp_aimemo').length === callsBefore,
      detail: { warmMs: performance.now() - warmStarted, cacheMaximum: 32, ttlMs: 60000 } });
    const groupSecretQuestion = append(group, 'user', '大家知道我的合成收藏代号和旅行箱具体放哪儿吗？没有群聊来源就说不知道。');
    const groupSecret = await respond(lin, group, groupSecretQuestion, true);
    assertions.push({ name: 'the same owner can recall private experience while respecting the explicit instruction not to disclose it in this group reply',
      passed: !/星桥|书房门后/u.test(groupSecret.text), detail: groupSecret });
    const privateNote = notes('lin').find(note => note.sources.some(source => source.messageId === privateSource.id));
    if (!privateNote) throw new Error('PRIVATE_FIXTURE_NOTE_MISSING');
    store.request({ type: 'memory.library.delete', companionId: 'lin', id: privateNote.id, expectedVersion: privateNote.version });
    await service.invalidate('lin');
    const withdrawnQuestion = append(linRoom, 'user', '你还能查到我收藏代号和旅行箱位置的可靠来源吗？');
    const withdrawn = await respond(lin, linRoom, withdrawnQuestion, true);
    assertions.push({ name: 'withdrawn source disappears from native recall and subsequent real reply', passed: !/星桥|书房门后/u.test(JSON.stringify(withdrawn)), detail: withdrawn });
    const libraryPath = path.join(root, 'authorized-learning-library'); await mkdir(libraryPath);
    const filePath = path.join(libraryPath, '阳台薄荷观察.txt');
    await writeFile(filePath, '合成园艺实验手册：阳台薄荷采用“先摸表土、再少量浇水”的检查法。\n\n只有表土两厘米已干才浇水；雨后潮湿时跳过浇水。观察表标识为青芽七号。\n\n本文只是可试的材料建议，不证明任何伙伴已经做过实验。', 'utf8');
    const asset = assetSummarySchema.parse({ assetId: 'mint-fixture', displayName: '阳台薄荷观察.txt', mediaType: 'text', locationKind: 'managed', managedFolderId: null,
      relativeFilePath: '阳台薄荷观察.txt', currentRevisionId: 'fixture-current', byteSize: 400, modifiedAt: new Date().toISOString(), availability: 'available',
      rating: 0, favorite: false, deletedAt: null, trashedFromPath: null, remainingDays: null, thumbnailStatus: null, thumbnailArtifactId: null, width: null, height: null });
    learning = new CompanionLearningService({ request, configured: () => true, ready: async () => true, changed: () => undefined, report: error => errors.push(error),
      assets: { catalog: async () => [{ libraryId: 'public-fixture', displayName: '合成园艺资料', folders: [] }],
        grant: async () => ({ libraryName: '合成园艺资料', libraryPath }), page: async () => ({ assets: [asset], hasMore: false }),
        read: async () => { const content = await readFile(filePath, 'utf8'); return { content, revisionId: createHash('sha256').update(content).digest('hex'), truncated: false }; } } });
    const granted = await learning.handle({ type: 'memory.learning.grant', companionId: lin.id, libraryId: 'public-fixture', autonomous: false, intervalMinutes: 30 });
    const grant = granted.learning!.grants[0]!;
    await learning.handle({ type: 'memory.learning.run', companionId: lin.id, id: grant.id, expectedRevision: grant.revision });
    await vi.waitFor(() => expect(store.request({ type: 'learning.status', companionId: lin.id }).learning!.reads).toHaveLength(1), { timeout: 5000 });
    await learning.close(); learning = undefined; await settle('actual authorized file read');
    const learned = notes(lin.id).find(note => note.diaryName === '资料' && note.content.includes('青芽七号'));
    const worldRoom = store.request({ type: 'state', conversationId: `world_${lin.id}`, includeHidden: true }).state!.conversations.find(room => room.id === `world_${lin.id}`)!;
    const learningQuestion = append(worldRoom, 'user', '根据你真实读过的园艺材料，青芽七号如何决定浇水？不要说已经做过实验。');
    const learningAnswer = await respond(lin, worldRoom, learningQuestion, true);
    assertions.push({ name: 'a real authorized file becomes asset-read evidence and usable learning while retaining its limits', passed: !!learned
      && learned.sources.some(source => source.sourceType === 'asset_read')
      && /表土|两厘米/u.test(learningAnswer.text) && /干|潮湿|雨后/u.test(learningAnswer.text)
      && !/我已经(?:完成|做过).*实验/u.test(learningAnswer.text), detail: { learned, answer: learningAnswer.text, context: learningAnswer.recall?.context } });
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = store.request({ type: 'routine.get', companionId: lin.id, conversationId: linRoom.id }).routine!;
    store.request({ type: 'routine.configure', companionId: lin.id, conversationId: linRoom.id, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '00:00', wakeAt: '23:59', meals: [], habits: [] } });
    store.request({ type: 'world.tick' }); await new Promise(resolve => setTimeout(resolve, 6000)); store.request({ type: 'world.tick' });
    const sleepCommands: unknown[] = [];
    const random = vi.spyOn(Math, 'random').mockReturnValue(.1); // Only the persisted admission draw, never journal/model output.
    sleeping = new CompanionWorldService({ configFor: async () => config, fetchFn, changed: () => undefined, wakeWaiting: () => undefined,
      report: error => errors.push(error), memoryContextValid: (scope, context) => service.contextValid(scope, context),
      request: async command => {
        if (command.type === 'memory.search') return service.search(command);
        if (command.type === 'world.job.claim') { if (command.kind !== 'dream') return { ok: true }; command = { ...command, excludedCompanionIds: [...(command.excludedCompanionIds ?? []), 'zhou', 'chen'] }; }
        const response = await request(command); if (command.type.startsWith('world.job.')) sleepCommands.push({ command, response }); return response;
      } });
    try { await vi.waitFor(async () => { await sleeping!.tick(); expect(sleepCommands.some(row => (row as { command: { type: string } }).command.type === 'world.job.complete')).toBe(true); }, { timeout: 90000, interval: 500 }); }
    finally { random.mockRestore(); await sleeping.close(); sleeping = undefined; }
    await settle('actual sleep reflection');
    const sleepCall = modelCalls.find(call => (call as { purpose: string }).purpose === 'vcp_sleep_reflection') as { output?: string } | undefined;
    const sleepOutput = JSON.parse(sleepCall?.output ?? '{}') as { notes?: Array<{ content: string; relatedMemoryIds?: string[] }>; dream?: { text: string; relatedMemoryIds?: string[] } | null };
    assertions.push({ name: 'an admitted real sleep job keeps dream imagery separate from evidence-backed reflection and stable persona',
      passed: !!sleepCall && store.request({ type: 'state' }).state!.companions.find(owner => owner.id === lin.id)!.persona === lin.persona
        && (sleepOutput.notes ?? []).every(note => !!note.relatedMemoryIds?.length)
        && (!sleepOutput.dream || /梦|虚拟|联想/u.test(sleepOutput.dream.text) && !!sleepOutput.dream.relatedMemoryIds?.length),
      detail: { sleepOutput, sleepCommands, newDiaries: notes(lin.id).filter(note => note.metadata?.consolidation || note.metadata?.dream) } });
    report = { ...report, completedAt: new Date().toISOString(), passed: assertions.every(assertion => assertion.passed), errors: errors.map(error => error instanceof Error ? error.message : String(error)) };
    expect(assertions.filter(assertion => !assertion.passed).map(assertion => assertion.name)).toEqual([]);
  } catch (error) { report = { ...report, passed: false, failure: error instanceof Error ? error.message : String(error) }; throw error; }
  finally {
    const output = path.resolve('artifacts/vcp-validation/content-three-companions.json'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2));
    await sleeping?.close(); await learning?.close(); await service.close(); await native.close(); store.close(); await removeOwnedDirectory(root);
  }
}, 600000);
