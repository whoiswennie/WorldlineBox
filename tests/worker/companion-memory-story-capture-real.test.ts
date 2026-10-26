import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { generateCompanionReply } from '../../src/main/companions/model';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { EXTENDED_RECALL_CASES, storyAccountChecks } from '../fixtures/passive-recall-extended-cases';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

it.skipIf(process.env.WORLDLINEBOX_MEMORY_STORY_CAPTURE_REAL !== '1')('encodes a three-part story through three natural capture admissions and recalls all seven facts with actual models', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-story-capture-'));
  const output = path.resolve('artifacts/vcp-validation/memory-story-capture-real-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json');
  const story = EXTENDED_RECALL_CASES.find(test => test.id === 'three_part_story')!, captures: Array<Record<string, unknown>> = [], calls: Array<Record<string, unknown>> = [], errors: string[] = [];
  let store: CompanionsStore | undefined, memory: CompanionMemoryService | undefined;
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined, native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined;
  let status = 'running', stage = 'setup', failure: unknown, final: Record<string, unknown> | undefined;
  const sources: Array<{ id: string; content: string; sequence: number }> = [];
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, actualEncoder: true, encoderModel: native?.profile.modelName, actualProvider: true,
      actualCaptureService: true, actualCanonicalOwnerFiles: true, noForcedClaim: true, simulatedIsolatedClockQuietAdvanceMs: 65000,
      limitations: ['Only the isolated host Date advances to exercise natural quiet admission; no claim of a wall-clock multi-day soak.',
        'This measures actual model event encoding followed by recall, not perfect first-pass recall of three independently authored flat notes.'],
      sources, captures, modelCalls: calls, providerRequestCount: calls.filter(call => call.providerRequest).length,
      ledgerRequestCount: store?.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests, final, errors,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  };
  try {
    const config = await realGlobalChatConfig(root);
    const modelFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers), providerRequest = headers.get('authorization') === 'Bearer ' + config.apiKey
        || headers.get('x-api-key') === config.apiKey || headers.get('x-goog-api-key') === config.apiKey;
      const wire = JSON.parse(String(init?.body ?? '{}')), response = await fetch(input, init);
      let visible: string | undefined;
      if (providerRequest && !wire.stream) {
        const value = await response.clone().json().catch(() => undefined) as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
        visible = value?.choices?.flatMap(choice => typeof choice.message?.content === 'string' ? [choice.message.content] : []).join('\n');
      }
      calls.push({ stage, providerRequest, status: response.status, inputCharacters: JSON.stringify(wire.messages ?? wire.input ?? []).length,
        ...(providerRequest && stage.startsWith('capture') ? { actualInput: wire.messages ?? wire.input, visibleOutput: visible } : {}) });
      return response;
    };
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: '阿澄', description: '合成自然事件编码验收', persona: '根据有据经历交流。', model: '', avatar: 'sister', active: true, proactive: false }]);
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    files = await canonicalMemoryFiles(root, store, config); native = await realMemoryRuntime(root, undefined, { modelFetch });
    const request = async (command: CompanionStorageCommand) => {
      const result = await files!.request(command);
      if (command.type === 'memory.jobs.claim' && result.memoryJob) captures.push({ stage, event: 'claim', forced: command.force ?? false, at: new Date().toISOString(), job: result.memoryJob });
      if (command.type === 'memory.jobs.complete') captures.push({ stage, event: 'complete', at: new Date().toISOString(), input: command,
        saved: result.memories?.map(note => ({ id: note.id, version: note.version, contentRevision: note.contentRevision, content: note.content, sources: note.sources })) });
      if (command.type === 'memory.jobs.fail' || command.type === 'memory.jobs.defer') captures.push({ stage, event: command.type, command });
      return result;
    };
    memory = new CompanionMemoryService({ request, ...files.projection, runtime: native.runtime, configFor: files.configFor,
      cacheRootFor: async owner => path.join(root, 'owner-assets', owner, '.认知索引', 'views'), validateFiles: (owner, receipts, window) => files!.live.validate(owner, receipts, window),
      fetchFn: modelFetch, busy: () => true, blocked: () => false, changed: () => undefined,
      report: error => errors.push(error instanceof Error ? error.message.split(config.apiKey).join('[redacted]').slice(0, 1000) : String(error)) });
    vi.spyOn(memory, 'schedule').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const [index, content] of story.sources.entries()) {
      stage = 'capture_' + (index + 1);
      const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
      sources.push({ id: source.id, content, sequence: source.sequence });
      const before = store.request({ type: 'memory.lifecycle.state', companionId: 'alice' }).memoryLifecycleState!;
      expect(Date.parse(before.nextCaptureAt!)).toBeGreaterThan(Date.now());
      vi.setSystemTime(Date.now() + 65000);
      await (memory as unknown as { process(): Promise<void> }).process(); await memory.drainDeliveries();
      const state = store.request({ type: 'memory.status', companionId: 'alice' }).memoryStatus!;
      expect(state, state.lastError).toMatchObject({ pending: 0, running: 0, failed: 0 });
      captures.push({ stage, event: 'after-native-publication', state, page: (await request({ type: 'memory.browse', ...scope })).memoryPage });
      await save();
    }
    const completed = captures.filter(event => event.event === 'complete'); expect(completed).toHaveLength(3);
    expect(captures.filter(event => event.event === 'claim').every(event => event.forced === false)).toBe(true);
    const page = (await request({ type: 'memory.browse', ...scope })).memoryPage!;
    expect(new Set(page.items.flatMap(hit => hit.memory.sources.map(source => source.messageId)))).toEqual(new Set(sources.map(source => source.id)));
    stage = 'focus';
    const question = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: story.query, replyDirective: 'none' });
    const alice = store.state().companions.find(owner => owner.id === 'alice')!;
    const recalled = await memory.recall({ companion: alice, conversation, currentMessage: question, messages: [question], config: await files.configFor(alice), signal: AbortSignal.timeout(180000) });
    const focused = recalled.context?.text ?? '', focusChecks = { ...story.checks(focused), ...storyAccountChecks(focused), healthy: !recalled.degraded, currentSources: await memory.contextValid(scope, recalled.context) };
    stage = 'final_reply';
    const answer = (await generateCompanionReply({ companion: alice, conversation, sourceMessage: question, messages: [question], memories: recalled.memories,
      world: store.request({ type: 'world.snapshot' }).world, memoryRecall: recalled }, await files.configFor(alice), AbortSignal.timeout(180000), { fetchFn: modelFetch, loop: true, tools: [], timeoutMs: 120000 })).text;
    const answerChecks = { ...story.checks(answer), ...storyAccountChecks(answer) };
    final = { query: story.query, rawSourceChecks: story.checks(story.sources.join('\n')),
      encodedNoteChecks: story.checks(page.items.map(hit => hit.memory.content).join('\n')), focused, answer, focusChecks, answerChecks,
      evidence: recalled.context?.evidence, actualNotes: page.items.map(hit => hit.memory) };
    status = [...Object.values(focusChecks), ...Object.values(answerChecks)].every(Boolean) ? 'passed' : 'failed'; await save();
    expect(Object.values(focusChecks).every(Boolean), JSON.stringify(focusChecks)).toBe(true);
    expect(Object.values(answerChecks).every(Boolean), JSON.stringify(answerChecks)).toBe(true);
    expect(store.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests).toBe(calls.filter(call => call.providerRequest).length);
  } catch (error) { failure = error; status = 'failed'; throw error; }
  finally { await save(); await memory?.close(); await files?.close(); await native?.close(); store?.close(); vi.useRealTimers(); await removeOwnedDirectory(root); }
}, 600000);
