/** Opt-in real Service maintenance acceptance. All source diaries below are
 * human-authored fixtures; they are explicitly not automatic memory capture. */
import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, readdir, lstat, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BotAppBrain } from '../../src/main/companion-bot/app-brain';
import { BotBrainRouter } from '../../src/main/companion-bot/brain-router';
import { BotDshBrain, type BotDshModel } from '../../src/main/companion-bot/dsh-brain';
import { BotService } from '../../src/main/companion-bot/service';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { GLOBAL_EMBEDDING_SELECTION_ID } from '../../src/shared/embedding/global-profile';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { resolveStoredLlmConfig } from '../../src/shared/llm';
import { resolvePortableTools } from '../../src/main/portable-tools';
import type { BotMemoryWorkspaceRequest, BotMemoryCatalog, BotMemoryFullNote } from '../../src/shared/companion-bot-memory';
import type { BotMaintenanceJob, BotMaintenanceCandidates, BotMaintenanceCandidateDetail, BotMaintenanceDiagnostics } from '../../src/shared/companion-bot-maintenance';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, project = process.env.WORLDLINEBOX_BOT_REAL_PROJECT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_MAINTENANCE_OUTPUT!;
if (!root || !project || !source || !output || process.env.WORLDLINEBOX_BOT_MAINTENANCE_REAL !== '1') throw new Error('Explicit isolated maintenance acceptance inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (text: string) => text.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
  .replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, '<redacted>');
const safe = <T>(value: T): T => JSON.parse(clean(JSON.stringify(value))) as T;
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fixtureNotes = [
  '【人编维护验收资料，非自动记忆】2026年11月1日，用户为晨汐项目初定：使用蓝色收纳盒，晚间只整理桌面的西北角，单次上限20分钟。这里只是计划，尚未整理。',
  '【人编维护验收资料，非自动记忆】2026年11月2日明确更正：晨汐项目单次上限改为12分钟，取代11月1日的20分钟；蓝色收纳盒和晚间只整理西北角保持不变。这不是所有项目的通用上限。',
  '【人编维护验收资料，非自动记忆】2026年11月2日，用户决定先试一周晚上用麦茶替代咖啡，上午那杯咖啡照旧。用户不想全天戒咖啡，不能将此概括为永久偏好。',
  '【人编维护验收资料，非自动记忆】2026年11月1日的旧周六计划：下午两点在湖边入口见朋友并散步。只是讨论计划，没有预约、没有出发。',
  '【人编维护验收资料，非自动记忆】2026年11月3日因预报下雨，用户取消湖边下午两点的旧安排，改为周六下午三点在市美术馆南门见朋友。门票尚未预约，也尚未出发。',
  '【人编维护验收资料，非自动记忆】2026年11月3日，用户与大肥鱼讨论了如何把桌面整理拆成小步骤。伙伴没有读取真实桌面目录，没有移动文件，也没有声称完成整理。',
  '【人编维护验收资料，非自动记忆】用户描述上周在公园拍过两张银杏照片，这是独立经历。用户没有上传照片，伙伴没有看过照片，不能说已经替用户保存或处理图片。',
  '【人编维护验收资料，非自动记忆】本周二用户与伙伴聊过雨天适合在室内阅读，仅有共同讨论。没有商定购买书籍，没有付款或预订，也没有实际执行外部任务。',
];

void app.whenReady().then(async () => {
  const stages: Row[] = [], plans: Row[] = [], errors: Row[] = [], http: Row[] = [], diagnostics: Row[] = [], wireReads: Promise<void>[] = [];
  const lossless = process.env.WORLDLINEBOX_BOT_MAINTENANCE_LOSSLESS === '1';
  const selectedKind = process.env.WORLDLINEBOX_BOT_MAINTENANCE_KIND, requestedKinds: Array<'organize' | 'dream'> = selectedKind === 'organize' || selectedKind === 'dream' ? [selectedKind] : ['organize', 'dream'];
  const requestBudget = requestedKinds.length === 1 ? 1 : 3;
  const report: Row = { kind: 'bot-maintenance-result', runId: path.basename(root), passed: false, date: new Date().toISOString(),
    boundary: 'Isolated real BotService maintenance APIs + AppAgent + original VCP/DreamWave + CPU bundled 768; human-authored diary fixtures, not automatic capture or UI/DSH acceptance.',
    usesRealModel: true, usesRealVcp: true, usesRealEmbedding: true, productionWrites: false, dshHostsStarted: 0, manualAuthoredFixtureNotes: fixtureNotes.length,
    maximumModelRequests: requestBudget, modelRequests: 0, requestedKinds, losslessApplyRequested: lossless, insightApproval: 'not approved; requires separate human semantic review', stages, plans, errors, http, diagnostics, humanReviewRequired: true };
  let stage = 'initialization', service: BotService | undefined, memory: BotMemoryService | undefined, brain: BotAppBrain | undefined;
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    stage = name; process.send?.({ kind: 'bot-maintenance-progress', stage, modelRequests: report.modelRequests }); const start = performance.now();
    try { const value = await operation(); stages.push({ name, elapsedMs: performance.now() - start, passed: true }); return value; }
    catch (error) { stages.push({ name, elapsedMs: performance.now() - start, passed: false, error: clean(error instanceof Error ? error.message : String(error)) }); throw error; }
    finally { await persist(); }
  };
  const embedding = new GlobalEmbeddingService({ userDataPath: path.join(root, 'embedding-state'), bundleDirectory: path.join(project, 'resources/embedding-models'),
    koffiPath: createRequire(path.join(project, 'package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
  const gateway = new VcpEmbeddingGateway(embedding);
  const request = async <T>(input: BotMemoryWorkspaceRequest): Promise<T> => { const result = await service!.handle(input); if (!result.ok) throw new Error(result.error ?? 'Maintenance API failed'); return result.memory as T; };
  try {
    if (os.freemem() < 7 * 1024 ** 3) throw new Error('INSUFFICIENT_FREE_MEMORY_FOR_ONE_OWNED_768_ENCODER');
    report.freeMemoryBeforeGiB = os.freemem() / 1024 ** 3;
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw new Error('GLOBAL_MODEL_UNAVAILABLE');
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    const model: BotDshModel = { ...resolveStoredLlmConfig(profile), apiKey: secret, maxTokens: 4096 };
    if (!model.baseUrl || !secret || model.apiFormat !== 'openai_chat') throw new Error('GLOBAL_OPENAI_CHAT_CONFIGURATION_REQUIRED');
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat };
    await phase('one-owned-768-cpu-encoder', async () => { const vectors = await embedding.embed(['维护日记整理与梦境真实验收'], { purpose: 'query' });
      if (vectors.vectors[0]?.length !== 768 || vectors.profile.source !== 'local') throw new Error('ACTUAL_BUNDLED_768_REQUIRED');
      report.embedding = { dimensions: 768, source: vectors.profile.source, model: vectors.profile.modelName, backend: 'cpu', ownedEncoderCount: 1 }; });
    const packageRoot = path.join(project, '.tools/bot-memory-release/vcp-memory'), nodePath = (await resolvePortableTools({ appPath: project })).nodeExecutable;
    const hashes: Row = {};
    for (const file of ['lib/worker.cjs', 'lib/bot-host.cjs', 'lib/managed-notes.cjs']) hashes[file] = digest(await readFile(path.join(packageRoot, file)));
    report.vcpSourceHashes = hashes;
    const client = createRequire(path.join(packageRoot, 'package.json'))(path.join(packageRoot, 'lib/client.cjs')) as { createSession(options: object): { pid: number; closed: Promise<void>; close(): Promise<void>; request(operation: string, payload?: object, options?: object): Promise<unknown> } };
    const pids: number[] = []; report.vcpResidentPids = pids;
    memory = new BotMemoryService({ root: path.join(root, 'memory'), maxActiveDomains: 1, runtime: async () => ({ nodePath, packageRoot }),
      embedding: async () => gateway.configuration(GLOBAL_EMBEDDING_SELECTION_ID, await embedding.resolveProfile()),
      chat: async () => ({ baseUrl: 'http://127.0.0.1:9', model: 'disabled-hidden-memory-chat', apiKey: 'unavailable', apiType: 'openai-completions' }),
      onDiagnostic: value => { diagnostics.push(safe(value)); }, createSession: options => { const session = client.createSession(options); pids.push(session.pid); return session; } });
    brain = new BotAppBrain({ root: path.join(root, 'app-brain'), maxSteps: 1, fetchFn: async (url, init) => {
      if (new URL(String(url)).origin !== new URL(model.baseUrl).origin || init?.method !== 'POST') throw new Error('UNEXPECTED_PAID_MODEL_ENDPOINT');
      if (Number(report.modelRequests) >= requestBudget) throw new Error('MAINTENANCE_MODEL_REQUEST_BUDGET_EXHAUSTED');
      report.modelRequests = Number(report.modelRequests) + 1;
      const observation: Row = { ordinal: report.modelRequests, stage, startedAt: new Date().toISOString(), request: typeof init.body === 'string' ? JSON.parse(init.body) : undefined }; http.push(observation);
      const started = performance.now(), response = await fetch(url, init); observation.headersMs = performance.now() - started; observation.status = response.status;
      wireReads.push(response.clone().text().then(text => { observation.rawSse = clean(text); observation.elapsedMs = performance.now() - started;
        const usage = text.split('\n').filter(line => line.startsWith('data: ')).flatMap(line => { try { const value = object(JSON.parse(line.slice(6))); return value.usage ? [value.usage] : []; } catch { return []; } }); if (usage.length) observation.usage = usage.at(-1);
      }).catch(error => { observation.wireReadError = clean(String(error)); }));
      return response;
    } });
    const worker = new BotDshBrain({ getHost: async () => { report.dshHostsStarted = Number(report.dshHostsStarted) + 1; throw new Error('DSH_FORBIDDEN_IN_MAINTENANCE_ACCEPTANCE'); } });
    service = new BotService({ root: path.join(root, 'bot-service'), brain: new BotBrainRouter({ app: brain, worker }), brainRuntime: 'worldlinebox', memory, model: () => model,
      onEvent: () => undefined, report: error => { diagnostics.push(safe({ stage, error: error instanceof Error ? error.message : String(error), code: object(error).code })); } });
    const state = (await service.handle({ type: 'state' })).snapshot!, room = state.conversations.find(value => value.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const scope = { conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID }; report.scope = { ...scope, securityDomainId: service.store.getConversation(room.id)!.securityDomainId };
    await request({ type: 'memory.maintenance.settings.update', ...scope, settings: { enabled: false, autoApply: lossless ? 'lossless' : 'never' } });
    await phase('human-authored-public-memory-fixtures', async () => {
      const receipts: Row[] = []; report.seedReceipts = receipts;
      for (const [index, content] of fixtureNotes.entries()) receipts.push({ index, content, receipt: await request({ type: 'memory.remember', ...scope, requestId: `maintenance-human-fixture-${index}`, content, tags: ['人编维护验收', index < 2 ? '晨汐项目' : index === 3 || index === 4 ? '周六安排' : '独立经历'] }) });
      const catalog = await request<BotMemoryCatalog>({ type: 'memory.catalog', ...scope, limit: 60 }); report.seedCatalog = catalog;
      if (catalog.items.filter(item => item.indexState === 'indexed').length !== fixtureNotes.length || catalog.liveEligibleCount !== fixtureNotes.length) throw new Error('EIGHT_REAL_LIVE_INDEXED_HUMAN_FIXTURES_REQUIRED');
      const originals: BotMemoryFullNote[] = []; for (const item of catalog.items) originals.push(await request<BotMemoryFullNote>({ type: 'memory.note', ...scope, id: item.id }));
      report.originals = originals; await writeFile(path.join(output, 'human-fixture-originals.json'), clean(JSON.stringify(originals, null, 2)) + '\n');
    });
    const evidence = async (jobId: string) => {
      const summaries = await request<BotMaintenanceCandidates>({ type: 'memory.maintenance.candidates', ...scope, jobId, limit: 12 }), candidates: BotMaintenanceCandidateDetail[] = [];
      for (const candidate of summaries.items) candidates.push(await request<BotMaintenanceCandidateDetail>({ type: 'memory.maintenance.candidate', ...scope, jobId, candidateId: candidate.id }));
      const records: Row[] = []; let after: number | undefined;
      do {
        const page = await request<BotMaintenanceDiagnostics>({ type: 'memory.maintenance.diagnostics', ...scope, jobId, after, limit: 20 });
        for (const item of page.items) { let text = '', offset = 0;
          for (;;) { const value = (await request<BotMaintenanceDiagnostics>({ type: 'memory.maintenance.diagnostics', ...scope, jobId, entryId: item.id, offset })).entry!;
            text += value.text; if (value.nextOffset === undefined) break; if (value.nextOffset <= offset) throw new Error('DIAGNOSTIC_PAGE_DID_NOT_ADVANCE'); offset = value.nextOffset; }
          records.push({ ...item, text }); }
        after = page.nextAfter;
      } while (after !== undefined);
      await writeFile(path.join(output, `${jobId}-evidence.json`), clean(JSON.stringify({ candidates, diagnostics: records }, null, 2)) + '\n'); return { candidates, diagnostics: records };
    };
    for (const kind of requestedKinds) {
      await request({ type: 'memory.maintenance.settings.update', ...scope, settings: { enabled: false, autoApply: kind === 'organize' && lossless ? 'lossless' : 'never' } });
      const started = performance.now(), beforeRequests = Number(report.modelRequests), observation: Row = { kind, timing: {} }; plans.push(observation);
      try { await phase(`${kind}-public-maintenance-plan`, async () => {
        const accepted = await request<BotMaintenanceJob>({ type: 'memory.maintenance.run', ...scope, kind, requestId: `real-${kind}-one` }); observation.jobId = accepted.id;
        let job = accepted; const deadline = Date.now() + 240000;
        while (!['review', 'completed', 'blocked', 'failed', 'cancelled'].includes(job.status)) { if (Date.now() > deadline) throw new Error('MAINTENANCE_JOB_TIMEOUT'); await pause(250); job = await request<BotMaintenanceJob>({ type: 'memory.maintenance.get', ...scope, jobId: accepted.id }); }
        observation.job = job; Object.assign(observation, await evidence(job.id));
        observation.timing = { elapsedMs: performance.now() - started, queueMs: job.startedAt ? Date.parse(job.startedAt) - Date.parse(job.createdAt) : undefined,
          modelRequests: Number(report.modelRequests) - beforeRequests };
        if (!['review', 'completed'].includes(job.status)) throw new Error(`REAL_${kind.toUpperCase()}_PLAN_${job.status.toUpperCase()}: ${job.error ?? ''}`);
        if (!object(observation).diagnostics || !(observation.diagnostics as Row[]).some(item => item.phase === 'model-response')) throw new Error('REAL_MODEL_RESPONSE_DIAGNOSTIC_REQUIRED');
        if (kind === 'dream') report.insightsAwaitingHumanReview = (observation.candidates as BotMaintenanceCandidateDetail[]).filter(candidate => candidate.type === 'insight');
        else if (!lossless) { const candidate = (observation.candidates as BotMaintenanceCandidateDetail[])[0];
          if (candidate) { observation.reviewReceipt = await request({ type: 'memory.maintenance.review', ...scope, jobId: job.id, candidateId: candidate.id, revision: candidate.revision, decision: 'reject', requestId: 'reject-unapproved-model-rewrite' });
            observation.afterReviewJob = await request({ type: 'memory.maintenance.get', ...scope, jobId: job.id }); } }
      }); } catch (error) { observation.error = clean(error instanceof Error ? error.message : String(error)); if (observation.jobId) Object.assign(observation, await evidence(String(observation.jobId)).catch(() => ({}))); errors.push({ stage, message: observation.error }); }
      await persist();
    }
    report.finalCatalog = await request<BotMemoryCatalog>({ type: 'memory.catalog', ...scope, limit: 60 });
    if (lossless) {
      const originals = report.originals as BotMemoryFullNote[], catalog = report.finalCatalog as BotMemoryCatalog, applied: Row[] = [];
      for (const observation of plans.filter(item => item.kind === 'organize')) for (const candidate of observation.candidates as BotMaintenanceCandidateDetail[] ?? []) if (candidate.status === 'applied') {
        const returned = object(object(candidate.receipt).receipt), newId = returned.id;
        if (typeof newId !== 'string') throw new Error('APPLIED_LOSSLESS_ID_MISSING');
        const note = await request<BotMemoryFullNote>({ type: 'memory.note', ...scope, id: newId });
        const exactSources = originals.filter(original => candidate.sources.some(source => source.id === original.id));
        const allOriginalSentencesPreserved = exactSources.length === candidate.sources.length && exactSources.every(original => note.content.includes(original.content));
        if (!allOriginalSentencesPreserved || note.indexState !== 'indexed' || candidate.sources.some(source => catalog.items.find(item => item.id === source.id)?.indexState !== 'archived')) throw new Error('LOSSLESS_ORIGINAL_OR_INDEX_ARCHIVE_PROOF_FAILED');
        applied.push({ candidateId: candidate.id, note, exactSourceIds: exactSources.map(source => source.id), allOriginalSentencesPreserved });
      }
      report.losslessProof = applied;
    }
    const originalNotes = report.originals as BotMemoryFullNote[], finalCatalog = report.finalCatalog as BotMemoryCatalog;
    const unapprovedNotesUnchanged = lossless || finalCatalog.items.length === originalNotes.length && originalNotes.every(original => finalCatalog.items.some(current => current.id === original.id && current.checksum === original.checksum && current.indexState === 'indexed'));
    report.checks = { requestedRealPlans: plans.length === requestedKinds.length && plans.every(value => !value.error), twoRealPlans: plans.length === 2 && plans.every(value => !value.error), noDsh: Number(report.dshHostsStarted) === 0, unapprovedNotesUnchanged, vcpHiddenChatDisabled: true,
      countedModelBudget: Number(report.modelRequests) === requestedKinds.length && Number(report.modelRequests) <= requestBudget, humanSeedsExplicit: true,
      dreamNeverSelfApproved: plans.filter(value => value.kind === 'dream').every(value => (value.candidates as BotMaintenanceCandidateDetail[] ?? []).every(candidate => candidate.status === 'pending')),
      applyBoundary: lossless ? 'Only deterministic lossless organize may apply; insight/archive/model rewrites remain pending.' : 'Real plans, rejection API and diagnostics verified; no candidate approved, VCP mutations covered separately by native/UI protocol tests.' };
    report.passed = object(report.checks).requestedRealPlans === true && object(report.checks).noDsh === true && object(report.checks).countedModelBudget === true && object(report.checks).dreamNeverSelfApproved === true && unapprovedNotesUnchanged;
  } catch (error) { report.failedStage = stage; errors.push({ stage, message: clean(error instanceof Error ? error.message : String(error)), code: object(error).code }); }
  finally {
    await Promise.allSettled(wireReads);
    if (service) await service.shutdown().catch(error => errors.push({ stage: 'service-shutdown', message: clean(String(error)) }));
    else { await brain?.close().catch(() => undefined); await memory?.close().catch(() => undefined); }
    await gateway.close(); await embedding.close();
    // Preserve actual owned raw diary bytes before the runner removes scratch.
    const files: Row[] = [], archive = path.join(output, 'owned-note-bytes'); await mkdir(archive, { recursive: true });
    const walk = async (directory: string): Promise<void> => { for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(directory, item.name), info = await lstat(filename); if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await walk(filename); else if (item.name.endsWith('.txt')) { const bytes = await readFile(filename), relativePath = path.relative(path.join(root, 'memory'), filename), artifact = `${files.length}-${item.name}`;
        await copyFile(filename, path.join(archive, artifact)); files.push({ relativePath, bytes: bytes.length, sha256: digest(bytes), artifact: `owned-note-bytes/${artifact}` }); }
    } };
    await walk(path.join(root, 'memory')).catch(error => errors.push({ stage: 'preserve-owned-notes', message: clean(String(error)) })); report.physicalNoteEvidence = files;
    if (!files.length || errors.some(value => value.stage === 'service-shutdown' || value.stage === 'preserve-owned-notes')) report.passed = false;
    await persist(); await new Promise<void>(resolve => { if (process.send) process.send(safe(report), () => resolve()); else resolve(); }); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-maintenance-result', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
