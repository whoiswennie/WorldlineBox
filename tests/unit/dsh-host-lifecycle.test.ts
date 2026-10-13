import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { HOST_LIFECYCLE_TOKEN_ENV, prepareManagedHostBootstrap, stopManagedHost } from '../../src/main/dsh/host-lifecycle';

const roots: string[] = [];
const children = new Set<ChildProcess>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
  children.clear();
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(tmpdir()).toLowerCase()
      || !path.basename(resolved).startsWith('worldlinebox-host-lifecycle-test-')) throw new Error('Unexpected Host lifecycle fixture root.');
    await rm(resolved, { recursive: true, force: true });
  }
});

async function fixture(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-host-lifecycle-test-')); roots.push(root);
  const nativeCli = path.join(root, 'native-cli.mjs'); await writeFile(nativeCli, source);
  const instanceRoot = path.join(root, 'instance'); await mkdir(instanceRoot);
  const bootstrap = await prepareManagedHostBootstrap(instanceRoot, nativeCli);
  const output: unknown[] = [];
  const child = spawn(process.execPath, [bootstrap.bootstrapPath, nativeCli, 'web', '--patch', 'private.patch.yml', '--port', '0'], {
    cwd: root, env: { ...process.env, [HOST_LIFECYCLE_TOKEN_ENV]: bootstrap.token }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  children.add(child); child.once('error', () => undefined);
  const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.on('message', message => {
      output.push(message);
      if (message && typeof message === 'object' && (message as Record<string, unknown>).type === 'ready') resolve(message as Record<string, unknown>);
    });
    child.once('error', reject); child.once('exit', code => reject(new Error(`Fixture exited before readiness: ${code}`)));
  });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  return { root, nativeCli, bootstrap, child, output, ready, stderr: () => stderr };
}

const pendingWriteCli = `
import {writeFile} from 'node:fs/promises';
export async function runCli(){
 let signals=0;
 process.on('SIGTERM',()=>{signals++;void(async()=>{await new Promise(r=>setTimeout(r,40));await writeFile('last-session-event.json',JSON.stringify({title:'保留最后一次改名',signals}));process.exit(0)})()});
 process.send({type:'ready',argv:process.argv,tokenAbsent:process.env.WORLDLINEBOX_DSH_HOST_LIFECYCLE_TOKEN===undefined});
 setInterval(()=>{},1000);
}
`;

describe('managed native Host lifecycle', () => {
  it('keeps the physical native CLI argv and drains the native SIGTERM handler before releasing ownership', async () => {
    const f = await fixture(pendingWriteCli); const ready = await f.ready;
    expect(ready.argv).toEqual([process.execPath, await realpath(f.nativeCli), 'web', '--patch', 'private.patch.yml', '--port', '0']);
    expect(ready.tokenAbsent).toBe(true);
    let forced = 0;
    const result = await stopManagedHost(f.child, f.bootstrap.token, async () => { forced++; f.child.kill(); });
    expect(result).toEqual({ graceful: true, exitCode: 0 }); expect(forced).toBe(0);
    expect(JSON.parse(await readFile(path.join(f.root, 'last-session-event.json'), 'utf8'))).toEqual({ title: '保留最后一次改名', signals: 1 });
    expect(f.stderr()).toBe('');
  });

  it('ignores foreign capabilities and coalesces duplicate valid stops rather than escalating native shutdown', async () => {
    const f = await fixture(pendingWriteCli); await f.ready;
    f.child.send({ type: 'worldlinebox:dsh-host:stop', token: 'a'.repeat(64) });
    await new Promise(resolve => setTimeout(resolve, 30)); expect(f.child.exitCode).toBeNull();
    const result = stopManagedHost(f.child, f.bootstrap.token, async () => { f.child.kill(); });
    f.child.send({ type: 'worldlinebox:dsh-host:stop', token: f.bootstrap.token });
    expect((await result).graceful).toBe(true);
    expect(JSON.parse(await readFile(path.join(f.root, 'last-session-event.json'), 'utf8')).signals).toBe(1);
  });

  it('reports a missing native handler and uses only the supplied owned-process fence', async () => {
    const f = await fixture("export async function runCli(){process.send({type:'ready'});setInterval(()=>{},1000)}"); await f.ready;
    let forced = 0;
    const result = await stopManagedHost(f.child, f.bootstrap.token, async () => {
      forced++; const exited = once(f.child, 'exit'); f.child.kill(); await exited;
    });
    expect(result.graceful).toBe(false); expect(result.reason).toBe('native-handler-unavailable'); expect(forced).toBe(1);
  });

  it('bounds an unresponsive native disposer and preserves an explicit timeout outcome', async () => {
    const f = await fixture("export async function runCli(){process.on('SIGTERM',()=>{});process.send({type:'ready'});setInterval(()=>{},1000)}"); await f.ready;
    let forced = 0;
    const result = await stopManagedHost(f.child, f.bootstrap.token, async () => {
      forced++; const exited = once(f.child, 'exit'); f.child.kill(); await exited;
    }, 80);
    expect(result.graceful).toBe(false); expect(result.reason).toBe('timeout'); expect(forced).toBe(1);
  });

  it('does not label a late exit 0 near native forced-shutdown timeout as clean', async () => {
    const f = await fixture("export async function runCli(){process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),4600));process.send({type:'ready'});setInterval(()=>{},1000)}"); await f.ready;
    let forced = 0;
    const result = await stopManagedHost(f.child, f.bootstrap.token, async () => { forced++; });
    expect(result).toEqual({ graceful: false, reason: 'native-timeout', exitCode: 0 }); expect(forced).toBe(1);
  });

  it('reuses owned bootstrap bytes without rewriting and refuses unrelated files', async () => {
    const f = await fixture(pendingWriteCli); await f.ready;
    const previous = await stat(f.bootstrap.bootstrapPath);
    const repeated = await prepareManagedHostBootstrap(path.join(f.root, 'instance'), f.nativeCli);
    expect(repeated.bootstrapPath).toBe(f.bootstrap.bootstrapPath); expect(repeated.token).not.toBe(f.bootstrap.token);
    expect((await stat(repeated.bootstrapPath)).mtimeMs).toBe(previous.mtimeMs);
    await writeFile(repeated.bootstrapPath, 'unmanaged source');
    await expect(prepareManagedHostBootstrap(path.join(f.root, 'instance'), f.nativeCli)).rejects.toThrow('unmanaged');
  });
});
