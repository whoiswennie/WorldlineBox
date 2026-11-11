import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module'; import { createHash } from 'node:crypto'; import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotMaintenanceRuntime, type BotMaintenanceRuntimeOptions } from '../../src/main/companion-bot/memory-maintenance-runtime';
import { maintenanceDigest, type BotMemoryMaintenancePlan } from '../../src/main/companion-bot/memory-maintenance';
import type { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { BotDshDeliveryUnknownError } from '../../src/main/companion-bot/dsh-brain';
const require = createRequire(path.resolve('resources/vcp-memory/package.json')), { BotHost } = require('./lib/bot-host.cjs');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

// Native work/version SQL, production selector/runtime, and the operational
// journal are real. This suite replaces semantic retrieval and model responses;
// the separate real-user-data verification runs the actual native model/KB.
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-incremental-runtime-')), home = path.join(root, 'memory'); mkdirSync(home);
  let store = new BotStore(path.join(root, 'bot.sqlite')), host = new BotHost(home), runtime: BotMaintenanceRuntime;
  store.createCompanion({ id: 'alice', name: 'Alice', persona: '核对来源' }); const room = store.openDirect('alice'), scope = { companionId: 'alice', conversationId: room.id, securityDomainId: room.securityDomainId };
  const run = vi.fn<BotMaintenanceRuntimeOptions['brain']['run']>(async input => ({ text: JSON.stringify({ narrative: '本批无需改写。', candidates: [] }), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }));
  const memory = {
    maintenanceWork: vi.fn<BotMemoryService['maintenanceWork']>(async (_scope, input) => host.maintenanceWork[input.action](input)),
    catalog: vi.fn(async () => { throw Error('Incremental maintenance must never use the retained whole-history catalog'); }),
    withdrawnSources: async () => host.tombstones(), tool: async () => ({ results: [] }), dreamRecall: async () => ({ groups: {} }),
    readNote: vi.fn(async (_scope: unknown, input: { id: string }) => { const row = host.db.prepare('SELECT * FROM mutations WHERE id=?').get(input.id); return { id: row.id, checksum: row.checksum, indexState: row.state, content: row.content, createdAt: row.created_at, tags: [], sourceMessageIds: [] }; }),
  };
  const install = () => new BotMaintenanceRuntime({ store, root, memory, brain: { run, archive: vi.fn(async () => undefined) }, model: () => ({ model: 'fixture', apiFormat: 'openai_chat', baseUrl: 'http://127.0.0.1:9', apiKey: 'unused-fixture', contextWindow: 1048576, maxTokens: 32768 }), callback: async () => ({ url: 'http://127.0.0.1:9', token: 'fixture' }), changed: () => undefined, report: vi.fn() } as unknown as BotMaintenanceRuntimeOptions);
  runtime = install();
  cleanups.push(async () => { await runtime.close(); store.close(); host.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('wlb-incremental-runtime-')) throw Error('Unexpected incremental test root'); rmSync(resolved, { recursive: true, force: true }); });
  return { scope, run, memory, get store() { return store; }, get host() { return host; }, get runtime() { return runtime; },
    seed(key: string, content: string) { const id = createHash('sha256').update(key).digest('hex'), checksum = createHash('md5').update(content).digest('hex'); host.db.prepare("INSERT INTO mutations(id,hash,state,note_path,checksum,created_at,content,tags_json) VALUES(?,?,'indexed',?,?,?,?,'[]') ON CONFLICT(id) DO UPDATE SET checksum=excluded.checksum,content=excluded.content,state='indexed'").run(id, id, 'Companion/' + id + '.txt', checksum, new Date().toISOString(), content); return { id, checksum, content }; },
    enqueue(key: string, automatic = false) { return runtime.journal.enqueue(scope, 'organize', key, automatic); },
    async step() { const claim = store.claimMemoryJob({ workerId: 'incremental-runtime-test' }); if (!claim) throw Error('No available fixture task'); const result = await runtime.run(claim, new AbortController().signal); store.settleMemoryJob({ id: claim.job.id, leaseToken: claim.leaseToken, ...result }); return result; },
    async reopen() { await runtime.close(); store.close(); host.close(); store = new BotStore(path.join(root, 'bot.sqlite')); host = new BotHost(home); runtime = install(); },
  };
}

it('analyzes unchanged real queue versions once, then selects only a new or edited version without catalog scans', async () => {
  const f = fixture(), a = f.seed('a', '用户尚未预约。'); f.seed('b', '用户计划周六出门。');
  const first = f.enqueue('first'); expect((await f.step()).status).toBe('done'); expect(f.runtime.journal.get(f.scope, first.id).job.metrics).toMatchObject({ incremental: true, examined: 2 });
  f.enqueue('unchanged'); await f.step(); expect(f.run).toHaveBeenCalledOnce(); expect(f.memory.readNote).toHaveBeenCalledTimes(2);
  await f.reopen(); f.enqueue('unchanged-after-restart'); await f.step(); expect(f.run).toHaveBeenCalledOnce();
  f.seed('a', '用户确认预约成功。'); const edited = f.enqueue('one-edit'); await f.step(); expect(f.runtime.journal.get(f.scope, edited.id).plan?.sources.map(n => n.id)).toEqual([a.id]);
  const c = f.seed('c', '用户新增了回程安排。'); const added = f.enqueue('one-addition'); await f.step(); expect(f.runtime.journal.get(f.scope, added.id).plan?.sources.map(n => n.id)).toEqual([c.id]);
  expect(f.run).toHaveBeenCalledTimes(3); expect(f.memory.catalog).not.toHaveBeenCalled();
});

it('recovers a lost progress acknowledgement after restarting without repeating the model or losing later pages', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(); for (let i = 0; i < 25; i++) f.seed('source-' + i, '完整原始日记：' + i);
  const actual = f.memory.maintenanceWork.getMockImplementation()!; let lost = false;
  f.memory.maintenanceWork.mockImplementation(async (scope, input) => { if (input.action === 'complete' && !lost) { lost = true; throw Object.assign(new Error('Lost completion acknowledgement'), { code: 'SESSION_CLOSED' }); } return actual(scope, input); });
  const job = f.enqueue('ack-lost', true); f.runtime.journal.updateSettings(f.scope, { idleMinutes: 1 }); vi.setSystemTime(Date.now() + 61000);
  expect((await f.step()).status).toBe('retry'); expect(f.run).toHaveBeenCalledOnce();
  await f.reopen(); vi.setSystemTime(Date.now() + 30001); expect((await f.step()).status).toBe('done'); expect(f.run).toHaveBeenCalledOnce();
  expect(f.runtime.journal.get(f.scope, job.id).job.status).toBe('completed');
  expect((await f.step()).status).toBe('done'); expect(f.run).toHaveBeenCalledTimes(2); expect(JSON.parse(f.run.mock.calls[1]![0].prompt).sources).toHaveLength(1);
});
it('reimports matching historical versions when the native queue is restored without its progress database', async () => {
  const f = fixture(); f.seed('restored-note', '未发生变化的真实版本。'); f.enqueue('before-restore'); await f.step(); expect(f.run).toHaveBeenCalledOnce();
  f.host.db.exec("DELETE FROM maintenance_work; DELETE FROM maintenance_batches; DELETE FROM maintenance_work_identity; DELETE FROM metadata WHERE key='maintenance-work-v1';");
  await f.reopen(); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(1);
  f.enqueue('after-restore'); await f.step(); expect(f.run).toHaveBeenCalledOnce(); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(0);
});

it('imports historical analyzed versions and reserves pending review sources without blocking fresh notes', async () => {
  const f = fixture(), old = f.seed('old', '用户原计划去湖边。'); const historical = f.enqueue('legacy-plan');
  const body: Omit<BotMemoryMaintenancePlan, 'id'> = { format: 'worldlinebox-memory-maintenance-v1', operationId: historical.id, scope: f.scope, kind: 'organize', contextEpoch: 1, sourceRevision: '0', createdAt: new Date().toISOString(), sources: [{ ...old, tags: [], createdAt: new Date().toISOString(), sourceMessageIds: [] }], scan: { examined: 1, selected: 1, deferred: [] }, retrieval: { engine: 'LightMemo', result: {} }, narrative: '历史候选待审阅。', candidates: [{ id: 'old-candidate', type: 'update', sourceIds: [old.id], content: old.content, tags: [], reason: '保留来源。', uncertainties: [], quotes: [{ sourceId: old.id, text: old.content }] }] };
  f.runtime.journal.savePlan(f.scope, historical.id, { ...body, id: maintenanceDigest(body) }); await f.step();
  const fresh = f.seed('fresh', '用户今天补充了新的安排。'), job = f.enqueue('fresh-incremental'); await f.step();
  expect(f.runtime.journal.get(f.scope, job.id).plan?.sources.map(n => n.id)).toEqual([fresh.id]); expect(f.host.db.prepare("SELECT state FROM maintenance_work WHERE kind='organize' AND note_id=?").get(old.id).state).toBe('review');
  const candidate = f.runtime.journal.candidate(f.scope, historical.id, 'old-candidate'); await f.runtime.handle({ type: 'memory.maintenance.review', conversationId: f.scope.conversationId, companionId: f.scope.companionId, jobId: historical.id, candidateId: candidate.id, revision: candidate.revision, decision: 'reject', requestId: 'human-rejects-old' }, f.scope);
  expect(f.host.db.prepare("SELECT state FROM maintenance_work WHERE kind='organize' AND note_id=?").get(old.id).state).toBe('reviewed');
  f.enqueue('after-rejection'); await f.step(); expect(f.run).toHaveBeenCalledOnce();
});

it('retries an invalid version later while processing unrelated additions and never exhausting a retry quota', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), bad = f.seed('bad', '用户尚未出发。'); f.runtime.journal.updateSettings(f.scope, { idleMinutes: 1 });
  f.run.mockImplementationOnce(async input => ({ text: JSON.stringify({ narrative: '', candidates: [{ type: 'update', sourceIds: [bad.id], content: '用户尚未出发。', tags: [], reason: '保留事实。', uncertainties: [], quotes: [{ sourceId: bad.id, text: '根本不存在的引文。' }] }] }), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }));
  f.enqueue('invalid-source-evidence'); expect((await f.step()).status).toBe('failed'); expect(f.host.maintenanceWork.stats({ kind: 'organize' })).toMatchObject({ ready: 0, retrying: 1 });
  const fresh = f.seed('other', '另一篇日记可以继续。'), other = f.enqueue('unrelated-addition'); await f.step(); expect(f.runtime.journal.get(f.scope, other.id).plan?.sources.map(n => n.id)).toEqual([fresh.id]);
  vi.setSystemTime(Date.now() + 300001); f.runtime.poll(); await new Promise(done => setTimeout(done, 20));
  expect(f.runtime.journal.list(f.scope).items.some(job => job.automatic && job.status === 'queued')).toBe(true); expect((await f.step()).status).toBe('done');
  expect(f.run).toHaveBeenCalledTimes(3); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(0);
});
it('lets an unrelated new version proceed while another model turn is waiting for its original delivery receipt', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), unknown = f.seed('unknown', '这项分析的执行回执暂未确认。'); f.runtime.journal.updateSettings(f.scope, { idleMinutes: 1 });
  f.run.mockImplementation(async input => { const sources = JSON.parse(input.prompt).sources as Array<{ id: string }>; if (sources.some(source => source.id === unknown.id)) throw new BotDshDeliveryUnknownError('receipt not confirmed'); return { status: 'succeeded', text: '{"narrative":"本批无需改写。","candidates":[]}', eventId: input.eventId, sessionId: input.laneId }; });
  const original = f.enqueue('unknown-receipt'); expect((await f.step()).status).toBe('retry'); const fresh = f.seed('fresh-after-unknown', '其他新日记不应被此任务阻塞。');
  vi.setSystemTime(Date.now() + 25 * 3600000); expect((await f.step()).status).toBe('retry'); f.runtime.poll(); await new Promise(done => setTimeout(done, 20));
  const next = f.runtime.journal.list(f.scope).items.find(job => job.automatic && job.id !== original.id); expect(next).toBeDefined(); expect((await f.step()).status).toBe('done');
  expect(f.runtime.journal.get(f.scope, next!.id).plan?.sources.map(source => source.id)).toEqual([fresh.id]);
  expect(f.runtime.journal.get(f.scope, original.id).job.status).toBe('queued'); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).processing).toBe(1);
});
