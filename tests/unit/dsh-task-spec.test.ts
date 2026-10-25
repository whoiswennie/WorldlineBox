import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { companionDshArgumentsSchema } from '../../src/shared/companion-dsh-tool';
import { dshTaskSpecSchema } from '../../src/shared/dsh-task-spec';
import { snapshotDshTaskExecution } from '../../src/main/dsh/task-execution';
import { prepareDshTaskWorkspace } from '../../src/main/dsh/task-workspace';

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

  it('reuses each owner’s managed workspace across Sessions while keeping different owners separate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-task-space-')); roots.push(root);
    const storage = path.join(root, '.worldlinebox', 'companions', 'dsh-tasks');
    const first = await prepareDshTaskWorkspace({ workspaceRootPath: storage, recordScope: owner }, randomUUID(), root);
    const second = await prepareDshTaskWorkspace({ workspaceRootPath: storage, recordScope: owner }, randomUUID(), root);
    expect(path.relative(storage, first.workspacePath)).toBe('companion-a');
    expect(second.workspacePath).toBe(first.workspacePath);
    const other = await prepareDshTaskWorkspace({ workspaceRootPath: storage, recordScope: { ...owner, companionId: 'companion-b' } }, randomUUID(), root);
    expect(other.workspacePath).not.toBe(first.workspacePath);
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
