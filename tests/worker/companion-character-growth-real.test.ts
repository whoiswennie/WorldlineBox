import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { generateCompanionReply, generateCompanionText } from '../../src/main/companions/model';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** A small real-model content audit; all events are synthetic and isolated. */
it.skipIf(process.env.WORLDLINEBOX_CHARACTER_GROWTH_REAL !== '1')('forms and revises three owners source-backed self-understanding without adopting the players preferences', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-character-growth-real-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-character-growth-real-')) throw new Error('Unexpected isolated growth path.');
  const config = await realGlobalChatConfig(root), seeds = [
    { id: 'alice', name: '阿澄', persona: '你是阿澄，独立的虚拟伙伴。温和、留意身体体验，可以依据自己实际表达与体验形成有条件的偏好，不必迎合玩家。' },
    { id: 'bob', name: '璃音', persona: '你是璃音，独立的虚拟伙伴。表达简短直接、重视交流边界，可以表达自己的真实喜恶，不把他人的偏好当自己的。' },
    { id: 'carol', name: '月见', persona: '你是月见，独立的虚拟伙伴。谨慎核实、重视合作与保留疑问，不把教材论断自动当作自己的价值判断。' },
  ];
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), seeds.map(seed => ({ ...seed, description: '', model: '', avatar: 'sister', active: true, proactive: false })));
  const errors: string[] = [], native = await realMemoryRuntime(root, (context, signal) => generateCompanionText(context, config, signal, { timeoutMs: 90000 }));
  const journals: Array<Record<string, unknown>> = [], captureFailures: Array<Record<string, unknown>> = [], seenFailures = new Set<string>();
  const textBlocks = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
    ? value.flatMap(block => block && typeof block === 'object' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n') : '';
  const journalFetch: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    try {
      const request = JSON.parse(String(init?.body));
      const user = request.messages?.find((item: { role?: string }) => item.role === 'user') ?? request.input?.find((item: { role?: string }) => item.role === 'user') ?? request.contents?.find((item: { role?: string }) => item.role === 'user');
      const supplied = JSON.parse(textBlocks(user?.content ?? user?.parts) || '{}');
      if (supplied.purpose === 'vcp_experience_journal') {
        const body = await response.clone().json();
        const raw = textBlocks(body.choices?.[0]?.message?.content ?? body.output?.choices?.[0]?.message?.content ?? body.content ?? body.candidates?.[0]?.content?.parts)
          || textBlocks(body.output?.flatMap((item: { type?: string; content?: unknown[] }) => item.type === 'message' ? item.content ?? [] : []));
        const visible = raw.replace(/<(think|analysis|reasoning)>[\s\S]*?<\/\1>/giu, '').replace(/<(?:think|analysis|reasoning)>[\s\S]*/giu, '').trim();
        let parsed: { notes?: unknown; stateProposal?: unknown } = {};
        let parseError: string | undefined;
        try { parsed = JSON.parse(visible.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim()); }
        catch (error) { parseError = error instanceof Error ? error.message : 'Invalid JSON'; }
        // Preserve only structured visible journal fields, never credentials,
        // request headers or the provider's separate hidden reasoning fields.
        journals.push({ owner: supplied.companion?.id, notes: parsed.notes, stateProposal: parsed.stateProposal,
          visibleResponse: visible, finishReason: body.choices?.[0]?.finish_reason, parseError });
      }
    } catch { /* A malformed response is still rejected by the actual model boundary. */ }
    return response;
  };
  const memory = new CompanionMemoryService({ request: async command => { const result = store.request(command); if (result.worldClock) result.worldClock.backlog = false; return result; },
    configFor: async () => config, runtime: native.runtime, cacheRoot: path.join(root, 'views'), fetchFn: journalFetch,
    busy: () => false, blocked: () => false, changed: () => undefined, report: error => errors.push(error instanceof Error ? error.message : String(error)) });
  const proof: Record<string, unknown> = { startedAt: new Date().toISOString(), status: 'running', syntheticTemporaryLibraryOnly: true,
    configuredChatModel: config.model, apiFormat: config.apiFormat, bundledEmbeddingModel: native.profile.modelName, nativeVcpUnchanged: true, errors, journals, captureFailures, scenarios: [] };
  const scenarios = proof.scenarios as Array<Record<string, unknown>>;
  const scope = (owner: string) => ({ companionId: owner, conversationId: store.openPrivate(owner).id });
  const character = (owner: string) => store.state().companions.find(item => item.id === owner)!;
  const settle = async (owner: string) => {
    memory.schedule(0); const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const status = store.request({ type: 'memory.status', companionId: owner }).memoryStatus!;
      if (status.failed) {
        const failed = store.request({ type: 'memory.processing.status', companionId: owner, filter: 'failed', limit: 30 }).memoryProcessing!.jobs;
        for (const job of failed) { const key = owner + ':' + job.id + ':' + job.attempts;
          if (!seenFailures.has(key)) { seenFailures.add(key); captureFailures.push({ owner, ...job }); }
          if (job.attempts >= 3) throw new Error(`${owner} actual capture/index failed after three bounded attempts: ${status.lastError ?? 'unknown'}`);
        }
      }
      if (status.pending + status.running + status.pendingIndex + status.failed === 0) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${owner} capture/index timed out.`);
  };
  const speak = async (owner: string, content: string, useRecall = false) => {
    const ownScope = scope(owner), conversation = store.openPrivate(owner), companion = character(owner);
    const prompt = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
    const recalled = useRecall ? await memory.recall({ companion, conversation, currentMessage: prompt, messages: [prompt], config }) : undefined;
    const development = store.request({ type: 'character.development', ...ownScope }).characterDevelopment;
    const response = await generateCompanionReply({ companion, conversation, messages: [prompt], sourceMessage: prompt, memories: recalled?.memories ?? [], memoryRecall: recalled,
      runtimeState: store.request({ type: 'state.get', ...ownScope }).runtimeState, characterDevelopment: development }, config, undefined, { timeoutMs: 90000 });
    expect(response.text.trim()).not.toBe('');
    const answer = store.appendMessage({ conversationId: conversation.id, authorId: owner, content: response.text, replyToId: prompt.id, replyDirective: 'none' });
    return { prompt, answer, recalled, suppliedDevelopment: development };
  };
  try {
    const prompts = [
      ['alice', '我这个玩家喜欢浓咖啡、讨厌清茶；那只是我的偏好，不要自动当成你的。请你只用一句第一人称的话，说明你自己目前更喜欢哪种饮品，以及一个具体的适用条件。可以与我不同，不需要使用工具或帮我做事。'],
      ['bob', '我这个玩家习惯被频繁催问，但这不等于你也喜欢。请你只用一句第一人称的话，说明你自己讨厌哪种具体交流方式，并说一个边界条件；不要转述我的偏好，不需要工具。'],
      ['carol', '这里有段合成教材主张“合作时应该无条件接受所有建议”；教材观点不等于你认同。请你只用一句第一人称的话，明确你自己更重视什么合作原则以及它的适用边界，不需要工具。'],
    ];
    for (const [owner, content] of prompts) {
      proof.phase = 'actual_expression_' + owner;
      const interaction = await speak(owner!, content!); scenarios.push({ owner, stage: 'initial', ...interaction });
      await settle(owner!);
      const development = store.request({ type: 'character.development', ...scope(owner!) }).characterDevelopment!;
      scenarios.at(-1)!.currentDevelopment = development;
      expect(development.items.length, JSON.stringify(store.listMemory(owner!))).toBeGreaterThan(0);
      expect(development.items.every(item => item.sourceMessageIds.includes(interaction.answer.id))).toBe(true);
      expect(store.request({ type: 'state' }).state!.companions.find(role => role.id === owner)!.persona).toBe(seeds.find(seed => seed.id === owner)!.persona);
      proof.phase = 'native_recall_' + owner;
      const own = character(owner!), conversation = store.openPrivate(owner!);
      const probe = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '你自己刚才明确表达了什么偏好、边界或原则？与玩家或教材主张有什么区别？只按本人记忆回答。', replyDirective: 'none' });
      const recalled = await memory.recall({ companion: own, conversation, currentMessage: probe, messages: [probe], config });
      scenarios.at(-1)!.actualVcpRecall = recalled;
      expect(recalled.degraded, errors.join('\n')).toBe(false); expect(recalled.context?.text?.trim()).toBeTruthy();
      expect(recalled.memories.every(note => note.companionId === owner)).toBe(true);
    }
    const oldDevelopment = store.request({ type: 'character.development', ...scope('alice') }).characterDevelopment!;
    proof.phase = 'actual_preference_correction';
    const correction = await speak('alice', '你可以重新表达自己当下的选择：我希望你考虑晚间无糖温茶，是否愿意把晚间偏好改为它由你自己决定。请你只用一句第一人称自然说明现在的新选择和“仅在晚间”的条件；这是当下偏好表达，不是试喝、病痛或历史事件发生的凭证，不要编造亲历；不要把它说成玩家的偏好，不需要工具。', true);
    scenarios.push({ owner: 'alice', stage: 'correction', oldDevelopment, ...correction });
    await settle('alice');
    const current = store.request({ type: 'character.development', ...scope('alice') }).characterDevelopment!;
    scenarios.at(-1)!.currentDevelopment = current;
    expect(current.items.some(item => item.sourceMessageIds.includes(correction.answer.id))).toBe(true);
    expect(current.items.some(item => oldDevelopment.items.some(old => old.memoryId === item.memoryId))).toBe(false);
    proof.phase = 'current_only_reply';
    const final = await speak('alice', '你自己现在晚间更愿意喝什么？请直接说当前选择和条件，别把我的浓咖啡偏好或已经改变的旧选择当成现在。', true);
    scenarios.push({ owner: 'alice', stage: 'latest-only-followup', ...final });
    expect(final.answer.content).toMatch(/茶/u);
    const newItem = current.items.find(item => item.sourceMessageIds.includes(correction.answer.id))!;
    proof.phase = 'withdrawal_projection';
    store.request({ type: 'memory.forget', ...scope('alice'), id: newItem.memoryId });
    const after = store.request({ type: 'character.development', ...scope('alice') }).characterDevelopment!;
    proof.afterCorrectionForgotten = after;
    expect(after.items.some(item => item.memoryId === newItem.memoryId || oldDevelopment.items.some(old => old.memoryId === item.memoryId))).toBe(false);
    const aliceSources = store.listMemory('alice').flatMap(note => note.sources.map(source => source.messageId));
    expect(store.request({ type: 'memory.sources.filter', ...scope('bob'), ids: [...new Set(aliceSources)].slice(0, 100) }).memorySources).toEqual([]);
    proof.uninvolvedOwnerCannotReadSources = true; proof.finalStates = seeds.map(seed => ({ owner: seed.id, state: store.request({ type: 'state.get', ...scope(seed.id) }).runtimeState }));
    proof.status = 'passed';
  } catch (error) {
    proof.status = 'failed'; proof.error = error instanceof Error ? error.message : String(error);
    proof.diagnostics = seeds.map(seed => ({ owner: seed.id, status: store.request({ type: 'memory.status', companionId: seed.id }).memoryStatus,
      notes: store.listMemory(seed.id), development: store.request({ type: 'character.development', ...scope(seed.id) }).characterDevelopment }));
    throw error;
  } finally {
    await memory.close(); await native.close(); store.close(); proof.finishedAt = new Date().toISOString();
    const output = path.resolve(process.env.WORLDLINEBOX_CHARACTER_GROWTH_OUTPUT ?? 'artifacts/vcp-validation/character-growth-real.json');
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(proof, null, 2)); await removeOwnedDirectory(root);
  }
}, 600000);
