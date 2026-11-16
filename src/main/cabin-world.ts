import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
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

  async request(route: '/v1/events' | '/v1/tool', signal: AbortSignal, body?: object): Promise<Record<string, unknown>> {
    const bridge = this.bridge;
    if (this.stopping || !bridge?.pid || bridge.exitCode !== null || bridge.signalCode) throw Error('小屋世界离线。');
    const info = JSON.parse(await readFile(this.bridgeJson, { encoding: 'utf8', signal })) as { pid?: number; url?: string; token?: string };
    if (this.bridge !== bridge || this.stopping || info.pid !== bridge.pid || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(info.url ?? '') || !/^[a-f0-9]{48}$/.test(info.token ?? '')) {
      throw Error('小屋世界连接尚未就绪。');
    }
    const response = await fetch(info.url! + route, {
      method: body ? 'POST' : 'GET', body: body && JSON.stringify(body), signal, redirect: 'error',
      headers: { authorization: `Bearer ${info.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    });
    const result = await response.json() as Record<string, unknown>;
    return response.ok ? result : { ...result, ok: false };
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

  private async prepareProfile() {
    const layouts = path.join(this.data, 'layouts');
    await mkdir(layouts, { recursive: true });
    const featureFile = path.join(this.data, 'features.json');
    if (await readFile(featureFile).catch(error => { if (error.code !== 'ENOENT') throw error; })) return;
    const { modules } = JSON.parse(await readFile(path.join(this.resources, 'bridge', 'update', 'modules.json'), 'utf8')) as {
      modules: Array<{ id: string; default: boolean }>;
    };
    const backup = path.join(this.data, 'backups', 'before-1.1');
    for (const directory of ['saves', 'layouts', 'world']) {
      const source = path.join(this.data, directory);
      const entries = await readdir(source).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (entries.some(entry => entry !== 'game-link.json')) {
        await cp(source, path.join(backup, directory), { recursive: true, force: false,
          filter: entry => path.basename(entry) !== 'game-link.json' });
      }
    }
    // The 1.0 executable resolved furniture layouts one directory above its resource directory.
    for (const room of ['home', 'arcade', 'shop', 'restaurant', 'park']) {
      const filename = `${room}-grid-layout.json`;
      await copyFile(path.join(path.dirname(this.resources), filename), path.join(layouts, filename), constants.COPYFILE_EXCL)
        .catch(error => { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; });
    }
    await atomicJson(featureFile, { version: 1, modules: Object.fromEntries(modules.map(module => [module.id, module.default])) });
  }

  private async start() {
    if (process.platform !== 'win32') throw Error('内置小屋世界需要 Windows x64。');
    if (await this.connected()) return;
    const exe = path.join(this.resources, 'CabinWorld.exe');
    await readFile(path.join(this.resources, 'release.json'), 'utf8').catch(() => { throw Error('缺少内置小屋世界资源。开发环境请运行 node scripts/stage-cabin-world.mjs。'); });
    // Cabin World's direct-entry check compares argv to the resolved module path.
    const bridgeEntry = await realpath(path.join(this.resources, 'bridge', 'bridge.mjs'));
    await this.prepareProfile();
    this.abort.signal.throwIfAborted();
    const config = path.join(this.data, 'managed-bridge-config.json');
    await atomicJson(config, { dataDir: this.data, gameExe: exe, launchGame: false, hostName: 'WorldlineBox', http: { port: 0 } });
    this.abort.signal.throwIfAborted();
    let failure: Error | undefined;
    const observe = (child: ChildProcess) => child.once('error', error => { failure = error; });
    if (!this.bridge || this.bridge.exitCode !== null || this.bridge.signalCode) {
      this.bridge = observe(spawn(this.node, [bridgeEntry, '--config', config], {
        cwd: this.data, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true,
      }));
    }
    if (!this.game || this.game.exitCode !== null || this.game.signalCode) {
      this.game = observe(spawn(exe, ['--', '--data', this.data, '--save', path.join(this.data, 'saves'),
        '--layout', path.join(this.data, 'layouts', 'home-grid-layout.json')], { cwd: this.data, stdio: 'ignore' }));
    }
    try {
      const until = Date.now() + 25000;
      do {
        if (failure) throw failure;
        if (!this.bridge || this.bridge.exitCode !== null || this.bridge.signalCode) throw Error(`小屋世界连接服务提前退出（${this.bridge?.exitCode ?? this.bridge?.signalCode ?? '未知'}）。`);
        if (!this.game || this.game.exitCode !== null || this.game.signalCode) throw Error(`小屋世界游戏提前退出（${this.game?.exitCode ?? this.game?.signalCode ?? '未知'}）。`);
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
