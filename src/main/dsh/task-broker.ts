import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dshTaskInputSchema, dshTaskRecordSchema, dshTaskSessionIdSchema, type DshTaskInput, type DshTaskRecord,
  type DshTaskResult, type DshTaskEvent } from '../../shared/dsh-tasks';
import type { DshCliSelection } from './cli-terminal';
import { lstat, mkdir, open, rm, realpath } from './disk';
import { atomicJson, readJson } from './files';
import { launchCli, sanitizeOutput, terminateOwnedProcess } from './instance-process';
import type { OperationContext } from './operations';
import { dshTaskExecutionPatch, snapshotDshTaskExecution, type DshTaskExecutionOptions } from './task-execution';
import { randomUUID } from 'node:crypto';
import { companionRuntimeSource } from './companion-runtime-source';
import { runtimeSdkRoot } from './runtime-sdk';
import { DshTaskPreparationError } from './task-preparation';
import { DshTaskInput as DshTaskInbox } from './task-input';

const LINE_LIMIT = 1024 * 1024;
const EVENT_LIMIT = 1000;
const RETAIN_LIMIT = 16 * 1024 ** 2;
const MAX_TASKS = 100;
async function realpathResumeWorkspace(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error('The original task workspace is not absolute.');
  const resolved = await realpath(value);
  if (!(await lstat(resolved)).isDirectory()) throw new Error('The original task workspace is unavailable.');
  return resolved;
}
type DshTaskProgress = Pick<DshTaskEvent, 'stage' | 'toolName' | 'summary'>;
const SECRET_IDENTIFIER = /(?:^|[_./:-])(?:sk-|ghp_|github_pat_|bearer[_:-]|api[_-]?key[_:=]|access[_-]?token[_:=]|secret[_:=])/i;

/** Identifier metadata is allowed; arbitrary display text, paths and credentials are not. */
function progressToolName(value: unknown, privateValues: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(value) || SECRET_IDENTIFIER.test(value)) return;
  if (privateValues.some(secret => secret.length >= 4 && value.includes(secret))) return;
  return value;
}

/**
 * Both inspected official SDKs (0.2.0-rc.2 / 0.2.1-alpha.2) project the same
 * tool_call {callId,tool,input} and tool_result {callId,status,result} shapes.
 * Keep the original event type; stage provides the user-facing start/end state.
 * Summaries are generated from protocol states; the broker separately redacts
 * public text and tool data for live progress. Reasoning never enters progress.
 */
export function normalizeDshTaskProgress(value: Record<string, unknown>, pendingTools: Map<string, string>,
  privateValues: readonly string[] = []): DshTaskProgress {
  const callId = typeof value.callId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value.callId) ? value.callId : undefined;
  switch (value.type) {
    case 'text': return { stage: 'message', summary: '能力正在输出' };
    case 'text_stream': return { stage: 'message', summary: '能力正在流式输出' };
    case 'tool_stream': return { stage: 'tool_prepare', toolName: progressToolName(value.tool, privateValues), summary: '正在生成调用参数，尚未执行' };
    case 'input_accepted': return { stage: 'message', summary: value.mode === 'steer' ? '补充已进入下一步' : value.mode === 'queue' ? '消息已进入下一轮队列' : '任务已进入 agent loop' };
    case 'session': return dshTaskSessionIdSchema.safeParse(value.sessionId).success ? { stage: 'session', summary: '执行环境已连接' } : {};
    case 'tool_call': {
      const toolName = progressToolName(value.tool, privateValues);
      if (callId && toolName) {
        // Bound uncompleted correlation state independently of retained events.
        if (pendingTools.size < EVENT_LIMIT || pendingTools.has(callId)) pendingTools.set(callId, toolName);
      }
      return { stage: 'tool_start', ...(toolName ? { toolName } : {}), summary: '开始调用工具' };
    }
    case 'tool_result': {
      const toolName = callId ? pendingTools.get(callId) : undefined;
      if (callId) pendingTools.delete(callId);
      return { stage: 'tool_end', ...(toolName ? { toolName } : {}),
        summary: value.status === 'error' ? '工具执行失败' : value.status === 'completed' ? '工具执行完成' : '工具调用结束' };
    }
    case 'status': {
      const step = Number.isSafeInteger(value.step) && Number(value.step) >= 1 && Number(value.step) <= 1_000_000 ? Number(value.step) : undefined;
      switch (value.phase) {
        case 'turn_start': return { stage: 'turn_start', summary: '开始处理任务' };
        case 'step_start': return { stage: 'step_start', summary: step === undefined ? '开始下一步处理' : `开始第 ${step} 步处理` };
        case 'step_end': return { stage: 'step_end', summary: step === undefined ? '当前处理步骤结束' : `第 ${step} 步处理结束` };
        case 'turn_end': {
          const reason = value.reason && typeof value.reason === 'object' && !Array.isArray(value.reason) ? value.reason as Record<string, unknown> : undefined;
          return { stage: 'turn_end', summary: reason?.kind === 'error' ? '本轮处理遇到错误' : '本轮处理结束' };
        }
        default: return {};
      }
    }
    case 'final': return typeof value.text === 'string' ? { stage: 'completed', summary: '执行器已返回结果' } : {};
    case 'error': return { stage: 'failed', summary: '执行器报告错误' };
    default: return {};
  }
}
export interface DshTaskPin { contextFile: string; dispose(): Promise<void> | void }
export interface DshTaskBrokerOptions {
  rootPath: string; getSelection(instanceId?: string, signal?: AbortSignal, resume?: DshTaskRecord,
    preparation?: { progress(summary: string): void }): Promise<DshCliSelection>; pin(selection: DshCliSelection): Promise<DshTaskPin>;
  onChanged?: () => void; onEvent?: (event: DshTaskEvent) => void;
}
export class DshTaskError extends Error { constructor(message: string, readonly result: DshTaskResult) { super(message); this.name = 'DshTaskError'; } }
/** Every task pins one selected runtime and private profile before any child starts. Selection changes affect later tasks. */
export class DshTaskBroker {
  private records: DshTaskRecord[] = [];
  private readonly results = new Map<string, DshTaskResult>();
  private readonly histories = new Map<string, DshTaskEvent[]>();
  private readonly active = new Map<string, { abort: AbortController; finished: Promise<void>; input?: DshTaskInbox; terminate?: () => Promise<void> }>();
  private readonly unconfirmedStops = new Map<string, () => Promise<void>>();
  private readonly resumedSessions = new Set<string>();
  private reservations = 0;
  private loaded = false;
  private loadTask?: Promise<void>;
  private writes = Promise.resolve();
  private closed = false;
  constructor(private readonly options: DshTaskBrokerOptions) {}
  state(): DshTaskRecord[] { return this.records.map(record => ({ ...record })); }
  result(taskId: string): DshTaskResult | undefined { const result = this.results.get(taskId); return result ? { ...result } : undefined; }
  events(taskId: string, after = -1): DshTaskEvent[] { return (this.histories.get(taskId) ?? []).filter(event => event.sequence > after).map(event => ({ ...event })); }
  private changed(): void { try { this.options.onChanged?.(); } catch { /* UI teardown cannot interrupt an owned process cleanup. */ } }
  private save(): Promise<void> {
    const value = { format: 'worldlinebox-dsh-tasks-v1', records: this.state() };
    const write = this.writes.then(() => atomicJson(path.join(this.options.rootPath, 'tasks.json'), value));
    this.writes = write.catch(() => undefined); return write;
  }
  init(): Promise<void> {
    if (this.loaded) return Promise.resolve(); if (this.loadTask) return this.loadTask;
    this.loadTask = (async () => {
      await mkdir(this.options.rootPath, { recursive: true }); if ((await lstat(this.options.rootPath)).isSymbolicLink()) throw new Error('Task storage cannot be linked.');
      const file = path.join(this.options.rootPath, 'tasks.json'); const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)) throw new Error('Saved task metadata is linked or exceeds the limit.');
      const stored = await readJson<{ format?: unknown; records?: unknown }>(file);
      if (stored) {
        if (stored.format !== 'worldlinebox-dsh-tasks-v1' || !Array.isArray(stored.records) || stored.records.length > MAX_TASKS) throw new Error('Saved task metadata is unsupported; the original file was preserved.');
        this.records = stored.records.map(value => dshTaskRecordSchema.parse(value));
        for (const record of this.records) if (record.status === 'running') { record.status = 'interrupted'; record.finishedAt = new Date().toISOString(); record.error = 'The application exited before the task completed.'; }
      }
      await this.save(); this.loaded = true;
    })();
    return this.loadTask;
  }
  async execute(inputValue: DshTaskInput, operation: OperationContext, executionValue?: DshTaskExecutionOptions): Promise<DshTaskResult> {
    const input = dshTaskInputSchema.parse(inputValue);
    const execution = snapshotDshTaskExecution(executionValue);
    let secrets: string[] = [];
    const resume = execution.resume;
    if (resume && (!resume.sessionId || resume.sessionId !== input.sessionId || resume.instanceId !== input.instanceId || !resume.accessMode || resume.accessMode !== execution.access?.mode || resume.status === 'running')) throw new Error('The resume checkpoint does not match its recorded task, session and access policy.');
    if (execution.access && input.sessionId && !resume) throw new Error('Existing DSH sessions retain their recorded access policy. Start a fresh task to apply this snapshot.');
    if (resume?.sessionId && (this.resumedSessions.has(resume.sessionId) || this.records.some(record => record.status === 'running' && record.sessionId === resume.sessionId))) throw new Error('This native task session already has a running owner.');
    const containsTaskSecret = (value: string) => secrets.some(secret => value.includes(secret));
    const sanitizeTaskOutput = (value: string) => sanitizeOutput(secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value));
    if (Buffer.byteLength(input.prompt) > 65536) throw new Error('The task prompt exceeds its UTF-8 size limit.');
    if (this.closed) throw new Error('The DSH task broker is closing.');
    if (this.reservations >= 20) throw new Error('Twenty DSH tasks are already running. Wait for one to finish.');
    if (this.active.has(operation.id) || this.records.some(record => record.id === operation.id)) throw new Error('This task operation identity is already in use.');
    this.reservations++;
    if (resume?.sessionId) this.resumedSessions.add(resume.sessionId);
    const abort = new AbortController(); let resolveFinished!: () => void; const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    const taskInput = execution.interactive ? new DshTaskInbox() : undefined;
    this.active.set(operation.id, { abort, finished, input: taskInput });
    let pin: DshTaskPin | undefined; let record: DshTaskRecord | undefined; let child: Awaited<ReturnType<typeof launchCli>> | undefined;
    let taskPatch: string | undefined;
    let runtimePlugin: string | undefined;
    let stopUnconfirmed = false;
    const releaseContext = async () => {
      try {
        if (taskPatch) await rm(taskPatch, { force: true });
        if (runtimePlugin) await rm(runtimePlugin, { force: true });
        if (pin) await pin.dispose();
      } catch { await operation.log('The completed task context could not be removed; cleanup was deferred.').catch(() => undefined); }
    };
    const signal = AbortSignal.any([operation.signal, abort.signal, AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000)]);
    let result: DshTaskResult | undefined; let taskFailed = false; let outputError: Error | undefined; let saveError = false;
    let sequence = 0; let retained = 0;
    this.histories.set(operation.id, []);
    const publish = (event: DshTaskEvent) => {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (retained + bytes > RETAIN_LIMIT) return;
      retained += bytes;
      const history = this.histories.get(operation.id)!;
      history.push(event); if (history.length > EVENT_LIMIT) history.shift();
      try { this.options.onEvent?.({ ...event }); } catch { /* UI teardown cannot stop the task. */ }
    };
    const preparation = (stage: 'preparing' | 'starting', summary: string) => {
      if (execution.toolkit) publish({ taskId: operation.id, sequence: sequence++, type: stage, stage, summary, receivedAt: new Date().toISOString() });
    };
    try {
      await this.init(); signal.throwIfAborted();
      preparation('preparing', '正在读取所选 DSH 实例的 CLI 配置');
      const selection = await this.options.getSelection(input.instanceId, signal, resume, {
        progress: summary => preparation('preparing', summary),
      }); signal.throwIfAborted();
      const captured: DshCliSelection = { ...selection, instance: { ...selection.instance }, plan: { ...selection.plan, env: { ...selection.plan.env } }, env: { ...selection.env }, nativeArgs: selection.nativeArgs ? [...selection.nativeArgs] : undefined };
      secrets = Object.entries(captured.env).filter(([name, value]) => /(?:key|token|secret|password|authorization)/i.test(name) && value && value.length >= 6).map(([, value]) => value!);
      if (input.instanceId && captured.instance.id !== input.instanceId) throw new Error('The task selection differs from its requested instance binding.');
      const version = captured.runtimeVersion ?? ''; if (!version) throw new Error('The selected CLI context has no recorded runtime version.');
      if (resume) {
        if (captured.instance.runtimeId !== resume.runtimeId || version !== resume.runtimeVersion) throw new Error('The original task runtime is unavailable; the existing session was preserved.');
        if (resume.workspacePath) captured.workspacePath = await realpathResumeWorkspace(resume.workspacePath);
      }
      if ((execution.toolkit || execution.access || execution.interactive)
        && captured.runtime?.id !== captured.instance.runtimeId) throw new DshTaskPreparationError('selection', 'CLI 任务的运行版本与所选实例不一致，任务尚未启动。');
      preparation('preparing', '正在绑定当前实例的 CLI 任务与权限');
      pin = await this.options.pin(captured); signal.throwIfAborted();
      if (execution.toolkit || execution.access || execution.interactive) {
        const directory = path.dirname(pin.contextFile);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The task-control patch directory is not managed.');
        const filename = path.join(directory, `${randomUUID()}-task.patch.json`);
        const handle = await open(filename, 'wx', 0o600);
        taskPatch = filename;
        try {
          const patch: unknown[] = dshTaskExecutionPatch(execution, captured.workspacePath);
          if (execution.interactive) {
            const sdk = await runtimeSdkRoot(path.join(this.options.rootPath, 'runtimes', captured.instance.runtimeId, 'program'));
            runtimePlugin = path.join(directory, `${randomUUID()}-agent.mjs`);
            const plugin = await open(runtimePlugin, 'wx', 0o600);
            try { await plugin.writeFile(companionRuntimeSource(path.join(sdk, '@deepseek-ai/dsh/package.json'), resume?.sessionId, resume?.sessionId ? { id: operation.id, prompt: input.prompt, inputs: execution.inputs ?? [] } : undefined), 'utf8'); } finally { await plugin.close(); }
            patch.push({ id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true },
              { insert: [{ id: 'worldlinebox-companion-runtime', name: runtimePlugin }] });
          }
          await handle.writeFile(JSON.stringify(patch), 'utf8');
        }
        finally { await handle.close(); }
        signal.throwIfAborted();
      }
      record = dshTaskRecordSchema.parse({ id: operation.id, operationId: operation.id, instanceId: captured.instance.id, runtimeId: captured.instance.runtimeId,
        runtimeVersion: version, title: sanitizeTaskOutput(input.title ?? 'DSH task').slice(0, 100), status: 'running', accessMode: execution.access?.mode,
        workspacePath: captured.workspacePath, sessionId: input.sessionId && !containsTaskSecret(input.sessionId) ? input.sessionId : undefined, startedAt: new Date().toISOString() });
      this.records.unshift(record); this.prune(); await this.save(); this.changed();
      result = { taskId: record.id, instanceId: record.instanceId, runtimeId: record.runtimeId, runtimeVersion: version, sessionId: record.sessionId };
      await operation.update('Starting the task in its pinned DSH environment', 10);
      // The shim appends input after its shared model overlay. Keep this task's
      // last routing overlay before --json starts native app option parsing.
      const args = [...(taskPatch ? ['--patch', taskPatch] : []), ...(execution.interactive ? [] : ['--json', ...(record.sessionId ? ['--session-id', record.sessionId] : []), '-'])];
      child = await launchCli({ executable: process.execPath, cli: path.join(this.options.rootPath, 'cli', 'shim.cjs'), env: {} }, args,
        { ...captured.env, ELECTRON_RUN_AS_NODE: '1', WORLDLINEBOX_DSH_CLI_CONTEXT: pin.contextFile }, captured.workspacePath);
      preparation('starting', '能力进程已启动，正在加载任务环境');
      const selectedChild = child; const stop = () => {
        taskInput?.cancel();
        const terminate = () => { void terminateOwnedProcess(selectedChild).catch(() => undefined); };
        if (taskInput) setTimeout(terminate, 250); else terminate();
      };
      this.active.get(operation.id)!.terminate = () => terminateOwnedProcess(selectedChild);
      record.pid = child.pid; await this.save(); this.changed();
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      const decoder = new StringDecoder('utf8'); let pending = ''; let received = 0; let hasFinal = false;
      const pendingTools = new Map<string, string>();
      const privateProgressValues = [input.prompt, ...Object.values(captured.env).filter((value): value is string => typeof value === 'string' && value.length >= 6)];
      const safeProgressText = (input: unknown, live = false): string => {
        const serialized = typeof input === 'string' ? input : JSON.stringify(input, (key, value) =>
          /^(?:env|environment|headers|authorization|api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token|base64|bytes)$/i.test(key) ? '[redacted]' : value);
        let output = sanitizeTaskOutput(serialized ?? '');
        for (const secret of secrets) output = output.replaceAll(secret, '[redacted]');
        // Token snapshots must not publish a partial private key at their tail.
        for (const secret of live ? secrets : []) {
          for (let length = Math.min(secret.length - 1, output.length); length > 0; length--) {
            if (output.endsWith(secret.slice(0, length))) { output = output.slice(0, -length); break; }
          }
        }
        return output.replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[image data]').slice(0, 16000);
      };
      const rejectOutput = (message: string) => { if (!outputError) outputError = new Error(message); stop(); };
      const event = (line: string) => {
        if (Buffer.byteLength(line) > LINE_LIMIT) { rejectOutput('A DSH task event exceeded the one MiB line limit.'); return; }
        let payload: unknown; try { payload = JSON.parse(line); } catch { return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return; const value = payload as Record<string, unknown>;
        taskInput?.receive(value);
        const type = typeof value.type === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$/.test(value.type) && !containsTaskSecret(value.type) ? value.type : 'unknown';
        const safe: DshTaskEvent = { taskId: record!.id, sequence: sequence++, type, receivedAt: new Date().toISOString(),
          ...normalizeDshTaskProgress(value, pendingTools, privateProgressValues) };
        if (['tool_call', 'tool_result', 'text', 'text_stream', 'tool_stream'].includes(type)) {
          const content = type === 'tool_call' ? value.input : type === 'tool_result' ? value.result : value.text;
          if (content !== undefined && !(typeof content === 'string' && /<(?:think|analysis|reasoning)>/i.test(content))) {
            safe.text = safeProgressText(content, type === 'text_stream' || type === 'tool_stream');
            safe.contentKind = type === 'tool_call' || type === 'tool_stream' ? 'input' : type === 'tool_result' ? 'output' : 'message';
          }
          if (typeof value.callId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value.callId) && !containsTaskSecret(value.callId)) safe.callId = value.callId;
          if (typeof value.streamId === 'string' && /^(?:stream|tool_stream)_[0-9]{1,8}(?:_[0-9]{1,8})?$/.test(value.streamId)) safe.streamId = value.streamId;
          if (['draft', 'committed', 'abandoned'].includes(String(value.outputState))) safe.outputState = value.outputState as DshTaskEvent['outputState'];
        }
        if (type === 'session') {
          const sessionId = dshTaskSessionIdSchema.safeParse(value.sessionId).data;
          if (sessionId && !containsTaskSecret(sessionId)) { safe.sessionId = sessionId; record!.sessionId = sessionId; result!.sessionId = sessionId;
            void this.save().catch(() => { saveError = true; }); this.changed(); }
        }
        if (type === 'final' && typeof value.text === 'string') {
          const text = sanitizeTaskOutput(value.text); if (Buffer.byteLength(text) > LINE_LIMIT || text.length > LINE_LIMIT) { rejectOutput('The final DSH reply exceeded the one MiB result limit.'); return; }
          safe.text = text; result!.text = text; hasFinal = true;
        }
        if (type === 'error') {
          taskFailed = true;
          if (typeof value.code === 'string' && /^[A-Za-z0-9_./:-]{1,100}$/.test(value.code) && !containsTaskSecret(value.code)) safe.code = value.code;
          if (value.code === 'task/startup' && typeof value.message === 'string') { safe.text = safeProgressText(value.message).slice(0, 1000); safe.contentKind = 'output'; }
        }
        // Only explicitly projected/redacted fields enter the stream; no raw stderr or reasoning.
        publish(safe);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        received += chunk.length; if (received > (input.maxOutputBytes ?? RETAIN_LIMIT)) { rejectOutput('The DSH task output exceeded its configured limit.'); return; }
        pending += decoder.write(chunk); let newline = pending.indexOf('\n');
        while (newline >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); event(line); newline = pending.indexOf('\n'); }
        if (Buffer.byteLength(pending) > LINE_LIMIT) rejectOutput('An unterminated DSH task event exceeded the one MiB line limit.');
      });
      // stderr is drained, but never persisted: plugins may print the prompt, arguments or credentials.
      child.stderr.resume(); child.stdin.on('error', () => { if (!signal.aborted) rejectOutput('The DSH task input pipe closed unexpectedly.'); });
      if (taskInput) taskInput.begin(child, input.prompt, execution.inputs, operation.id); else child.stdin.end(input.prompt, 'utf8');
      try {
        const code = await new Promise<number | null>((resolve, reject) => { selectedChild.once('error', reject); selectedChild.once('close', resolve); });
        pending += decoder.end(); if (pending && !outputError) event(pending);
        result.code = code; record.code = code; signal.throwIfAborted(); if (outputError) throw outputError;
        if (code !== 0 || taskFailed || !hasFinal) throw new Error(code !== 0 ? `The pinned DSH task failed (exit ${code ?? 'unknown'}).` : taskFailed ? 'The selected DSH runtime returned a task error.' : 'The DSH task ended without a final structured reply.');
      } finally { signal.removeEventListener('abort', stop); await terminateOwnedProcess(selectedChild); }
      if (saveError) throw new Error('Task metadata could not be saved.');
      record.status = 'succeeded'; record.finishedAt = new Date().toISOString(); this.results.set(record.id, { ...result }); await this.save(); this.changed(); return { ...result };
    } catch (error) {
      if (child) try { await terminateOwnedProcess(child); }
      catch {
        stopUnconfirmed = true;
        const owned = child;
        // Retain this exact child/Job and its pin for a later explicit retry;
        // terminal journal status is never an OS-process lifetime proof.
        this.unconfirmedStops.set(operation.id, async () => { await terminateOwnedProcess(owned); await releaseContext(); });
      }
      if (record && result) {
        record.status = stopUnconfirmed ? 'failed' : signal.aborted ? 'cancelled' : 'failed'; record.finishedAt = new Date().toISOString();
        record.error = stopUnconfirmed ? 'The owned DSH task processes could not be confirmed stopped. Retry termination before releasing task data.'
          : signal.aborted ? 'The DSH task was cancelled or reached its time limit.' : outputError?.message ?? (error instanceof Error && /^(The pinned DSH task failed|The selected DSH runtime returned|The DSH task ended without|Task metadata could not)/.test(error.message) ? error.message : 'The DSH task could not complete in its selected environment.');
        this.results.set(record.id, { ...result }); await this.save().catch(() => undefined); this.changed(); throw new DshTaskError(record.error, { ...result });
      }
      const detail = signal.aborted ? '任务在 CLI 启动前已取消或超时。'
        : error instanceof DshTaskPreparationError ? sanitizeTaskOutput(error.message).slice(0, 1000)
          : 'DSH CLI 启动前的配置读取或任务绑定失败，执行进程尚未启动。请检查所选实例的运行文件与访问权限。';
      await operation.log(detail).catch(() => undefined);
      if (execution.toolkit) publish({ taskId: operation.id, sequence: sequence++, type: 'error', stage: 'failed',
        code: `task/preparation/${error instanceof DshTaskPreparationError ? error.code : 'unknown'}`, summary: detail, receivedAt: new Date().toISOString() });
      throw new Error(detail, { cause: error });
    } finally {
      try { if (!stopUnconfirmed) await releaseContext(); }
      finally { taskInput?.close(); this.active.delete(operation.id); this.reservations--; if (resume?.sessionId) this.resumedSessions.delete(resume.sessionId); resolveFinished(); }
    }
  }
  private prune(): void {
    while (this.records.length > MAX_TASKS) {
      const index = this.records.findLastIndex(record => record.status !== 'running'); if (index < 0) break;
      const [removed] = this.records.splice(index, 1); if (removed) { this.results.delete(removed.id); this.histories.delete(removed.id); }
    }
  }
  cancel(taskId: string): void { const task = this.active.get(taskId); if (!task) throw new Error('This DSH task is no longer running.'); task.abort.abort(new Error('Task cancelled.')); }
  async terminate(taskId: string): Promise<void> {
    const task = this.active.get(taskId);
    const retry = this.unconfirmedStops.get(taskId);
    // The journal is a bounded display history. Its absence or terminal label
    // cannot hide an owned cleanup callback, and an absent owner needs no kill.
    if (!task && !retry) return;
    task?.abort.abort(new Error('User terminated the CLI process.'));
    await task?.terminate?.();
    // Preparation may not have created a process yet. Wait until its abort
    // checks, final journal and pin disposal have all completed as well.
    await task?.finished;
    const remaining = this.unconfirmedStops.get(taskId);
    if (remaining) { await remaining(); this.unconfirmedStops.delete(taskId); }
  }
  async sendInput(taskId: string, content: string, mode: 'steer' | 'queue', messageId?: string): Promise<void> {
    const input = this.active.get(taskId)?.input;
    if (!input) throw new Error('This task has no active input inbox.');
    await input.send(content, mode, messageId);
  }
  async shutdown(): Promise<void> {
    this.closed = true; for (const task of this.active.values()) task.abort.abort(new Error('Application closing.'));
    await Promise.all([...this.active.values()].map(task => task.finished));
    for (const [id, stop] of this.unconfirmedStops) { await stop(); this.unconfirmedStops.delete(id); }
    await this.writes;
  }
}
