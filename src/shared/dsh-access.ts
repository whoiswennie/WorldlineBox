import { z } from 'zod';

/** Official DSH file-effect modes, shared by filesystem and shell executors. */
export const dshExecutionAccessModeSchema = z.enum(['danger-full-access', 'workspace-write', 'read-only']);
export const accessModeSchema = dshExecutionAccessModeSchema;
export type DshExecutionAccessMode = z.infer<typeof dshExecutionAccessModeSchema>;

/** Launcher preference. Read once for a new task; running tasks retain their snapshot. */
export const dshExecutionAccessSettingsSchema = z.strictObject({
  mode: dshExecutionAccessModeSchema.default('danger-full-access'),
});
export type DshExecutionAccessSettings = z.infer<typeof dshExecutionAccessSettingsSchema>;

export const DSH_EXECUTION_ACCESS_OPTIONS: readonly { value: DshExecutionAccessMode; label: string; description: string }[] = [
  { value: 'danger-full-access', label: '完全访问', description: 'DSH 可以在当前 Windows 用户权限内读写文件并执行命令。' },
  { value: 'workspace-write', label: '工作区可写', description: '允许读取文件，只允许修改任务工作区和 DSH 临时目录内的文件。' },
  { value: 'read-only', label: '只读', description: '允许读取文件，DSH 文件和命令执行器阻止文件修改。' },
];
