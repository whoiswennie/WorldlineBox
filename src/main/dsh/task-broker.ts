import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { dshTaskInputSchema, dshTaskRecordSchema, dshTaskEventSchema, type DshTaskInput, type DshTaskRecord,
  type DshTaskResult, type DshTaskEvent } from '../../shared/dsh-tasks';
import { atomicJson, readJson } from './files';
import { sanitizeOutput } from './instance-process';
import type { OperationContext } from './operations';
import { snapshotDshTaskExecution, type DshTaskExecutionOptions } from './task-execution';
import { removeOwnedDirectory } from '../companions/owned-directory-cleanup';
import { DshTaskRecordStore } from './task-record-store';
import type { DshRecordQuery } from '../../shared/dsh-task-record';
import { dshTaskCapabilitiesSchema, type DshTaskCapabilities } from '../../shared/dsh-task-spec';
import type { DshInstance, DshRuntime } from '../../shared/dsh-launcher';
import { prepareDshTaskWorkspace } from './task-workspace';
import { assertDshResumeScope } from './task-scope';
import { compileDshDeliverySchema, verifyDshDelivery } from './task-delivery';
import type { NativeHostClient } from './native-host-client';
import { compileDshTaskPrompt } from './task-prompt';

export interface DshTaskBrokerOptions {
  rootPath: string;
  getHost(instanceId?: string, signal?: AbortSignal): Promise<{ instance: DshInstance; runtime: DshRuntime; client: NativeHostClient }>;
  onChanged?: () => void; onEvent?: (event: DshTaskEvent) => void;
}
export class DshTaskError extends Error { constructor(message: string, readonly result: DshTaskResult) { super(message); this.name = 'DshTaskError'; } }
type Active = { abort: AbortController; signal: AbortSignal; ready: Promise<void>; finished: Promise<void>; client?: NativeHostClient; sessionId?: string; submitted?: boolean; pendingInputs: Map<string, Promise<void>> };

/** Native DSH owns execution and saves; this broker keeps the partner's authorized audit projection. */
export class DshTaskBroker {
  private readonly archive: DshTaskRecordStore;
  private records: DshTaskRecord[] = [];
  private readonly results = new Map<string, DshTaskResult>();
  private readonly histories = new Map<string, DshTaskEvent[]>();
  private readonly active = new Map<string, Active>();
  private readonly pendingStops = new Map<string, { client: NativeHostClient; sessionId: string }>();
  private loading?: Promise<void>;
  private writes = Promise.resolve();
  private closed = false;
  constructor(private readonly options: DshTaskBrokerOptions) {
    this.archive = new DshTaskRecordStore(path.join(options.rootPath, 'task-records'), (id, error) => this.active.get(id)?.abort.abort(error));
  }
  readRecord(query: DshRecordQuery) { return this.archive.read(query); }
  recordMetadata(id: string) { return this.archive.metadata(id); }
  removeRecord(id: string) { return this.archive.remove(id); }
  async removeCompanionRecords(owner: string, jobId: string = randomUUID()) {
    await this.init();
    const owned: DshTaskRecord[] = [];
    for (const record of this.records) {
      const metadata = await this.archive.metadata(record.id).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return; throw error; });
      if (metadata?.scope?.companionId === owner) owned.push(record);
    }
    const groups = new Map<string, DshTaskRecord[]>();
    for (const record of owned) {
      if (this.active.has(record.id) || this.pendingStops.has(record.id)) throw new Error('伙伴仍有未停止的原生任务。');
      const group = groups.get(record.instanceId) ?? []; group.push(record); groups.set(record.instanceId, group);
    }
    const roots = new Set<string>();
    for (const [instanceId, records] of groups) {
      const managed = records.filter(record => {
        if (!record.taskWorkspaceRoot || !record.workspacePath) return false;
        const relative = path.relative(path.resolve(record.taskWorkspaceRoot, owner), path.resolve(record.workspacePath));
        return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      });
      // The deadline includes host startup/integrity checks, not just HTTP.
      // Keep the durable records for a safe retry when that host is unavailable.
      const signal = AbortSignal.timeout(120000);
      try {
        const { client } = await this.options.getHost(instanceId, signal);
        await client.request('/companions/reset', { sessionIds: [...new Set(records.flatMap(record => record.sessionId ? [record.sessionId] : []))],
          workspacePaths: [...new Set(managed.map(record => record.sessionWorkspacePath ?? record.workspacePath!))] }, signal);
      } catch (error) {
        if (signal.aborted) throw new Error('原生任务记录清理超时，请稍后继续重置。', { cause: error });
        throw error;
      }
      for (const record of managed) roots.add(record.taskWorkspaceRoot!);
    }
    for (const root of roots) await removeOwnedDirectory(root, owner, jobId);
    const ids = new Set(owned.map(record => record.id));
    this.records = this.records.filter(record => !ids.has(record.id));
    for (const id of ids) { this.results.delete(id); this.histories.delete(id); }
    await this.save();
    await this.archive.removeOwner(owner); this.changed();
  }
  state() { return this.records.map(record => ({ ...record })); }
  result(id: string) { const value = this.results.get(id); return value ? { ...value } : undefined; }
  events(id: string, after = -1) { return (this.histories.get(id) ?? []).filter(event => event.sequence > after).map(value => ({ ...value })); }
  private changed() { this.options.onChanged?.(); }
  private save() { const value = { format: 'worldlinebox-dsh-tasks-v1', records: this.state() }; const pending = this.writes.then(() => atomicJson(path.join(this.options.rootPath, 'tasks.json'), value)); this.writes = pending.catch(() => undefined); return pending; }
  init(): Promise<void> {
    return this.loading ??= (async () => {
      await mkdir(this.options.rootPath, { recursive: true });
      const stored = await readJson<{ format: string; records: unknown[] }>(path.join(this.options.rootPath, 'tasks.json'));
      if (stored) {
        if (stored.format !== 'worldlinebox-dsh-tasks-v1' || !Array.isArray(stored.records)) throw new Error('Unsupported task metadata.');
        this.records = stored.records.map(value => dshTaskRecordSchema.parse(value));
        for (const record of this.records) if (record.status === 'running') { record.status = 'interrupted'; record.finishedAt = new Date().toISOString(); record.error = 'The application exited before task completion.'; }
      }
      await this.save();
    })();
  }
  private async resume(input: DshTaskInput, execution: DshTaskExecutionOptions) {
    let previous = execution.resume;
    if (execution.task?.session?.mode === 'resume') previous ??= this.records.find(record => record.id === execution.task!.session!.taskId);
    if (!previous && (input.sessionId || execution.task?.session?.mode === 'resume')) throw new Error('A native Session requires an authorized task checkpoint.');
    if (!previous) return;
    const stored = this.records.find(record => record.id === previous!.id);
    if (!stored || !stored.sessionId || stored.status === 'running') throw new Error('The task checkpoint is unavailable or still running.');
    if ([...this.pendingStops.values()].some(value => value.sessionId === stored.sessionId)) throw new Error('Native Session cancellation is unconfirmed; confirm termination before resuming.');
    assertDshResumeScope((await this.archive.metadata(stored.id)).scope, execution.recordScope, execution.resumeScope);
    if (input.instanceId && input.instanceId !== stored.instanceId || input.sessionId && input.sessionId !== stored.sessionId) throw new Error('The Session checkpoint differs from the requested instance.');
    for (const key of ['mode', 'tools', 'skills'] as const) {
      const requested = execution.task?.[key], previousValue = stored.profile?.[key];
      const stable = (value: unknown) => JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
      if (requested !== undefined && stable(requested) !== stable(previousValue)) throw new Error('A continued Session retains its tool, skill and preset selection.');
    }
    if (execution.access && execution.access.mode !== stored.accessMode) throw new Error('A continued Session retains its native permission policy.');
    execution.task = { ...stored.profile, ...execution.task }; input.instanceId = stored.instanceId; input.sessionId = stored.sessionId; return stored;
  }
  async execute(inputValue: DshTaskInput, operation: OperationContext, executionValue?: DshTaskExecutionOptions): Promise<DshTaskResult> {
    const input = dshTaskInputSchema.parse(inputValue), execution = snapshotDshTaskExecution(executionValue);
    await this.init(); if (this.closed || this.active.size + this.pendingStops.size >= 20) throw new Error('The DSH broker is closing or at its concurrent task limit.');
    if (this.active.has(operation.id) || this.records.some(record => record.id === operation.id)) throw new Error('Task identity is already in use.');
    if (execution.cognitiveOnly && input.sessionId) throw new Error('A cognitive task requires a new Session.');
    compileDshDeliverySchema(execution.task?.delivery?.jsonSchema);
    const previous = await this.resume(input, execution), prompt = compileDshTaskPrompt(input, execution);
    if (previous && [...this.active.values()].some(value => value.sessionId === previous.sessionId)) throw new Error('This native Session already has an active owner.');
    const abort = new AbortController(), signal = AbortSignal.any([operation.signal, abort.signal, AbortSignal.timeout(input.timeoutMs ?? 600000)]);
    let release!: () => void, ready!: () => void, failReady!: (error: Error) => void;
    const active: Active = { abort, signal, ready: new Promise((resolve, reject) => { ready = resolve; failReady = reject; }),
      finished: new Promise(resolve => { release = resolve; }), sessionId: previous?.sessionId, pendingInputs: new Map() };
    void active.ready.catch(() => undefined);
    this.active.set(operation.id, active);
    let record: DshTaskRecord | undefined, result: DshTaskResult | undefined, sequence = 0, archived = false;
    const started = performance.now(); let retained = 0;
    const emit = (value: Omit<DshTaskEvent, 'taskId' | 'sequence' | 'receivedAt'>) => {
      const event = dshTaskEventSchema.parse({ ...value, taskId: operation.id, sequence: sequence++, receivedAt: new Date().toISOString() });
      if (event.text) event.text = sanitizeOutput(event.text);
      this.archive.append(operation.id, event); const error = this.archive.error(operation.id); if (error) throw error;
      const history = this.histories.get(operation.id) ?? []; history.push(event); retained += Buffer.byteLength(JSON.stringify(event));
      while (history.length > 1000 || retained > (input.maxOutputBytes ?? 16 * 1024 ** 2)) { const removed = history.shift(); if (!removed) break; retained -= Buffer.byteLength(JSON.stringify(removed)); }
      this.histories.set(operation.id, history); this.options.onEvent?.(event);
    };
    try {
      await this.archive.begin(operation.id, input.title ?? 'DSH task', execution.recordScope); archived = true;
      emit({ type: 'status', stage: 'preparing', summary: '正在连接所选实例的原生 Web Host' });
      const { instance, runtime, client } = await this.options.getHost(input.instanceId, signal); active.client = client;
      if (previous && previous.runtimeId !== runtime.id) throw new Error('The continued native Session requires its original DSH version.');
      signal.throwIfAborted();
      const workspace = previous?.workspacePath ? { workspacePath: await realpath(previous.workspacePath), taskWorkspaceRoot: previous.taskWorkspaceRoot }
        : await prepareDshTaskWorkspace(execution, operation.id, instance.workspacePath);
      let sessionId = input.sessionId ?? randomUUID(); active.sessionId = sessionId;
      const ownerRoot = execution.workspaceRootPath && execution.recordScope?.companionId
        ? path.resolve(execution.workspaceRootPath, execution.recordScope.companionId) : undefined;
      const relative = ownerRoot ? path.relative(ownerRoot, workspace.workspacePath) : undefined;
      const ownedWorkspace = relative !== undefined && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
      const workspaceTitle = ownedWorkspace && execution.task?.workspace?.mode !== 'existing' ? execution.companionName : undefined;
      // Native workspace membership requires an identical stored Session cwd.
      // Group by the stable owner directory; keep each invocation's output
      // directory separate and explicitly pass it to the executor and verifier.
      const sessionWorkspacePath = previous ? previous.sessionWorkspacePath ?? workspace.workspacePath
        : workspaceTitle ? await realpath(ownerRoot!) : workspace.workspacePath;
      const taskPrompt = sessionWorkspacePath === workspace.workspacePath ? prompt : prompt + '\n\n本次任务目录：' + workspace.workspacePath
        + '\n本会话归入该伙伴的统一工作区。先切换到上述任务目录再执行命令；相对路径、输出文件和临时文件均以本次任务目录为基准。其他并行任务使用其他目录，不覆盖或清理它们。返回交付文件的绝对路径。';
      if (Buffer.byteLength(taskPrompt) > 65536) throw new Error('Compiled DSH task and working directory exceed the input limit.');
      const preparation = performance.now();
      const session = await client.request<{ sessionId: string; cursor: number; capabilities: unknown; accessMode: DshTaskRecord['accessMode'] }>('/sessions', {
        sessionId, resume: !!previous, cwd: sessionWorkspacePath, ...(workspaceTitle ? { workspaceTitle } : {}), ...(execution.task?.mode === 'ptc' ? { preset: 'ptc' } : {}),
        policy: { tools: execution.task?.tools, skills: execution.task?.skills, cognitiveOnly: execution.cognitiveOnly },
        ...(previous ? {} : execution.access ? { accessMode: execution.access.mode } : {}),
      }, signal);
      if (previous && session.sessionId !== sessionId) throw new Error('Native resume returned a different Session identity.');
      sessionId = session.sessionId; active.sessionId = sessionId;
      const capabilities = dshTaskCapabilitiesSchema.parse({ ...session.capabilities as object, instanceId: instance.id, runtimeId: runtime.id,
        runtimeVersion: runtime.version, workspacePath: workspace.workspacePath, capturedAt: new Date().toISOString() });
      record = dshTaskRecordSchema.parse({ id: operation.id, operationId: operation.id, instanceId: instance.id, runtimeId: runtime.id, runtimeVersion: runtime.version,
        title: input.title ?? 'DSH task', status: 'running', accessMode: session.accessMode, ...workspace, sessionWorkspacePath, pid: client.pid, sessionId,
        profile: { mode: execution.task?.mode ?? 'native', tools: execution.task?.tools, skills: execution.task?.skills }, effective: capabilities.effective,
        constraintsDigest: execution.constraints ? createHash('sha256').update(JSON.stringify(execution.constraints)).digest('hex') : undefined, startedAt: new Date().toISOString() });
      this.records.unshift(record); while (this.records.length > 100) { const index = this.records.findLastIndex(value => value.status !== 'running'); if (index < 0) break; const removed = this.records.splice(index, 1)[0]!; this.results.delete(removed.id); this.histories.delete(removed.id); }
      result = { taskId: operation.id, instanceId: instance.id, runtimeId: runtime.id, runtimeVersion: runtime.version, sessionId, workspacePath: workspace.workspacePath,
        mode: capabilities.effective?.mode ?? execution.task?.mode ?? 'native', artifacts: [], effective: capabilities.effective };
      this.archive.execution(operation.id, { workspacePath: result.workspacePath, mode: result.mode, sessionId, artifacts: [], effective: result.effective,
        startup: { preparationMs: preparation - started, bootMs: performance.now() - preparation, reusedWorker: true } });
      await this.save(); this.changed(); emit({ type: 'ready', sessionId, stage: 'session', summary: '已接入原生 Web Host 会话' });
      await operation.update('Submitting task to the shared native Web Host', 10);
      active.submitted = true;
      await client.request(`/sessions/${sessionId}/prompt`, { prompt: taskPrompt }, signal);
      ready();
      for (const item of execution.inputs ?? []) await this.sendInput(operation.id, item.content, item.mode, item.id);
      let complete = false;
      for await (const event of client.events(sessionId, session.cursor, signal)) {
        if (event.type === 'complete') {
          result.text = sanitizeOutput(event.text ?? ''); result.artifacts = event.artifacts ?? []; complete = true;
          if (event.status !== 'succeeded') throw new Error(event.error ?? `Native task ${event.status}: ${event.reason?.kind ?? 'no completion reason'}`);
          emit({ type: 'final', text: result.text, stage: 'completed', summary: '原生会话执行完成' }); break;
        }
        emit(event);
      }
      if (!complete) throw new Error('Native task stream ended without completion.');
      if (execution.task?.delivery?.format === 'json') {
        try { result.structured = JSON.parse(result.text ?? ''); } catch { throw new Error('Native task did not return valid JSON delivery.'); }
      }
      await verifyDshDelivery(result, execution.task?.delivery, workspace.workspacePath, execution.allowedWorkspaceRoots, signal);
      this.archive.execution(operation.id, { artifacts: result.artifacts, verification: result.verification, ...(JSON.stringify(result.structured ?? '').length <= 16000 ? { structured: result.structured } : { structuredTruncated: true }) });
      record.status = 'succeeded'; record.code = 0; result.code = 0; this.results.set(operation.id, result);
      await this.archive.finish(operation.id, 'succeeded', record.startedAt); archived = false; return result;
    } catch (error) {
      // A failed transport must also cancel only the owned native Session, never its Host.
      let confirmed = true;
      if (active.submitted && active.client && active.sessionId) {
        try { await active.client.request(`/sessions/${active.sessionId}/cancel`, {}, AbortSignal.timeout(15000)); }
        catch { confirmed = false; this.pendingStops.set(operation.id, { client: active.client, sessionId: active.sessionId }); }
      }
      const message = sanitizeOutput(error instanceof Error ? error.message : String(error)) + (confirmed ? '' : ' Native Session cancellation is unconfirmed.');
      const status = confirmed ? signal.aborted ? 'cancelled' : 'failed' : 'interrupted';
      if (record) { record.status = status; record.error = message.slice(0, 1000); record.code = null; }
      if (result) { result.code = null; this.results.set(operation.id, result); }
      if (archived) { await this.archive.finish(operation.id, status, record?.startedAt, message).catch(() => undefined); archived = false; }
      if (result) throw new DshTaskError(message, result); throw error;
    } finally {
      failReady(new Error('The native task ended before accepting follow-up input.'));
      if (record) record.finishedAt = new Date().toISOString(); if (archived) await this.archive.finish(operation.id, 'failed', record?.startedAt).catch(() => undefined);
      this.active.delete(operation.id); release(); await this.save(); this.changed();
    }
  }
  async discover(instanceId?: string, execution?: DshTaskExecutionOptions): Promise<DshTaskCapabilities> {
    const { instance, runtime, client } = await this.options.getHost(instanceId);
    const sessionId = `worldlinebox-catalog-${instance.id}`;
    const value = await client.request<object>('/capabilities', { sessionId, cwd: instance.workspacePath, query: execution?.capabilityQuery });
    return dshTaskCapabilitiesSchema.parse({ ...value, instanceId: instance.id, runtimeId: runtime.id, runtimeVersion: runtime.version,
      workspacePath: instance.workspacePath, capturedAt: new Date().toISOString() });
  }
  async sendInput(taskId: string, content: string, mode: 'steer' | 'queue', messageId: string = randomUUID()): Promise<void> {
    const active = this.active.get(taskId);
    if (!active) throw new Error('The native task Session is not active.');
    if (!content.trim() || content.length > 16000 || !['steer', 'queue'].includes(mode)) throw new Error('Invalid task follow-up.');
    const accepted = active.pendingInputs.get(messageId); if (accepted) return accepted;
    if (active.pendingInputs.size >= 100) throw new Error('The task follow-up limit was reached.');
    const receipt = (async () => {
      await active.ready; active.signal.throwIfAborted();
      if (this.active.get(taskId) !== active || !active.client || !active.sessionId) throw new Error('The native task Session has ended.');
      await active.client.request(`/sessions/${active.sessionId}/prompt`, { prompt: content, mode, messageId }, AbortSignal.any([active.signal, AbortSignal.timeout(30000)]));
    })();
    active.pendingInputs.set(messageId, receipt);
    try { await receipt; } catch (error) { active.pendingInputs.delete(messageId); throw error; }
  }
  cancel(taskId: string) { this.active.get(taskId)?.abort.abort(new Error('DSH task cancelled.')); }
  async terminate(taskId: string) {
    const task = this.active.get(taskId); if (task) { this.cancel(taskId); await task.finished; }
    const pending = this.pendingStops.get(taskId); if (!pending) return;
    await pending.client.request(`/sessions/${pending.sessionId}/cancel`, {}, AbortSignal.timeout(15000));
    this.pendingStops.delete(taskId); const record = this.records.find(value => value.id === taskId);
    if (record) { record.status = 'cancelled'; delete record.error; await this.save(); this.changed(); }
  }
  async shutdown() { this.closed = true; for (const id of this.active.keys()) this.cancel(id); await Promise.allSettled([...this.active.values()].map(value => value.finished)); await this.writes; }
}
