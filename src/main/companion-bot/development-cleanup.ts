import path from 'node:path';
import { lstat, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BotDevelopmentDefaultCleanup } from './store';

/** Remove only an explicitly collected, application-owned child directory.
 * Resolve real paths before recursive deletion; junctions cannot widen scope. */
export async function removeManagedChild(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root), resolved = path.resolve(target), relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理目标不在指定资料目录中。');
  let info;
  try { info = await lstat(resolved); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('清理目标不是独立的应用资料目录。');
  const realRoot = await realpath(resolvedRoot), realTarget = await realpath(resolved), realRelative = path.relative(realRoot, realTarget);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error('清理目标的真实路径越出指定资料目录。');
  await rm(resolved, { recursive: true, force: true });
}
export async function eraseDevelopmentWorkspaces(root: string, plan: BotDevelopmentDefaultCleanup): Promise<void> {
  if (plan.phase !== 'sql-deleted') throw new Error('原生退休尚未确认，不能移除执行工作区。');
  for (const laneId of plan.laneIds) await removeManagedChild(path.join(root, 'lanes'), path.join(root, 'lanes', createHash('sha256').update(laneId).digest('hex')));
  for (const task of plan.taskWorkspaces) {
    const domainRoot = path.join(root, 'workspaces', createHash('sha256').update(task.securityDomainId).digest('hex'));
    await removeManagedChild(domainRoot, path.join(domainRoot, task.taskId));
  }
}
