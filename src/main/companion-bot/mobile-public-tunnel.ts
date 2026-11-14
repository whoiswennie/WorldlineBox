import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { MOBILE_TUNNEL_ORIGIN_PORT, type MobileEndpointMode } from '../../shared/mobile-access';
import release from '../../../resources/mobile-tunnel-release.json';

const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function hasFixedMobilePublicEndpoint() {
  return !!process.env.WORLDLINEBOX_MOBILE_TUNNEL_TOKEN?.trim()
    && hostnamePattern.test(process.env.WORLDLINEBOX_MOBILE_TUNNEL_HOSTNAME?.trim().toLowerCase() ?? '');
}

function fixedEndpoint() {
  const host = process.env.WORLDLINEBOX_MOBILE_TUNNEL_HOSTNAME?.trim().toLowerCase();
  const token = process.env.WORLDLINEBOX_MOBILE_TUNNEL_TOKEN?.trim();
  if (!host && !token) return undefined;
  if (!host || !hostnamePattern.test(host) || !token) {
    throw new Error('公网入口配置不完整，请检查固定域名和隧道凭据。');
  }
  return { host, token };
}

async function digest(file: string) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

async function resolveExecutable(appPath: string, userData: string, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('跨网测试服务目前支持 Windows x64。');
  const bundled = path.join(process.resourcesPath, 'mobile-cloudflared', 'cloudflared.exe');
  const staged = path.join(appPath, '.tools', 'mobile-cloudflared', 'cloudflared.exe');
  const directory = path.join(userData, 'mobile-network');
  const cached = path.join(directory, `cloudflared-${release.version}.exe`);
  for (const file of [bundled, staged, cached]) {
    try { await access(file); if (await digest(file) === release.exe.sha256) return file; }
    catch { /* Try the next distribution location. */ }
  }
  await mkdir(directory, { recursive: true });
  const temporary = cached + '.download';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '90', '--output', temporary, release.exe.url], { windowsHide: true, signal, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('无法自动下载远程连接组件。')));
    });
    if (await digest(temporary) !== release.exe.sha256) throw new Error('远程连接组件校验失败。');
    await rename(temporary, cached);
    return cached;
  } finally { await rm(temporary, { force: true }); }
}

export async function startMobilePublicTunnel(appPath: string, userData: string, sshPort: number, signal: AbortSignal) {
  const fixed = fixedEndpoint();
  const endpointMode: MobileEndpointMode = fixed ? 'fixed' : 'temporary';
  const executable = await resolveExecutable(appPath, userData, signal);
  signal.throwIfAborted();
  const http = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const websocket = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 128 * 1024 });
  const streams = new Set<ReturnType<typeof connect>>();
  http.on('upgrade', (request, socket, head) => {
    if (request.url !== '/worldlinebox-ssh' || request.headers.origin || streams.size >= 16) { socket.destroy(); return; }
    websocket.handleUpgrade(request, socket, head, peer => {
      const ssh = connect(sshPort, '127.0.0.1');
      streams.add(ssh);
      const transport = createWebSocketStream(peer);
      ssh.once('close', () => streams.delete(ssh));
      ssh.setTimeout(90_000, () => ssh.destroy());
      void pipeline(transport, ssh).catch(() => undefined);
      void pipeline(ssh, transport).catch(() => undefined);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(fixed ? MOBILE_TUNNEL_ORIGIN_PORT : 0, '127.0.0.1', () => { http.off('error', reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === 'string') { http.close(); throw new Error('无法启动本机远程连接入口。'); }
  const args = ['tunnel', '--no-autoupdate', '--protocol', 'http2',
    ...(fixed ? ['run'] : ['--url', `http://127.0.0.1:${address.port}`])];
  const child = spawn(executable, args, {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WORLDLINEBOX_MOBILE_TUNNEL_TOKEN: undefined, TUNNEL_TOKEN: fixed?.token },
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    child.kill();
    for (const peer of websocket.clients) peer.terminate();
    for (const ssh of streams) ssh.destroy();
    websocket.close();
    http.close();
    http.closeAllConnections();
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    const host = await new Promise<string>((resolve, reject) => {
      let endpoint = fixed?.host;
      let pending = '';
      const finish = (error?: Error, host?: string) => {
        clearTimeout(timer);
        child.stderr?.off('data', handleData);
        child.stderr?.resume();
        child.off('error', handleError);
        child.off('exit', handleExit);
        signal.removeEventListener('abort', handleAbort);
        if (host) resolve(host);
        else reject(error);
      };
      const handleData = (chunk: Buffer) => {
        pending = (pending + chunk.toString()).slice(-8192);
        endpoint ??= pending.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/u)?.[1];
        if (endpoint && pending.includes('Registered tunnel connection')) finish(undefined, endpoint);
      };
      const handleError = () => finish(new Error('公网连接组件无法启动。'));
      const handleExit = () => finish(new Error('公网连接组件已停止。'));
      const handleAbort = () => finish(new Error('公网连接已取消。'));
      const timer = setTimeout(() => finish(new Error('公网入口连接超时，请稍后重试。')), 35_000);
      timer.unref();
      child.stderr?.on('data', handleData);
      child.once('error', handleError);
      child.once('exit', handleExit);
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
    return { host, endpointMode, close, alive: () => !closed && child.exitCode === null && child.signalCode === null };
  } catch (error) { close(); throw error; }
}
