import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import type * as Koffi from 'koffi';
import { describe, expect, it } from 'vitest';
import { attachProcessJob, type WindowsProcessJob } from '../../src/main/dsh/windows-job';

const idleProgram = 'setInterval(() => {}, 1000);';
const workerProgram = `const {spawn}=require('node:child_process'); const leaf=spawn(process.execPath,['-e',${JSON.stringify(idleProgram)}],{windowsHide:true,detached:true,stdio:'ignore'}); console.log(leaf.pid); setInterval(()=>{},1000);`;
// A startup gate ensures this fixture's grandchildren are created only after
// its root is assigned to the Job, just as the launcher assigns before ready.
const hostProgram = `const {spawn}=require('node:child_process'); process.stdin.once('data',()=>{ const worker=spawn(process.execPath,['-e',${JSON.stringify(workerProgram)}],{windowsHide:true,stdio:['ignore','pipe','pipe']}); worker.stdout.once('data',chunk=>console.log(JSON.stringify([process.pid,worker.pid,Number(String(chunk).trim())]))); }); setInterval(()=>{},1000);`;

interface ProcessProbe { alive(): boolean; dispose(): void }

function processProbe(pid: number): ProcessProbe {
  // Keep the acquired kernel handle alive through assertions and cleanup. A
  // recycled PID cannot cause a test to stop a process belonging to the user.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof Koffi;
  const kernel = koffi.load('kernel32.dll');
  const open = kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(uintptr_t handle, uint32_t timeout)');
  const terminate = kernel.func('int __stdcall TerminateProcess(uintptr_t handle, uint32_t exitCode)');
  const close = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
  const handle = open(0x00100000 | 0x0001, 0, pid) as bigint | number;
  if (handle === 0 || handle === 0n) throw new Error(`Could not retain fixture process ${pid}.`);
  let closed = false;
  return {
    alive() { return !closed && wait(handle, 0) === 258; },
    dispose() {
      if (closed) return;
      if (wait(handle, 0) === 258) { terminate(handle, 1); wait(handle, 5_000); }
      close(handle); closed = true;
    },
  };
}

function spawnNode(program: string, env = process.env): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', program], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

function readPids(child: ChildProcessWithoutNullStreams): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let output = ''; let errors = '';
    const timeout = setTimeout(() => finish(new Error(`Fixture did not start: ${errors}`)), 15_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const line = output.split('\n')[0];
      if (!output.includes('\n') || !line) return;
      try {
        const pids: unknown = JSON.parse(line);
        if (!Array.isArray(pids) || pids.length !== 3 || pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) throw new Error('Invalid fixture process IDs.');
        finish(undefined, pids as number[]);
      } catch (error) { finish(error as Error); }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error(`Fixture exited before startup: ${errors}`));
    const onStderr = (chunk: Buffer): void => { errors += chunk.toString(); };
    const finish = (error?: Error, pids?: number[]): void => {
      clearTimeout(timeout); child.stdout.removeListener('data', onData); child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError); child.removeListener('exit', onExit);
      if (error) reject(error); else resolve(pids!);
    };
    child.stdout.on('data', onData); child.stderr.on('data', onStderr); child.once('error', onError); child.once('exit', onExit);
  });
}

async function waitGone(probes: ProcessProbe[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (probes.some(probe => probe.alive()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  expect(probes.map(probe => probe.alive())).toEqual(probes.map(() => false));
}

async function removeFixture(root: string): Promise<void> {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-job-test-')) throw new Error('Unexpected fixture directory.');
  await rm(absolute, { recursive: true, force: true });
}

describe.skipIf(process.platform !== 'win32')('Windows DSH instance Job supervision', () => {
  it('retains terminal Job accounting after its worker exits until all descendants are stopped',async()=>{
    const host=spawnNode(hostProgram);let job:WindowsProcessJob|undefined;const probes:ProcessProbe[]=[];
    try{
      job=attachProcessJob(host,{closeOnExit:false});const ready=readPids(host);host.stdin.write('start\n');
      for(const pid of await ready)probes.push(processProbe(pid));
      await expect(job!.waitForEmpty(50)).rejects.toThrow('still hold');
      const exited=new Promise<void>(resolve=>host.once('exit',()=>resolve()));host.kill();await exited;
      expect(probes.slice(1).every(probe=>probe.alive())).toBe(true);
      await expect(job!.waitForEmpty(50)).rejects.toThrow('still hold');
      job!.terminate();await job!.waitForEmpty();await waitGone(probes);job!.close();await job!.waitForEmpty();
    }finally{job?.close();for(const probe of probes)probe.dispose();host.kill();}
  });
  it('closes a nested instance Job and kills its whole tree while an unrelated Node stays alive', async () => {
    const host = spawnNode(hostProgram); const unrelated = spawnNode(idleProgram);
    let outer: WindowsProcessJob | undefined; let inner: WindowsProcessJob | undefined;
    const probes: ProcessProbe[] = []; let unrelatedProbe: ProcessProbe | undefined;
    try {
      outer = attachProcessJob(host); inner = attachProcessJob(host);
      expect(outer).toBeDefined(); expect(inner).toBeDefined();
      unrelatedProbe = processProbe(unrelated.pid!);
      const pidsReady = readPids(host); host.stdin.write('start\n');
      for (const pid of await pidsReady) probes.push(processProbe(pid));
      expect(probes.every(probe => probe.alive())).toBe(true);
      inner!.close(); inner!.close(); inner!.terminate();
      await waitGone(probes);
      expect(unrelatedProbe.alive()).toBe(true);
      outer!.close(); outer!.terminate();
    } finally {
      inner?.close(); outer?.close(); for (const probe of probes) probe.dispose(); unrelatedProbe?.dispose();
      host.kill(); unrelated.kill();
    }
  });

  it('terminates the entire tree repeatedly and also cleans descendants on a natural root exit', async () => {
    for (const operation of ['terminate', 'root-exit'] as const) {
      const host = spawnNode(hostProgram); let job: WindowsProcessJob | undefined; const probes: ProcessProbe[] = [];
      try {
        job = attachProcessJob(host);
        const pidsReady = readPids(host); host.stdin.write('start\n');
        for (const pid of await pidsReady) probes.push(processProbe(pid));
        if (operation === 'terminate') { job!.terminate(); job!.terminate(); }
        else host.kill();
        await waitGone(probes);
        job!.close(); job!.close(); job!.terminate();
      } finally { job?.close(); for (const probe of probes) probe.dispose(); host.kill(); }
    }
  });

  it('kills the owned tree when its manager crashes without JS shutdown hooks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-job-test-'));
    let manager: ChildProcessWithoutNullStreams | undefined; let managerProbe: ProcessProbe | undefined;
    const probes: ProcessProbe[] = [];
    try {
      // Execute the actual helper in a separate manager, transpiled without
      // bundling: the manager must be the only owner of its Job handle.
      const source = await readFile(path.resolve('src/main/dsh/windows-job.ts'), 'utf8');
      const modulePath = path.join(root, 'windows-job.cjs');
      await writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
      const program = `const {spawn}=require('node:child_process'); const {attachProcessJob}=require(${JSON.stringify(modulePath)}); const host=spawn(process.execPath,['-e',${JSON.stringify(hostProgram)}],{windowsHide:true,stdio:['pipe','pipe','pipe']}); attachProcessJob(host); host.stdout.pipe(process.stdout); host.stderr.pipe(process.stderr); host.stdin.write('start\\n'); setInterval(()=>{},1000);`;
      manager = spawnNode(program, { ...process.env, NODE_PATH: path.resolve('node_modules') });
      managerProbe = processProbe(manager.pid!);
      for (const pid of await readPids(manager)) probes.push(processProbe(pid));
      expect(probes.every(probe => probe.alive())).toBe(true);
      managerProbe.dispose();
      await waitGone(probes);
    } finally {
      managerProbe?.dispose(); for (const probe of probes) probe.dispose(); manager?.kill();
      await removeFixture(root);
    }
  });
});

describe('Windows Job platform boundary', () => {
  it.skipIf(process.platform === 'win32')('does not load or assign native Jobs on other platforms', () => {
    expect(attachProcessJob({} as ChildProcessWithoutNullStreams)).toBeUndefined();
  });
});
