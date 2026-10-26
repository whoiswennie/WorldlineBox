import { fork } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionCredentials } from '../../src/main/companions/credentials';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionVcpRuntime } from '../../src/main/companions/vcp-runtime';
import { VcpChatGateway } from '../../src/main/vcp-chat-gateway';
import { generateCompanionText, type CompanionModelConfig } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { Companion } from '../../src/shared/companions';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';
import { companionMemoryIdentity } from '../../src/main/companions/memory-identity';
import { fixtureOwnerRuntimePaths } from '../fixtures/owner-runtime-storage';
import { CompanionAssetIo } from '../../src/main/companions/asset-io';
import { companionModelQuota } from '../../src/main/companions/model-quota';

const ports = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: ports.launch },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() } }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owner-routing fixture cleanup failed.');
});

it('routes actual concurrent native focus through each owner selection and cancels one without retiring its peer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-owner-model-'));
  cleanups.push(async () => {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-native-owner-model-')) throw Error('Unsafe owner-routing fixture cleanup.');
    await removeOwnedDirectory(root);
  });
  const children = new Set<number>(); let peakChildren = 0;
  ports.launch.mockImplementation((file: string) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete environment.NODE_PATH;
    const child = fork(file, [], { execPath: process.execPath, env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.add(child.pid!); peakChildren = Math.max(peakChildren, children.size);
    child.once('exit', () => children.delete(child.pid!));
    return { postMessage: (message: { command?: { type: string; configuration?: { dataRoot: string } } }) => {
      return child.send(message);
    }, on: child.on.bind(child), kill: () => child.kill() };
  });
  const embeddingServer = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk.toString();
    const body = JSON.parse(text) as { input: string[] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: body.input.map((_input, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
  });
  await new Promise<void>(resolve => embeddingServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { await new Promise<void>(resolve => { embeddingServer.close(() => resolve()); embeddingServer.closeAllConnections(); }); });
  const address = embeddingServer.address(); if (!address || typeof address === 'string') throw Error('Missing fixture embedding endpoint.');
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [
    { id: 'alpha', name: 'Alpha', description: '', persona: '保留来源', model: '', avatar: 'sister', active: true, proactive: false,
      llm: { apiFormat: 'anthropic', baseUrl: 'https://alpha.invalid', model: 'owner-selected-alpha' } },
    { id: 'beta', name: 'Beta', description: '', persona: '保留来源', model: '', avatar: 'sister', active: true, proactive: false,
      llm: { apiFormat: 'gemini_native', baseUrl: 'https://beta.invalid', model: 'owner-selected-beta' } },
  ]);
  cleanups.push(async () => { store.close(); });
  const rows = ['alpha', 'beta'].map(owner => {
    const conversation = store.openPrivate(owner), content = `${owner} promised ${owner === 'alpha' ? 'cedar tea' : 'amber coffee'} for the routing experiment.`;
    const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content, replyDirective: 'none' });
    // The test supplies existing journal material. It validates routing and
    // native indexing/focus, independently of model journal extraction quality.
    for (;;) {
      const capture = store.request({ type: 'memory.jobs.claim', companionId: owner }).memoryJob;
      if (!capture) break;
      store.request({ type: 'memory.jobs.complete', id: capture.id, leaseToken: capture.leaseToken, notes: [] });
    }
    const note = store.request({ type: 'memory.record', companionId: owner, conversationId: conversation.id,
      candidate: { content, tags: [owner, 'routing'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] } }).memories![0]!;
    return { owner, conversation, content, note };
  });
  const credentials = new CompanionCredentials(root);
  await credentials.save('alpha', 'alpha-local-fixture-key'); await credentials.save('beta', 'beta-local-fixture-key');
  const globalConfig = vi.fn((): CompanionModelConfig => ({ apiFormat: 'openai_chat', model: 'unconfigured-global', apiKey: '' }));
  // Invoke Main's actual configuration resolver with its real credential store;
  // no Main background subsystems are constructed for this isolated route test.
  const configFor = (companion: Companion): Promise<CompanionModelConfig> => Reflect.apply(
    Reflect.get(CompanionService.prototype, 'configFor'), { resettingCompanions: new Set(), dormantCompanions: new Set(), credentials, options: { getConfig: globalConfig } }, [companion]);
  const gateway = new VcpChatGateway(); cleanups.push(() => gateway.close());
  const calls: Array<{ owner: string; nativeKind: 'focus' | 'timeline'; context: { system: string; user: string }; model: string; url: string; headerKey: string }> = [];
  const disposedOwners: string[] = [];
  const workspaceRoot = path.join(root, 'owner-assets'), vendorRoot = path.resolve('vendor/vcp-memory');
  const profiles = new CompanionAssetProfileStore(workspaceRoot, {
    loadInitialFocusPrompt: () => readFile(path.join(vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8'),
    loadInitialTimelinePrompts: () => loadInitialTimelinePrompts(vendorRoot), loadInitialTagPrompt: async () => 'Synthetic fixture tag instructions.',
  });
  const assetIo = new CompanionAssetIo(); cleanups.push(() => assetIo.close());
  const assetHost = Object.assign(Object.create(CompanionService.prototype), { assetProfiles: profiles, assetIo });
  const prepareAssetContext: CompanionService['prepareModelAssetContext'] = (ownerId, ...args) => Reflect.apply(
    CompanionService.prototype.prepareModelAssetContext, assetHost, [ownerId, ...args]);
  let blockNextAlphaFocus = false, blockedSignal: AbortSignal | undefined;
  let onProvider: ((context: { system: string; user: string }) => Promise<void>) | undefined;
  const runtime = new CompanionVcpRuntime({ resolveOwnerStorage: async ownerId => {
    const owner = store.request({ type: 'state' }).state!.companions.find(owner => owner.id === ownerId)!;
    await profiles.bootstrap(owner); const snapshot = await profiles.load(ownerId);
    return { ownerId, workspaceRoot, ownerRoot: snapshot.root, indexRoot: path.join(snapshot.root, '.认知索引'), ownerPrompts: {
      aimemoTemplate: snapshot.nativeFocusTemplate, timelineTemplate: snapshot.nativeTimelineTemplate, summaryTemplate: snapshot.nativeSummaryTemplate } };
  }, resolveOwnerCleanupStorage: fixtureOwnerRuntimePaths(workspaceRoot), vendorRoot,
    workerPath: path.resolve('src/main/vcp-memory/worker.cjs'), generationProfile: { adapter: 'fixture-generic-text-v1' },
    resolveEmbedding: async () => ({ baseUrl: `http://127.0.0.1:${address.port}/document`, queryBaseUrl: `http://127.0.0.1:${address.port}/query`,
      model: 'controlled-embedding', modelSignature: 'owner-route-test-space', dimension: 4, apiKey: 'local-embedding-fixture' }),
    resolveGenerationPlugins: async ({ ownerId, config }) => {
      const snapshot = Object.freeze({ ...config });
      const route = await gateway.registerOwnerRoute({ ownerId, semanticProfile: { apiFormat: snapshot.apiFormat, model: snapshot.model },
        credential: snapshot.apiKey, generate: (context, signal, work) => generateCompanionText(context,
          { ...snapshot, ownerId, workPriority: work?.priority ?? 'foreground',
            resolveAssetContext: (context, kind) => prepareAssetContext(ownerId, context, kind, work?.nativePrompt) }, signal, { timeoutMs: 15000,
          fetchFn: async (url, init) => {
            // Classify the authenticated native envelope before the live owner
            // resolver fills its empty system slot; template text is editable.
            const nativeFocus = !context.system.trim() && work?.priority === 'foreground';
            const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
            const actualContext = snapshot.apiFormat === 'anthropic' ? { system: body.system, user: body.messages[0].content }
              : { system: body.system_instruction.parts[0].text, user: body.contents[0].parts[0].text };
            expect(body.nativePrompt).toBeUndefined();
            calls.push({ owner: ownerId, nativeKind: nativeFocus ? 'focus' : 'timeline', context: actualContext, model: body.model ?? decodeURIComponent(String(url)), url: String(url),
              headerKey: headers.get(snapshot.apiFormat === 'anthropic' ? 'x-api-key' : 'x-goog-api-key') ?? '' });
            if (calls.length > 20) throw Error('Controlled native route request budget exceeded.');
            await onProvider?.(actualContext);
            if (ownerId === 'alpha' && blockNextAlphaFocus && nativeFocus) {
              blockedSignal = signal;
              return new Promise<Response>((_resolve, reject) => {
                const cancel = () => reject(new Error('Fixture provider operation cancelled.'));
                if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
              });
            }
            const own = rows.find(row => row.owner === ownerId)!;
            const text = nativeFocus
              ? `这是我获取的所有相关知识/记忆[[${own.content}]]` : `${own.content}\nTag: ${ownerId}, routing`;
            return new Response(JSON.stringify(snapshot.apiFormat === 'anthropic' ? { content: [{ type: 'text', text }] }
              : { candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
          } }) });
      return { plugins: { chat: route.chat }, dispose: async () => { disposedOwners.push(ownerId); await route.dispose(); } };
    } });
  cleanups.push(async () => { await runtime.close(); expect(children.size).toBe(0); });
  const report = vi.fn();
  const memory = new CompanionMemoryService({ runtime, cacheRoot: path.join(root, 'views'), configFor, fetchFn: async (url, init) => {
    if (new URL(String(url)).hostname !== '127.0.0.1') throw Error('Unexpected journal model request.');
    return fetch(url, init);
  },
    request: async command => { const response = store.request(command); if (response.worldClock) response.worldClock.backlog = false; return response; },
    changed: () => undefined, report, busy: () => false });
  cleanups.push(() => memory.close());
  memory.schedule(0);
  await vi.waitFor(() => {
    for (const row of rows) expect(store.request({ type: 'memory.snapshot', companionId: row.owner, conversationId: row.conversation.id }).memorySnapshot!.notes.map(note => note.id)).toContain(row.note.id);
  }, { timeout: 30000, interval: 100 });
  const search = (row: typeof rows[number], query = 'routing experiment') => memory.search({ companionId: row.owner, conversationId: row.conversation.id, query }, 'passive');
  const results = await Promise.all(rows.map(row => search(row)));
  for (const [index, result] of results.entries()) {
    expect(result.memoryContext!.text).toContain(rows[index]!.content);
    expect(result.memoryContext!.text).not.toContain(rows[1 - index]!.content);
  }
  for (const owner of ['alpha', 'beta']) {
    const guidance = (await profiles.load(owner)).prompts.vcp_focus_guidance!;
    expect(guidance.trim()).not.toBe('');
    expect(calls.some(call => call.owner === owner && call.nativeKind === 'focus' && call.context.system.includes(guidance))).toBe(true);
  }
  for (const call of calls) {
    expect(call.url).toContain(`${call.owner}.invalid`); expect(call.model).toContain(`owner-selected-${call.owner}`);
    expect(call.headerKey).toBe(`${call.owner}-local-fixture-key`);
    expect(call.context.user).not.toContain(rows.find(row => row.owner !== call.owner)!.content);
  }
  expect(globalConfig).not.toHaveBeenCalled();
  // Edit the actual production profile modules on disk. Every subsequent
  // native call reads its owner files; another owner's modules stay separate.
  let profile = await profiles.load('alpha');
  for (const [purpose, content] of [['vcp_aimemo', 'PROFILE_FOCUS_HOT_ALPHA {{knowledge_base}} {{current_user_prompt}}'],
    ['native_timeline', 'PROFILE_TIMELINE_HOT_ALPHA {{agentName}} {{month}}'], ['native_summary', 'PROFILE_SUMMARY_HOT_ALPHA {{agentName}} {{month}}']]) {
    const module = profile.modules.find(module => module.purposes.includes(purpose!))!;
    profile = await profiles.writePrompt({ companionId: 'alpha', relativePath: module.path, expectedRevision: module.revision, content: content! });
  }
  await search(rows[0]!, 'routing experiment current alpha profile');
  expect(calls.at(-1)!.context.user).toContain('PROFILE_FOCUS_HOT_ALPHA');
  await search(rows[1]!, 'routing experiment current beta profile');
  expect(calls.at(-1)!.context.user).not.toContain('PROFILE_FOCUS_HOT_ALPHA');
  const alpha = store.request({ type: 'state' }).state!.companions.find(owner => owner.id === 'alpha')!;
  const identity = companionMemoryIdentity(alpha), generation = await runtime.acquireGeneration({ ownerId: 'alpha', config: await configFor(alpha) });
  try {
    const scope = { scopeId: 'native-owner-profile-live-timeline' };
    await generation.client.remember(scope, { id: 'profile-live-source', content: rows[0]!.content, tags: ['alpha'], author: identity.agentName, occurredAt: '2026-10-21T12:00:00Z' });
    await generation.client.timeline(scope, { operation: 'generateTimelines', agentName: identity.agentName, owner: identity, options: { startMonth: '2026-10', endMonth: '2026-10' } });
    expect(calls.at(-1)!.context.system).toContain(`PROFILE_TIMELINE_HOT_ALPHA ${identity.agentName} 2026-10`);
    await generation.client.remember(scope, { id: 'profile-previous-month-source', content: 'alpha borrowed a blue umbrella in September.',
      tags: ['alpha'], author: identity.agentName, occurredAt: '2026-09-21T12:00:00Z' });
    await vi.waitFor(() => expect(companionModelQuota.snapshot().active).toBe(0));
    let releaseAdmissions!: () => void;
    const admissions = new Promise<void>(resolve => { releaseAdmissions = resolve; });
    const blockers = Array.from({ length: 4 }, (_, index) => companionModelQuota.run({ ownerId: `native-test-blocker-${index}`,
      connectionId: `native-test-provider-${index}`, priority: 'foreground' }, () => admissions));
    await vi.waitFor(() => expect(companionModelQuota.snapshot().active).toBe(4));
    const liveCallsStart = calls.length;
    const multiMonth = generation.client.timeline(scope, { operation: 'generateTimelines', agentName: identity.agentName, owner: identity,
      options: { startMonth: '2026-09', endMonth: '2026-10', overwrite: true } });
    try {
      await vi.waitFor(() => expect(companionModelQuota.snapshot().queued).toBe(1), { timeout: 15000 });
      let currentProfile = await profiles.load('alpha'), module = currentProfile.modules.find(module => module.purposes.includes('native_timeline'))!;
      await profiles.writePrompt({ companionId: 'alpha', relativePath: module.path, expectedRevision: module.revision,
        content: 'PROFILE_TIMELINE_AFTER_QUEUE_ALPHA {{agentName}} {{month}}' });
      onProvider = async context => {
        if (!context.system.includes('PROFILE_TIMELINE_AFTER_QUEUE_ALPHA')) return;
        currentProfile = await profiles.load('alpha'); module = currentProfile.modules.find(module => module.purposes.includes('native_timeline'))!;
        await profiles.writePrompt({ companionId: 'alpha', relativePath: module.path, expectedRevision: module.revision,
          content: 'PROFILE_TIMELINE_NEXT_MONTH_ALPHA {{agentName}} {{month}}' });
      };
      releaseAdmissions(); await Promise.all(blockers); await multiMonth;
      const monthCalls = calls.slice(liveCallsStart);
      expect(monthCalls).toHaveLength(2);
      expect(monthCalls[0]!.context.system).toContain(`PROFILE_TIMELINE_AFTER_QUEUE_ALPHA ${identity.agentName} 2026-09`);
      expect(monthCalls[1]!.context.system).toContain(`PROFILE_TIMELINE_NEXT_MONTH_ALPHA ${identity.agentName} 2026-10`);
      expect(monthCalls[0]!.context.user).toContain('alpha borrowed a blue umbrella in September.');
      expect(monthCalls[1]!.context.user).toContain(rows[0]!.content);
      expect(monthCalls[1]!.context.system).not.toContain('PROFILE_TIMELINE_AFTER_QUEUE_ALPHA');
    } finally { onProvider = undefined; releaseAdmissions(); await Promise.all(blockers); await multiMonth; }
    const beforeRename = await profiles.load('alpha'), beforeRenameCalls = calls.length;
    await profiles.writeProfile({ companionId: 'alpha', expectedRevision: beforeRename.profileRevision,
      profile: { ...beforeRename.profile, name: 'A different current owner name' } });
    try {
      await expect(generation.client.timeline(scope, { operation: 'generateTimelines', agentName: identity.agentName, owner: identity,
        options: { startMonth: '2026-10', endMonth: '2026-10', overwrite: true } })).rejects.toThrow();
      expect(calls).toHaveLength(beforeRenameCalls);
    } finally {
      const renamed = await profiles.load('alpha');
      await profiles.writeProfile({ companionId: 'alpha', expectedRevision: renamed.profileRevision, profile: beforeRename.profile });
    }
    await generation.client.timeline(scope, { operation: 'generateSummaries', agentName: identity.agentName, owner: identity });
    expect(calls.at(-1)!.context.system).toContain(`PROFILE_SUMMARY_HOT_ALPHA ${identity.agentName} 2026-10`);
    // The task already captured valid files; actual model admission must still
    // reject a role deleted while the request waits in the shared quota.
    await vi.waitFor(() => expect(companionModelQuota.snapshot().active).toBe(0));
    let unblock!: () => void; const held = new Promise<void>(resolve => { unblock = resolve; });
    const queuedBlockers = Array.from({ length: 4 }, (_, index) => companionModelQuota.run({ ownerId: `role-file-blocker-${index}`,
      connectionId: `role-file-provider-${index}`, priority: 'foreground' }, () => held));
    await vi.waitFor(() => expect(companionModelQuota.snapshot().active).toBe(4));
    const beforeMissingRole = calls.length, commonRole = path.join((await profiles.load('alpha')).root, '提示词', '共同.md'), originalRole = await readFile(commonRole, 'utf8');
    const queuedRole = generation.client.timeline(scope, { operation: 'generateTimelines', agentName: identity.agentName, owner: identity,
      options: { startMonth: '2026-10', endMonth: '2026-10', overwrite: true } });
    const rejectedRole = expect(queuedRole).rejects.toThrow();
    try {
      await vi.waitFor(() => expect(companionModelQuota.snapshot().queued).toBe(1), { timeout: 15000 });
      await unlink(commonRole); unblock(); await Promise.all(queuedBlockers); await rejectedRole;
      expect(calls).toHaveLength(beforeMissingRole);
    } finally { unblock(); await Promise.all(queuedBlockers); await writeFile(commonRole, originalRole); await queuedRole.catch(() => undefined); }
  } finally { await generation.release(); }
  expect(disposedOwners).toEqual([]);
  blockNextAlphaFocus = true;
  const cancelled = search(rows[0]!, 'routing experiment cedar tea cancellation');
  const cancelledExpectation = expect(cancelled).rejects.toThrow();
  await vi.waitFor(() => expect(blockedSignal).toBeDefined(), { timeout: 15000, interval: 50 });
  const peer = await search(rows[1]!, 'routing experiment amber coffee unaffected');
  expect(peer.memoryContext!.text).toContain(rows[1]!.content);
  expect(disposedOwners).not.toContain('beta');
  await memory.invalidate('alpha');
  await cancelledExpectation;
  await vi.waitFor(() => expect(blockedSignal!.aborted).toBe(true));
  expect(disposedOwners).toContain('alpha'); expect(disposedOwners).not.toContain('beta');
  expect((await search(rows[1]!, 'routing experiment amber coffee after peer cancellation')).memoryContext!.text).toContain(rows[1]!.content);
  expect(disposedOwners).not.toContain('beta');
  expect(peakChildren).toBeLessThanOrEqual(4);
  const alphaProfile = await profiles.load('alpha'), focusModule = alphaProfile.modules.find(module => module.purposes.includes('vcp_aimemo'))!;
  const staleProjection = path.join(alphaProfile.root, '.认知索引', 'generation', 'a'.repeat(64), 'b'.repeat(64));
  await mkdir(staleProjection, { recursive: true }); await writeFile(path.join(staleProjection, 'synthetic-stale-index'), 'synthetic derived material');
  await unlink(path.join(alphaProfile.root, ...focusModule.path.split('/')));
  await expect(runtime.get({ ownerId: 'alpha' })).rejects.toThrow('不可读取');
  await runtime.purgeOwner('alpha');
  await expect(lstat(staleProjection)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await profiles.load('beta')).nativeFocusTemplate).not.toContain('PROFILE_FOCUS_HOT_ALPHA');
  expect(disposedOwners).not.toContain('beta');
}, 120000);
