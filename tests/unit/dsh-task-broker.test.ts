import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
import { DshTaskBroker } from '../../src/main/dsh/task-broker';
import { removeManaged } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-broker-')); roots.push(rootPath); await mkdir(path.join(rootPath, 'cli'));
  const shim = `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const context=JSON.parse(fs.readFileSync(process.env.WORLDLINEBOX_DSH_CLI_CONTEXT,'utf8'));let prompt='';
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>prompt+=text);process.stdin.on('end',()=>{
 const line=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 line({type:'session',sessionId:'native-'+context.id});line({type:'user',text:prompt});line({type:'tool_start',args:{prompt,apiKey:'sk-fixture-never-retain'}});
 if(prompt==='sleep'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(context.capture,JSON.stringify({pid:child.pid}));line({type:'job_started'});setInterval(()=>{},1000);return;}
 if(prompt==='large'){line({type:'final',text:'x'.repeat(1200000)});return;}
 if(prompt==='error'){line({type:'error',code:'fixture/error',message:prompt+' secret: sk-fixture-never-retain'});process.exitCode=1;return;}
 setTimeout(()=>{const text=JSON.stringify({type:'final',text:'来自 '+context.instanceId+'：完成'})+'\\n';const b=Buffer.from(text);process.stdout.write(b.subarray(0,20));setTimeout(()=>process.stdout.write(b.subarray(20)),10);},prompt==='delay'?150:10);
});`;
  await writeFile(path.join(rootPath, 'cli', 'shim.cjs'), shim);
  const selection = (id: string): DshCliSelection => ({ instance: { id, name: id, runtimeId: `runtime-${id}`, profile: 'web', status: 'stopped', createdAt: '', updatedAt: '',
    homePath: path.join(rootPath, id, 'home'), agentsPath: path.join(rootPath, id, 'agents'), workspacePath: rootPath, browserPartition: `persist:${id}`, isDefault: false },
    plan: { executable: process.execPath, cli: 'selected-native-cli.js', env: {} }, env: { ...process.env }, workspacePath: rootPath, routingPatch: 'private.patch', runtimeVersion: id === 'instance-a' ? '0.2.0-rc.2' : '0.2.1-alpha.2' });
  let selected = 'instance-a'; const pins: string[] = []; const removed: string[] = []; const captured: DshCliSelection[] = []; let eventHook: ((type: string, id: string) => void) | undefined;
  const broker = new DshTaskBroker({ rootPath, getSelection: async id => selection(id ?? selected), pin: async context => {
    captured.push(context); const id = randomUUID(); const contextFile = path.join(rootPath, `${id}.json`); pins.push(contextFile);
    await writeFile(contextFile, JSON.stringify({ id, instanceId: context.instance.id, capture: path.join(rootPath, 'child.json') }));
    return { contextFile, dispose: async () => { removed.push(contextFile); await removeManaged(rootPath, contextFile); } };
  }, onEvent: event => eventHook?.(event.type, event.taskId) });
  const logs: string[] = []; const operation = (id = randomUUID(), controller = new AbortController()): OperationContext => ({ id, signal: controller.signal,
    update: async () => undefined, log: async message => { logs.push(message); } });
  return { rootPath, broker, pins, removed, captured, logs, operation, select: (id: string) => { selected = id; }, events: (hook: typeof eventHook) => { eventHook = hook; } };
}
describe('Pinned DSH task broker', () => {
  it('pins A while selection changes to B, captures real native session IDs and keeps user/tool input out of metadata and events', async () => {
    const test = await fixture(); const a = test.operation(); const running = test.broker.execute({ prompt: 'delay' }, a);
    while (!test.broker.state().length) await new Promise(resolve => setTimeout(resolve, 10)); test.select('instance-b');
    const b = await test.broker.execute({ prompt: '中文任务私密输入' }, test.operation()); const resultA = await running;
    expect(resultA).toMatchObject({ instanceId: 'instance-a', runtimeId: 'runtime-instance-a', runtimeVersion: '0.2.0-rc.2', text: '来自 instance-a：完成' });
    expect(b).toMatchObject({ instanceId: 'instance-b', runtimeVersion: '0.2.1-alpha.2', text: '来自 instance-b：完成' }); expect(b.sessionId).toMatch(/^native-/);
    const persisted = await readFile(path.join(test.rootPath, 'tasks.json'), 'utf8'); const retained = JSON.stringify(test.broker.events(b.taskId));
    expect(persisted).not.toMatch(/中文任务|delay|sk-fixture|tool_start/); expect(retained).not.toMatch(/中文任务|sk-fixture|apiKey/);
    expect(test.logs.join('\n')).not.toMatch(/中文任务|delay|sk-fixture/); expect(test.removed).toEqual(expect.arrayContaining(test.pins));
    expect(test.broker.result(b.taskId)).toEqual(b); await test.broker.shutdown();
  });
  it('cancels only the owned job and all descendants while leaving an unrelated process alive', async () => {
    const test = await fixture(); const operation = test.operation(); let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    test.events(type => { if (type === 'job_started') ready(); }); const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    try {
      const task = test.broker.execute({ prompt: 'sleep' }, operation); void task.catch(() => undefined); await started;
      const child = JSON.parse(await readFile(path.join(test.rootPath, 'child.json'), 'utf8')) as { pid: number }; test.broker.cancel(operation.id);
      await expect(task).rejects.toThrow('cancelled'); expect(test.broker.state()[0]?.status).toBe('cancelled');
      expect(() => process.kill(child.pid, 0)).toThrow(); expect(() => process.kill(foreign.pid!, 0)).not.toThrow(); expect(test.removed).toHaveLength(1);
    } finally { foreign.kill(); await test.broker.shutdown(); }
  });
  it('contains oversized NDJSON lines and error bodies without storing prompts or leaving a pin alive', async () => {
    const test = await fixture(); await expect(test.broker.execute({ prompt: 'large' }, test.operation())).rejects.toThrow('one MiB');
    expect(test.broker.state()[0]?.status).toBe('failed'); await expect(test.broker.execute({ prompt: 'error' }, test.operation())).rejects.toThrow('failed');
    expect(JSON.stringify(test.broker.state())).not.toContain('sk-fixture'); expect(test.removed).toHaveLength(2); await test.broker.shutdown();
  });
  it('marks interrupted metadata on restart and does not persist model replies', async () => {
    const test = await fixture(); const result = await test.broker.execute({ prompt: 'fixture' }, test.operation()); const stored = JSON.parse(await readFile(path.join(test.rootPath, 'tasks.json'), 'utf8')) as { records: Array<{ status: string }> };
    stored.records[0]!.status = 'running'; await writeFile(path.join(test.rootPath, 'tasks.json'), JSON.stringify(stored));
    const restarted = new DshTaskBroker({ rootPath: test.rootPath, getSelection: async () => test.captured[0]!, pin: async () => { throw new Error('Never auto-run interrupted jobs'); } });
    await restarted.init(); expect(restarted.state()[0]?.status).toBe('interrupted'); expect(restarted.state()[0]?.sessionId).toBe(result.sessionId); expect(restarted.result(result.taskId)).toBeUndefined(); await restarted.shutdown();
  });
  it('enforces four in-flight reservations and frees every job and pin during shutdown', async () => {
    const test = await fixture(); const tasks = Array.from({ length: 4 }, () => test.broker.execute({ prompt: 'sleep' }, test.operation()));
    for (const task of tasks) void task.catch(() => undefined);
    await expect(test.broker.execute({ prompt: 'fifth' }, test.operation())).rejects.toThrow('Four DSH tasks');
    while (test.broker.state().length < 4) await new Promise(resolve => setTimeout(resolve, 10));
    await test.broker.shutdown(); expect((await Promise.allSettled(tasks)).every(result => result.status === 'rejected')).toBe(true);
    expect(test.broker.state().every(record => record.status === 'cancelled')).toBe(true); expect(test.removed).toHaveLength(4);
  });
  it('cancels an abort-aware context preparation before creating any pin or process and releases the reservation', async () => {
    const test = await fixture(); const controller = new AbortController(); let entered!: () => void; const preparing = new Promise<void>(resolve => { entered = resolve; }); let pinned = false;
    const broker = new DshTaskBroker({ rootPath: test.rootPath, getSelection: async (_id, signal) => {
      entered(); return await new Promise<DshCliSelection>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('Preparation interrupted')), { once: true }); });
    }, pin: async () => { pinned = true; throw new Error('An aborted context must not be pinned'); } });
    const task = broker.execute({ prompt: 'private fixture' }, test.operation(randomUUID(), controller)); void task.catch(() => undefined); await preparing; controller.abort();
    await expect(task).rejects.toThrow('cancelled before'); expect(pinned).toBe(false); expect(broker.state()).toEqual([]); await broker.shutdown();
  });
});
