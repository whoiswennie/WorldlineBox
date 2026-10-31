import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionWorldJob } from '../../src/shared/companion-world';

const roots: string[] = [], stores = new Set<CompanionsStore>();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-24T02:00:00Z'); vi.spyOn(Math, 'random').mockReturnValue(.99); });
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-maintenance-readsets-')) throw Error('Unexpected cleanup'); rmSync(root, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-maintenance-readsets-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite');
  const store = new CompanionsStore(filename, ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '认真', model: '', avatar: 'sister' as const, active: true, proactive: false }))); stores.add(store);
  const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id }, world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); return store.request({ type: 'world.tick', snapshot: true }).world!; };
  const cycle = (asleep: boolean) => { const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    // This suite isolates readset rotation across eligible deep passes; the
    // independent lifecycle suite verifies the production six-hour gate.
    if (asleep) { const scheduling = new (BetterSqlite3 as unknown as { new(filename: string): CompanionConnection })(filename);
      try { scheduling.prepare("UPDATE companion_memory_maintenance_owners SET data=json_set(data,'$.lastDecisionAt',?) WHERE companion_id=?")
        .run(Date.now() - 7 * 3600000, scope.companionId); } finally { scheduling.close(); } }
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', sleepAt: asleep ? '01:00' : '23:00', wakeAt: asleep ? '07:00' : '01:00', meals: [], habits: [] } });
    advance(10000); const result = advance(6000); expect(result.actors.find(actor => actor.companionId === 'alice')?.activity === 'sleeping').toBe(asleep); };
  const original = (content: string, room = scope.conversationId, owner = 'alice', sourceRevision = 1) => {
    const source = store.appendMessage({ conversationId: room, authorId: 'user', content, replyDirective: 'none' });
    if (sourceRevision !== 1) {
      // Coherent imported same-text revision fixture; there is no public UI edit
      // port in this test. Claim/complete/index below remain the real APIs.
      const db = new (BetterSqlite3 as unknown as { new(filename: string): CompanionConnection })(filename);
      try { db.transaction(() => {
        db.prepare('UPDATE messages SET revision=? WHERE id=?').run(sourceRevision, source.id);
        db.prepare('UPDATE vcp_capture_jobs SET source_revision=? WHERE message_id=?').run(sourceRevision, source.id);
      }).immediate(); } finally { db.close(); }
    }
    let job = store.request({ type: 'memory.jobs.claim', force: true, companionId: owner }).memoryJob!;
    // A group source also legitimately queued Bob's separate capture. Settle
    // that unrelated controlled empty output before selecting his private one.
    for (let skipped = 0; !job.sourceMessageIds.includes(source.id) && skipped < 20; skipped++) {
      store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [] });
      job = store.request({ type: 'memory.jobs.claim', force: true, companionId: owner }).memoryJob!;
    }
    expect(job.sourceMessageIds).toContain(source.id);
    const memory = store.request({ type: 'memory.jobs.complete', id: job.id, leaseToken: job.leaseToken, notes: [{ artifactKind: 'episode_memory' as const, content, tags: ['实际来源'], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: content }] }] }).memories![0]!;
    for (;;) { const entry = store.request({ type: 'memory.outbox.claim' }).memoryOutbox; if (!entry) break; store.request({ type: 'memory.outbox.complete', id: entry.id, leaseToken: entry.leaseToken, indexed: true }); }
    expect(memory.captureMethod).toBe('automatic'); return { source, memory };
  };
  const claim = () => { const job = store.request({ type: 'world.job.claim', kind: 'dream', excludedCompanionIds: ['bob'] }).worldJob!; expect(job).toBeDefined(); return job; };
  const bind = (job: CompanionWorldJob) => {
    const ids = [...new Set([...job.sourceMemoryIds, ...(job.maintenanceMemoryIds ?? [])])];
    const memories = ids.map(id => store.request({ type: 'memory.read', ...scope, id }).memoryRead!.memory);
    store.request({ type: 'world.job.bind-memories', id: job.id, leaseToken: job.leaseToken!, memoryVersions: memories.map(note => ({ id: note.id, version: note.version })) }); return memories;
  };
  const complete = (job: CompanionWorldJob) => { const memories = bind(job), reviewed = memories.filter(note => (job.maintenanceMemoryIds ?? job.sourceMemoryIds).includes(note.id));
    store.request({ type: 'world.job.complete', stage: 'real', id: job.id, leaseToken: job.leaseToken!, sourceMemoryIds: memories.map(note => note.id),
      ...(reviewed.length >= 2 ? { maintenance: { decision: 'defer', reason: '受控存储协议夹具：本轮保留原文，不声称真实语义判断。', reviewedMemoryVersions: reviewed.map(note => ({ id: note.id, version: note.version })) } } : {}) }); };
  const database = () => new (BetterSqlite3 as unknown as { new(filename: string): CompanionConnection })(filename);
  return { root, filename, store, scope, cycle, original, claim, bind, complete, database };
}

it('keeps old maintenance atoms outside reflection seeds and rejects their withdrawal before the actual complete transaction', () => {
  const f = fixture(), a = f.original('第一批真实原始经历。'); f.cycle(true); const first = f.claim(); f.complete(first); f.cycle(false);
  const b = f.original('第二批同域补充经历。'); f.cycle(true); const second = f.claim();
  expect(second.sourceMemoryIds).toEqual([b.memory.id]); expect(second.maintenanceMemoryIds?.sort()).toEqual([a.memory.id, b.memory.id].sort());
  const memories = f.bind(second); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [a.source.id] });
  expect(() => f.store.request({ type: 'world.job.complete', stage: 'real', id: second.id, leaseToken: second.leaseToken!, sourceMemoryIds: memories.map(note => note.id),
    maintenance: { decision: 'defer', reason: '已撤回旧依赖，不能结算。', reviewedMemoryVersions: memories.map(note => ({ id: note.id, version: note.version })) } })).toThrow('租约已失效');
  expect(f.store.request({ type: 'world.job.check', id: second.id, leaseToken: second.leaseToken! }).worldJob).toBeUndefined();
  expect(f.store.getMessage(a.source.id).content).toBe(a.source.content);
  expect(f.store.getMessage(b.source.id).content).toBe(b.source.content);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: b.memory.id }).memoryRead!.memory.archivedAt).toBeUndefined();
});

it('rotates at least thirteen deferred old originals and advances past an invalid old source without exceeding twelve maintenance atoms', () => {
  const f = fixture(), old = Array.from({ length: 13 }, (_, index) => f.original('待维护旧原始资料 ' + index));
  f.cycle(true); f.complete(f.claim()); f.cycle(false); f.cycle(true); f.complete(f.claim()); f.cycle(false);
  const db = f.database(); try {
    // Controlled stored-source corruption: a legitimate admission must skip it,
    // and the pure scheduling cursor must still advance past this actual row.
    db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.sources[0].checksum',?) WHERE id=?").run('0'.repeat(64), old[0]!.memory.id);
    db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.sources[0].revision',999) WHERE id=?").run(old[1]!.memory.id);
  } finally { db.close(); }
  const seen = new Set<string>();
  for (let round = 0; round < 3; round++) {
    const fresh = f.original('后续实际新来源 ' + round); f.cycle(true); const job = f.claim();
    expect(job.sourceMemoryIds).toEqual([fresh.memory.id]); expect(job.maintenanceMemoryIds!.length).toBeLessThanOrEqual(12);
    expect(job.maintenanceMemoryIds).not.toContain(old[0]!.memory.id);
    expect(job.maintenanceMemoryIds).not.toContain(old[1]!.memory.id);
    for (const id of job.maintenanceMemoryIds!) seen.add(id); f.complete(job); f.cycle(false);
  }
  for (const entry of old.slice(2)) expect(seen.has(entry.memory.id)).toBe(true);
  expect(seen.has(old[12]!.memory.id)).toBe(true);
});

it('does not advance an old-original cursor when twelve fresh reflection seeds already fill the maintenance budget', () => {
  const f = fixture(); f.original('已审旧来源'); f.cycle(true); f.complete(f.claim()); f.cycle(false);
  const db = f.database(), key = 'world-maintenance-original-cursor/' + createHash('sha256').update(JSON.stringify(['alice', f.scope.conversationId])).digest('hex');
  let before: unknown; try { before = db.prepare('SELECT value FROM metadata WHERE key=?').get(key); } finally { db.close(); }
  const fresh = Array.from({ length: 12 }, (_, index) => f.original('满批新原始来源 ' + index)); f.cycle(true); const job = f.claim();
  expect(job.maintenanceMemoryIds?.sort()).toEqual(fresh.map(note => note.memory.id).sort());
  const after = f.database(); try { expect(after.prepare('SELECT value FROM metadata WHERE key=?').get(key)).toEqual(before); } finally { after.close(); }
});

it('keeps maintenance owner and actual source-domain boundaries when adding a prior original', () => {
  const f = fixture(), a = f.original('本人私聊旧来源'); f.cycle(true); f.complete(f.claim()); f.cycle(false);
  const group = f.store.createConversation('独立来源域', ['alice', 'bob']), foreign = f.original('本人另一实际域来源', group.id);
  f.cycle(true); f.complete(f.claim()); f.cycle(false);
  const bob = f.original('另一伙伴私有来源', f.store.openPrivate('bob').id, 'bob');
  const fresh = f.original('本人私聊新补充'); f.cycle(true); const job = f.claim();
  expect(job.sourceMemoryIds).toEqual([fresh.memory.id]); expect(job.maintenanceMemoryIds?.sort()).toEqual([a.memory.id, fresh.memory.id].sort());
  expect(job.maintenanceMemoryIds).not.toContain(foreign.memory.id); expect(job.maintenanceMemoryIds).not.toContain(bob.memory.id);
});

it('requires a complete fresh-schema maintenance readset rather than accepting an obsolete job shape', () => {
  const f = fixture(); f.original('固定读集原始资料A'); f.original('固定读集原始资料B'); f.cycle(true); const job = f.claim();
  expect(job.maintenanceMemoryIds).toBeDefined(); expect(job.maintenanceSessionId).toBeDefined();
  const db = f.database(); try { db.prepare("UPDATE companion_world_jobs SET data=json_remove(data,'$.maintenanceMemoryIds','$.maintenanceMemoryVersions') WHERE id=?").run(job.id); } finally { db.close(); }
  expect(() => f.store.request({ type: 'world.job.complete', stage: 'real', id: job.id, leaseToken: job.leaseToken! })).toThrow('完整的固定读集');
});

it('admits a valid same-text source revision above one from persisted messages while still reading its exact current reference', () => {
  const f = fixture(), a = f.original('同字节但已合法记录第二版本的真实来源。', f.scope.conversationId, 'alice', 2);
  expect(a.memory.sources[0]?.revision).toBe(2);
  expect(f.store.request({ type: 'memory.read', ...f.scope, id: a.memory.id }).memoryRead!.memory.sources[0]?.revision).toBe(2);
  f.cycle(true); f.complete(f.claim()); f.cycle(false);
  const b = f.original('后来新增的同域实际补充。'); f.cycle(true); const job = f.claim();
  expect(job.sourceMemoryIds).toEqual([b.memory.id]);
  expect(job.maintenanceMemoryIds?.sort()).toEqual([a.memory.id, b.memory.id].sort());
  expect(f.bind(job).find(note => note.id === a.memory.id)?.sources[0]?.revision).toBe(2);
  f.complete(job);
});

it('waits on exact pending sources without consuming deferred seeds or blocking independent source domains', () => {
  const f = fixture(), a = f.original('待整合的原始来源A'), b = f.original('待整合的原始来源B'), c = f.original('需要随后维护的来源C');
  f.cycle(true); const reviewing = f.claim(), memories = f.bind(reviewing);
  const winner = f.store.request({ type: 'memory.consolidate', ...f.scope, operationId: 'pending_winner',
    inputs: [a.memory, b.memory].map(note => ({ id: note.id, version: note.version })),
    candidate: { artifactKind: 'episode_memory' as const, content: `${a.source.content}\n${b.source.content}`, tags: [], sourceMessageIds: [a.source.id, b.source.id],
      evidence: [a.source, b.source].map(source => ({ sourceMessageId: source.id, quote: source.content })) } }).memories![0]!;
  const delivery = f.store.request({ type: 'memory.outbox.claim' }).memoryOutbox!;
  expect(delivery.noteId).toBe(winner.id);
  f.store.request({ type: 'world.job.complete', stage: 'real', id: reviewing.id, leaseToken: reviewing.leaseToken!, sourceMemoryIds: memories.map(note => note.id),
    maintenance: { decision: 'merge', reason: '受控夹具：候选A/C在索引确认前与A/B的待发布计划重叠。', reviewedMemoryVersions: memories.map(note => ({ id: note.id, version: note.version })) },
    consolidations: [{ inputs: [a.memory, c.memory].map(note => ({ id: note.id, version: note.version })), candidate: { artifactKind: 'episode_memory' as const,
      content: `${a.source.content}\n${c.source.content}`, tags: [], relatedMemoryIds: [], sourceMessageIds: [a.source.id, c.source.id],
      evidence: [a.source, c.source].map(source => ({ sourceMessageId: source.id, quote: source.content })) } }] });
  const db = f.database(); try {
    expect(db.prepare('SELECT 1 FROM companion_world_dream_watermark WHERE companion_id=? AND memory_id=?').get('alice', c.memory.id)).toBeUndefined();
    const saved = db.prepare('SELECT data FROM companion_world_jobs WHERE id=?').get(reviewing.id) as { data: string };
    expect(JSON.parse(saved.data).maintenance).toMatchObject({ decision: 'defer', reason: expect.stringContaining('具体来源重叠') });
  } finally { db.close(); }
  expect(f.store.request({ type: 'world.sleep-plan', companionId: 'alice' }).worldSleepPlan?.hasUnconsolidated).toBe(false);
  const group = f.store.createConversation('独立日志来源域', ['alice', 'bob']);
  const unrelated = f.original('索引慢任务期间仍可到达和处理的新日志。', group.id);
  f.cycle(false); f.cycle(true); const independent = f.claim();
  expect(independent.sourceMemoryIds).toEqual([unrelated.memory.id]);
  expect(independent.maintenanceMemoryIds).not.toContain(c.memory.id); f.complete(independent);
  f.store.request({ type: 'memory.outbox.complete', id: delivery.id, leaseToken: delivery.leaseToken, indexed: true });
  f.cycle(false); f.cycle(true); const refreshed = f.claim();
  expect(refreshed.sourceMemoryIds).toEqual([c.memory.id]);
  expect(refreshed.sourceMemoryIds).not.toContain(a.memory.id); f.complete(refreshed);
});
