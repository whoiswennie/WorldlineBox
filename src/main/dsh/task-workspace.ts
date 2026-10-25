import path from 'node:path';
import { lstat, mkdir, realpath } from './disk';
import type { DshTaskExecutionOptions } from './task-execution';

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}
/** Refuse linked components before creating a library-owned task directory. */
async function ordinaryDirectory(directory: string, create: boolean): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('Task workspace roots must be absolute.');
  const parsed = path.parse(directory); let current = parsed.root;
  for (const component of path.relative(parsed.root, path.resolve(directory)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (create) await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Task workspace directories cannot be linked.');
  }
  return realpath(current);
}
/** Workspace authorization is supplied by Main; the task can only choose within it. */
export async function prepareDshTaskWorkspace(execution: DshTaskExecutionOptions, taskId: string, fallback: string): Promise<{ workspacePath: string; taskWorkspaceRoot?: string }> {
  if (execution.task?.workspace?.mode === 'existing') {
    const requested = execution.task.workspace.path!;
    if (!path.isAbsolute(requested)) throw new Error('An existing task workspace must be absolute.');
    const candidate = await ordinaryDirectory(requested, false);
    for (const root of execution.allowedWorkspaceRoots ?? []) {
      const authorized = await ordinaryDirectory(root, false);
      if (inside(authorized, candidate)) return { workspacePath: candidate, taskWorkspaceRoot: authorized };
    }
    throw new Error('The requested workspace is outside the host-authorized directories.');
  }
  if (!execution.workspaceRootPath) return { workspacePath: fallback };
  const owner = execution.recordScope?.companionId;
  if (!owner || !/^[A-Za-z0-9_-]{1,100}$/.test(owner) || !/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('Managed task workspaces require a trusted owner and task identity.');
  const root = await ordinaryDirectory(execution.workspaceRootPath, true);
  // Native DSH groups Sessions by their exact cwd. Reuse one stable directory
  // per owner; its display title is independent of names and filesystem paths.
  const workspacePath = await ordinaryDirectory(path.join(root, owner), true);
  if (!inside(root, workspacePath)) throw new Error('The task workspace escaped its library directory.');
  return { workspacePath, taskWorkspaceRoot: root };
}
