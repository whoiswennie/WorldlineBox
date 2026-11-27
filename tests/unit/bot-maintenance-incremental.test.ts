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
    catalog: vi.fn<BotMemoryService['catalog']>(async () => { throw Error('Incremental maintenance must never use the retained whole-history catalog'); }),
    withdrawnSources: async () => host.tombstones(), associateDiaries: async () => ({ engine: 'DailyNoteManager.Associate', sourceRevision: '0', items: [], queries: [] }), dreamRecall: async () => ({ groups: {} }),
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

it.each(['scan', 'track', 'deepclean'] as const)('revisits reviewed diaries for a scoped %s inventory and resumes the exact next catalog page after restart', async mode => {
  const f = fixture(), ids: string[] = [];
  for (let index = 0; index < 24; index++) {
    const key = 'history-' + index, entry = f.seed(key, '历史采样 ' + index);
    f.host.db.prepare('INSERT INTO mutation_sources VALUES(?,?,?)').run(entry.id, 'event', key);
    ids.push(entry.id);
  }
  f.host.db.prepare("UPDATE maintenance_work SET state='reviewed' WHERE kind='organize'").run();
  f.memory.catalog.mockImplementation(async (scope, input) => {
    expect(scope).toEqual(f.scope); expect(input.indexedOnly).toBe(true);
    return f.host.catalog(input);
  });
  const requestId = 'explicit-' + mode;
  const fromTool = f.runtime.tool(f.scope, { operation: 'plan', mode }, requestId) as { accepted: boolean; approvalRequired?: boolean; job?: { id: string } };
  let firstId: string;
  if (mode === 'deepclean') {
    expect(fromTool).toMatchObject({ accepted: false, approvalRequired: true });
    expect(f.runtime.journal.list(f.scope).items).toEqual([]);
    const human = await f.runtime.handle({ type: 'memory.maintenance.run', ...f.scope, kind: 'organize', mode, requestId: 'workbench-confirmation' }, f.scope) as { id: string };
    firstId = human.id;
  } else { expect(fromTool.accepted).toBe(true); firstId = fromTool.job!.id; }
  expect((await f.step()).status).toBe('done');
  const first = f.runtime.journal.get(f.scope, firstId);
  expect(first.job.survey).toMatchObject({ rootId: firstId, page: 1 });
  expect(f.runtime.journal.list(f.scope).items.find(item => item.id === firstId)).toEqual(first.job);
  expect(first.job.survey?.nextJobId).toBeTruthy();
  expect(first.plan?.sources.length).toBeLessThanOrEqual(20);
  await f.reopen();
  expect((await f.step()).status).toBe('done');
  const last = f.runtime.journal.get(f.scope, first.job.survey!.nextJobId!);
  expect(last.job.survey).toMatchObject({ rootId: firstId, page: 2, progress: { pages: 2, examined: 24, complete: true } });
  expect(f.runtime.journal.get(f.scope, firstId).job.survey?.progress).toEqual(last.job.survey!.progress);
  expect([...first.plan!.sources,...last.plan!.sources].map(source => source.id).sort()).toEqual(ids.sort());
  expect(f.memory.maintenanceWork).not.toHaveBeenCalled();
  expect(f.host.db.prepare("SELECT count(*) AS n FROM maintenance_work WHERE kind='organize' AND state='reviewed'").get().n).toBe(24);
  expect(f.run).toHaveBeenCalledTimes(2);
});

it('preserves separate project briefs and the original three-month boundary through restart and catalog pagination', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-03-31T04:00:00Z'));
  const f = fixture(), expected: string[] = [];
  const seed = (key: string, date: string) => {
    const entry = f.seed(key, '用于模型研判的记录 ' + key);
    f.host.db.prepare('INSERT INTO mutation_sources VALUES(?,?,?)').run(entry.id, 'event', key);
    f.host.db.prepare('UPDATE mutations SET note_path=?,created_at=? WHERE id=?').run('Companion/' + date + '-12_00_00-' + entry.id + '.txt', date + 'T04:00:00Z', entry.id);
    return entry.id;
  };
  for (let i = 0; i < 22; i++) expected.push(seed('inside' + i, '2026-01-15'));
  const march = seed('march', '2026-03-01'); expected.push(march);
  seed('outside-before', '2025-12-30'); seed('outside-after', '2026-04-01');
  f.memory.catalog.mockImplementation(async (scope, input) => { expect(scope).toEqual(f.scope); return f.host.catalog(input); });
  const firstBrief = { topic: '灯塔项目', period: '最近三个月' }, secondBrief = { topic: '海岸项目', fromDate: '2026-03-01', toDate: '2026-03-01' };
  const start = (brief: typeof firstBrief | typeof secondBrief, id: string) => f.runtime.tool(f.scope, { operation: 'plan', mode: 'scan', brief }, id) as { accepted: boolean; job: { id: string } };
  const first = start(firstBrief, 'lighthouse-scan'), second = start(secondBrief, 'coast-scan');
  expect(first.accepted && second.accepted).toBe(true); expect(first.job.id).not.toBe(second.job.id);
  expect((await f.step()).status).toBe('done');
  const pageOne = f.runtime.journal.get(f.scope, first.job.id);
  const effective = { ...firstBrief, fromDate: '2025-12-31', toDate: '2026-03-31', requestedBy: 'companion' };
  expect(pageOne.snapshot?.brief).toEqual(effective);
  await f.reopen(); vi.setSystemTime(new Date('2026-05-08T04:00:00Z'));
  expect(start(firstBrief, 'lighthouse-scan')).toEqual(first);
  await f.step(); await f.step();
  const pageTwo = f.runtime.journal.get(f.scope, pageOne.job.survey!.nextJobId!);
  expect(pageTwo.snapshot?.brief).toEqual(effective);
  expect([...pageOne.plan!.sources,...pageTwo.plan!.sources].map(source => source.id).sort()).toEqual(expected.sort());
  const other = f.runtime.journal.get(f.scope, second.job.id);
  expect(other.plan!.sources.map(source => source.id)).toEqual([march]);
  const prompts = f.run.mock.calls.map(([input]) => JSON.parse(input.prompt) as BotMemoryMaintenancePlan);
  expect(prompts.map(prompt => prompt.brief?.topic)).toEqual(['灯塔项目','海岸项目','灯塔项目']);
  expect(prompts.every(prompt => !prompt.sources.some(source => source.content.includes('outside')))).toBe(true);
  f.runtime.journal.invalidate(f.scope);
  expect(f.runtime.journal.get(f.scope, first.job.id).job.brief).toBeUndefined();
  expect(start(firstBrief, 'lighthouse-scan')).toEqual({ accepted: false, withdrawn: true });
});

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
  const job = f.enqueue('ack-lost'); vi.setSystemTime(Date.now() + 61000);
  expect((await f.step()).status).toBe('retry'); expect(f.run).toHaveBeenCalledOnce();
  await f.reopen(); vi.setSystemTime(Date.now() + 30001); expect((await f.step()).status).toBe('done'); expect(f.run).toHaveBeenCalledOnce();
  expect(f.runtime.journal.get(f.scope, job.id).job.status).toBe('completed');
  f.enqueue('next-manual-page'); expect((await f.step()).status).toBe('done'); expect(f.run).toHaveBeenCalledTimes(2); expect(JSON.parse(f.run.mock.calls[1]![0].prompt).sources).toHaveLength(5);
});
it('reimports matching historical versions when the native queue is restored without its progress database', async () => {
  const f = fixture(); f.seed('restored-note', '未发生变化的真实版本。'); f.enqueue('before-restore'); await f.step(); expect(f.run).toHaveBeenCalledOnce();
  f.host.db.exec("DELETE FROM maintenance_work; DELETE FROM maintenance_batches; DELETE FROM maintenance_work_identity; DELETE FROM metadata WHERE key='maintenance-work-v1';");
  await f.reopen(); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(1);
  f.enqueue('after-restore'); await f.step(); expect(f.run).toHaveBeenCalledOnce(); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(0);
});

it.each(['LightMemo', 'DailyNoteManager.Associate'])('retires pre-native planner jobs with %s retrieval across restarts without applying stale output', async engine => {
  const f = fixture(), original = f.seed('old', '用户原计划去湖边。');
  const legacy = f.enqueue('old-planner');
  const claim = { kind: 'organize', jobId: legacy.id, limit: 20 };
  f.host.maintenanceWork.claim(claim);
  f.host.maintenanceWork.complete({ ...claim, sources: [original], reserved: [original.id] });
  const receipt = JSON.stringify({ state: 'pending', operationId: 'prior-operation' });
  const body = { format: 'worldlinebox-memory-maintenance-v1', operationId: legacy.id, scope: f.scope, kind: 'organize', contextEpoch: 1, sourceRevision: '0', createdAt: new Date().toISOString(),
    sources: [{ ...original, tags: [], createdAt: new Date().toISOString(), sourceMessageIds: [] }], scan: { incremental: true, examined: 1, selected: 1, deferred: [] },
    retrieval: { engine, result: {} }, narrative: '不得重放旧指令。', candidates: [{ id: 'candidate', type: 'update', sourceIds: [original.id], content: '旧草稿', tags: [], reason: '历史断点', uncertainties: [], quotes: [{ sourceId: original.id, text: original.content }] }] };
  const oldPlan = { ...body, id: maintenanceDigest(body) };
  f.store.taskTransaction(sql => {
    sql.prepare('DELETE FROM bot_metadata WHERE key=?').run('maintenance-native-submission-v2');
    sql.prepare("UPDATE bot_maintenance_jobs SET plan_json=?,status='applying' WHERE id=?").run(JSON.stringify(oldPlan), legacy.id);
    sql.prepare("INSERT INTO bot_maintenance_candidates VALUES(?,?,0,'unknown',?,?,?,?)").run(legacy.id, 'candidate', 'old-revision', JSON.stringify(body.candidates[0]), receipt, body.createdAt);
  });
  await f.reopen();
  const retired = f.runtime.journal.get(f.scope, legacy.id).job;
  expect(retired).toMatchObject({ status: 'cancelled', phase: 'planner_retired' });
  expect(f.runtime.journal.candidate(f.scope, legacy.id, 'candidate').receipt).toEqual(JSON.parse(receipt));
  expect(() => f.runtime.journal.control(f.scope, legacy.id, 'retry', 'retry-old')).toThrow('旧版');
  expect(() => f.runtime.journal.resumeCandidate(f.scope, legacy.id, 'candidate', 'old-revision', 'resume-old')).toThrow('旧版');
  expect(f.store.claimMemoryJob({ workerId: 'verify-retirement' })).toBeUndefined();
  expect(f.run).not.toHaveBeenCalled();
  const fresh = f.enqueue('fresh-planner'); await f.step();
  const plan = f.runtime.journal.get(f.scope, fresh.id).plan!;
  expect(plan.format).toBe('worldlinebox-memory-maintenance-v2');
  expect(plan.sources.map(source => source.id)).toEqual([original.id]);
  expect(f.run.mock.calls[0]![0].prompt).not.toContain(body.narrative);
  expect(f.host.db.prepare('SELECT state,content,checksum FROM mutations WHERE id=?').get(original.id)).toEqual({ state: 'indexed', content: original.content, checksum: original.checksum });
  await f.reopen();
  expect(f.runtime.journal.get(f.scope, fresh.id).plan).toEqual(plan);
  expect(f.runtime.journal.get(f.scope, legacy.id).job).toEqual(retired);
  expect(f.run).toHaveBeenCalledTimes(1);
});

it('retries an invalid version later while processing unrelated additions and never exhausting a retry quota', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), bad = f.seed('bad', '用户尚未出发。');
  f.run.mockImplementationOnce(async input => ({ text: JSON.stringify({ narrative: '', candidates: [{ type: 'update', sourceIds: [bad.id], content: '用户尚未出发。', tags: [], reason: '保留事实。', uncertainties: [], quotes: [{ sourceId: bad.id, text: '根本不存在的引文。' }] }] }), status: 'succeeded', eventId: input.eventId, sessionId: input.laneId }));
  f.enqueue('invalid-source-evidence'); expect((await f.step()).status).toBe('failed'); expect(f.host.maintenanceWork.stats({ kind: 'organize' })).toMatchObject({ ready: 0, retrying: 1 });
  const fresh = f.seed('other', '另一篇日记可以继续。'), other = f.enqueue('unrelated-addition'); await f.step(); expect(f.runtime.journal.get(f.scope, other.id).plan?.sources.map(n => n.id)).toEqual([fresh.id]);
  vi.setSystemTime(Date.now() + 300001);
  f.enqueue('retry-manual'); expect((await f.step()).status).toBe('done');
  expect(f.run).toHaveBeenCalledTimes(3); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).ready).toBe(0);
});
it('lets an unrelated new version proceed while another model turn is waiting for its original delivery receipt', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); const f = fixture(), unknown = f.seed('unknown', '这项分析的执行回执暂未确认。');
  f.run.mockImplementation(async input => { const sources = JSON.parse(input.prompt).sources as Array<{ id: string }>; if (sources.some(source => source.id === unknown.id)) throw new BotDshDeliveryUnknownError('receipt not confirmed'); return { status: 'succeeded', text: '{"narrative":"本批无需改写。","candidates":[]}', eventId: input.eventId, sessionId: input.laneId }; });
  const original = f.enqueue('unknown-receipt'); expect((await f.step()).status).toBe('retry'); const fresh = f.seed('fresh-after-unknown', '其他新日记不应被此任务阻塞。');
  vi.setSystemTime(Date.now() + 25 * 3600000); expect((await f.step()).status).toBe('retry');
  const next = f.enqueue('next-manual'); expect(next).toBeDefined(); expect((await f.step()).status).toBe('done');
  expect(f.runtime.journal.get(f.scope, next!.id).plan?.sources.map(source => source.id)).toEqual([fresh.id]);
  expect(f.runtime.journal.get(f.scope, original.id).job.status).toBe('queued'); expect(f.host.maintenanceWork.stats({ kind: 'organize' }).processing).toBe(1);
});
