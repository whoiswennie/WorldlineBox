import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { companionModelResourcePolicySchema, INITIAL_COMPANION_MODEL_RESOURCES, type CompanionModelConnectionPolicy } from '../../shared/companion-model-resources';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionRuntimeDirectory } from './owner-runtime-storage';
import { companionModelConnection, companionModelQuota, CompanionModelAdmissionError } from './model-quota';
import { CompanionModelError, type CompanionModelConfig } from './model';
import { CompanionAssetIo } from './asset-io';

const hostInstance = randomUUID(), serial = new Map<string, Promise<unknown>>();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const stamp = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
type Finish = Awaited<ReturnType<NonNullable<CompanionModelConfig['providerBudget']>['beforeRequest']>>;
function serializeResource<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const pending = (serial.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation);
  serial.set(file, pending); void pending.finally(() => { if (serial.get(file) === pending) serial.delete(file); }).catch(() => undefined); return pending;
}
/** Operational workspace limits contain no keys, prompts or source prose.
 * They are authored files; the database stores durable attempt counters only. */
export class CompanionModelResources {
  readonly file: string;
  private readonly io = new CompanionAssetIo();
  private readonly active = new Map<string, Promise<void>>();
  private readonly connections = new Set<string>();
  private readonly policyOwner = randomUUID();
  private closing?: Promise<void>;
  constructor(private readonly options: { directory: string; request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>; report(error: unknown): void }) {
    if (!path.isAbsolute(options.directory)) throw Error('Model resource directory must be absolute.');
    this.file = path.join(options.directory, '模型资源预算.json');
  }
  private async read() {
    await companionRuntimeDirectory(this.options.directory);
    const before = await lstat(this.file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw Error('Invalid model resource policy file.');
    const handle = await open(this.file, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || stamp(opened) !== stamp(before)) throw Error('Resource policy file changed.');
      const bytes = Buffer.alloc(65537), result = await handle.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead > 65536) throw Error('Resource policy exceeds its size limit.');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, result.bytesRead));
      const after = await lstat(this.file);
      if (stamp(after) !== stamp(before) || stamp(await handle.stat()) !== stamp(before) || await realpath(this.file) !== path.join(await realpath(this.options.directory), path.basename(this.file)))
        throw Error('Resource policy file changed.');
      return { content, revision: digest(content), policy: companionModelResourcePolicySchema.parse(JSON.parse(content)) };
    } finally { await handle.close(); }
  }
  load() { return this.io.run(() => this.loadOnce()); }
  private async loadOnce() {
    const current = serializeResource(this.file, async () => {
      const status = await this.options.request({ type: 'model.resources.config.status' });
      if (!status.ok) throw Error('Unable to inspect model resource initialization.');
      if (!status.modelResourcesInitialized) {
        await companionRuntimeDirectory(this.options.directory, true);
        let handle;
        try {
          handle = await open(this.file, 'wx');
          await handle.writeFile(JSON.stringify(INITIAL_COMPANION_MODEL_RESOURCES, null, 2) + '\n', 'utf8'); await handle.sync();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        finally { await handle?.close(); }
        const initial = await this.read();
        const marked = await this.options.request({ type: 'model.resources.config.initialized' });
        if (!marked.ok) throw Error('Unable to mark model resource initialization.'); return initial;
      }
      return this.read();
    });
    try { return await current; }
    catch { throw new CompanionModelError('CONFIG', '模型资源预算文件缺失、损坏或正在修改；不会用初始预算覆盖。请核对模型资源预算.json。'); }
  }
  async save(expectedRevision: string, content: string) {
    companionModelResourcePolicySchema.parse(JSON.parse(content));
    if (Buffer.byteLength(content) > 65536) throw Error('资源预算文件过大。');
    await this.load();
    return this.io.run(() => serializeResource(this.file, async () => {
      const before = await this.read(); if (before.revision !== expectedRevision) throw Error('资源预算文件已有外部修改，请重新读取。');
      const temporary = this.file + '.' + randomUUID() + '.tmp', handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(content, 'utf8'); await handle.sync(); await handle.close();
        if ((await this.read()).revision !== expectedRevision) throw Error('资源预算文件已有外部修改，请重新读取。');
        await rename(temporary, this.file); return await this.read();
      } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    }));
  }
  bind(config: CompanionModelConfig, companionId: string): Promise<CompanionModelConfig> {
    return this.io.run(async () => {
    const connectionId = companionModelConnection(config), snapshot = await this.loadOnce();
    const select = (value: typeof snapshot): CompanionModelConnectionPolicy => value.policy.connections[connectionId] ?? value.policy.defaultConnection;
    this.connections.add(connectionId); companionModelQuota.configureConnection(connectionId, select(snapshot).concurrency, this.policyOwner);
    return { ...config, providerBudget: { beforeRequest: (inputBytes, reservedOutputTokens, purpose) => this.io.run(async () => {
      let current: typeof snapshot;
      try { current = await this.loadOnce(); }
      catch (error) {
        if (error instanceof CompanionModelError && error.code === 'CONFIG') throw new CompanionModelAdmissionError('policy_unavailable', error.message);
        throw error;
      }
      const policy = select(current), id = randomUUID();
      companionModelQuota.configureConnection(connectionId, policy.concurrency, this.policyOwner);
      let response: CompanionStorageResponse;
      try { response = await this.options.request({ type: 'model.resources.admit', id, companionId, connectionId, hostPid: process.pid, hostInstance,
        policy, policyRevision: current.revision, inputBytes, reservedOutputTokens, purpose }); }
      catch { throw new CompanionModelAdmissionError('accounting_unavailable', '模型资源准入账本暂不可用，本次没有发送提供方请求。'); }
      if (!response.ok || !response.modelResourceAdmission) throw new CompanionModelAdmissionError('accounting_unavailable', '模型资源准入账本暂不可用，本次没有发送提供方请求。');
      if (!response.modelResourceAdmission.accepted) {
        const reason = response.modelResourceAdmission.reason;
        throw new CompanionModelAdmissionError('budget', reason === 'concurrency' ? '这个模型连接的并发预算已满，请稍后重试。'
          : reason === 'requests_minute' ? '这个模型连接已达到每分钟请求预算，请稍后重试。'
            : '这个模型连接已达到当日请求、输入、输出或已配置成本预算；来源仍保留，可调整预算文件或等待下一个UTC日。', response.modelResourceAdmission.retryAt);
      }
      let resolve!: () => void, finished = false;
      this.active.set(id, new Promise<void>(done => { resolve = done; }));
      const finish: Finish = async (outcome, durationMs, httpStatus) => {
        if (finished) return; finished = true;
        try {
          const result = await this.options.request({ type: 'model.resources.finish', id, outcome, durationMs, httpStatus });
          if (!result.ok) throw Error('Unable to finish model request accounting.');
        } catch (error) { try { this.options.report(error); } catch { /* Diagnostics cannot change a real response. */ } }
        finally { this.active.delete(id); resolve(); }
      };
      return finish;
    }) } };
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      await this.io.close(); await Promise.allSettled([...this.active.values()]);
      for (const connection of this.connections) companionModelQuota.releaseConnectionPolicy(connection, this.policyOwner);
    })();
  }
}
