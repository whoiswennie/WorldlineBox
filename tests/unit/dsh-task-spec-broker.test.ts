import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DshTaskBroker } from '../../src/main/dsh/task-broker';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';
import type { DshTaskExecutionOptions } from '../../src/main/dsh/task-execution';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(stableProfile = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-spec-')); roots.push(root);
  const cli = path.join(root, 'cli'); await mkdir(cli);
  await writeFile(path.join(cli, 'shim.cjs'), String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),crypto=require('node:crypto');
const emit=value=>console.log(JSON.stringify(value));
let opened;
emit({type:'runtime_ready'});
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const input=JSON.parse(line);
 if(input.type==='open'){opened=input;return}
 if(input.type!=='start'||!opened)return;
 const sessionId=opened.resumeSessionId||'session-'+crypto.randomUUID();
 emit({type:'session',sessionId}); emit({type:'capabilities',modes:['native'],preset:'standard',tools:[{name:'read',description:'read'}],skills:[],toolRestrictions:true,skillSelection:true});
 if(opened.policy?.discover){emit({type:'final',text:'discovered'});emit({type:'task_finished',code:0});opened=undefined;return}
 const file=path.join(opened.cwd,'result.txt');
 if(!input.content.includes('missing-artifact'))fs.writeFileSync(file,input.content.includes('echo-constraints')?input.content:'verified output');
 emit({type:'artifacts',files:[{path:'result.txt',description:'test delivery'}]});
 emit({type:'status',phase:'turn_start'});emit({type:'status',phase:'turn_end',reason:{kind:'completed'}});
 emit({type:'final',text:input.content.includes('bad-json')?'bad':input.content.includes('Delivery format: json')?JSON.stringify({done:true}):'done'});emit({type:'task_finished',code:0});opened=undefined;
});lines.on('close',()=>process.exit(0));`);
  const home = stableProfile ? path.join(root, 'home') : root, agents = stableProfile ? path.join(root, 'agents') : root;
  if (stableProfile) { await mkdir(home); await mkdir(agents); }
  const selected: DshCliSelection = { instance: { id: 'fixture', name: 'fixture', runtimeId: 'runtime-fixture', profile: 'web', status: 'stopped', homePath: home,
    agentsPath: agents, workspacePath: root, browserPartition: 'temporary:fixture', isDefault: true, createdAt: '', updatedAt: '' },
    plan: { executable: process.execPath, cli: 'fixture', env: {} }, env: { ...process.env }, workspacePath: root, routingPatch: '', runtimeVersion: 'fixture', runtime: { id: 'runtime-fixture' } as DshCliSelection['runtime'] };
  const captured: DshCliSelection[] = [];
  const broker = new DshTaskBroker({ rootPath: root, getSelection: async () => selected, pin: async selection => {
    captured.push(selection); const directory = path.join(cli, randomUUID()); await mkdir(directory);
    const contextFile = path.join(directory, 'context.json'); await writeFile(contextFile, '{}');
    return { contextFile, dispose: async () => { await rm(contextFile); await rm(directory, { recursive: true }); } };
  } });
  const owner = { actionId: randomUUID(), companionId: 'owner', conversationId: 'conversation', sourceMessageId: 'message' };
  const execution: DshTaskExecutionOptions = { workspaceRootPath: path.join(root, '.worldlinebox', 'companions', 'dsh-tasks'), recordScope: owner, access: { mode: 'read-only' } };
  const operation = () => ({ id: randomUUID(), signal: new AbortController().signal, log: async () => undefined, update: async () => undefined });
  return { root, broker, captured, execution, operation };
}

describe('DSH TaskSpec execution and receipts', () => {
  it('keeps cwd and mode pinned across authorized continuation and records real artifact/JSON delivery', async () => {
    const test = await fixture();
    try {
      const first = await test.broker.execute({ prompt: 'Create output.' }, test.operation(), { ...test.execution, task: { tools: ['read'], skills: [], delivery: { format: 'json' } } });
      expect(first.structured).toEqual({ done: true });
      expect(await readFile(first.artifacts![0]!.path, 'utf8')).toBe('verified output');
      const overview = (await test.broker.readRecord({ recordId: first.taskId })).overview;
      expect(overview).toMatchObject({ sessionId: first.sessionId, workspacePath: first.workspacePath, structured: { done: true }, artifacts: first.artifacts });
      const continued = await test.broker.execute({ prompt: 'Continue output.' }, test.operation(), { ...test.execution, task: { session: { mode: 'resume', taskId: first.taskId } } });
      expect(continued.sessionId).toBe(first.sessionId); expect(continued.workspacePath).toBe(first.workspacePath);
      expect(test.broker.state()[0]!.profile).toEqual({ mode: 'native', tools: ['read'], skills: [] });
      await expect(test.broker.execute({ prompt: 'Change mode.' }, test.operation(), { ...test.execution, task: { mode: 'ptc', session: { mode: 'resume', taskId: first.taskId } } })).rejects.toThrow('retains');
      await expect(test.broker.execute({ prompt: 'Cross owner.' }, test.operation(), { ...test.execution, recordScope: { ...test.execution.recordScope!, companionId: 'another' }, task: { session: { mode: 'resume', taskId: first.taskId } } })).rejects.toThrow('another companion');
    } finally { await test.broker.shutdown(); }
  }, 30000);

  it('marks malformed structured output and missing artifacts failed instead of returning a success receipt', async () => {
    const test = await fixture();
    try {
      await expect(test.broker.execute({ prompt: 'bad-json' }, test.operation(), { ...test.execution, task: { delivery: { format: 'json' } } })).rejects.toThrow('valid JSON');
      await expect(test.broker.execute({ prompt: 'missing-artifact' }, test.operation(), { ...test.execution, task: {} })).rejects.toThrow('artifact');
      expect(test.broker.state().every(record => record.status === 'failed')).toBe(true);
      expect(test.broker.result(test.broker.state()[0]!.id)?.artifacts).toEqual([]);
    } finally { await test.broker.shutdown(); }
  }, 30000);

  it('discovers live native metadata without a task model turn', async () => {
    const test = await fixture();
    try {
      const catalog = await test.broker.discover('fixture');
      expect(catalog).toMatchObject({ instanceId: 'fixture', runtimeId: 'runtime-fixture', modes: ['native'], tools: [{ name: 'read', description: 'read' }] });
      expect(test.broker.state()[0]?.status).toBe('succeeded');
    } finally { await test.broker.shutdown(); }
  }, 30000);

  it('coalesces thought prewarm with the real managed request in either order without importing the source workspace dotenv', async () => {
    for (const prewarmFirst of [true, false]) {
      const test = await fixture(true);
      await writeFile(path.join(test.root, '.env'), 'SOURCE_WORKSPACE_ONLY=must-not-enter-thought-host');
      try {
        const operation = test.operation();
        const execute = () => test.broker.execute({ prompt: 'An independent request.' }, operation, { ...test.execution, cognitiveOnly: true });
        let warm: ReturnType<typeof test.broker.prewarmThought>, actual: ReturnType<typeof execute>;
        if (prewarmFirst) { warm = test.broker.prewarmThought('fixture'); actual = execute(); }
        else { actual = execute(); warm = test.broker.prewarmThought('fixture'); }
        const [catalog, result] = await Promise.all([warm, actual]);
        expect(catalog.workspacePath).toBe(path.join(test.root, 'cli', 'thought-prewarm'));
        const records = test.broker.state(); expect(records).toHaveLength(2);
        expect(new Set(records.map(record => record.pid)).size).toBe(1);
        expect(test.captured.every(selection => selection.workspacePath !== test.root)).toBe(true);
        expect(records.find(record => record.id === result.taskId)?.profile).toEqual({ mode: 'native', tools: [], skills: [] });
        const startups = await Promise.all(records.map(async record => (await test.broker.readRecord({ recordId: record.id })).overview.startup));
        expect(startups.filter(startup => startup?.reusedWorker)).toHaveLength(1);
        await expect(readFile(path.join(catalog.workspacePath!, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
        const full = await test.broker.discover('fixture', { access: { mode: 'danger-full-access' } });
        expect(full.workspacePath).toBe(test.root);
        const fullPid = test.broker.state()[0]!.pid; expect(fullPid).not.toBe(records[0]!.pid);
        const next = await test.broker.execute({ prompt: 'Another independent request.' }, test.operation(), { ...test.execution, cognitiveOnly: true });
        expect(test.broker.state().find(record => record.id === next.taskId)?.pid).toBe(records[0]!.pid);
      } finally { await test.broker.shutdown(); }
    }
  }, 30000);

  it('requires current source proof and the same topic/domain when continuing a scoped task', async () => {
    const test = await fixture();
    const recordScope = { ...test.execution.recordScope!, topicId: 'topic-a', domain: 'reality' as const,
      sourceDigest: 'a'.repeat(64), invocationId: 'invocation-original', executionReadsetDigest: 'c'.repeat(64) };
    try {
      const first = await test.broker.execute({ prompt: 'Create output.' }, test.operation(), { ...test.execution, recordScope, task: {} });
      const task = { session: { mode: 'resume' as const, taskId: first.taskId } };
      await expect(test.broker.execute({ prompt: 'Continue.' }, test.operation(), { ...test.execution, recordScope, task })).rejects.toThrow('revalidated');
      await expect(test.broker.execute({ prompt: 'Continue.' }, test.operation(), { ...test.execution, recordScope: { ...recordScope, topicId: null }, resumeScope: recordScope, task })).rejects.toThrow('another topic');
      await expect(test.broker.execute({ prompt: 'Continue.' }, test.operation(), { ...test.execution, recordScope, resumeScope: { ...recordScope, sourceDigest: 'b'.repeat(64) }, task })).rejects.toThrow('revalidated');
      await expect(test.broker.execute({ prompt: 'Continue.' }, test.operation(), { ...test.execution, recordScope: { ...recordScope, executionReadsetDigest: 'd'.repeat(64) }, resumeScope: recordScope, task })).rejects.toThrow('source dependencies');
      const continued = await test.broker.execute({ prompt: 'Continue.' }, test.operation(), { ...test.execution,
        recordScope: { ...recordScope, actionId: randomUUID(), sourceMessageId: 'new-user-source', sourceDigest: 'b'.repeat(64), invocationId: 'invocation-new', executionReadsetDigest: 'd'.repeat(64) }, resumeScope: recordScope, task });
      expect(continued.sessionId).toBe(first.sessionId);
    } finally { await test.broker.shutdown(); }
  }, 30000);

  it('compiles positive/conditional host constraints and validates JSON business shape and real files', async () => {
    const test = await fixture();
    try {
      const accepted = await test.broker.execute({ prompt: 'Create output.' }, test.operation(), { ...test.execution, task: { delivery: {
        format: 'json', jsonSchema: { type: 'object', properties: { done: { const: true } }, required: ['done'], additionalProperties: false },
        artifacts: [{ path: 'result.txt', minBytes: 10, containsText: 'verified output' }], requirements: ['Reviewer must inspect style.'] } } });
      expect(accepted.artifacts?.[0]).toMatchObject({ bytes: 15, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(accepted.verification).toMatchObject({ jsonSchema: true, artifactChecks: 1, unverifiedRequirements: ['Reviewer must inspect style.'] });
      await expect(test.broker.execute({ prompt: 'Create output.' }, test.operation(), { ...test.execution, task: { delivery: {
        format: 'json', jsonSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } } } })).rejects.toThrow('required schema');
      await expect(test.broker.execute({ prompt: 'Create output.' }, test.operation(), { ...test.execution, task: { delivery: {
        format: 'text', artifacts: [{ path: 'result.txt', containsText: 'required-but-missing' }] } } })).rejects.toThrow('required text');
      const exact = 'Only after both reviews pass, publish the report into the authorized output directory.';
      const output = await test.broker.execute({ prompt: 'echo-constraints' }, test.operation(), { ...test.execution,
        constraints: [{ id: 'user-conditional', text: exact, sourceMessageId: 'original-message', revision: 2 }], task: {} });
      expect(await readFile(output.artifacts![0]!.path, 'utf8')).toContain(exact);
      expect(test.broker.state()[0]?.constraintsDigest).toMatch(/^[a-f0-9]{64}$/);
      await expect(test.broker.execute({ prompt: 'Bounded context.' }, test.operation(), { ...test.execution,
        constraints: Array.from({ length: 5 }, (_, index) => ({ id: String(index), text: 'x'.repeat(16000), sourceMessageId: 'original-message' })), task: {} })).rejects.toThrow('not truncated');
    } finally { await test.broker.shutdown(); }
  }, 30000);
});
