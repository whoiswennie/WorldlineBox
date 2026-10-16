import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
import { DshTaskBroker, normalizeDshTaskProgress } from '../../src/main/dsh/task-broker';
import { DshTaskPreparationError } from '../../src/main/dsh/task-preparation';
import { removeManaged } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';
import * as processTools from '../../src/main/dsh/instance-process';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import { dshCompatibilityCheckIds } from '../../src/shared/dsh-runtime-compatibility';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function fixture(sharedStatus: 'passed' | 'failed' | 'missing' = 'passed') {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-broker-')); roots.push(rootPath); await mkdir(path.join(rootPath, 'cli'));
  const descendantProgram = "const {spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(leaf.pid);setInterval(()=>{},1000);";
  const shim = `const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const context=JSON.parse(fs.readFileSync(process.env.WORLDLINEBOX_DSH_CLI_CONTEXT,'utf8'));let prompt='';
process.stdin.setEncoding('utf8');process.stdin.on('data',text=>prompt+=text);process.stdin.on('end',()=>{
 const line=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 line({type:'session',sessionId:'native-'+context.id});line({type:'user',text:prompt});line({type:'tool_start',args:{prompt,apiKey:'sk-fixture-never-retain'}});
 if(prompt==='progress'){
  line({type:'status',phase:'turn_start',turn:0});line({type:'status',phase:'step_start',turn:0,step:0});
  line({type:'tool_call',callId:'call-1',tool:'filesystem.read',input:{prompt,env:{TOKEN:'sk-fixture-never-retain'}}});
  line({type:'thinking',text:'raw reasoning '+prompt+' sk-fixture-never-retain'});line({type:'text',text:'raw intermediate '+prompt+' sk-fixture-never-retain'});
  line({type:'tool_result',callId:'call-1',status:'completed',result:'raw result '+prompt+' sk-fixture-never-retain'});
  line({type:'status',phase:'step_end',turn:0,step:0,usage:{inputTokens:10,secret:'sk-fixture-never-retain'}});
  line({type:'status',phase:'turn_end',turn:0,reason:{kind:'completed',message:'private '+prompt}});
 }
 if(prompt==='many-progress')for(let i=0;i<1100;i++)line({type:'status',phase:'step_start',turn:0,step:i,input:prompt});
 if(prompt==='connection'||prompt==='connection-error'){
  const args=process.argv.slice(2),at=args.indexOf('--patch'),patchPath=at<0?undefined:args[at+1],key=process.env.WORLDLINEBOX_TASK_DEEPSEEK_API_KEY;
  const patch=patchPath?JSON.parse(fs.readFileSync(patchPath,'utf8')):undefined;
  fs.writeFileSync(path.join(path.dirname(context.capture),context.id+'-binding.json'),JSON.stringify({args,patch,patchPath,context,
   keyPresent:!!key,keyHash:key?require('node:crypto').createHash('sha256').update(key).digest('hex'):null}));
  if(key){line({type:'session',sessionId:key});line({type:'tool_call',callId:'key-call',tool:key,input:{key}});line({type:key});}
  if(prompt==='connection-error'){line({type:'error',code:key,message:key});process.exitCode=1;return;}
  line({type:'final',text:'connection completed '+(key||'native configuration')});return;
 }
 if(prompt==='sleep'||prompt==='orphan'){const child=spawn(process.execPath,['-e',${JSON.stringify(descendantProgram)}],{windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',chunk=>{fs.writeFileSync(context.capture,JSON.stringify({pid:child.pid,grandchildPid:Number(String(chunk).trim())}));line({type:'job_started'});if(prompt==='orphan')process.stdout.write(JSON.stringify({type:'final',text:'fixture done'})+'\\n',()=>process.exit(0));});setInterval(()=>{},1000);return;}
 if(prompt==='large'){line({type:'final',text:'x'.repeat(1200000)});return;}
 if(prompt==='error'){line({type:'error',code:'fixture/error',message:prompt+' secret: sk-fixture-never-retain'});process.exitCode=1;return;}
 setTimeout(()=>{const text=JSON.stringify({type:'final',text:'来自 '+context.instanceId+'：完成'})+'\\n';const b=Buffer.from(text);process.stdout.write(b.subarray(0,20));setTimeout(()=>process.stdout.write(b.subarray(20)),10);},prompt==='delay'?150:10);
});`;
  await writeFile(path.join(rootPath, 'cli', 'shim.cjs'), shim);
  const selection = (id: string): DshCliSelection => ({ instance: { id, name: id, runtimeId: `runtime-${id}`, profile: 'web', status: 'stopped', createdAt: '', updatedAt: '',
    homePath: path.join(rootPath, id, 'home'), agentsPath: path.join(rootPath, id, 'agents'), workspacePath: rootPath, browserPartition: `persist:${id}`, isDefault: false },
    plan: { executable: process.execPath, cli: 'selected-native-cli.js', env: {} }, env: { ...process.env }, workspacePath: rootPath, routingPatch: 'private.patch', runtimeVersion: id === 'instance-a' ? '0.2.0-rc.2' : '0.2.1-alpha.2',
    runtime: { id: `runtime-${id}`, version: 'synthetic', nodeVersion: process.versions.node, platform: 'win32-x64', adapter: 'node-cli-web-v1',
      source: 'synthetic transport fixture', sourceSha256: 'a'.repeat(64), installedAt: '', fileCount: 0, byteLength: 0, contentSha256: 'a'.repeat(64), compatibility: sharedStatus === 'missing' ? undefined : {
      runtimeId: `runtime-${id}`, contentSha256: 'a'.repeat(64), contract: 'synthetic transport fixture', status: sharedStatus, startedAt: '', peers: [],
      checks: dshCompatibilityCheckIds.map(id => ({ id, status: sharedStatus === 'failed' && id === 'native-api' ? 'failed' : 'passed', detail: 'synthetic transport fixture' })),
    } } as DshRuntime });
  let selected = 'instance-a'; const pins: string[] = []; const removed: string[] = []; const captured: DshCliSelection[] = []; let eventHook: ((type: string, id: string) => void) | undefined;
  let disposeHook: (() => Promise<void>) | undefined;
  const broker = new DshTaskBroker({ rootPath, getSelection: async id => selection(id ?? selected), pin: async context => {
    captured.push(context); const id = randomUUID(); const contextFile = path.join(rootPath, `${id}.json`); pins.push(contextFile);
    await writeFile(contextFile, JSON.stringify({ id, instanceId: context.instance.id, capture: path.join(rootPath, 'child.json') }));
    return { contextFile, dispose: async () => { await disposeHook?.(); removed.push(contextFile); await removeManaged(rootPath, contextFile); } };
  }, onEvent: event => eventHook?.(event.type, event.taskId) });
  const logs: string[] = []; const operation = (id = randomUUID(), controller = new AbortController()): OperationContext => ({ id, signal: controller.signal,
    update: async () => undefined, log: async message => { logs.push(message); } });
  return { rootPath, broker, pins, removed, captured, logs, operation, select: (id: string) => { selected = id; }, events: (hook: typeof eventHook) => { eventHook = hook; }, dispose: (hook: typeof disposeHook) => { disposeHook = hook; } };
}
describe('Pinned DSH task broker', () => {
  it.each(['failed', 'missing'] as const)('executes a selection admitted by the launcher without duplicating its storage policy for a %s cached report', async status => {
    const test = await fixture(status);
    try {
      const result = await test.broker.execute({ prompt: 'connection' }, test.operation(), { toolkit: true, access: { mode: 'read-only' } });
      expect(result.text).toContain('native configuration');
      expect(test.broker.state()[0]?.status).toBe('succeeded');
    } finally { await test.broker.shutdown(); }
  });
  it('preserves controlled preparation diagnostics and progress before any pin or process is created', async () => {
    const test = await fixture(); const operation = test.operation(); let pinned = false;
    const broker = new DshTaskBroker({ rootPath: test.rootPath,
      getSelection: async (_id, _signal, _resume, preparation) => {
        preparation?.progress('正在读取实例账号配置');
        throw new DshTaskPreparationError('compatibility', 'DSH 检测失败：model-settings；请重新检测。');
      }, pin: async () => { pinned = true; throw new Error('must not pin'); } });
    await expect(broker.execute({ prompt: 'fixture' }, operation, { toolkit: true })).rejects.toThrow('model-settings');
    expect(pinned).toBe(false); expect(broker.state()).toEqual([]);
    expect(broker.events(operation.id).at(-1)).toMatchObject({ stage: 'failed', code: 'task/preparation/compatibility', summary: expect.stringContaining('model-settings') });
    expect(test.logs).toContain('DSH 检测失败：model-settings；请重新检测。');
    await broker.shutdown(); await test.broker.shutdown();
  });
  it('does not publish arbitrary preparation exceptions that may contain native credentials', async () => {
    const test = await fixture(); const operation = test.operation();
    const broker = new DshTaskBroker({ rootPath: test.rootPath,
      getSelection: async () => { throw new Error('private-native-credential-and-prompt'); },
      pin: async () => { throw new Error('must not pin'); } });
    await expect(broker.execute({ prompt: 'fixture' }, operation, { toolkit: true })).rejects.toThrow('执行进程尚未启动');
    expect(JSON.stringify([test.logs, broker.events(operation.id)])).not.toContain('private-native-credential');
    await broker.shutdown(); await test.broker.shutdown();
  });
  it('pins and records the effective access policy without applying a changed preference mid-task', async () => {
    const test = await fixture();
    const access = { mode: 'read-only' as const };
    const operation = test.operation();
    const task = test.broker.execute({ prompt: 'connection' }, operation, { toolkit: true, access });
    Object.assign(access, { mode: 'danger-full-access' });
    const result = await task;
    const binding = JSON.parse(await readFile(path.join(test.rootPath, `${path.basename(test.pins[0]!, '.json')}-binding.json`), 'utf8')) as {
      patch: Array<{ id: string; disabled?: boolean; config?: unknown }>; keyPresent: boolean;
    };
    expect(binding.patch).toContainEqual({ id: 'sandbox-policy', disabled: false, config: { mode: 'read-only', workspaceRoot: test.rootPath } });
    expect(test.broker.state().find(record => record.id === result.taskId)?.accessMode).toBe('read-only');
    const stored = JSON.parse(await readFile(path.join(test.rootPath, 'tasks.json'), 'utf8')) as { records: Array<{ accessMode?: string }> };
    expect(stored.records[0]?.accessMode).toBe('read-only');
    expect(binding.keyPresent).toBe(false);
    await expect(test.broker.execute({ prompt: 'continue', sessionId: result.sessionId }, test.operation(), { access: { mode: 'danger-full-access' } })).rejects.toThrow('recorded access policy');
    expect(test.pins).toHaveLength(1);
    await test.broker.shutdown();
  });
  it('provides a companion toolkit with native instance credentials when no global connection is passed', async () => {
    const test = await fixture();
    const result = await test.broker.execute({ prompt: 'connection' }, test.operation(), { toolkit: true });
    const binding = JSON.parse(await readFile(path.join(test.rootPath, `${path.basename(test.pins[0]!, '.json')}-binding.json`), 'utf8')) as {
      keyPresent: boolean; patchPath: string; patch: Array<{ id: string; disabled?: boolean; config?: unknown }>;
    };
    expect(binding.keyPresent).toBe(false);
    expect(binding.patch).toContainEqual({ id: 'tool-fs', disabled: false });
    expect(binding.patch).toContainEqual({ id: 'tool-fs-search', disabled: false });
    expect(binding.patch.every(entry => !entry.config || entry.id === 'tools')).toBe(true);
    expect(result.text).toContain('native configuration');
    await expect(readFile(binding.patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await test.broker.shutdown();
  });
  it('runs concurrent native tasks without writing any provider, model or credential overlay', async () => {
    const test = await fixture();
    const results = await Promise.all([test.broker.execute({ prompt: 'connection' }, test.operation(), { toolkit: true }), test.broker.execute({ prompt: 'connection' }, test.operation(), { toolkit: true })]);
    for (const pin of test.pins) {
      const binding = JSON.parse(await readFile(path.join(test.rootPath, path.basename(pin, '.json')+'-binding.json'), 'utf8'));
      expect(binding.keyPresent).toBe(false);
      expect(binding.patch.some((row: { id: string }) => /^(?:llm-|agent-default-model|web-search-deepseek)/.test(row.id))).toBe(false);
      expect(binding.patchPath).toMatch(/-task\.patch\.json$/);
      await expect(readFile(binding.patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(results.every(result => result.text?.includes('native configuration'))).toBe(true);
    await test.broker.shutdown();
  });
  it('cleans its task-control patch when the native task fails', async () => {
    const test = await fixture(); const operation = test.operation();
    await expect(test.broker.execute({ prompt: 'connection-error' }, operation, { toolkit: true })).rejects.toThrow('failed');
    const binding = JSON.parse(await readFile(path.join(test.rootPath, path.basename(test.pins[0]!, '.json')+'-binding.json'), 'utf8'));
    await expect(readFile(binding.patchPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(test.removed).toHaveLength(1); await test.broker.shutdown();
  });

  it('removes a transient routing patch before releasing a cancelled task pin', async () => {
    const test = await fixture();
    const operation = test.operation();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    test.events(type => { if (type === 'job_started') ready(); });
    const task = test.broker.execute({ prompt: 'sleep' }, operation, { toolkit: true });
    void task.catch(() => undefined);
    await started;
    const patch = (await readdir(test.rootPath)).find(name => name.endsWith('-task.patch.json'))!;
    expect(patch).toBeTruthy();
    expect(await readFile(path.join(test.rootPath, patch), 'utf8')).not.toContain('llm-deepseek');
    test.broker.cancel(operation.id);
    await expect(task).rejects.toThrow('cancelled');
    await expect(readFile(path.join(test.rootPath, patch))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(test.removed).toHaveLength(1);
    await test.broker.shutdown();
  });

  it('refuses task capabilities when the selected runtime identity is missing before creating a pin', async () => {
    const test = await fixture();
    await test.broker.execute({ prompt: 'fixture' }, test.operation());
    let pinned = false;
    const broker = new DshTaskBroker({ rootPath: test.rootPath,
      getSelection: async () => ({ ...test.captured[0]!, runtimeVersion: '0.1.0-unknown', runtime: undefined }),
      pin: async () => { pinned = true; throw new Error('Capabilities must not enter an uninspected runtime.'); } });
    await expect(broker.execute({ prompt: 'fixture' }, test.operation(), { toolkit: true })).rejects.toThrow('运行版本与所选实例不一致');
    expect(pinned).toBe(false);
    await broker.shutdown();
    await test.broker.shutdown();
  });

  it('streams real tool inputs, results and public output while removing reasoning and credentials', async () => {
    const test = await fixture();
    const result = await test.broker.execute({ prompt: 'progress' }, test.operation());
    const events = test.broker.events(result.taskId);
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(events.find(event => event.type === 'tool_call')).toMatchObject({ stage: 'tool_start', toolName: 'filesystem.read', summary: '开始调用工具' });
    expect(events.find(event => event.type === 'tool_result')).toMatchObject({ stage: 'tool_end', toolName: 'filesystem.read', summary: '工具执行完成' });
    expect(events.filter(event => event.type === 'status').map(event => event.stage)).toEqual(['turn_start', 'step_start', 'step_end', 'turn_end']);
    expect(events.find(event => event.type === 'thinking')).not.toHaveProperty('text');
    const archived = await test.broker.readRecord({ recordId: result.taskId, start: 1, end: 20 });
    expect(archived.overview).toMatchObject({ turns: 1, steps: 1, toolCalls: 1, complete: true });
    expect(JSON.stringify(archived)).not.toMatch(/raw reasoning|sk-fixture-never-retain/);
    expect(events.find(event => event.type === 'text')).toMatchObject({ contentKind: 'message', text: 'raw intermediate progress [redacted]' });
    const retained = JSON.stringify(events);
    expect(retained).not.toMatch(/sk-fixture|raw reasoning|inputTokens|TOKEN|"env":/);
    expect(events.find(event => event.type === 'tool_result')?.text).toContain('raw result');
    expect(events.at(-1)).toMatchObject({ type: 'final', stage: 'completed', text: result.text });
    expect(events.every(event => !event.summary || event.summary.length <= 1000)).toBe(true);
    await test.broker.shutdown();
  });

  it('bounds event retention without disturbing sequence cursors or structured progress', async () => {
    const test = await fixture();
    const result = await test.broker.execute({ prompt: 'many-progress' }, test.operation());
    const events = test.broker.events(result.taskId);
    expect(events).toHaveLength(1000);
    expect(events[0]!.sequence).toBeGreaterThan(0);
    expect(events.every((event, index) => index === 0 || event.sequence === events[index - 1]!.sequence + 1)).toBe(true);
    const cursor = events.at(-2)!.sequence;
    expect(test.broker.events(result.taskId, cursor)).toEqual([events.at(-1)]);
    expect(events.at(-1)?.type).toBe('final');
    const archived = await test.broker.readRecord({ recordId: result.taskId, start: 1, end: 5 });
    expect(archived.overview.recordCount).toBeGreaterThan(1000);
    expect(archived.overview.steps).toBe(1100);
    expect(archived.entries[0]?.event.sequence).toBe(0);
    expect(JSON.stringify(events)).not.toContain('many-progress');
    await test.broker.shutdown();
  });

  it('accepts only actual progress fields and does not use plugin-provided display strings', () => {
    const tools = new Map<string, string>();
    expect(normalizeDshTaskProgress({ type: 'tool_call', callId: 'tool-1', tool: 'shell.exec', input: 'private arguments', summary: 'fake summary' }, tools)).toEqual({ stage: 'tool_start', toolName: 'shell.exec', summary: '开始调用工具' });
    expect(normalizeDshTaskProgress({ type: 'tool_result', callId: 'tool-1', status: 'error', tool: 'fake.other', result: 'apiKey: never-publish' }, tools)).toEqual({ stage: 'tool_end', toolName: 'shell.exec', summary: '工具执行失败' });
    expect(tools.size).toBe(0);
    for (const tool of ['private input', 'sk-fixture-never-publish', 'ghp_fixturesecret', 'fixture-private-prompt']) {
      expect(normalizeDshTaskProgress({ type: 'tool_call', tool, callId: 'untrusted' }, tools, ['fixture-private-prompt'])).not.toHaveProperty('toolName');
    }
    expect(normalizeDshTaskProgress({ type: 'tool_start', name: 'not-inspected-shape', summary: 'do not infer' }, tools)).toEqual({});
    expect(normalizeDshTaskProgress({ type: 'status', phase: 'not-a-supported-phase', summary: 'do not infer' }, tools)).toEqual({});
    expect(normalizeDshTaskProgress({ type: 'status', phase: 'step_start', step: 1 }, tools)).toMatchObject({ summary: '开始第 1 步处理' });
    expect(normalizeDshTaskProgress({ type: 'status', phase: 'step_end', step: 1 }, tools)).toMatchObject({ summary: '第 1 步处理结束' });
    expect(normalizeDshTaskProgress({ type: 'thinking', text: 'raw private reasoning' }, tools)).toEqual({});
    expect(normalizeDshTaskProgress({ type: 'text', text: 'raw private intermediate' }, tools)).toEqual({ stage: 'message', summary: '能力正在输出' });
    expect(normalizeDshTaskProgress({ type: 'final', text: { secret: 'not-a-real-final' } }, tools)).toEqual({});
    expect(normalizeDshTaskProgress({ type: 'session', sessionId: '../not-a-real-session' }, tools)).toEqual({});
  });

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
  it('manually terminates only the selected CLI process tree and retains its recoverable session record', async () => {
    const test = await fixture(), operation = test.operation();
    let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
    test.events(type => { if (type === 'job_started') ready(); });
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    let disposing!: () => void, release!: () => void;
    const disposingStarted = new Promise<void>(resolve => { disposing = resolve; });
    const disposalAllowed = new Promise<void>(resolve => { release = resolve; });
    test.dispose(async () => { disposing(); await disposalAllowed; });
    try {
      const task = test.broker.execute({ prompt: 'sleep' }, operation); void task.catch(() => undefined); await started;
      const child = JSON.parse(await readFile(path.join(test.rootPath, 'child.json'), 'utf8')) as { pid: number; grandchildPid: number };
      let terminated = false;
      const termination = test.broker.terminate(operation.id).then(() => { terminated = true; });
      await disposingStarted;
      expect(terminated).toBe(false); expect(test.removed).toEqual([]);
      expect(() => process.kill(child.pid, 0)).toThrow(); expect(() => process.kill(child.grandchildPid, 0)).toThrow();
      release(); await termination;
      // Do not await execute before checking terminate's actual promise contract.
      expect(test.removed).toHaveLength(1);
      await expect(task).rejects.toThrow('cancelled');
      expect(test.broker.state()[0]).toMatchObject({ status: 'cancelled', sessionId: expect.stringMatching(/^native-/), workspacePath: test.rootPath });
      expect(() => process.kill(child.pid, 0)).toThrow();
      expect(() => process.kill(foreign.pid!, 0)).not.toThrow();
      await expect(test.broker.terminate(operation.id)).resolves.toBeUndefined();
      await expect(test.broker.terminate('unretained-old-operation')).resolves.toBeUndefined();
    } finally { release(); foreign.kill(); await test.broker.shutdown(); }
  });
  it('verifies descendants are gone after a natural CLI exit before reporting success', async () => {
    if (process.platform !== 'win32') return;
    const test = await fixture();
    try {
      await test.broker.execute({ prompt: 'orphan' }, test.operation());
      const child = JSON.parse(await readFile(path.join(test.rootPath, 'child.json'), 'utf8')) as { pid: number; grandchildPid: number };
      expect(() => process.kill(child.pid, 0)).toThrow(); expect(() => process.kill(child.grandchildPid, 0)).toThrow();
      expect(test.removed).toHaveLength(1);
    } finally { await test.broker.shutdown(); }
  });
  it('waits for a cancelled preparation to finish before resolving termination', async () => {
    const test = await fixture(); let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; }), allowed = new Promise<void>(resolve => { release = resolve; });
    const broker = new DshTaskBroker({ rootPath: test.rootPath, getSelection: async () => { entered(); await allowed; throw new Error('Fixture preparation finished'); },
      pin: async () => { throw new Error('Cancelled preparation must not pin'); } });
    const operation = test.operation(), task = broker.execute({ prompt: 'fixture' }, operation); void task.catch(() => undefined);
    try {
      await preparing; let finished = false;
      const stopped = broker.terminate(operation.id).then(() => { finished = true; });
      await new Promise(resolve => setTimeout(resolve, 25)); expect(finished).toBe(false);
      release(); await stopped; await expect(task).rejects.toThrow('启动前已取消'); expect(broker.state()).toEqual([]);
    } finally { release(); await broker.shutdown(); await test.broker.shutdown(); }
  });
  it('retains an unconfirmed owned cleanup and its pin until termination is retried successfully', async () => {
    const test = await fixture(), operation = test.operation();
    const termination = vi.spyOn(processTools, 'terminateOwnedProcess').mockRejectedValue(new Error('Fixture process accounting unavailable'));
    try {
      await expect(test.broker.execute({ prompt: 'delay' }, operation)).rejects.toThrow('could not be confirmed stopped');
      expect(test.broker.state()[0]?.status).toBe('failed'); expect(test.removed).toEqual([]);
      termination.mockRestore();
      await test.broker.terminate(operation.id);
      expect(test.removed).toHaveLength(1);
      await expect(test.broker.terminate(operation.id)).resolves.toBeUndefined();
    } finally { termination.mockRestore(); await test.broker.shutdown(); }
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
  it('enforces twenty in-flight reservations and frees every job and pin during shutdown', async () => {
    const test = await fixture(); const tasks = Array.from({ length: 20 }, () => test.broker.execute({ prompt: 'sleep' }, test.operation()));
    for (const task of tasks) void task.catch(() => undefined);
    await expect(test.broker.execute({ prompt: 'twenty-first' }, test.operation())).rejects.toThrow('Twenty DSH tasks');
    while (test.broker.state().length < 20) await new Promise(resolve => setTimeout(resolve, 10));
    await test.broker.shutdown(); expect((await Promise.allSettled(tasks)).every(result => result.status === 'rejected')).toBe(true);
    expect(test.broker.state().every(record => record.status === 'cancelled')).toBe(true); expect(test.removed).toHaveLength(20);
  });
  it('cancels an abort-aware context preparation before creating any pin or process and releases the reservation', async () => {
    const test = await fixture(); const controller = new AbortController(); let entered!: () => void; const preparing = new Promise<void>(resolve => { entered = resolve; }); let pinned = false;
    const broker = new DshTaskBroker({ rootPath: test.rootPath, getSelection: async (_id, signal) => {
      entered(); return await new Promise<DshCliSelection>((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('Preparation interrupted')), { once: true }); });
    }, pin: async () => { pinned = true; throw new Error('An aborted context must not be pinned'); } });
    const task = broker.execute({ prompt: 'private fixture' }, test.operation(randomUUID(), controller)); void task.catch(() => undefined); await preparing; controller.abort();
    await expect(task).rejects.toThrow('启动前已取消'); expect(pinned).toBe(false); expect(broker.state()).toEqual([]); await broker.shutdown();
  });
});
