import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { companionDshArgumentsSchema } from '../../src/shared/companion-dsh-tool';
import { dshTaskSpecSchema } from '../../src/shared/dsh-task-spec';
import { snapshotDshTaskExecution } from '../../src/main/dsh/task-execution';
import { prepareDshTaskWorkspace } from '../../src/main/dsh/task-workspace';
import { taskRuntimePolicySource, type DshRuntimeTaskPolicy } from '../../src/main/dsh/task-runtime-policy';
import { companionRuntimeSource } from '../../src/main/dsh/companion-runtime-source';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const owner = { actionId: randomUUID(), companionId: 'companion-a', conversationId: 'conversation-a', sourceMessageId: 'message-a' };

describe('Companion task specification', () => {
  it('accepts per-task choices while denying plugin, model and credential fields', () => {
    const task = { title: 'Read', prompt: 'Inspect the file', mode: 'native', tools: ['read'], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' }, delivery: { format: 'json' } };
    expect(companionDshArgumentsSchema.safeParse({ tasks: [task] }).success).toBe(true);
    for (const field of ['plugins', 'model', 'apiKey', 'cwd']) expect(companionDshArgumentsSchema.safeParse({ tasks: [{ ...task, [field]: 'untrusted' }] }).success).toBe(false);
    expect(dshTaskSpecSchema.safeParse({ session: { mode: 'resume' } }).success).toBe(false);
    expect(dshTaskSpecSchema.safeParse({ workspace: { mode: 'existing' } }).success).toBe(false);
    expect(dshTaskSpecSchema.safeParse({ tools: ['read', 'read'] }).success).toBe(false);
    expect(snapshotDshTaskExecution({ task: { tools: [] } })).toMatchObject({ interactive: true, toolkit: true });
  });

  it('creates distinct owner/date/session directories in the host library root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-space-')); roots.push(root);
    const storage = path.join(root, '.worldlinebox', 'companions', 'dsh-tasks');
    const first = await prepareDshTaskWorkspace({ workspaceRootPath: storage, recordScope: owner }, randomUUID(), root);
    const second = await prepareDshTaskWorkspace({ workspaceRootPath: storage, recordScope: owner }, randomUUID(), root);
    expect(path.relative(storage, first.workspacePath).replaceAll('\\', '/')).toMatch(/^companion-a\/\d{4}-\d{2}-\d{2}\/session-[a-f0-9-]{36}$/);
    expect(second.workspacePath).not.toBe(first.workspacePath);
    expect(first.taskWorkspaceRoot).toBe(storage);
  });

  it('rejects unauthorized existing paths and junction escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-space-')); roots.push(root);
    const allowed = path.join(root, 'allowed'), outside = path.join(root, 'outside'); await mkdir(allowed); await mkdir(outside);
    await expect(prepareDshTaskWorkspace({ task: { workspace: { mode: 'existing', path: outside } }, allowedWorkspaceRoots: [allowed] }, randomUUID(), root)).rejects.toThrow('host-authorized');
    await symlink(outside, path.join(allowed, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(prepareDshTaskWorkspace({ task: { workspace: { mode: 'existing', path: path.join(allowed, 'link') } }, allowedWorkspaceRoots: [allowed] }, randomUUID(), root)).rejects.toThrow('linked');
  });
});

function runtime(policy: DshRuntimeTaskPolicy) {
  type Call = { name: string; arguments?: { name?: string }; agent?: object };
  const guards: Array<(exec: Call) => string | undefined> = [];
  const restrictions: Array<{ allow?: string[]; deny?: string[] }> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const definitions = ['read', 'write', 'skill', 'plugin_manager'].map(name => ({ name, description: name }));
  const registry = { schemas: () => definitions, guard: (guard: (exec: Call) => string | undefined) => { guards.push(guard); } };
  const skills = { list: async () => ['alpha', 'beta'].map(name => ({ name, description: name })),
    get: async (name: string) => ({ name, content: `instructions-${name}` }),
    snapshot: async () => ({ skills: await skills.list() }) };
  const ctx = { get: (name: string) => name === 'tools' ? registry : name === 'skills' ? skills : name === 'agentPresets' ? { list: async () => [{ id: 'standard' }] } : undefined };
  type Assembly = { tools?: Array<{ name: string }> };
  let assemblyHook: ((_assembly: unknown, _context: unknown, next: () => Promise<Assembly>) => Promise<Assembly>) | undefined;
  const scope = { tools: { restrict: (value: { allow?: string[]; deny?: string[] }) => { restrictions.push(value); } },
    on: (_event: string, hook: NonNullable<typeof assemblyHook>) => { assemblyHook = hook; return () => undefined; } };
  const build = new Function('ctx', 'emit', 'Buffer', 'process', 'require', `const io={},cwd=process.cwd(),cleanup=[]; ${taskRuntimePolicySource(policy)}; return { configureTask, publishTaskCapabilities, prelude: () => taskPrelude };`);
  const adapter = build(ctx, (value: Record<string, unknown>) => emitted.push(value), Buffer, process, createRequire(import.meta.url)) as { configureTask(scope: object, agent: object): Promise<void>; publishTaskCapabilities(agent:object):Promise<void>; prelude(): string };
  return { adapter, skills, registry, restrictions, emitted, scope,
    assemble: async (tools: Array<{ name: string }>) => assemblyHook ? assemblyHook(undefined, undefined, async () => ({ tools })) : { tools },
    prepare: async () => {const subject={}; await adapter.configureTask(scope,subject); await adapter.publishTaskCapabilities(subject);}, deny: (exec: Call) => guards.map(guard => guard(exec)).find(Boolean) };
}

describe('Native task policy at tool dispatch', () => {
  it('enforces a host-only cognitive task with a fresh workspace and no assembled, effective or dispatchable tools or skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-cognitive-policy-')); roots.push(root);
    const execution = snapshotDshTaskExecution({ cognitiveOnly: true, workspaceRootPath: root, recordScope: owner,
      task: { mode: 'ptc', tools: ['read', 'run_code'], skills: ['alpha'], workspace: { mode: 'existing', path: process.cwd() } } });
    expect(execution).toMatchObject({ cognitiveOnly: true, interactive: true, toolkit: true, access: { mode: 'read-only' },
      task: { mode: 'native', tools: [], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' } } });
    expect(dshTaskSpecSchema.safeParse({ cognitiveOnly: true }).success).toBe(false);
    expect(() => snapshotDshTaskExecution({ cognitiveOnly: true })).toThrow('trusted owner');
    expect(() => snapshotDshTaskExecution({ cognitiveOnly: true, workspaceRootPath: root, recordScope: owner,
      task: { session: { mode: 'resume', taskId: owner.actionId } } })).toThrow('new session');
    const first = await prepareDshTaskWorkspace(execution, randomUUID(), process.cwd());
    const second = await prepareDshTaskWorkspace(execution, randomUUID(), process.cwd());
    expect(first.workspacePath).not.toBe(second.workspacePath); expect(first.taskWorkspaceRoot).toBe(root);
    const test = runtime({ cognitiveOnly: true, mode: 'ptc', tools: ['read', 'run_code'], skills: ['alpha'] });
    await test.prepare();
    expect((await test.assemble([{ name: 'read' }, { name: 'run_code' }, { name: 'late_plugin_tool' }])).tools).toEqual([]);
    for (const name of ['read', 'write', 'run_code', 'skill', 'late_plugin_tool'])
      expect(test.deny({ name, arguments: { name: 'alpha' }, agent: { descendant: true } })).toContain('cognitive');
    expect(await test.skills.list()).toEqual([]); expect(await test.skills.get('alpha')).toBeUndefined();
    expect((await test.skills.snapshot()).skills).toEqual([]); expect(test.adapter.prelude()).toBe('');
    expect(test.emitted[0]).toMatchObject({ tools: [], skills: [], effective: { mode: 'native', toolCount: 0, skillCount: 0 } });
  });
  it('emits a syntactically valid native plugin with data-only task controls', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-plugin-')); roots.push(root);
    const filename = path.join(root, 'task.mjs');
    await writeFile(filename, companionRuntimeSource(path.join(root, 'package.json'), undefined, undefined, { tools: ['read'], skills: [], mode: 'native' }));
    const checked = spawnSync(process.execPath, ['--check', filename], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(checked.status, checked.stderr).toBe(0);
  });
  it('filters the catalog and denies disallowed direct, nested and descendant calls', async () => {
    const test = runtime({ tools: ['read'] }); await test.prepare();
    expect(test.restrictions).toContainEqual({ allow: ['read'] });
    expect(test.deny({ name: 'read' })).toBeUndefined();
    expect(test.deny({ name: 'write', agent: { descendant: true } })).toContain('outside');
    expect(test.deny({ name: 'run_code' })).toBeUndefined();
    expect(test.deny({ name: 'write' })).toContain('outside');
    expect(test.deny({ name: 'plugin_manager' })).toContain('host');
    expect(test.emitted[0]?.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'plugin_manager' })]));
  });
  it('limits actual skill list, lookup and loading to selected instructions', async () => {
    const test = runtime({ skills: ['alpha'] }); await test.prepare();
    expect(await test.skills.list()).toEqual([{ name: 'alpha', description: 'alpha' }]);
    expect(await test.skills.get('beta')).toBeUndefined();
    expect((await test.skills.snapshot()).skills.map(item => item.name)).toEqual(['alpha']);
    expect(test.adapter.prelude()).toContain('instructions-alpha');
    expect(test.adapter.prelude()).not.toContain('instructions-beta');
    expect(test.deny({ name: 'skill', arguments: { name: 'beta' } })).toContain('outside');
  });
  it('rejects unknown names and runtimes without enforcing guards', async () => {
    await expect(runtime({ tools: ['invented'] }).prepare()).rejects.toThrow('unknown tools');
    await expect(runtime({ skills: ['invented'] }).prepare()).rejects.toThrow('unknown skill');
    const test = runtime({ tools: ['read'] }); Object.assign(test.registry, { guard: undefined });
    await expect(test.prepare()).rejects.toThrow('cannot be isolated');
  });
  it('pins actual tool schemas and skill instructions before admitting a continued session', async () => {
    const first = runtime({}); await first.prepare();
    const effective = first.emitted[0]?.effective as { digest: string };
    expect(effective.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(runtime({ expectedEffectiveDigest: effective.digest }).prepare()).resolves.toBeUndefined();
    const changed = runtime({ expectedEffectiveDigest: effective.digest });
    changed.skills.get = async name => ({ name, content: `changed-${name}` });
    await expect(changed.prepare()).rejects.toThrow('capabilities changed');
    const changedTools = runtime({ expectedEffectiveDigest: effective.digest });
    changedTools.registry.schemas()[0]!.description = 'Changed provider contract';
    await expect(changedTools.prepare()).rejects.toThrow('capabilities changed');
  });
});
