import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionMemoryService } from '../../src/main/companions/memory-service';
import { CompanionMemoryProjectionCache } from '../../src/main/companions/memory-projection-cache';
import { projectCompanionMemoryContextForModel } from '../../src/main/companions/memory-model-context';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryNote, VcpMemoryScope } from '../../src/main/vcp-memory/contracts';
import type { Companion, CompanionMemory } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { controlledMemoryRuntime } from '../fixtures/controlled-memory-runtime';
import { companionMemoryTypeScope } from '../../src/main/companions/memory-type-scope';
import { companionAgentRunSchema } from '../../src/shared/companion-agent-run';
import { activityPassiveRecallSchema } from '../../src/shared/companion-activity-task';
import { companionSocialRecallSchema } from '../../src/shared/companion-social-reply';

const cleanup: Array<{ root: string; close(): Promise<void> }> = [];
afterEach(async () => { for (const item of cleanup.splice(0)) { await item.close();
  if (path.dirname(item.root) !== path.resolve(tmpdir()) || !path.basename(item.root).startsWith('companion-type-scope-')) throw new Error('Unsafe fixture cleanup');
  await rm(item.root, { recursive: true, force: true }); } });
const at = '2026-10-28T10:00:00.000Z';
it('T-024 preserves one typed recall contract across durable actor, activity and social boundaries', () => {
  const context = { text: '本人暂定认识', revision: 'exact', profileKey: 'embedding-profile', typeScope: companionMemoryTypeScope('self') };
  expect(companionAgentRunSchema.shape.passiveRecall.parse({ prepared: true, context })?.context).toEqual(context);
  expect(activityPassiveRecallSchema.parse({ prepared: true, context }).context).toEqual(context);
  expect(companionSocialRecallSchema.parse({ reasons: [], pending: false, degraded: false, context }).context).toEqual(context);
  expect(companionSocialRecallSchema.safeParse({ reasons: [], pending: false, degraded: false,
    context: { ...context, typeScope: { ...context.typeScope, contentKinds: ['episode_memory'] } } }).success).toBe(false);
});
const owner: Companion = { id: 'alice', name: 'Alice', description: '', persona: '创建人格', model: '', avatar: 'sister', proactive: false, builtin: false, active: true, createdAt: at };
const note = (artifactKind: CompanionMemory['artifactKind']): CompanionMemory => ({ artifactKind, id: artifactKind, companionId: owner.id, scopeId: 'scope',
  content: `CANARY_${artifactKind}`, tags: [], diaryName: '所有类型故意同名', sourceConversationId: 'room', sourceSequence: 1,
  sources: [{ messageId: 'raw', conversationId: 'room', sequence: 1, authorId: owner.id, revision: 1, checksum: 'a'.repeat(64), createdAt: at }],
  status: 'indexed', version: 1, contentRevision: 1, captureMethod: 'automatic', origin: 'companion', createdAt: at, updatedAt: at });
class TypedFixtureClient extends VcpMemoryClient {
  override readonly supportsDetachedRecall = false;
  readonly fixtureScopes = new Map<string, VcpMemoryNote[]>();
  constructor(root: string) { super({ dataRoot: root, vendorRoot: 'unused', workerPath: 'unused', embedding: { model: 'fixture', dimension: 8, apiKey: 'fixture', baseUrl: 'http://127.0.0.1/unused' } }); }
  override replace = vi.fn(async (scope: VcpMemoryScope, notes: readonly VcpMemoryNote[]) => { this.fixtureScopes.set(scope.scopeId, structuredClone([...notes])); return { replaced: true as const, count: notes.length }; });
  override search = vi.fn(async (scope: VcpMemoryScope) => ({ results: (this.fixtureScopes.get(scope.scopeId) ?? []).map(value => ({ ...value, sourceFile: value.id + '.md', score: 1, engine: 'river' as const })), diagnostics: {}, degraded: false }));
  override pluginCall = vi.fn(async (scope: VcpMemoryScope) => ({ result: (this.fixtureScopes.get(scope.scopeId) ?? []).map(value => value.content).join('\n'), indexed: true }));
  override capabilities = vi.fn(async () => ({ plugins: {}, timelineGenerationConfigured: false, coldKnowledge: false }));
  override purgeScope = vi.fn(async (scope: VcpMemoryScope) => { this.fixtureScopes.delete(scope.scopeId); });
  override interruptScope = vi.fn(async () => undefined);
  override close = vi.fn(async () => undefined);
}

it('T-024/T-039 builds separate typed VCP views before native search or focus even if a port returns a mixed snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-type-scope-')), client = new TypedFixtureClient(root);
  const notes = ['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'].map(kind => note(kind as CompanionMemory['artifactKind']));
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    switch (command.type) {
      case 'state': return { ok: true, state: { companions: [owner], conversations: [], activities: [], configured: true } };
      case 'memory.snapshot': return { ok: true, memorySnapshot: { scopeId: 'scope', revision: 'fixed', semanticRevision: 'fixed-semantic', revocationEpoch: 0, notes: structuredClone(notes) } };
      case 'memory.outbox.pending': return { ok: true, memoryOutboxPending: false };
      case 'memory.lifecycle.state': return { ok: true, memoryLifecycleState: { companionId: owner.id, ledgerSequence: 1, revocationEpoch: 0 } };
      case 'memory.records.filter': return { ok: true, memories: notes.filter(value => command.ids.includes(value.id)) };
      case 'world.clock': return { ok: true, worldClock: { realNow: at, virtualNow: at, timeZone: 'Asia/Shanghai', mode: 'realtime', speed: 1, backlog: false } };
      default: return { ok: true };
    }
  });
  const fetchFn = vi.fn<typeof fetch>(), service = new CompanionMemoryService({ request, configFor: async () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture' }),
    runtime: controlledMemoryRuntime({ get: async () => ({ client, profileKey: 'typed-fixture' }), close: async () => undefined }), fetchFn,
    changed: () => undefined, report: vi.fn(), busy: () => true });
  cleanup.push({ root, close: () => service.close() });
  const facts = await service.search({ companionId: owner.id, conversationId: 'room', query: '相关回忆' });
  expect(facts.memoryPage!.items.map(hit => hit.memory.artifactKind).sort()).toEqual(['episode_memory', 'knowledge', 'procedure']);
  expect(facts.memoryContext!.text).not.toContain('self_understanding'); expect(facts.memoryContext!.text).not.toContain('dream_fiction');
  expect(facts.memoryContext!.typeScope?.consumer).toBe('facts');
  const self = await service.search({ companionId: owner.id, conversationId: 'room', query: '我有哪些有条件认识', retrievalScope: 'self' });
  expect(self.memoryPage!.items.map(hit => hit.memory.artifactKind)).toEqual(['self_understanding']);
  expect(self.memoryContext!.text).toContain('self_understanding'); expect(self.memoryContext!.typeScope?.meaning).toContain('主观');
  const fiction = await service.search({ companionId: owner.id, conversationId: 'room', query: '联想', retrievalScope: 'dream' });
  expect(fiction.memoryPage!.items.map(hit => hit.memory.artifactKind)).toEqual(['dream_fiction']); expect(fiction.memoryContext!.typeScope?.meaning).toContain('虚构');
  const seenDomains = client.replace.mock.calls.map(([, values]) => new Set(values.map(value => value.metadata?.hostArtifactKind)));
  expect(seenDomains.every(domain => !(domain.has('dream_fiction') && domain.size > 1) && !(domain.has('self_understanding') && domain.size > 1))).toBe(true);
  expect(fetchFn).not.toHaveBeenCalled();
  const projected = JSON.parse(projectCompanionMemoryContextForModel({ system: '', user: JSON.stringify({ memoryContext: self.memoryContext }) }).user);
  expect(projected.memoryContext.typeScope.meaning).toContain('主观');
});

it('T-014/T-024 rejects a mismatched type in a metadata projection and never labels it as facts', async () => {
  const state = { companionId: 'alice', sequence: 1, floorSequence: 0, revocationEpoch: 0, resetRevision: 0, externalVersion: 1, generation: 0 };
  const cache = new CompanionMemoryProjectionCache(async command => {
    if (command.type === 'memory.projection.state') return { ok: true, memoryProjectionState: state };
    if (command.type === 'memory.projection.page') { const { content: _content, ...metadata } = note('dream_fiction'); void _content;
      return { ok: true, memoryProjectionPage: { state, notes: [{ ...metadata, bodyFingerprint: 'b'.repeat(64), projectionFingerprint: 'c'.repeat(64), notBeforeSequence: 1 }], removedIds: [], hasMore: false } }; }
    return { ok: true };
  });
  await expect(cache.acquire({ companionId: 'alice', conversationId: 'room', contentKinds: ['episode_memory', 'knowledge', 'procedure'] })).rejects.toThrow('内容类型');
  expect(companionMemoryTypeScope('self').contentKinds).toEqual(['self_understanding']); cache.clear();
});
