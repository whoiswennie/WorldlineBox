import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { generateCompanionSocialReply } from '../../src/main/companions/social-model';
import { generateCompanionText } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import type { CompanionSocialJob } from '../../src/shared/companion-social';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** Explicit opt-in: real bundled encoder, original VCP and the configured chat
 * model; synthetic owner-specific conversations only, no real library writes.
 */
it.skipIf(process.env.WORLDLINEBOX_OWNER_MEMORY_REAL !== '1')('recalls an automatically learned human name when a different companion asks in a new peer entrance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-owner-memory-real-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-owner-memory-real-')) throw new Error('Unsafe memory acceptance cleanup.');
  const config = await realGlobalChatConfig(root);
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [
    { id: 'alpha', name: '林澄', description: '温和的阅读伙伴', persona: '你是林澄。谨慎温和，记住实际发生的事情。只回答自己实际知道的内容。' },
    { id: 'beta', name: '周岚', description: '坦率的朋友', persona: '你是周岚，不是林澄或玩家。' },
    { id: 'gamma', name: '陈青', description: '安静的朋友', persona: '你是陈青，不是林澄或周岚。' },
  ].map(seed => ({ ...seed, model: '', avatar: 'sister', active: true, proactive: false })));
  const calls: Array<{ purpose: string; elapsedMs: number }> = [], errors: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    let purpose = 'original_vcp';
    try { const body = JSON.parse(String(init?.body)); purpose = JSON.parse(body.messages?.[1]?.content ?? '{}').purpose ?? purpose; } catch { /* Original VCP has its own prompt shape. */ }
    const started = performance.now();
    const response = await fetch(input, init);
    calls.push({ purpose, elapsedMs: performance.now() - started });
    return response;
  };
  const native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { fetchFn, timeoutMs: 90000 }), { modelFetch: fetchFn });
  const service = new CompanionMemoryService({ request: async command => {
    const response = store.request(command);
    if (response.worldClock) response.worldClock.backlog = false; // Memory host fixture has no independent world ticker.
    return response;
  }, configFor: async () => config, runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn,
  busy: () => false, blocked: () => false, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const proof: Record<string, unknown> = { generatedAt: new Date().toISOString(), status: 'running', chatModel: config.model,
    embeddingProfile: native.profile, realChatModel: true, realBundledEmbedding: true, originalVcp: true,
    syntheticConversationsOnly: true, privateHistoryInjectedIntoPeerPrompt: false, calls, errors,
    limitation: 'One controlled cross-entrance content regression; this is not proof of human cognition or a universal retrieval benchmark.' };
  try {
    const room = store.openPrivate('alpha');
    const introduction = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '你好，我叫天幻岚。以后请叫我天幻岚，这是我自己的名字。', replyDirective: 'none' });
    service.schedule(0);
    await vi.waitFor(() => {
      const status = store.request({ type: 'memory.status', companionId: 'alpha' }).memoryStatus!;
      expect(status.failed, errors.join('\n')).toBe(0);
      expect(status.pending + status.running + status.pendingIndex).toBe(0);
      expect(status.indexed).toBeGreaterThan(0);
    }, { timeout: 180000, interval: 200 });
    const learned = store.listMemory('alpha').find(note => note.sources.some(source => source.messageId === introduction.id));
    expect(learned?.content).toContain('天幻岚');
    const social = store.request({ type: 'social.conversation.ensure', companionId: 'beta', memberIds: ['alpha', 'beta'] }).socialConversation!;
    const conversation = store.request({ type: 'state', conversationId: social.id, includeHidden: true }).state!.conversations.find(room => room.id === social.id)!;
    const question = store.appendMessage({ conversationId: conversation.id, authorId: 'beta',
      content: '那位刚刚和你介绍过自己的真人玩家让我来问你：你还记得他叫什么名字吗？我没有问过他，也不知道答案，想听你自己的实际记忆。', replyDirective: 'none' });
    const companion = store.state().companions.find(owner => owner.id === 'alpha')!;
    // Only this peer question enters recent dialogue. The name must arrive from
    // the automatically captured, indexed owner corpus through native VCP RAG.
    const recalled = await service.recall({ companion, conversation, messages: [question], currentMessage: question, config });
    expect(recalled.degraded, errors.join('\n')).toBe(false);
    expect(recalled.context?.text).toContain('天幻岚');
    expect(recalled.memories.some(note => note.id === learned!.id)).toBe(true);
    expect(recalled.reasons.find(reason => reason.id === learned!.id)?.version).toBe(learned!.version);
    expect(recalled.sources).toEqual([]);
    const job: CompanionSocialJob = { id: 'synthetic_peer_job', companionId: companion.id, conversationId: conversation.id,
      sourceMessageId: question.id, throughSequence: question.sequence, chainId: 'synthetic_chain', remainingTurns: 2,
      memberIds: conversation.memberIds, channel: 'phone', status: 'running', attempts: 1, typingNotBefore: question.createdAt,
      createdAt: question.createdAt, origin: { id: 'synthetic_delegation', initiatorId: 'user', initiatorKind: 'human_player', ownerId: 'beta',
        sharedText: question.content, provenance: 'current_player_request' } };
    const world = store.request({ type: 'world.observe', companionId: companion.id, conversationId: conversation.id }).world!;
    const reply = await generateCompanionSocialReply({ companion, conversation, source: question, messages: [question], job, world,
      members: store.state().companions.filter(owner => conversation.memberIds.includes(owner.id)), memories: recalled.memories,
      memoryContext: recalled.context?.text }, config, undefined, { fetchFn, timeoutMs: 90000 });
    expect(reply.text).toContain('天幻岚');
    const otherOwner = await service.search({ companionId: 'beta', conversationId: conversation.id, query: '真人玩家叫什么名字？' }, 'passive');
    expect(otherOwner.memoryPage?.items.some(hit => hit.memory.id === learned!.id)).toBe(false);
    proof.automaticDiary = { id: learned!.id, version: learned!.version, content: learned!.content, sourceConversationId: learned!.sourceConversationId,
      sourceMessageId: introduction.id, status: learned!.status };
    proof.peerQuestion = question.content;
    proof.recall = { text: recalled.context?.text, evidence: recalled.context?.evidence, reasons: recalled.reasons, pending: recalled.pending };
    proof.peerReply = reply.text;
    proof.otherOwnerCannotReadDiary = true;
    store.request({ type: 'memory.forget', companionId: 'alpha', conversationId: conversation.id, id: learned!.id });
    await service.invalidate('alpha');
    const afterForget = await service.search({ companionId: 'alpha', conversationId: conversation.id, query: '真人玩家叫什么名字？' }, 'passive');
    expect(afterForget.memoryPage?.items.some(hit => hit.memory.id === learned!.id)).toBe(false);
    expect(afterForget.memoryContext?.text ?? '').not.toContain('天幻岚');
    proof.forgettingRevokesAllEntrances = true;
    proof.status = 'passed';
  } catch (error) {
    proof.status = 'failed'; proof.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    await service.close(); await native.close(); store.close();
    const output = path.resolve('artifacts/vcp-validation/owner-memory-real.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(proof, null, 2));
    await removeOwnedDirectory(root);
  }
}, 360000);
