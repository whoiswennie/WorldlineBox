import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson } from './dsh/files';

export async function cabinBridgeOnline(bridgeJson: string, expectedPid?: number): Promise<boolean> {
  try {
    const { url, pid } = JSON.parse(await readFile(bridgeJson, 'utf8')) as { url: string; pid: number };
    if ((expectedPid !== undefined && pid !== expectedPid) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) return false;
    const response = await fetch(url + '/v1/health', { signal: AbortSignal.timeout(1200), redirect: 'error' });
    return response.ok && (await response.json() as { game?: boolean }).game === true;
  } catch { return false; }
}

export class CabinWorld {
  readonly bridgeJson: string;
  readonly toolDefinitions: string;
  private bridge?: ChildProcess;
  private game?: ChildProcess;
  private opening?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(private readonly resources: string, private readonly data: string, private readonly node: string) {
    this.bridgeJson = path.join(data, 'bridge.json');
    this.toolDefinitions = path.join(resources, 'bridge', 'openai-tools.json');
  }

  async state() {
    const release = await readFile(path.join(this.resources, 'release.json'), 'utf8').then(text => JSON.parse(text) as { version: string }, () => undefined);
    return { available: process.platform === 'win32' && !!release, version: release?.version, running: await this.online() };
  }

  async online(): Promise<boolean> {
    return !this.stopping && this.connected();
  }

  private async connected(): Promise<boolean> {
    if (!this.bridge?.pid || this.bridge.exitCode !== null || this.bridge.signalCode) return false;
    return cabinBridgeOnline(this.bridgeJson, this.bridge.pid);
  }

  open(): Promise<void> {
    this.abort.signal.throwIfAborted();
    if (this.stopping) return this.stopping.then(() => this.open());
    return this.opening ??= this.start().finally(() => { this.opening = undefined; });
  }

  private async start() {
    if (process.platform !== 'win32') throw Error('内置小屋世界需要 Windows x64。');
    if (await this.connected()) return;
    const exe = path.join(this.resources, 'CabinWorld.exe');
    await readFile(path.join(this.resources, 'release.json'), 'utf8').catch(() => { throw Error('缺少内置小屋世界资源。开发环境请运行 node scripts/stage-cabin-world.mjs。'); });
    await mkdir(this.data, { recursive: true });
    this.abort.signal.throwIfAborted();
    const config = path.join(this.data, 'managed-bridge-config.json');
    await atomicJson(config, { dataDir: this.data, gameExe: exe, launchGame: false, hostName: 'WorldlineBox', http: { port: 0 } });
    this.abort.signal.throwIfAborted();
    let failure: Error | undefined;
    const observe = (child: ChildProcess) => child.once('error', error => { failure = error; });
    if (!this.bridge || this.bridge.exitCode !== null || this.bridge.signalCode) {
      this.bridge = observe(spawn(this.node, [path.join(this.resources, 'bridge', 'bridge.mjs'), '--config', config], {
        cwd: this.data, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true,
      }));
    }
    if (!this.game || this.game.exitCode !== null || this.game.signalCode) {
      this.game = observe(spawn(exe, ['--', '--data', this.data, '--save', path.join(this.data, 'saves')], { cwd: this.data, stdio: 'ignore' }));
    }
    try {
      const until = Date.now() + 25000;
      do {
        if (failure) throw failure;
        if (!this.bridge || !this.game || this.bridge.exitCode !== null || this.game.exitCode !== null || this.bridge.signalCode || this.game.signalCode) throw Error('小屋世界进程提前退出。');
        if (await this.connected()) return;
        await delay(250, undefined, { signal: this.abort.signal });
      } while (Date.now() < until);
      throw Error('小屋世界启动超时，游戏尚未连接。');
    } catch (error) { await this.stopProcesses(); throw error; }
  }

  private stopProcesses() {
    const children = [this.game, this.bridge];
    this.game = undefined; this.bridge = undefined;
    return Promise.all(children.map(async child => {
      if (!child?.pid || child.exitCode !== null || child.signalCode) return;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); child.off('exit', done); resolve(); };
        const timer = setTimeout(done, 4000);
        child.once('exit', done);
        if (!child.kill()) done();
      });
    })).then(() => undefined);
  }

  stop(): Promise<void> {
    const opening = this.opening;
    return this.stopping ??= Promise.resolve(opening).catch(() => undefined).then(() => this.stopProcesses()).finally(() => { this.stopping = undefined; });
  }

  async close() { this.abort.abort(); await this.stop(); }
}
