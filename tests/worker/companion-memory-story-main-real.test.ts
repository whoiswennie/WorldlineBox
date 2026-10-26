import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { COMPANION_DIALOGUE_WINDOW } from '../../src/main/companions/context-window';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { canonicalMemoryFiles } from '../fixtures/canonical-memory-files';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { EXTENDED_RECALL_CASES, storyAccountChecks } from '../fixtures/passive-recall-extended-cases';

const transport = vi.hoisted(() => ({ request: undefined as undefined | ((command: CompanionStorageCommand) => Promise<CompanionStorageResponse>),
  fetch: undefined as undefined | typeof fetch }));
// Only Electron utility IPC is replaced. Main, SQLite, agent kernel, model,
// memory tools, source gates and canonical file readers remain production code.
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  async start() { /* The fixture owns the real SQLite connection. */ }
  async request(command: CompanionStorageCommand) { if (!transport.request) throw Error('Unbound storage transport.'); return transport.request(command); }
  async close() { /* Finally owns connection cleanup. */ }
} }));
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() }, net: { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (!transport.fetch) throw Error('Unbound actual provider transport.'); return transport.fetch(input, init);
} }, dialog: { showOpenDialog: vi.fn() }, protocol: { handle: vi.fn() },
safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));

it.skipIf(process.env.WORLDLINEBOX_MEMORY_STORY_MAIN_REAL !== '1')('uses the actual Main memory-tool loop to recover a three-part story without a scripted tool plan', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-story-main-'));
  const output = path.resolve('artifacts/vcp-validation/memory-story-main-real-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8) + '.json');
  const story = EXTENDED_RECALL_CASES.find(test => test.id === 'three_part_story')!;
  const modelCalls: Array<Record<string, unknown>> = [], commandCounts = new Map<string, number>(), errors: string[] = [];
  const seeded: Array<{ case: string; id: string; content: string }> = [], firstPass: Array<Record<string, unknown>> = [];
  let store: CompanionsStore | undefined, service: CompanionService | undefined;
  let files: Awaited<ReturnType<typeof canonicalMemoryFiles>> | undefined, native: Awaited<ReturnType<typeof realMemoryRuntime>> | undefined;
  let loop: CompanionLoopCheckpoint | undefined, sourceId = '', status = 'running', failure: unknown, final: Record<string, unknown> | undefined;
  let mainInitialized = false;
  const save = async () => {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ status, actualMain: true, actualAgentKernel: true, actualSQLite: true, actualCanonicalFiles: true,
      actualModel: true, actualEncoder: true, encoderModel: native?.profile.modelName, actualMemoryToolKernel: true,
      actualMemoryToolsInvoked: loop?.turns.some(turn => turn.calls.some(call => call.name === 'memory')) ?? false,
      utilityIpc: 'direct real-store transport', scriptedModelOutputs: false, seeded, firstPass, modelCalls, commandCounts: Object.fromEntries(commandCounts),
      mainInitialized, sourceId, loop, final, errors,
      limitations: ['Synthetic independent flat notes; no handwritten aggregate and no answer facts or IDs appended to the original question.',
        'Background autonomous schedulers are disabled to isolate one actual foreground loop; foreground world attention, tools and evidence checks are intact.',
        'Initial passive recall may be incomplete. The independent earlier first-pass failure remains a failure even if active tools recover the story.'],
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}) }, null, 2));
  };
  try {
    const config = await realGlobalChatConfig(root);
    const observedFetch: typeof fetch = async (input, init) => {
      const wire = JSON.parse(String(init?.body ?? '{}')), headers = new Headers(init?.headers);
      const providerRequest = headers.get('authorization') === 'Bearer ' + config.apiKey || headers.get('x-api-key') === config.apiKey || headers.get('x-goog-api-key') === config.apiKey;
      const response = await fetch(input, init);
      const visible = providerRequest && !wire.stream ? await response.clone().json().catch(() => undefined) : undefined;
      let actualPassiveSelection: unknown;
      try { actualPassiveSelection = JSON.parse(wire.messages?.[1]?.content ?? '{}').memoryRecall?.context?.selection; } catch { /* Native focus inputs are not domain JSON. */ }
      modelCalls.push({ providerRequest, status: response.status, stream: wire.stream === true,
        ...(providerRequest ? { actualMessages: wire.messages ?? wire.input, actualPassiveSelection, response: visible, toolNames: wire.tools?.map((tool: { function?: { name: string } }) => tool.function?.name) } : {}) });
      return response;
    };
    store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: '阿澄', description: '合成主动回忆验收', persona: '根据有据记录交流。', model: '', avatar: 'sister', active: true, proactive: false }]);
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    // Keep the same unrelated semantic boundaries as the earlier flat-note
    // probe. Every story part remains a separate original body.
    for (const test of EXTENDED_RECALL_CASES) for (const content of test.sources) {
      const note = store.saveMemory({ ...scope, content, diaryName: test.id === 'dream_is_not_experience' ? '梦境' : '资料', tags: ['合成验收', test.id] });
      seeded.push({ case: test.id, id: note.id, content });
    }
    for (;;) {
      const job = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!job) break;
      store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true });
    }
    files = await canonicalMemoryFiles(root, store, config);
    await files.close(); files = undefined; // Main becomes the only file actor.
    for (let i = 0; i < COMPANION_DIALOGUE_WINDOW.maxMessages + 20; i++) store.appendMessage({ conversationId: conversation.id, authorId: 'user',
      content: '合成无关日常编号' + i + '：本条没有任务请求，也没有新增的故事资料。', replyDirective: 'none' });
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    const future = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString().slice(11, 16);
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: future(240), wakeAt: future(241), meals: [], habits: [] } });
    transport.request = async command => { commandCounts.set(command.type, (commandCounts.get(command.type) ?? 0) + 1); return store!.request(command); };
    transport.fetch = observedFetch;
    native = await realMemoryRuntime(root, undefined, { modelFetch: observedFetch });
    const recall = CompanionMemoryService.prototype.recall;
    vi.spyOn(CompanionMemoryService.prototype, 'recall').mockImplementation(async function (this: CompanionMemoryService, input) {
      const result = await recall.call(this, input);
      if (input.currentMessage.id === sourceId || input.currentMessage.content === story.query) firstPass.push({ query: input.currentMessage.content,
        focused: result.context?.text, checks: story.checks(result.context?.text ?? ''), evidence: result.context?.evidence, selection: result.context?.selection, degraded: result.degraded });
      return result;
    });
    vi.spyOn(CompanionMemoryService.prototype, 'schedule').mockImplementation(() => undefined);
    service = new CompanionService({ userData: root, dataRoot: root, memoryLibraryRoot: path.join(root, 'owner-assets'), appPath: process.cwd(),
      workerPath: 'explicit-real-store-transport', window: () => undefined, hasConfig: () => true, getConfig: () => config,
      memoryRuntime: native.runtime, dsh: () => undefined,
      report: error => errors.push(error instanceof Error ? error.message.split(config.apiKey).join('[redacted]').slice(0, 1500) : String(error)) });
    // Do not script foreground model decisions or tool execution. Isolate the
    // lane by disabling only unrelated periodic background starts.
    const background = service as unknown as Record<string, { start(): void }>;
    for (const name of ['memoryTags', 'schedules', 'activityTasks', 'world']) vi.spyOn(background[name]!, 'start').mockImplementation(() => undefined);
    await service.handle({ type: 'state' }); mainInitialized = true; await save();
    const sent = await service.handle({ type: 'message.send', conversationId: conversation.id, delivery: 'queue', clientId: 'actual-story-question-' + randomUUID(), content: story.query });
    sourceId = sent.message!.id;
    const until = performance.now() + 360000;
    while (performance.now() < until) {
      loop = store.request({ type: 'loop.get', sourceMessageId: sourceId, companionId: 'alice' }).loop;
      if (loop?.status === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (loop?.status !== 'done') throw Error('ACTUAL_MAIN_STORY_NOT_DONE: ' + JSON.stringify({ status: loop?.status, progress: loop?.progress, errors }));
    const answer = loop.messageId ? store.getMessage(loop.messageId).content : '';
    const calls = loop.turns.flatMap(turn => turn.calls), memoryCalls = calls.filter(call => call.name === 'memory');
    const answerChecks = { ...story.checks(answer), ...storyAccountChecks(answer) };
    const originalContext = loop.context ? JSON.parse(loop.context.user) : {};
    const actualDialogue = JSON.stringify(originalContext.messages ?? []);
    const historyLeak = story.sources.some(text => actualDialogue.includes(text));
    const passiveMissingFacts = firstPass.some(result => Object.values(result.checks as Record<string, boolean>).some(value => !value));
    const selectionReachedProvider = modelCalls.some(call => {
      const selection = call.actualPassiveSelection as { kind?: unknown; exhaustive?: unknown } | undefined;
      return selection?.kind === 'ranked_candidates' && selection.exhaustive === false;
    });
    final = { answer, answerChecks, memoryCalls, passiveMissingFacts, selectionReachedProvider, historyLeak, actualInitialContext: loop.context,
      providerRequestCount: modelCalls.filter(call => call.providerRequest).length,
      ledgerRequestCount: store.request({ type: 'model.resources.usage', companionId: 'alice' }).modelResourceUsage?.requests };
    status = Object.values(answerChecks).every(Boolean) && memoryCalls.length > 0 && !historyLeak && selectionReachedProvider ? 'passed' : 'failed'; await save();
    expect(historyLeak).toBe(false);
    expect(selectionReachedProvider).toBe(true);
    expect(passiveMissingFacts, 'Active compensation requires a witnessed incomplete first pass.').toBe(true);
    expect(memoryCalls.length, 'The real model must actually use memory tools, not only give a lucky passive answer.').toBeGreaterThan(0);
    expect(Object.values(answerChecks).every(Boolean), JSON.stringify(answerChecks)).toBe(true);
    expect(final.ledgerRequestCount).toBe(final.providerRequestCount);
  } catch (error) { status = 'failed'; failure = error; throw error; }
  finally { await save(); await service?.shutdown(); await files?.close(); await native?.close(); store?.close(); vi.restoreAllMocks(); await removeOwnedDirectory(root); }
}, 600000);
