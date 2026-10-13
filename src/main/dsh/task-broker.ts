import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dshTaskInputSchema, dshTaskRecordSchema, dshTaskSessionIdSchema, type DshTaskInput, type DshTaskRecord,
  type DshTaskResult, type DshTaskEvent } from '../../shared/dsh-tasks';
import type { DshCliSelection } from './cli-terminal';
import { lstat, mkdir } from './disk';
import { atomicJson, readJson } from './files';
import { launchCli, sanitizeOutput, terminateOwnedProcess } from './instance-process';
import type { OperationContext } from './operations';

const LINE_LIMIT = 1024 * 1024;
const EVENT_LIMIT = 1000;
const RETAIN_LIMIT = 16 * 1024 ** 2;
const MAX_TASKS = 100;
export interface DshTaskPin { contextFile: string; dispose(): Promise<void> | void }
export interface DshTaskBrokerOptions {
  rootPath: string; getSelection(instanceId?: string, signal?: AbortSignal): Promise<DshCliSelection>; pin(selection: DshCliSelection): Promise<DshTaskPin>;
  onChanged?: () => void; onEvent?: (event: DshTaskEvent) => void;
}
export class DshTaskError extends Error { constructor(message: string, readonly result: DshTaskResult) { super(message); this.name = 'DshTaskError'; } }
/** Every task pins one selected runtime and private profile before any child starts. Selection changes affect later tasks. */
export class DshTaskBroker {
  private records: DshTaskRecord[] = [];
  private readonly results = new Map<string, DshTaskResult>();
  private readonly histories = new Map<string, DshTaskEvent[]>();
  private readonly active = new Map<string, { abort: AbortController; finished: Promise<void> }>();
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
  async execute(inputValue: DshTaskInput, operation: OperationContext): Promise<DshTaskResult> {
    const input = dshTaskInputSchema.parse(inputValue);
    if (Buffer.byteLength(input.prompt) > 65536) throw new Error('The task prompt exceeds its UTF-8 size limit.');
    if (this.closed) throw new Error('The DSH task broker is closing.');
    if (this.reservations >= 4) throw new Error('Four DSH tasks are already running. Wait for one to finish.');
    if (this.active.has(operation.id) || this.records.some(record => record.id === operation.id)) throw new Error('This task operation identity is already in use.');
    this.reservations++;
    const abort = new AbortController(); let resolveFinished!: () => void; const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
    this.active.set(operation.id, { abort, finished });
    let pin: DshTaskPin | undefined; let record: DshTaskRecord | undefined; let child: Awaited<ReturnType<typeof launchCli>> | undefined;
    const signal = AbortSignal.any([operation.signal, abort.signal, AbortSignal.timeout(input.timeoutMs ?? 30 * 60_000)]);
    let result: DshTaskResult | undefined; let taskFailed = false; let outputError: Error | undefined; let saveError = false;
    try {
      await this.init(); signal.throwIfAborted();
      const selection = await this.options.getSelection(input.instanceId, signal); signal.throwIfAborted();
      const captured: DshCliSelection = { ...selection, instance: { ...selection.instance }, plan: { ...selection.plan, env: { ...selection.plan.env } }, env: { ...selection.env }, nativeArgs: selection.nativeArgs ? [...selection.nativeArgs] : undefined };
      if (input.instanceId && captured.instance.id !== input.instanceId) throw new Error('The task selection differs from its requested instance binding.');
      const version = captured.runtimeVersion ?? ''; if (!version) throw new Error('The selected CLI context has no recorded runtime version.');
      pin = await this.options.pin(captured); signal.throwIfAborted();
      record = dshTaskRecordSchema.parse({ id: operation.id, operationId: operation.id, instanceId: captured.instance.id, runtimeId: captured.instance.runtimeId,
        runtimeVersion: version, title: sanitizeOutput(input.title ?? 'DSH task').slice(0, 100), status: 'running', sessionId: input.sessionId, startedAt: new Date().toISOString() });
      this.records.unshift(record); this.prune(); this.histories.set(record.id, []); await this.save(); this.changed();
      result = { taskId: record.id, instanceId: record.instanceId, runtimeId: record.runtimeId, runtimeVersion: version, sessionId: input.sessionId };
      await operation.update('Starting the task in its pinned DSH environment', 10);
      const args = ['--json', ...(input.sessionId ? ['--session-id', input.sessionId] : []), '-'];
      child = await launchCli({ executable: process.execPath, cli: path.join(this.options.rootPath, 'cli', 'shim.cjs'), env: {} }, args,
        { ...captured.env, ELECTRON_RUN_AS_NODE: '1', WORLDLINEBOX_DSH_CLI_CONTEXT: pin.contextFile }, captured.workspacePath);
      const selectedChild = child; const stop = () => { void terminateOwnedProcess(selectedChild).catch(() => undefined); };
      signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
      const decoder = new StringDecoder('utf8'); let pending = ''; let received = 0; let retained = 0; let sequence = 0; let hasFinal = false;
      const rejectOutput = (message: string) => { if (!outputError) outputError = new Error(message); stop(); };
      const event = (line: string) => {
        if (Buffer.byteLength(line) > LINE_LIMIT) { rejectOutput('A DSH task event exceeded the one MiB line limit.'); return; }
        let payload: unknown; try { payload = JSON.parse(line); } catch { return; }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return; const value = payload as Record<string, unknown>;
        const type = typeof value.type === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,99}$/.test(value.type) ? value.type : 'unknown';
        const safe: DshTaskEvent = { taskId: record!.id, sequence: sequence++, type, receivedAt: new Date().toISOString() };
        if (type === 'session') {
          const sessionId = dshTaskSessionIdSchema.safeParse(value.sessionId).data;
          if (sessionId) { safe.sessionId = sessionId; record!.sessionId = sessionId; result!.sessionId = sessionId;
            void this.save().catch(() => { saveError = true; }); this.changed(); }
        }
        if (type === 'final' && typeof value.text === 'string') {
          const text = sanitizeOutput(value.text); if (Buffer.byteLength(text) > LINE_LIMIT || text.length > LINE_LIMIT) { rejectOutput('The final DSH reply exceeded the one MiB result limit.'); return; }
          safe.text = text; result!.text = text; hasFinal = true;
        }
        if (type === 'error') { taskFailed = true; if (typeof value.code === 'string' && /^[A-Za-z0-9_./:-]{1,100}$/.test(value.code)) safe.code = value.code; }
        // User messages, tool arguments, env maps and raw error bodies never enter retained events.
        const bytes = Buffer.byteLength(JSON.stringify(safe)); if (retained + bytes <= RETAIN_LIMIT) {
          retained += bytes; const history = this.histories.get(record!.id)!; history.push(safe); if (history.length > EVENT_LIMIT) history.shift();
          try { this.options.onEvent?.({ ...safe }); } catch { /* The UI is optional. */ }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        received += chunk.length; if (received > (input.maxOutputBytes ?? RETAIN_LIMIT)) { rejectOutput('The DSH task output exceeded its configured limit.'); return; }
        pending += decoder.write(chunk); let newline = pending.indexOf('\n');
        while (newline >= 0) { const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1); event(line); newline = pending.indexOf('\n'); }
        if (Buffer.byteLength(pending) > LINE_LIMIT) rejectOutput('An unterminated DSH task event exceeded the one MiB line limit.');
      });
      // stderr is drained, but never persisted: plugins may print the prompt, arguments or credentials.
      child.stderr.resume(); child.stdin.on('error', () => { if (!signal.aborted) rejectOutput('The DSH task input pipe closed unexpectedly.'); });
      child.stdin.end(input.prompt, 'utf8');
      try {
        const code = await new Promise<number | null>((resolve, reject) => { selectedChild.once('error', reject); selectedChild.once('close', resolve); });
        pending += decoder.end(); if (pending && !outputError) event(pending);
        result.code = code; record.code = code; signal.throwIfAborted(); if (outputError) throw outputError;
        if (code !== 0 || taskFailed || !hasFinal) throw new Error(code !== 0 ? `The pinned DSH task failed (exit ${code ?? 'unknown'}).` : taskFailed ? 'The selected DSH runtime returned a task error.' : 'The DSH task ended without a final structured reply.');
      } finally { signal.removeEventListener('abort', stop); await terminateOwnedProcess(selectedChild); }
      if (saveError) throw new Error('Task metadata could not be saved.');
      record.status = 'succeeded'; record.finishedAt = new Date().toISOString(); this.results.set(record.id, { ...result }); await this.save(); this.changed(); return { ...result };
    } catch (error) {
      if (child) await terminateOwnedProcess(child).catch(() => undefined);
      if (record && result) {
        record.status = signal.aborted ? 'cancelled' : 'failed'; record.finishedAt = new Date().toISOString();
        record.error = signal.aborted ? 'The DSH task was cancelled or reached its time limit.' : outputError?.message ?? (error instanceof Error && /^(The pinned DSH task failed|The selected DSH runtime returned|The DSH task ended without|Task metadata could not)/.test(error.message) ? error.message : 'The DSH task could not complete in its selected environment.');
        this.results.set(record.id, { ...result }); await this.save().catch(() => undefined); this.changed(); throw new DshTaskError(record.error, { ...result });
      }
      throw new Error(signal.aborted ? 'The DSH task was cancelled before its environment was ready.' : 'The DSH task could not prepare its selected environment.', { cause: error });
    } finally {
      try { if (pin) await pin.dispose(); }
      catch { await operation.log('The completed task context could not be removed; cleanup was deferred.').catch(() => undefined); }
      finally { this.active.delete(operation.id); this.reservations--; resolveFinished(); }
    }
  }
  private prune(): void {
    while (this.records.length > MAX_TASKS) {
      const index = this.records.findLastIndex(record => record.status !== 'running'); if (index < 0) break;
      const [removed] = this.records.splice(index, 1); if (removed) { this.results.delete(removed.id); this.histories.delete(removed.id); }
    }
  }
  cancel(taskId: string): void { const task = this.active.get(taskId); if (!task) throw new Error('This DSH task is no longer running.'); task.abort.abort(new Error('Task cancelled.')); }
  async shutdown(): Promise<void> { this.closed = true; for (const task of this.active.values()) task.abort.abort(new Error('Application closing.')); await Promise.all([...this.active.values()].map(task => task.finished)); await this.writes; }
}
