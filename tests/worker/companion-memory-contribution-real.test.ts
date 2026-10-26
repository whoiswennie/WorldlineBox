import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { generateCompanionJournal } from '../../src/main/companions/memory-model';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMemory } from '../../src/shared/companions';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { nativeManagementHarness } from '../fixtures/vcp-management-native';

/** Paid, synthetic-only semantic acceptance. This is actual global chat and
 * actual vendored Rust/VCP retrieval; the local 16-D vectors are deliberately
 * deterministic, and make no encoder or general retrieval-quality claim. */
it.skipIf(process.env.WORLDLINEBOX_MEMORY_CONTRIBUTION_REAL !== '1')('avoids re-encoding a same-source overview awaiting native publication while retaining its omitted fact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-contribution-real-'));
  const config = await realGlobalChatConfig(root), started = performance.now();
  const receipts: unknown[] = [], provider: unknown[] = [];
  let status = 'failed', failure: string | undefined;
  const modelFetch: typeof fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    const response = await fetch(url, init);
    provider.push({ request: { model: request.model, messages: request.messages }, status: response.status, response: await response.clone().text() });
    return response;
  };
  try {
    for (const omittedFact of [false, true]) {
      const store = new CompanionsStore(path.join(root, omittedFact ? 'partial.sqlite' : 'complete.sqlite'),
        [{ id: 'alice', name: '阿澜', description: '', persona: '珍惜实际共同经历，记录重要细节、条件和未完成事项；已有事实不换句话另记一次。', model: '', avatar: 'sister', active: true, proactive: false }]);
      const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
      const nativeRoot = path.join(root, omittedFact ? 'partial-native' : 'complete-native');
      await mkdir(nativeRoot, { recursive: true });
      const native = await nativeManagementHarness(nativeRoot, async command => store.request(command));
      const snapshot = () => store.request({ type: 'memory.snapshot', ...scope }).memorySnapshot!.notes;
      const draft = (id: string, raw: string, content: string) => ({ content, tags: ['真实经历'], diaryName: '经历', sourceMessageIds: [id], evidence: [{ sourceMessageId: id, quote: raw }] });
      let receipt: Record<string, unknown> = { omittedFact };
      try {
        for (let i = 0; i < 12; i++) {
          const raw = `group0 合成索引旁证${i}：今天检查了编号DL-${i}的工具盒，位置在第${i + 1}格，不涉及旧书修复。`;
          const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: raw, replyDirective: 'none' });
          store.request({ type: 'memory.record', ...scope, candidate: draft(source.id, raw, raw) });
        }
        for (;;) {
          const publication = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox;
          if (!publication) break;
          await native.client.remember(publication, { id: publication.note.id, content: publication.note.content, tags: publication.note.tags, diaryName: publication.note.diaryName });
          store.request({ type: 'memory.outbox.complete', id: publication.id, leaseToken: publication.leaseToken, indexed: true });
        }
        const raw = 'group0 这是本次合成验收。今天在青岚书店修复编号QL-27的旧书，只缝好了上半部书脊，下半部尚未开始；剩余米色棉线放在第二层抽屉。';
        const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: raw, replyDirective: 'none' });
        const savedOverview = omittedFact
          ? '玩家自述今天在青岚书店修复QL-27旧书，只缝好了上半部书脊，下半部尚未开始。'
          : '玩家自述今天在青岚书店修复QL-27旧书，只缝好了上半部书脊，下半部尚未开始；剩余米色棉线放在第二层抽屉。';
        const overview = store.request({ type: 'memory.record', ...scope, candidate: draft(source.id, raw, savedOverview) }).memories![0]!;
        const notes = snapshot();
        await native.client.replace({ scopeId: overview.scopeId }, notes.map(note => ({ id: note.id, content: note.content, tags: note.tags, diaryName: note.diaryName, occurredAt: note.occurredAt })));
        const search = await native.client.search({ scopeId: overview.scopeId }, { text: raw, topK: 8 });
        receipt = { ...receipt, source, overview, overviewPublication: 'queued_not_yet_in_native_index', nativeSearch: search, vectorRequests: native.embeddingRequests };
        receipts.push(receipt);
        expect(search.results.length).toBeGreaterThan(0);
        expect(search.results.some(hit => hit.id === overview.id)).toBe(false);
        const job = store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob!;
        expect(job).toBeDefined();
        const contributions: CompanionMemory[] = [];
        let afterId: string | undefined;
        do {
          const page = store.request({ type: 'memory.jobs.contributions', companionId: 'alice', id: job.id, leaseToken: job.leaseToken, afterId }).memoryCaptureContributions!;
          contributions.push(...page.items); afterId = page.hasMore ? page.nextId : undefined;
        } while (afterId);
        expect(contributions.some(note => note.id === overview.id)).toBe(true);
        const relevant = [...new Map([...search.results.flatMap(hit => notes.filter(note => note.id === hit.id)), ...contributions].map(note => [note.id, note])).values()];
        const companion = store.request({ type: 'state', companionId: 'alice', includeConversations: false }).state!.companions.find(item => item.id === 'alice')!;
        const profiles = new CompanionAssetProfileStore(path.join(root, omittedFact ? 'partial-profiles' : 'complete-profiles'));
        const ownerFiles = await profiles.bootstrap(companion);
        receipt.ownerPromptRevision = ownerFiles.promptRevision;
        const messages = store.request({ type: 'memory.sources.filter', ...scope, beforeSequence: job.throughSequence, ids: job.sourceMessageIds }).memorySources!;
        const result = await generateCompanionJournal({ companion, conversation, messages, relevantMemories: relevant, sourceContributions: contributions },
          { ...config, ownerId: 'alice', workPriority: 'background', resolveAssetContext: async (context, kind) => assembleCompanionAssetContext(context, await profiles.load('alice'), kind) },
          undefined, { fetchFn: modelFetch, timeoutMs: 120000 });
        receipt.contributions = contributions; receipt.actualModelResult = result;
        const committed = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: result.notes,
          readMemories: relevant.map(note => ({ id: note.id, version: note.version, contentRevision: note.contentRevision! })) });
        const final = store.request({ type: 'memory.browse', ...scope, limit: 100 }).memoryPage!.items.map(item => item.memory)
          .filter(note => note.sources.some(reference => reference.messageId === source.id));
        receipt.committed = committed; receipt.final = final;
        if (omittedFact) {
          expect(result.notes.length).toBeGreaterThan(0);
          expect(final.map(note => note.content).join('\n')).toMatch(/(?:第二层|第2层|二层).*抽屉/u);
          expect(final.map(note => note.content).join('\n')).toMatch(/下半部.*(?:未|没|尚)/u);
        } else {
          expect(result.notes).toEqual([]);
          expect(final).toHaveLength(1);
          expect(final[0]!.id).toBe(overview.id);
        }
        expect(store.request({ type: 'memory.jobs.claim', companionId: 'alice', force: true }).memoryJob).toBeUndefined();
      } finally { await native.close(); store.close(); }
    }
    status = 'passed';
  } catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    const destination = path.resolve(`artifacts/vcp-validation/memory-contribution-real-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify({ status, failure, actualChatModel: provider.length > 0, actualVendoredRustIndex: receipts.length > 0, actualEncoder: false,
      deterministicVectors: 'synthetic-localhost-16d', syntheticFixtureOnly: true, userDataModified: false,
      canonicalOwnerPurposeFiles: true,
      limitations: ['two synthetic source-contribution cases; not an encoder benchmark or long-duration stability proof', 'canonical file authority is covered separately by Main integration tests'],
      durationMs: performance.now() - started, model: config.model, receipts, provider }, null, 2));
    await removeOwnedDirectory(root);
  }
}, 300000);
