import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { appendCompanionMessageSchema } from '../../src/shared/companion-storage';
import { companionHostBehaviorMatches } from '../../src/shared/companion-host-behavior';
import { CompanionAssetProfileStore, projectCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { CompanionMemoryLibrary } from '../../src/main/companions/memory-library';
import { CompanionMemorySourceFiles } from '../../src/main/companions/memory-source-files';
import { CompanionMemoryHistoryFiles } from '../../src/main/companions/memory-history-files';
import { CompanionGrowthService, validateCompanionPersonaPublication } from '../../src/main/companions/growth-service';
import type { generateCompanionStructured } from '../../src/main/companions/model';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';

afterEach(() => vi.useRealTimers());

it('T-014/T-018 attests actual owner virtual behavior, grows a private conditional habit and rejects forged, revised and foreign evidence', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-14T10:00:00Z');
  const root = await mkdtemp(path.join(tmpdir(), 'companion-host-behavior-')), filename = path.join(root, 'messages.sqlite');
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-host-behavior-')) throw new Error('Unexpected fixture cleanup');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '',
    persona: '我愿意按准确来源理解事情。\n\n我仍会保留不确定性。', model: '', avatar: 'sister', active: true, proactive: true })));
  const requestStorage = async (command: CompanionStorageCommand) => store.request(command);
  const profiles: CompanionAssetProfileStore = new CompanionAssetProfileStore(path.join(root, 'owners'), { registryStorage: { request: requestStorage },
    validatePersonaPublication: proposal => validateCompanionPersonaPublication(proposal, { profiles, requestStorage }) });
  const library = new CompanionMemoryLibrary({ libraryDirectory: path.join(root, 'owners'), profileStore: profiles, request: requestStorage });
  const sources = new CompanionMemorySourceFiles({ library }), history = new CompanionMemoryHistoryFiles({ library });
  const growth: CompanionGrowthService[] = [];
  try {
    const privateRoom = store.openPrivate('alice').id, scope = { companionId: 'alice', conversationId: 'world_alice' };
    const owner = store.state().companions.find(role => role.id === 'alice')!, initial = await profiles.bootstrap(owner);
    await profiles.bootstrap(store.state().companions.find(role => role.id === 'bob')!);
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    for (const id of ['alice', 'bob']) {
      const room = store.openPrivate(id).id, routine = store.request({ type: 'routine.get', companionId: id, conversationId: room }).routine!;
      store.request({ type: 'routine.configure', companionId: id, conversationId: room, expectedRevision: routine.revision,
        patch: { timeZone: 'UTC', sleepAt: '23:00', wakeAt: '07:00', meals: [], habits: [] } });
      for (const rule of store.request({ type: 'life-rule.list', companionId: id }).lifeRules!) store.request({ type: 'life-rule.remove', companionId: id, id: rule.id, expectedRevision: rule.revision });
    }
    for (;;) { const job = store.request({ type: 'memory.jobs.claim', force: true }).memoryJob; if (!job) break;
      store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] }); }
    store.request({ type: 'life-rule.create', companionId: 'alice', rule: { title: '合成散步验证', enabled: true, startMinute: 600, endMinute: 610,
      probability: 1, checkIntervalMinutes: 1, action: 'park_walk', durationMinutes: 35 } });
    const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; };
    advance(61000); store.request({ type: 'life-event.tick' });
    let occurrence = store.request({ type: 'life-event.claim' }).lifeOccurrence;
    for (let attempt = 0; attempt < 4 && !occurrence; attempt++) { advance(61000); occurrence = store.request({ type: 'life-event.claim' }).lifeOccurrence; }
    expect(occurrence).toBeDefined(); store.request({ type: 'life-event.complete', id: occurrence!.id, leaseToken: occurrence!.leaseToken! });
    let completed = advance(15000).events.find(event => event.kind === 'park_walk_complete');
    for (let step = 0; step < 160 && !completed; step++) completed = advance(15000).events.find(event => event.kind === 'park_walk_complete');
    expect(completed).toBeDefined();
    const job = store.request({ type: 'memory.jobs.claim', force: true, companionId: 'alice' }).memoryJob!, raw = store.getMessage(job.sourceMessageIds[0]!);
    expect(raw.hostBehavior).toMatchObject({ actorId: 'alice', ownerId: 'alice', sourceId: raw.id, sourceRevision: 1, eventId: completed!.id, realm: 'virtual_world',
      audienceIds: ['world_alice', privateRoom] });
    expect(companionHostBehaviorMatches('bob', raw)).toBeUndefined();
    expect(appendCompanionMessageSchema.safeParse({ conversationId: 'world_alice', authorId: 'system', kind: 'notice', content: raw.content, hostBehavior: raw.hostBehavior }).success).toBe(false);
    const forged = store.appendMessage({ conversationId: 'world_alice', authorId: 'system', kind: 'notice', content: raw.content, replyDirective: 'none' });
    expect(store.getMessage(forged.id).hostBehavior).toBeUndefined();
    const episode = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ artifactKind: 'episode_memory', content: completed!.text,
      sourceMessageIds: [raw.id], evidence: [{ sourceMessageId: raw.id, quote: completed!.text }], tags: ['虚拟散步'] }] }).memories![0]!;
    const statement = '我愿意在虚拟生活中尝试用短暂散步整理关注。', qualification = '这只反映本次实际完成的虚拟生活行为，不证明现实身体经验或已经养成稳定习惯。';
    const candidate = { artifactKind: 'self_understanding' as const, content: statement + qualification, sourceMessageIds: [raw.id],
      evidence: [{ sourceMessageId: raw.id, quote: completed!.text }], relatedMemoryIds: [episode.id],
      selfDevelopment: { kind: 'habit' as const, topic: '虚拟生活中的散步', statement, basis: 'reflection' as const, qualification } };
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, selfDevelopment: { ...candidate.selfDevelopment, basis: 'self_expression' } } })).toThrow('本人');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, sourceMessageIds: [forged.id], evidence: [{ sourceMessageId: forged.id, quote: completed!.text }] } })).toThrow();
    expect(() => store.request({ type: 'memory.record', companionId: 'bob', conversationId: 'world_bob', candidate })).toThrow();
    const understanding = store.request({ type: 'memory.record', ...scope, candidate }).memories![0]!;
    for (;;) { const outbox = store.request({ type: 'memory.outbox.claim', companionId: 'alice' }).memoryOutbox; if (!outbox) break;
      store.request({ type: 'memory.outbox.complete', id: outbox.id, leaseToken: outbox.leaseToken, indexed: true }); }
    while ((await sources.flush('alice')).pending) { /* exact source */ } while ((await history.flush('alice')).pending) { /* exact current and history bodies */ }
    const registry = await profiles.artifacts('alice'), sourceArtifact = await registry.get(`source:${raw.id}:r1`);
    expect(sourceArtifact?.visibility).toEqual({ scope: 'audience', audienceIds: ['world_alice', privateRoom] });
    const fragment = initial.personaFragments.fragments[0]!, text = '我愿意按准确来源理解事情；在虚拟生活中，也愿意有条件地尝试短暂散步整理关注。';
    const generate = vi.fn<typeof generateCompanionStructured>().mockResolvedValue({ decisions: [{ action: 'qualify', fragmentId: fragment.fragmentId,
      expectedHash: fragment.contentHash, text, supportingNoteIds: [understanding.id], reason: '实际已完成的虚拟散步提供一次有条件实践依据。',
      applicableBehavior: '虚拟生活任务间隙尝试短暂散步。', reevaluateWhen: '后续虚拟生活反馈不适用时重新核查。' }], noChangeReason: '' });
    const service = new CompanionGrowthService({ profiles, requestStorage, getConfig: () => ({ apiFormat: 'openai_chat', model: 'fixture', apiKey: 'synthetic' }), generateStructured: generate, report: vi.fn() }); growth.push(service);
    expect((await service.runOnce(scope)).status).toBe('published');
    const current = await profiles.load('alice'); expect(projectCompanionAssetProfile(current, [privateRoom]).persona).toContain('短暂散步');
    expect(projectCompanionAssetProfile(current, ['unrelated_group']).persona).not.toContain('短暂散步'); expect(generate).toHaveBeenCalledTimes(1);
    const sql = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename);
    try {
      const saved = sql.prepare('SELECT data FROM companion_world_events WHERE id=?').get(completed!.id) as { data: string };
      const altered = { ...JSON.parse(saved.data), text: '已发生事件的内容被外部改变。' };
      sql.prepare('UPDATE companion_world_events SET data=? WHERE id=?').run(JSON.stringify(altered), completed!.id);
      expect(store.getMessage(raw.id).hostBehavior).toBeUndefined();
      expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: candidate.content + '事件已改变，不能冒认旧行为。' } })).toThrow();
      sql.prepare('UPDATE companion_world_events SET data=? WHERE id=?').run(saved.data, completed!.id);
      expect(store.getMessage(raw.id).hostBehavior?.eventId).toBe(completed!.id);
      sql.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(raw.id);
    } finally { sql.close(); }
    expect(store.getMessage(raw.id).hostBehavior).toBeUndefined();
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: candidate.content + '改版后不能重用旧行为凭证。' } })).toThrow();
    store.request({ type: 'memory.forget', ...scope, sourceMessageIds: [raw.id] });
    while ((await sources.flush('alice')).pending) { /* revoke source closure */ }
    expect((await profiles.load('alice')).profile.persona).not.toContain('短暂散步');
  } finally {
    for (const service of growth) await service.close(); await library.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
