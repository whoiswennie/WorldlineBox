import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { lstat, mkdir } from './disk';
import { dshCompatibilityCheckIds, dshCompatibilityReportSchema, supportsSharedDataRuntime,
  type DshCompatibilityReport, type DshCompatibilityCheckId } from '../../shared/dsh-runtime-compatibility';
import type { DshRuntime } from '../../shared/dsh-launcher';
import type { RuntimeServiceLike } from './runtime-service';
import type { OperationContext } from './operations';
import { assertOwnedDirectory, atomicJson, readJson, redact, removeManaged } from './files';
import { COMPATIBILITY_DRIVER } from './runtime-compatibility-driver';
import { SHARED_WORKSPACE_ADAPTER_SOURCE } from './shared-workspace-adapter';
import { NATIVE_CREDENTIAL_MIGRATION_SOURCE } from './shared-credentials';
import { probeRuntimeCompatibility } from './runtime-compatibility-probe';
import { DshTaskPreparationError } from './task-preparation';
import { DSH_NATIVE_CLI_DISABLED_IDS, DSH_NATIVE_CLI_ENABLED_IDS, prepareNativeCliMode } from './cli-profile-mode';

/** Changing the executable native contract invalidates old evidence automatically. */
export function compatibilityContract(): string {
  return createHash('sha256').update(COMPATIBILITY_DRIVER).update(SHARED_WORKSPACE_ADAPTER_SOURCE)
    .update(NATIVE_CREDENTIAL_MIGRATION_SOURCE).update(probeRuntimeCompatibility.toString())
    .update(prepareNativeCliMode.toString()).update(JSON.stringify([DSH_NATIVE_CLI_DISABLED_IDS, DSH_NATIVE_CLI_ENABLED_IDS])).digest('hex');
}
export async function readRuntimeCompatibility(root: string, runtime: DshRuntime): Promise<DshCompatibilityReport | undefined> {
  const file = path.join(root, 'compatibility', `${runtime.id}.json`);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('兼容性检测凭据不是有效的受管文件。');
  const parsed = dshCompatibilityReportSchema.safeParse(await readJson(file));
  if (!parsed.success || parsed.data.contract !== compatibilityContract() || parsed.data.contentSha256 !== runtime.contentSha256 || parsed.data.runtimeId !== runtime.id) return undefined;
  return parsed.data;
}
export async function assertRuntimeCompatibility(root: string, runtime: DshRuntime): Promise<void> {
  const compatibility = await readRuntimeCompatibility(root, runtime);
  assertKnownRuntimeCompatibility({ ...runtime, compatibility });
}
export function assertKnownRuntimeCompatibility(runtime: DshRuntime): void {
  if (supportsSharedDataRuntime(runtime)) return;
  const report = runtime.compatibility;
  const failed = report?.checks.find(check => check.status === 'failed');
  const reason = failed ? `失败检查：${failed.id}。${failed.detail.slice(0, 600)}`
    : report?.status === 'running' ? '隔离检测仍在进行。' : '当前运行文件尚无有效的隔离检测结果。';
  throw new DshTaskPreparationError('compatibility', `DSH ${runtime.version} 兼容性检测尚未通过。${reason}请到「运行版本」查看详情或重新检测；任务尚未启动。`);
}

export class RuntimeCompatibility {
  private readonly reports = new Map<string, DshCompatibilityReport>();
  private pending = Promise.resolve();
  private readonly running = new Map<string, Promise<DshCompatibilityReport>>();
  constructor(private readonly options: { rootPath: string; runtimes: RuntimeServiceLike; onChanged(): void }) {}
  async init(): Promise<void> {
    const directory = path.join(this.options.rootPath, 'compatibility'); await mkdir(directory, { recursive: true });
    await assertOwnedDirectory(this.options.rootPath, directory);
    for (const runtime of this.options.runtimes.list()) {
      const report = await readRuntimeCompatibility(this.options.rootPath, runtime);
      if (!report) continue;
      if (report.status === 'running') {
        report.status = 'interrupted'; report.finishedAt = new Date().toISOString();
        for (const check of report.checks) if (['running', 'pending'].includes(check.status)) { check.status = 'skipped'; check.detail = '上次检测被应用退出中断，请重新检测。'; }
        await atomicJson(path.join(directory, `${runtime.id}.json`), report);
      }
      this.reports.set(runtime.id, report);
    }
  }
  report(runtime: DshRuntime): DshCompatibilityReport | undefined {
    const report = this.reports.get(runtime.id);
    return report?.contentSha256 === runtime.contentSha256 && report.contract === compatibilityContract() ? structuredClone(report) : undefined;
  }
  needsCheck(runtime: DshRuntime): boolean { return !this.report(runtime); }
  async invalidate(runtime: DshRuntime, detail: string): Promise<void> {
    const report = this.report(runtime); if (!report || report.status === 'running') return;
    report.status = 'failed'; report.finishedAt = new Date().toISOString();
    const check = report.checks.find(item => item.id === 'integrity');
    if (check) { check.status = 'failed'; check.detail = detail; }
    await atomicJson(path.join(this.options.rootPath, 'compatibility', `${runtime.id}.json`), report);
    this.reports.set(runtime.id, report); this.options.onChanged();
  }
  check(runtime: DshRuntime, operation?: OperationContext): Promise<DshCompatibilityReport> {
    const existing = this.running.get(runtime.id); if (existing) return existing;
    const task = this.pending.then(() => this.perform(runtime, operation));
    this.pending = task.then(() => undefined, () => undefined);
    this.running.set(runtime.id, task); void task.finally(() => this.running.delete(runtime.id)).catch(() => undefined);
    return task;
  }
  private async perform(runtime: DshRuntime, operation?: OperationContext): Promise<DshCompatibilityReport> {
    const peers = this.options.runtimes.list().filter(item => item.id !== runtime.id && supportsSharedDataRuntime({ ...item, compatibility: this.report(item) }));
    const report: DshCompatibilityReport = { runtimeId: runtime.id, contentSha256: runtime.contentSha256, contract: compatibilityContract(),
      status: 'running', startedAt: new Date().toISOString(), peers: peers.map(({ id, version, contentSha256 }) => ({ runtimeId: id, version, contentSha256 })),
      checks: dshCompatibilityCheckIds.map(id => ({ id, status: 'pending', detail: '等待检查。' })) };
    const file = path.join(this.options.rootPath, 'compatibility', `${runtime.id}.json`);
    const persist = async () => { await atomicJson(file, report); this.reports.set(runtime.id, structuredClone(report)); this.options.onChanged(); };
    await persist();
    const signal = AbortSignal.any([...(operation ? [operation.signal] : []), AbortSignal.timeout(5 * 60_000)]);
    let failed = false; let cleanupSafe = true; let scope: string | undefined;
    const check = async (id: DshCompatibilityCheckId, work: () => Promise<string>) => {
      const item = report.checks.find(value => value.id === id)!;
      if (failed && id !== 'cleanup') { item.status = 'skipped'; item.detail = '前置检查失败，未继续运行依赖此能力的检查。'; await persist(); return; }
      item.status = 'running'; item.detail = '正在使用独立临时数据检查。'; await persist();
      const started = Date.now();
      try { if (id !== 'cleanup') signal.throwIfAborted(); item.detail = await work(); item.status = 'passed'; }
      catch (error) { failed = true; item.status = 'failed'; item.detail = redact(error instanceof Error ? error.message : String(error)).slice(0, 6000); }
      item.durationMs = Date.now() - started; await persist(); await operation?.log(`${id}: ${item.status} — ${item.detail}`);
    };
    try {
      await check('integrity', async () => {
        await this.options.runtimes.verify(runtime.id, signal);
        for (const peer of peers) await this.options.runtimes.verify(peer.id, signal);
        return '候选制品和交叉检测制品的全部文件均与封存摘要一致。';
      });
      if (!failed) {
        const scratch = path.join(this.options.rootPath, 'compatibility-scratch'); await mkdir(scratch, { recursive: true });
        await assertOwnedDirectory(this.options.rootPath, scratch);
        scope = await mkdtemp(path.join(scratch, 'probe-'));
        await probeRuntimeCompatibility({ scope, runtime, peers, runtimes: this.options.runtimes, signal, check });
      }
    } catch (error) {
      failed = true;
      if (error instanceof Error && error.name === 'DshProbeCleanupError') cleanupSafe = false;
      const item = report.checks.find(item => item.status === 'running' || item.status === 'pending');
      if (item) { item.status = 'failed'; item.detail = redact(String(error)).slice(0, 6000); }
    } finally {
      await check('cleanup', async () => {
        if (!cleanupSafe) throw new Error('检测子进程尚未全部结束，保留临时目录，未授予共享资格。');
        if (scope) await removeManaged(this.options.rootPath, scope);
        return '检测子进程已结束，临时数据已清理；真实存档和账号未参与检测。';
      });
      for (const item of report.checks) if (item.status === 'pending') { item.status = 'skipped'; item.detail = '前置检查失败或检测被取消。'; }
      report.status = signal.aborted ? 'interrupted' : failed ? 'failed' : 'passed'; report.finishedAt = new Date().toISOString(); await persist();
    }
    operation?.signal.throwIfAborted();
    return structuredClone(report);
  }
}
