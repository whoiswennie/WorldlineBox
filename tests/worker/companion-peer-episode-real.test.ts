import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { generateCompanionReply, generateCompanionText } from '../../src/main/companions/model';
import { generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import type { CompanionSocialJob } from '../../src/shared/companion-social';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Real selective journaling and native recall, scoped to a synthetic library. */
it.skipIf(process.env.WORLDLINEBOX_PEER_EPISODE_REAL !== '1')('remembers that the sister actually asked about the player, not merely the old private name introduction', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-peer-episode-real-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-peer-episode-real-')) throw new Error('Unsafe fixture path.');
  const config = await realGlobalChatConfig(root), seeds = [
    { id: 'younger', name: '小肥鱼', persona: '你是小肥鱼，是大肥鱼的妹妹。大肥鱼伙伴的稳定ID是elder。真人玩家是独立的人。谨慎记住自己实际经历过的往来。' },
    { id: 'elder', name: '大肥鱼', persona: '你是大肥鱼，是小肥鱼的姐姐。妹妹ID是younger，不是玩家。' },
    { id: 'observer', name: '月见', persona: '你是月见，没有参与其他人的私人交谈。' },
  ];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  const errors: string[] = [], native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { timeoutMs: 90000 }));
  const service = new CompanionMemoryService({ request: async command => { const response = store.request(command);
    if (response.worldClock) response.worldClock.backlog = false; return response; }, configFor: async () => config, runtime: native.runtime,
    cacheRoot: path.join(root, 'views'), fetchFn: fetch, busy: () => false, blocked: () => false, changed: () => undefined,
    report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const proof: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', realChatModel: config.model,
    realBundledEmbedding: native.profile.modelName, nativeVcpUnchanged: true, syntheticTemporaryLibraryOnly: true, errors };
  const settle = async (owner: string) => {
    service.schedule(0);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const status = store.request({ type: 'memory.status', companionId: owner }).memoryStatus!;
      if (status.failed) throw new Error(`${owner} capture/index failed: ${status.lastError ?? 'unknown error'}`);
      if (status.pending + status.running + status.pendingIndex === 0) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${owner} capture/index did not finish within three minutes.`);
  };
  try {
    const privateRoom = store.openPrivate('younger');
    const intro = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user', content: '你好，我叫天幻岚，这是我本人的名字，以后请叫我天幻岚。', replyDirective: 'none' });
    proof.phase = 'private_name_capture';
    await settle('younger');
    const original = store.listMemory('younger').find(note => note.sources.some(ref => ref.messageId === intro.id));
    expect(original?.content).toContain('天幻岚');
    const peer = store.request({ type: 'social.conversation.ensure', companionId: 'elder', memberIds: ['elder', 'younger'] }).socialConversation!;
    const question = store.request({ type: 'social.message.append', conversationId: peer.id, authorId: 'elder', clientId: 'real_sister_question',
      content: '妹妹，我是姐姐大肥鱼。那位玩家请我来核实：你还记得他亲口介绍的名字叫什么吗？这次我特地来问你，不是玩家又在私聊里重复提问。',
      virtualCreatedAt: new Date().toISOString() }).socialMessage!.message;
    const conversation = store.request({ type: 'state', includeHidden: true, conversationId: peer.id }).state!.conversations.find(item => item.id === peer.id)!;
    const companion = store.state().companions.find(item => item.id === 'younger')!;
    const recalled = await service.recall({ companion, conversation, messages: [question], currentMessage: question, config });
    proof.phase = 'actual_peer_reply';
    const job: CompanionSocialJob = { id: 'synthetic_sister_job', companionId: companion.id, conversationId: conversation.id,
      sourceMessageId: question.id, throughSequence: question.sequence, chainId: 'synthetic_chain', remainingTurns: 1,
      memberIds: conversation.memberIds, channel: 'phone', status: 'running', attempts: 1, typingNotBefore: question.createdAt, createdAt: question.createdAt };
    const response = await generateCompanionSocialReply({ companion, conversation, source: question, messages: [question], job,
      world: store.request({ type: 'world.observe', companionId: companion.id, conversationId: conversation.id }).world!,
      members: store.state().companions.filter(item => conversation.memberIds.includes(item.id)), memories: recalled.memories,
      memoryContext: recalled.context?.text }, config, undefined, { timeoutMs: 90000 });
    expect(response.text).toContain('天幻岚');
    const answer = store.request({ type: 'social.message.append', conversationId: peer.id, authorId: 'younger', clientId: 'real_sister_answer',
      content: response.text!, replyToId: question.id, virtualCreatedAt: new Date().toISOString() }).socialMessage!.message;
    proof.actualPeerDialogue = [question, answer]; proof.phase = 'automatic_peer_episode_capture';
    await settle('younger'); await settle('elder');
    const notes = store.listMemory('younger').filter(note => note.sources.some(ref => ref.messageId === question.id || ref.messageId === answer.id));
    expect(notes.length, JSON.stringify(store.listMemory('younger').map(note => note.content))).toBeGreaterThan(0);
    expect(notes.some(note => /大肥鱼|姐姐/u.test(note.content) && /问|询|核实/u.test(note.content))).toBe(true);
    const elderNotes = store.listMemory('elder').filter(note => note.sources.some(ref => ref.messageId === question.id || ref.messageId === answer.id));
    expect(elderNotes.length).toBeGreaterThan(0);
    const followup = store.appendMessage({ conversationId: privateRoom.id, authorId: 'user',
      content: '你姐姐大肥鱼今天有实际来找你问过我的姓名吗？她问了什么，你实际怎么回应的？只按自己的经历回答，不要仅复述我原来的自我介绍。', replyDirective: 'none' });
    const laterRecall = await service.recall({ companion, conversation: privateRoom, messages: [followup], currentMessage: followup, config });
    expect(laterRecall.degraded, errors.join('\n')).toBe(false);
    expect(laterRecall.context?.text).toMatch(/大肥鱼|姐姐/u);
    expect(laterRecall.context?.text).toMatch(/问|询|核实/u);
    expect(laterRecall.memories.some(note => note.sources.some(ref => ref.messageId === question.id || ref.messageId === answer.id))).toBe(true);
    const laterAnswer = await generateCompanionReply({ companion, conversation: privateRoom, messages: [followup], sourceMessage: followup,
      memories: laterRecall.memories, memoryRecall: laterRecall }, config, undefined, { timeoutMs: 90000 });
    expect(laterAnswer.text).toMatch(/大肥鱼|姐姐/u); expect(laterAnswer.text).toMatch(/问|询|核实/u); expect(laterAnswer.text).toContain('天幻岚');
    const outsider = store.openPrivate('observer');
    expect(store.request({ type: 'memory.sources.filter', companionId: 'observer', conversationId: outsider.id, ids: [question.id, answer.id] }).memorySources).toEqual([]);
    proof.originalPrivateNote = original;
    proof.actualPeerDialogue = [question, answer];
    proof.selectivelyCapturedYoungerEpisodes = notes; proof.selectivelyCapturedElderEpisodes = elderNotes;
    proof.followupOnlyCurrentMessage = followup; proof.followupFocusedRecall = laterRecall; proof.followupAnswer = laterAnswer.text;
    proof.uninvolvedOwnerCannotReadPeerSources = true; proof.status = 'passed';
  } catch (error) { proof.status = 'failed'; proof.error = error instanceof Error ? error.message : String(error);
    proof.ownerDiagnostics = seeds.map(seed => ({ id: seed.id, status: store.request({ type: 'memory.status', companionId: seed.id }).memoryStatus,
      processing: store.request({ type: 'memory.processing.status', companionId: seed.id }).memoryProcessing, notes: store.listMemory(seed.id) }));
    throw error; }
  finally {
    await service.close(); await native.close(); store.close(); proof.finishedAt = new Date().toISOString();
    const output = path.resolve(process.env.WORLDLINEBOX_PEER_EPISODE_OUTPUT ?? 'artifacts/vcp-validation/peer-episode-real.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(proof, null, 2));
    await removeOwnedDirectory(root);
  }
}, 600000);
