import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { CompanionService } from '../../src/main/companions/service';
import { CompanionCredentials } from '../../src/main/companions/credentials';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { CompanionModelConfig } from '../../src/main/companions/model';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { AssetSummary } from '../../src/shared/asset-types';

const transport = vi.hoisted(() => ({ request: vi.fn<(command: CompanionStorageCommand) => Promise<CompanionStorageResponse>>(),
  close: vi.fn(async () => undefined), fetch: vi.fn<typeof fetch>() }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined; request = transport.request; close = transport.close;
} }));
vi.mock('electron', () => ({ net: { fetch: transport.fetch }, ipcMain: { handle: vi.fn() }, protocol: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString() } }));

const roots: string[] = [], stores = new Set<CompanionsStore>(), services = new Set<CompanionService>();
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime('2026-10-24T12:00:00Z');
  transport.fetch.mockImplementation(async () => { throw Error('Unexpected model request during configuration-only reading admission.'); });
});
afterEach(async () => {
  for (const service of services) { const closing = service.shutdown(); await vi.advanceTimersByTimeAsync(1000); await closing; }
  services.clear(); for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-learning-owner-config-')) throw Error('Unexpected learning configuration test directory.');
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
});
const seed = (id: string, llm?: CompanionSeed['llm']): CompanionSeed => ({ id, name: id, description: '', persona: '阅读资料不等于已经学会。',
  model: '', avatar: 'sister', proactive: false, active: true, ...(llm ? { llm } : {}) });
const globalConfig = (apiKey = ''): CompanionModelConfig => ({ apiFormat: 'openai_chat', baseUrl: 'https://global.invalid', model: 'chosen-global-model', apiKey });
async function fixture(seeds: CompanionSeed[], global: CompanionModelConfig, keys: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-learning-owner-config-')); roots.push(root);
  const dataRoot = path.join(root, 'companions'), store = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), seeds); stores.add(store);
  const settings = store.request({ type: 'world.snapshot' }).world!.settings;
  store.request({ type: 'world.configure', expectedRevision: settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  for (const owner of seeds) {
    const conversation = store.openPrivate(owner.id), scope = { companionId: owner.id, conversationId: conversation.id };
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '01:00', meals: [], habits: [] } });
    const world = store.request({ type: 'world.snapshot' }).world!;
    const computer = world.scenes.find(scene => scene.ownerId === owner.id)!.objects.find(object => object.kind === 'computer')!;
    store.request({ type: 'world.tool', ...scope, arguments: { action: 'move', destinationId: computer.id } });
  }
  vi.setSystemTime(Date.now() + 10_000); store.request({ type: 'world.tick' });
  // Routine/position setup is unrelated fixture history. Settle only those
  // pre-existing capture jobs before creating any learning grant or service.
  for (const owner of seeds) for (;;) {
    const job = store.request({ type: 'memory.jobs.claim', companionId: owner.id }).memoryJob;
    if (!job) break;
    store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
  }
  const credentials = new CompanionCredentials(dataRoot);
  for (const [id, key] of Object.entries(keys)) await credentials.save(id, key);
  const item = { assetId: 'actual-asset', displayName: '已授权原文.md', currentRevisionId: 'revision', relativeFilePath: 'source.md', mediaType: 'text' } as AssetSummary;
  const assets = { catalog: vi.fn(async () => []), grant: vi.fn(async () => ({ libraryName: '实际授权库', libraryPath: root })),
    page: vi.fn<CompanionLearningAssets['page']>(async () => ({ assets: [item], hasMore: false })),
    read: vi.fn<CompanionLearningAssets['read']>(async grant => {
      const content = `${grant.companionId} 实际读到的授权资料，不代表已经学会。`;
      return { content, revisionId: item.currentRevisionId + '_' + createHash('sha256').update(Buffer.from(content)).digest('hex').slice(0, 20), truncated: false };
    }) };
  transport.request.mockImplementation(async command => store.request(command));
  transport.close.mockImplementation(async () => undefined);
  // Persist the real automatic grant before Main starts; only Main's production timer may claim it.
  for (const owner of seeds) store.request({ type: 'learning.grant', companionId: owner.id, libraryId: 'library', libraryName: '实际授权库', libraryPath: root,
    autonomous: true, intervalMinutes: 30 });
  const report = vi.fn(), getConfig = vi.fn(() => global);
  const service = new CompanionService({ userData: root, workerPath: 'mocked-worker', learningAssets: assets,
    window: () => undefined, getConfig, hasConfig: () => !!global.apiKey.trim(), dsh: () => undefined, report,
    memoryLibraryRoot: path.join(root, 'cognition', '伙伴记忆') }); services.add(service);
  await service.handle({ type: 'state' });
  return { store, service, assets, report, getConfig };
}
const learning = (store: CompanionsStore, owner: string) => store.request({ type: 'learning.status', companionId: owner }).learning!;
async function automaticTick() { await vi.advanceTimersByTimeAsync(1000); }
async function expectRead(f: Awaited<ReturnType<typeof fixture>>, owner: string) {
  try { await vi.waitFor(() => expect(learning(f.store, owner).reads).toHaveLength(1), { timeout: 15000 }); }
  catch (error) {
    throw new Error(JSON.stringify({ owner, learning: learning(f.store, owner),
      actor: f.store.request({ type: 'world.snapshot' }).world!.actors.find(actor => actor.companionId === owner),
      reports: f.report.mock.calls.map(([value]) => value instanceof Error ? value.message : String(value)),
      commands: transport.request.mock.calls.slice(-15).map(([command]) => command.type) }), { cause: error });
  }
}

it.each(['anthropic', 'gemini_native', 'openai_responses'] as const)('automatically reads using the actual owner %s override while the global model has no key', async apiFormat => {
  const f = await fixture([seed('alice', { apiFormat, baseUrl: 'https://owner.invalid', model: 'owner-selected-model' })], globalConfig(), { alice: 'owner-private-test-key' });
  expect(f.assets.page).not.toHaveBeenCalled(); await automaticTick();
  await expectRead(f, 'alice');
  expect(f.assets.read.mock.calls[0]![0].companionId).toBe('alice');
  expect(learning(f.store, 'alice').grants[0]).toMatchObject({ autonomous: true, reads: 1 });
  const capture = f.store.request({ type: 'memory.jobs.claim', companionId: 'alice' }).memoryJob!;
  expect(capture.sourceMessageIds).toContain(learning(f.store, 'alice').reads[0]!.sourceMessageId);
  expect(transport.request.mock.calls.some(([command]) => command.type === 'learning.run')).toBe(false);
  expect(f.getConfig).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled();
});

it('keeps an owner without any model credentials waiting before reading or creating evidence', async () => {
  const f = await fixture([seed('alice')], globalConfig()); await automaticTick();
  await vi.waitFor(() => expect(learning(f.store, 'alice').grants[0]).toMatchObject({ status: 'waiting' }));
  expect(f.assets.page).not.toHaveBeenCalled(); expect(f.assets.read).not.toHaveBeenCalled();
  expect(learning(f.store, 'alice').reads).toEqual([]);
  expect(transport.request.mock.calls.some(([command]) => command.type === 'learning.commit')).toBe(false);
  expect(transport.fetch).not.toHaveBeenCalled();
});

it('does not borrow another owner override or credentials for an automatic reading job', async () => {
  const f = await fixture([seed('alice', { apiFormat: 'anthropic', baseUrl: 'https://alice.invalid', model: 'alice-model' }),
    seed('bob', { apiFormat: 'gemini_native', baseUrl: 'https://bob.invalid', model: 'bob-model' })], globalConfig(), { alice: 'alice-only-key' });
  await automaticTick();
  await expectRead(f, 'alice');
  await vi.waitFor(() => expect(learning(f.store, 'bob').grants[0]).toMatchObject({ status: 'waiting' }));
  expect(f.assets.page.mock.calls.map(([grant]) => grant.companionId)).toEqual(['alice']);
  expect(f.assets.read.mock.calls.map(([grant]) => grant.companionId)).toEqual(['alice']);
  expect(learning(f.store, 'bob').reads).toEqual([]); expect(f.getConfig).not.toHaveBeenCalled(); expect(transport.fetch).not.toHaveBeenCalled();
});

it('uses a configured global fallback only for owners without an explicit override', async () => {
  const f = await fixture([seed('alice'), seed('bob', { apiFormat: 'anthropic', baseUrl: 'https://bob.invalid', model: 'bob-model' })], globalConfig('global-key'));
  await automaticTick();
  await expectRead(f, 'alice');
  await vi.waitFor(() => expect(learning(f.store, 'bob').grants[0]).toMatchObject({ status: 'waiting' }));
  expect(f.getConfig).toHaveBeenCalled(); expect(f.assets.read.mock.calls.map(([grant]) => grant.companionId)).toEqual(['alice']);
  expect(learning(f.store, 'bob').reads).toEqual([]); expect(transport.fetch).not.toHaveBeenCalled();
});
