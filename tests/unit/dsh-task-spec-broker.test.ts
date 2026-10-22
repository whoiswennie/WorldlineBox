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
async function fixture() {
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
 if(!input.content.includes('missing-artifact'))fs.writeFileSync(file,'verified output');
 emit({type:'artifacts',files:[{path:'result.txt',description:'test delivery'}]});
 emit({type:'status',phase:'turn_start'});emit({type:'status',phase:'turn_end',reason:{kind:'completed'}});
 emit({type:'final',text:input.content.includes('bad-json')?'bad':input.content.includes('Delivery format: json')?JSON.stringify({done:true}):'done'});emit({type:'task_finished',code:0});opened=undefined;
});lines.on('close',()=>process.exit(0));`);
  const selected: DshCliSelection = { instance: { id: 'fixture', name: 'fixture', runtimeId: 'runtime-fixture', profile: 'web', status: 'stopped', homePath: root,
    agentsPath: root, workspacePath: root, browserPartition: 'temporary:fixture', isDefault: true, createdAt: '', updatedAt: '' },
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
});
