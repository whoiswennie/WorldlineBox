import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import BetterSqlite3 from 'better-sqlite3';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { BUILTIN_COMPANIONS } from '../../src/shared/companion-personas';
import { CompanionService } from '../../src/main/companions/service';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';
import { realMemoryRuntime } from '../fixtures/companion-real-memory';
import { createNativeAcceptanceBroker, createNativeAcceptanceLauncher, installedNativeAcceptanceSource } from '../helpers/companion-dsh-native-broker';

const port = vi.hoisted(() => ({ store: undefined as CompanionsStore | undefined, mainHttp: 0, maxMainHttp: 50 }));
vi.mock('../../src/main/companions/storage-client', () => ({ CompanionStorageClient: class {
  start = async () => undefined;
  request = async (command: CompanionStorageCommand) => port.store!.request(command);
  close = async () => undefined;
} }));
vi.mock('electron', () => ({ net: { fetch: async (url: string, init?: RequestInit) => {
  if (port.mainHttp >= port.maxMainHttp) throw new Error('ACTIVITY_THOUGHT_MAIN_HTTP_BUDGET');
  port.mainHttp++; return fetch(url, init);
} }, ipcMain: { handle: () => undefined }, dialog: {}, protocol: {}, shell: {},
safeStorage: { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() } }));

/** An explicitly requested real thought through the normal persistent activity,
 * Main action, production broker and installed native Agent. No answer is supplied. */
it.skipIf(process.env.WORLDLINEBOX_ACTIVITY_THOUGHT_REAL !== '1')('returns one real isolated CLI thought to its original persistent activity and reports it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-activity-thought-real-'));
  const output = path.resolve(process.env.WORLDLINEBOX_ACTIVITY_THOUGHT_REAL_RESULT ?? '.tools/test-output/companion-activity-thought-real-acceptance.json');
  const sourcePaths = ['src/main/companions/service.ts', 'src/main/companions/activity-task-service.ts', 'src/main/companions/structured-agent.ts',
    'src/main/companions/model.ts', 'src/companions/activity-task-store.ts', 'src/companions/store.ts', 'src/shared/companion-activity-thought.ts',
    'src/shared/dsh-task-record.ts', 'src/main/dsh/task-execution.ts', 'src/main/dsh/task-runtime-policy.ts', 'src/main/dsh/task-broker.ts',
    'src/main/dsh/task-scope.ts', 'src/main/dsh/companion-runtime-source.ts'];
  const fingerprint = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file,
    createHash('sha256').update(await readFile(path.resolve(file))).digest('hex')])));
  const before = await fingerprint(), failures: string[] = [];
  const config = await realGlobalChatConfig(path.join(root, 'profile'));
  const installed = await installedNativeAcceptanceSource();
  const native = await createNativeAcceptanceBroker(installed);
  const bridge = await createNativeAcceptanceLauncher(native, { maxTaskRuns: 3, timeoutMs: 120000 });
  const memory = await realMemoryRuntime(root, undefined, { modelFetch: async (url, init) => {
    if (port.mainHttp >= port.maxMainHttp) throw new Error('ACTIVITY_THOUGHT_MAIN_HTTP_BUDGET');
    port.mainHttp++; return fetch(url, init);
  } });
  const dataRoot = path.join(root, 'companions'); await mkdir(dataRoot);
  const role = BUILTIN_COMPANIONS.find(value => value.id === 'deepseek-sister')!;
  const store = port.store = new CompanionsStore(path.join(dataRoot, 'messages.sqlite'), [{ ...role, active: true, proactive: false }]);
  const room = store.openPrivate(role.id), scope = { companionId: role.id, conversationId: room.id };
  const world = store.request({ type: 'world.snapshot' }).world!;
  store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
  const routine = store.request({ type: 'routine.get', ...scope }).routine!;
  store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
    patch: { timeZone: 'UTC', sleepAt: '23:59', wakeAt: '00:01', meals: [], habits: [] } });
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', replyDirective: 'none',
    content: '这是一个短思考活动：先调用DSH做纯逻辑推演，不读写文件、不调用工具。判断“A必须先于B、B必须先于C、C必须先于A”能否同时满足。等DSH真实返回后，再根据它的结果向我说明有无可行顺序及原因，然后结束活动。' });
  const task = store.request({ type: 'activity.start', ...scope, sourceMessageId: source.id,
    clientId: 'real-thought-' + randomUUID(), title: '用DSH核对顺序约束', goal: source.content }).activityTask!;
  const ReportDatabase = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };
  const reportMessages = new ReportDatabase(path.join(dataRoot, 'messages.sqlite'), { readonly: true });
  const actualReport = () => {
    const row = reportMessages.prepare('SELECT id FROM messages WHERE client_id=?').get('activity_result_' + task.id) as { id: string } | undefined;
    if (!row) return undefined;
    return store.request({ type: 'memory.sources.filter', ...scope, ids: [row.id] }).memorySources?.find(message =>
      message.id === row.id && message.authorId === role.id && message.status === 'sent');
  };
  const service = new CompanionService({ userData: path.join(root, 'profile'), dataRoot, workerPath: 'in-process-port', window: () => undefined,
    memoryRuntime: memory.runtime, getConfig: () => config, hasConfig: () => true, dsh: () => bridge.launcher,
    report: error => failures.push(error instanceof Error ? error.message : String(error)) });
  const startedAt = new Date().toISOString();
  let status = 'failed', finalTask = task;
  let formalReport: CompanionMessage | undefined;
  let teardownFailure: unknown;
  try {
    await service.handle({ type: 'state' });
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      finalTask = store.request({ type: 'activity.get', ...scope, id: task.id }).activityTask!;
      formalReport = actualReport();
      if (['failed', 'cancelled'].includes(finalTask.status) || finalTask.status === 'succeeded' && formalReport) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const thoughtRecords = [];
    for (const record of native.broker.state()) {
      const recordScope = (await native.broker.recordMetadata(record.id)).scope;
      if (recordScope?.activityThought) thoughtRecords.push({ record, scope: recordScope });
    }
    expect(thoughtRecords.length).toBeGreaterThanOrEqual(1);
    for (const thought of thoughtRecords) expect(thought.scope.activityThought).toMatchObject({ taskId: task.id });
    const successful = thoughtRecords.filter(thought => thought.record.status === 'succeeded');
    expect(successful.length).toBeGreaterThanOrEqual(1);
    for (const thought of successful) {
      expect(thought.record).toMatchObject({ profile: { mode: 'native', tools: [], skills: [] },
        effective: { mode: 'native', toolCount: 0, skillCount: 0 } });
      expect(thought.record.sessionId).toBeTruthy();
      expect(thought.record.workspacePath?.startsWith(installed.sourceProfile.instance.workspacePath)).toBe(false);
    }
    expect(new Set(successful.map(thought => thought.record.sessionId)).size).toBe(successful.length);
    expect(new Set(successful.map(thought => thought.record.workspacePath)).size).toBe(successful.length);
    expect(bridge.telemetry().budgetExceeded, 'The explicit CLI acceptance budget is separate from product behavior.').toBe(false);
    expect(finalTask.status).toBe('succeeded');
    expect(formalReport?.content.trim(), 'Wait for the exact original activity report, not only the earlier terminal task row.').toBeTruthy();
    status = 'passed';
  } finally {
    for (const [label, close] of [['Main', () => service.shutdown()], ['Native DSH', () => bridge.close()], ['Native memory', () => memory.close()]] as const) {
      try { await close(); }
      catch (error) { teardownFailure ??= error; status = 'failed'; failures.push(`${label} shutdown failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    let after: Record<string, string> | undefined, sourceConfigurationUnchanged: boolean | undefined;
    try { after = await fingerprint(); sourceConfigurationUnchanged = await native.sourceConfigurationUnchanged(); }
    catch (error) { teardownFailure ??= error; failures.push(`Source guard failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (JSON.stringify(before) !== JSON.stringify(after) || sourceConfigurationUnchanged !== true) status = 'failed';
    try {
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, JSON.stringify({ status, root, startedAt, finishedAt: new Date().toISOString(), sourceId: source.id,
        sourceFingerprints: before, finishedSourceFingerprints: after, sourceConfigurationUnchanged,
        mainHttpRequests: port.mainHttp, mainHttpBudget: port.maxMainHttp, nativeDsh: bridge.telemetry(),
        originalProfileRoute: 'selected native provider/model/account unchanged; temporary credentials/session/record storage',
        finalTask, formalReport, actions: store.listAction(room.id), messages: store.messages({ conversationId: room.id, limit: 100 }).messages, failures }, null, 2));
    } finally { reportMessages.close(); store.close(); }
    expect(JSON.stringify(after)).toBe(JSON.stringify(before)); expect(sourceConfigurationUnchanged).toBe(true);
  }
  if (teardownFailure) throw teardownFailure;
}, 300000);
