import { z } from 'zod';
import { dshExecutionAccessSettingsSchema, type DshExecutionAccessSettings } from '../../shared/dsh-access';
import { dshTaskAccessPatch, snapshotDshTaskAccess } from './task-access';
import { dshTaskRecordSchema, type DshTaskRecord } from '../../shared/dsh-tasks';
import { dshRecordScopeSchema } from '../../shared/dsh-task-record';
import { dshTaskSpecSchema, dshTaskCapabilityQuerySchema, dshExecutionConstraintSchema, type DshExecutionConstraint, type DshTaskSpec, type DshTaskCapabilityQuery } from '../../shared/dsh-task-spec';

/** Task controls only. Account, provider and model belong exclusively to the selected DSH profile. */
export interface DshTaskExecutionOptions {
  toolkit?: boolean;
  interactive?: boolean;
  access?: Readonly<DshExecutionAccessSettings>;
  /** Trusted Main checkpoint only; never accepted as renderer launch options. */
  resume?: DshTaskRecord;
  recordScope?: z.infer<typeof dshRecordScopeSchema>;
  /** Main revalidates the original source/authorization before issuing this resume proof. */
  resumeScope?: z.infer<typeof dshRecordScopeSchema>;
  constraints?: DshExecutionConstraint[];
  inputs?: Array<{ id: string; content: string; mode: 'steer' | 'queue' }>;
  task?: DshTaskSpec;
  /** Trusted library-owned storage root; never accepted from a model or renderer. */
  workspaceRootPath?: string;
  allowedWorkspaceRoots?: string[];
  /** Host-only, read-only capability probe; never submits a model turn. */
  discover?: boolean;
  capabilityQuery?: DshTaskCapabilityQuery;
}
const executionSchema = z.strictObject({
  toolkit: z.boolean().optional(), interactive: z.boolean().optional(),
  access: dshExecutionAccessSettingsSchema.optional(),
  resume: dshTaskRecordSchema.optional(),
  recordScope: dshRecordScopeSchema.optional(),
  resumeScope: dshRecordScopeSchema.optional(), constraints: z.array(dshExecutionConstraintSchema).max(128).optional(),
  task: dshTaskSpecSchema.optional(), workspaceRootPath: z.string().min(1).max(4096).optional(),
  allowedWorkspaceRoots: z.array(z.string().min(1).max(4096)).max(20).optional(), discover: z.boolean().optional(),
  capabilityQuery: dshTaskCapabilityQuerySchema.optional(),
  inputs: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), content: z.string().min(1).max(16000), mode: z.enum(['steer', 'queue']) })).max(100).optional(),
});
export function snapshotDshTaskExecution(input?: DshTaskExecutionOptions): DshTaskExecutionOptions {
  const result = executionSchema.safeParse(input ?? {});
  if (!result.success) throw new Error('The DSH task controls are invalid. Model and credential overrides are not supported.');
  const value = result.data;
  return { ...value, toolkit: value.toolkit === true || !!value.task, interactive: value.interactive === true || !!value.task,
    ...(value.access ? { access: snapshotDshTaskAccess(value.access) } : {}) };
}

// Browser Agents mount a preset; headless Agents enable the existing native tools instead.
export const DSH_COMPANION_TASK_TOOL_IDS = ['tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'agent-instructions', 'tool-web'] as const;
export function dshCompanionTaskToolPatch(platform: NodeJS.Platform = process.platform) {
  return [...DSH_COMPANION_TASK_TOOL_IDS, platform === 'win32' ? 'tool-pwsh' : 'tool-bash'].map(id => ({ id, disabled: false }));
}
export function dshTaskExecutionPatch(execution: DshTaskExecutionOptions, workspaceRoot?: string) {
  return [...(execution.toolkit ? [...(execution.interactive ? [] : dshCompanionTaskToolPatch()), { id: 'tools', config: { mode: 'native' } }] : []),
    ...(execution.access ? dshTaskAccessPatch(execution.access, workspaceRoot ?? '') : [])];
}
