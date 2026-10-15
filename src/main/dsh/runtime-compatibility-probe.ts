import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from './disk';
import type { DshInstance, DshRuntime } from '../../shared/dsh-launcher';
import type { DshCompatibilityCheckId } from '../../shared/dsh-runtime-compatibility';
import { inventoryTree, redact } from './files';
import { instanceEnvironment, launchCli, parseReadyUrl, terminateOwnedProcess } from './instance-process';
import type { RuntimeServiceLike } from './runtime-service';
import { runtimeSdkRoot } from './runtime-sdk';
import { prepareSharedSessionData } from './shared-session-data';
import { sharedSessionRoutingPatches } from './shared-session-data';
import { writeTechnicalRoutingPatch } from './shared-credentials';
import { SharedSettingsCoordinator } from './shared-settings';
import { connectNativeSettings, type NativeSettingsTransport } from './shared-settings-rpc';
import { prepareNativeCliMode } from './cli-profile-mode';
import { COMPATIBILITY_DRIVER } from './runtime-compatibility-driver';

export type CompatibilityCheck = (id: DshCompatibilityCheckId, work: () => Promise<string>) => Promise<void>;
type Reply = Record<string, unknown>;
interface Peer { child: ChildProcessWithoutNullStreams; instance: DshInstance; env: NodeJS.ProcessEnv; url: string;
  transport?: NativeSettingsTransport; request(type: string, values?: Reply): Promise<Reply>; stop(): Promise<void> }
const assert = (value: unknown, message: string): void => { if (!value) throw new Error(message); };

/** All paths and credentials below are newly synthesized. The launcher shared root is never passed in. */
export async function probeRuntimeCompatibility(options: {
  scope: string; runtime: DshRuntime; peers: DshRuntime[]; runtimes: RuntimeServiceLike;
  signal: AbortSignal; check: CompatibilityCheck;
}): Promise<void> {
  const { scope, runtimes, runtime, check, signal } = options;
  const paths = await prepareSharedSessionData(path.join(scope, 'shared'));
  const script = path.join(scope, 'driver.mjs'); await writeFile(script, COMPATIBILITY_DRIVER);
  const children = new Set<ChildProcessWithoutNullStreams>(); const peers: Peer[] = [];
  const coordinator = new SharedSettingsCoordinator({ storePath: paths.settingsPath });
  let seq = 0;
  const abort = () => { for (const child of children) void terminateOwnedProcess(child).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  const start = async (record: DshRuntime): Promise<Peer> => {
    signal.throwIfAborted();
    const id = `probe-${++seq}`; const root = path.join(scope, id);
    await mkdir(path.join(root, 'launcher'), { recursive: true });
    const instance: DshInstance = { id, name: id, runtimeId: record.id, profile: 'web', status: 'stopped', isDefault: false,
      createdAt: '', updatedAt: '', homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'),
      workspacePath: paths.workspacePath, browserPartition: `temporary:${id}` };
    const routing = await writeTechnicalRoutingPatch({ instanceRoot: root, sharedRoot: paths.rootPath, runtimeVersion: record.version,
      programDirectory: runtimes.directory(record.id), workspacePath: paths.workspacePath, patches: sharedSessionRoutingPatches(paths.rootPath), signal });
    const plan = runtimes.plan(record.id);
    const isolated = await instanceEnvironment(root, instance, plan);
    // An allowlist of environment VARIABLE NAMES removes arbitrary inherited API keys and user plugins.
    const env = Object.fromEntries(Object.entries(isolated).filter(([key]) => /^(SystemRoot|WINDIR|COMSPEC|PATHEXT|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|DSH_HOME|DSH_AGENTS_HOME|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|XDG_(CONFIG_HOME|DATA_HOME|CACHE_HOME|RUNTIME_DIR)|NO_COLOR|FORCE_COLOR|ELECTRON_RUN_AS_NODE)$/i.test(key)));
    const system = process.env.SystemRoot ?? 'C:\\Windows';
    Object.assign(env, { PATH: [path.dirname(plan.executable), path.join(system, 'System32'), path.join(system, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter),
      DSH_TELEMETRY_DISABLED: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'user', '.gitconfig') });
    await coordinator.prepareStopped(id, instance.homePath);
    const child = await launchCli({ ...plan, cli: script }, [await runtimeSdkRoot(runtimes.directory(record.id)), routing, paths.workspacePath, 'host', paths.sessionsPath], env, paths.workspacePath);
    children.add(child);
    let output = ''; let diagnostics = ''; let readyUrl = ''; let nativeReady = false; let serial = 0;
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    const timer = setTimeout(() => readyReject(new Error(`原生环境启动超时（60 秒）。${diagnostics.slice(-1200)}`)), 60_000);
    child.stderr.on('data', chunk => { diagnostics = redact(diagnostics + String(chunk)).slice(-3000); });
    child.stdout.on('data', chunk => {
      output += String(chunk);
      if (output.length > 1024 * 1024) { readyReject(new Error('检测子进程输出超限。')); abort(); return; }
      for (let at = output.indexOf('\n'); at >= 0; at = output.indexOf('\n')) {
        const line = output.slice(0, at).trim(); output = output.slice(at + 1);
        readyUrl = parseReadyUrl(line) ?? readyUrl; if (line === 'COMPAT_READY') nativeReady = true;
        if (nativeReady && readyUrl) { clearTimeout(timer); readyResolve(); }
        if (!line.startsWith('COMPAT_RESULT ')) continue;
        try {
          const response = JSON.parse(line.slice('COMPAT_RESULT '.length)); const waiter = pending.get(response.id);
          if (!waiter) continue; clearTimeout(waiter.timer); pending.delete(response.id);
          if (response.error) waiter.reject(new Error(redact(`${response.error.code}: ${response.error.message}`))); else waiter.resolve(response.data);
        } catch { readyReject(new Error('原生检测返回了无效响应。')); }
      }
    });
    const exited = (message: string) => {
      clearTimeout(timer); readyReject(new Error(message));
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); } pending.clear();
    };
    child.once('error', error => exited(`原生环境启动失败：${error.message}`));
    child.once('close', code => exited(`检测子进程已退出（${code}）。${diagnostics.slice(-1200)}`));
    const peer: Peer = { child, instance, env, url: '', request(type, values = {}) {
      signal.throwIfAborted(); const id = ++serial;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`原生接口 ${type} 超时（20 秒）。`)); }, 20_000);
        pending.set(id, { resolve, reject, timer: timeout });
        child.stdin.write(JSON.stringify({ type, id, ...values }) + '\n');
      });
    }, async stop() {
      coordinator.detach(id); peer.transport?.close();
      if (child.exitCode === null && !signal.aborted) await peer.request('close').catch(() => undefined);
      await terminateOwnedProcess(child); children.delete(child);
    } }; peers.push(peer);
    await ready; signal.throwIfAborted(); peer.url = readyUrl;
    await coordinator.attach(id, peer.url, instance.homePath); peer.transport = await connectNativeSettings(peer.url);
    return peer;
  };
  const waitVisible = async (peer: Peer, sessionId: unknown, title: string): Promise<Reply> => {
    const deadline = Date.now() + 12_000;
    do { signal.throwIfAborted(); const state = await peer.request('state', { sessionId });
      if (JSON.stringify(state.list).includes(title) && JSON.stringify(state.workspaces).includes(String(sessionId))) return state;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error('会话标题或工作区索引未能跨实例同步（12 秒）。');
  };
  let a!: Peer; let b!: Peer; let sessionId: unknown;
  const checkWriter = async (record: DshRuntime): Promise<void> => {
    // Boot the installed plugin through its native profile, without depending on private constructor exports.
    const holder = await start(record);
    try {
      assert((await holder.request('lease', { sessionId })).held === true, '跨进程写入锁未能取得。');
      const before = await inventoryTree(paths.sessionsPath, signal); const result = await b.request('write', { sessionId });
      assert(result.refused === true, '并发写入未被拒绝；共享存档可能产生冲突。');
      assert((await inventoryTree(paths.sessionsPath, signal)).contentSha256 === before.contentSha256, '拒绝写入期间会话文件发生变化。');
    } finally { await holder.stop(); }
    assert((await b.request('write', { sessionId })).refused === false, '释放写入锁后仍无法获得写入权。');
  };
  let failure: unknown;
  try {
    await check('native-api', async () => { a = await start(runtime); return '使用临时 HOME 启动真实 DSH Web Host；原生会话与配置接口可用，未调用模型。'; });
    await check('session-roundtrip', async () => {
      const workspace = await a.request('workspace');
      sessionId = (await a.request('create', { workspaceId: workspace.workspaceId, title: 'WorldlineBox synthetic session A' })).sessionId;
      assert(typeof sessionId === 'string', '原生会话没有返回有效 ID。'); await a.stop(); b = await start(runtime); await b.request('workspace');
      const state = await waitVisible(b, sessionId, 'WorldlineBox synthetic session A');
      assert(state.agentAvailable === false && state.sessionAttached === false, '读取会话时意外激活了 Agent 或取得写入占用。');
      const header = state.header as { version?: number }; assert(header.version !== undefined && header.version <= 4, `当前存档迁移器不支持原生会话格式 ${header.version}。`);
      return '真实原生写入、正常关闭、重新启动后读取成功；只读观察未激活 Agent。';
    });
    await check('writer-lock', async () => {
      await checkWriter(runtime);
      return '独立进程持锁时拒绝第二个写入者，文件未变；释放后可重新写入。';
    });
    await check('workspace', async () => {
      assert(JSON.stringify((await waitVisible(b, sessionId, 'WorldlineBox synthetic session A')).workspaces).includes(String(sessionId)), '工作区关联丢失。');
      return '真实工作区创建、跨 Host 会话发现和标题投影正常。';
    });
    let ref: unknown;
    await check('attachments', async () => { ref = (await b.request('attachment-save')).ref;
      assert((await b.request('attachment-read', { ref })).text === 'WorldlineBox synthetic attachment', '原生附件写入后无法无损读取。');
      return '通过原生附件服务存取合成附件，内容一致。'; });
    await check('credentials', async () => {
      assert((await b.request('credential-host', { write: true })).configured === true, '原生 Host 保存后不能解析 API Key。');
      assert((await b.request('credentials')).valid === false, '空白合成账号状态不符合预期。');
      assert((await b.request('credentials', { write: true })).valid === true, '凭据原生解析或原子写入不兼容。');
      return '通过真实 Host 凭据服务保存并解析假 API Key，检查共享文件和假账号格式、文件锁及原子写入；未登录真实账号。'; });
    await check('model-settings', async () => {
      const view = (await b.transport!.describe()).find(row => row.ns === 'llm-pi-ai'); assert(view, '缺少 llm-pi-ai 原生配置接口。');
      await b.transport!.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'worldline-compatibility'], value: {
        api: 'openai-completions', baseURL: 'https://worldlinebox-compatibility.invalid/v1', apiKeyEnv: 'WORLDLINE_COMPAT_DUMMY', models: [{ id: 'synthetic-model' }] } }], view!.revision);
      await coordinator.syncNow(); return '真实配置 RPC 写入合成模型配置并同步至临时共享配置；未发送推理请求。';
    });
    await check('native-cli', async () => {
      const prefix = await prepareNativeCliMode(path.dirname(b.instance.homePath), runtimes.directory(runtime.id), runtime.version, signal);
      const child = await launchCli(runtimes.plan(runtime.id), [...prefix, '--help'], b.env, paths.workspacePath); children.add(child);
      try {
        let output = ''; child.stdout.on('data', value => { output = (output + String(value)).slice(-128000); }); child.stderr.resume();
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        assert(code === 0 && output.includes('Answer one task and exit') && !/^dsh web:/m.test(output), '原生无界面 CLI 组合检查未通过。');
      } finally { await terminateOwnedProcess(child); children.delete(child); }
      return '真实 CLI --help 可退出，未启动额外 Web 工作台或执行任务。';
    });
    await check('cross-runtime', async () => {
      // At least two distinct profiles are exercised even with one installed runtime.
      for (const other of options.peers.length ? options.peers : [runtime]) {
        const peer = await start(other); await peer.request('workspace');
        await waitVisible(peer, sessionId, 'WorldlineBox synthetic session A');
        assert((await peer.request('attachment-read', { ref })).text === 'WorldlineBox synthetic attachment', `${other.version} 无法读取共享附件。`);
        assert((await peer.request('credentials')).valid === true, `${other.version} 无法解析合成凭据。`);
        assert((await peer.request('credential-host')).configured === true, `${other.version} 的真实 Host 无法解析共享 API Key。`);
        const view = (await peer.transport!.describe()).find(row => row.ns === 'llm-pi-ai');
        assert((view?.user?.providers as Reply | undefined)?.['worldline-compatibility'], `${other.version} 未能加载共享模型配置。`);
        await checkWriter(other);
        const reverseRef = (await peer.request('attachment-save', { text: 'WorldlineBox reverse attachment' })).ref;
        assert((await b.request('attachment-read', { ref: reverseRef })).text === 'WorldlineBox reverse attachment', '候选制品无法读取另一实例写入的附件。');
        await peer.request('credentials', { write: true, reverse: true });
        assert((await b.request('credentials')).reverse === true, '候选制品无法读取另一实例写入的合成凭据。');
        await peer.transport!.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'worldline-reverse'], value: {
          api: 'openai-completions', baseURL: 'https://worldlinebox-compatibility.invalid/v1', models: [{ id: 'reverse-model' }] } }], view!.revision);
        await coordinator.syncNow();
        const reverseSettings = (await b.transport!.describe()).find(row => row.ns === 'llm-pi-ai');
        assert((reverseSettings?.user?.providers as Reply | undefined)?.['worldline-reverse'], '另一实例的合成模型配置未同步回候选制品。');
        const workspace = await peer.request('workspace'); const title = `WorldlineBox reverse ${other.id}`;
        const foreign = await peer.request('create', { workspaceId: workspace.workspaceId, title });
        await peer.stop(); await waitVisible(b, foreign.sessionId, title);
      }
      return options.peers.length ? `已与 ${options.peers.map(peer => `DSH ${peer.version} (${peer.contentSha256.slice(0, 12)})`).join('、')} 双向互读。` : '同一制品的独立实例双向互读通过；以后安装的新制品将与已通过制品再次交叉检测。';
    });
  } catch (error) { failure = error; }
  // A failed settings flush must never prevent process termination. Join every
  // cleanup and preserve the cleanup failure classification even after boot errors.
  const stopped = await Promise.allSettled([coordinator.dispose(), ...peers.map(peer => Promise.resolve().then(() => peer.transport?.close())),
    ...[...children].map(child => terminateOwnedProcess(child))]);
  signal.removeEventListener('abort', abort);
  if (stopped.some(result => result.status === 'rejected')) { const error = new Error('检测进程或配置连接未能完整清理；共享资格保持关闭，临时目录保留待清理。'); error.name = 'DshProbeCleanupError'; throw error; }
  if (failure) throw failure;
}
