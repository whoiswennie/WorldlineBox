import { z } from 'zod';
import { dshExecutionAccessSettingsSchema, type DshExecutionAccessSettings } from '../../shared/dsh-access';
import { dshTaskRecordSchema, type DshTaskRecord } from '../../shared/dsh-tasks';
import { dshRecordScopeSchema } from '../../shared/dsh-task-record';
import { dshTaskSpecSchema, dshTaskCapabilityQuerySchema, dshExecutionConstraintSchema, type DshExecutionConstraint, type DshTaskSpec, type DshTaskCapabilityQuery } from '../../shared/dsh-task-spec';

/** Task controls only. Account, provider and model belong exclusively to the selected DSH profile. */
export interface DshTaskExecutionOptions {
  /** Trusted Main-only thought request; never an actor/renderer TaskSpec field. */
  cognitiveOnly?: boolean;
  /** Trusted Main pixels, never paths or model/renderer TaskSpec fields. */
  visualInputs?: DshTaskVisualInput[];
  toolkit?: boolean;
  interactive?: boolean;
  access?: Readonly<DshExecutionAccessSettings>;
  /** Trusted Main checkpoint only; never accepted as renderer launch options. */
  resume?: DshTaskRecord;
  recordScope?: z.infer<typeof dshRecordScopeSchema>;
  /** Current display name read by Main, never supplied by the model's TaskSpec. */
  companionName?: string;
  /** Main revalidates the original source/authorization before issuing this resume proof. */
  resumeScope?: z.infer<typeof dshRecordScopeSchema>;
  constraints?: DshExecutionConstraint[];
  inputs?: Array<{ id: string; content: string; mode: 'steer' | 'queue' }>;
  task?: DshTaskSpec;
  /** Trusted library-owned storage root; never accepted from a model or renderer. */
  workspaceRootPath?: string;
  allowedWorkspaceRoots?: string[];
  capabilityQuery?: DshTaskCapabilityQuery;
}
export const DSH_TASK_VISUAL_MAX_IMAGES = 4;
export const DSH_TASK_VISUAL_MAX_IMAGE_BYTES = 1024 * 1024;
export const dshTaskVisualInputSchema = z.strictObject({ mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  dataBase64: z.string().min(4).max(1398104).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), source: z.strictObject({ kind: z.enum(['observation_storyboard', 'observation_frame']),
    sourceId: z.string().min(1).max(300), observedAt: z.iso.datetime({ offset: true }), offsetMs: z.number().finite().nonnegative().max(20000).optional() }) });
export type DshTaskVisualInput = z.infer<typeof dshTaskVisualInputSchema>;
export type DshTaskVisualManifest = Array<Omit<DshTaskVisualInput, 'dataBase64'>>;
const executionSchema = z.strictObject({
  cognitiveOnly: z.boolean().optional(),
  visualInputs: z.array(dshTaskVisualInputSchema).max(DSH_TASK_VISUAL_MAX_IMAGES).optional(),
  toolkit: z.boolean().optional(), interactive: z.boolean().optional(),
  access: dshExecutionAccessSettingsSchema.optional(),
  resume: dshTaskRecordSchema.optional(),
  recordScope: dshRecordScopeSchema.optional(),
  companionName: z.string().trim().min(1).max(100).optional(),
  resumeScope: dshRecordScopeSchema.optional(), constraints: z.array(dshExecutionConstraintSchema).max(128).optional(),
  task: dshTaskSpecSchema.optional(), workspaceRootPath: z.string().min(1).max(4096).optional(),
  allowedWorkspaceRoots: z.array(z.string().min(1).max(4096)).max(20).optional(),
  capabilityQuery: dshTaskCapabilityQuerySchema.optional(),
  inputs: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), content: z.string().min(1).max(16000), mode: z.enum(['steer', 'queue']) })).max(100).optional(),
});
export function snapshotDshTaskExecution(input?: DshTaskExecutionOptions): DshTaskExecutionOptions {
  const result = executionSchema.safeParse(input ?? {});
  if (!result.success) throw new Error('The DSH task controls are invalid. Model and credential overrides are not supported.');
  const value = result.data;
  if (value.visualInputs?.length && (!value.cognitiveOnly || !value.recordScope?.companionId || !value.recordScope.agendaOrigin))
    throw new Error('Observation pixels require a trusted new cognitive agenda task.');
  if (value.companionName && !value.recordScope?.companionId) throw new Error('A named companion workspace requires a trusted owner.');
  if (value.cognitiveOnly) {
    if (!value.recordScope?.companionId || !value.workspaceRootPath)
      throw new Error('A cognitive task requires a trusted owner and managed workspace root.');
    if (value.resume || value.resumeScope || value.task?.session?.mode === 'resume')
      throw new Error('A cognitive task requires a new session and cannot resume an existing task.');
    if (value.inputs?.length) throw new Error('A cognitive task accepts only its new, explicit thought request.');
    return { ...value, interactive: true, toolkit: true, access: { mode: 'read-only' },
      task: { ...value.task, mode: 'native', tools: [], skills: [], session: { mode: 'new' }, workspace: { mode: 'managed' } } };
  }
  // Companion execution is an explicitly delegated pair of hands. Pin the
  // host-owned permission snapshot on a new Session rather than accidentally
  // inheriting a Web profile's workspace sandbox. Explicit restrictions and
  // resumed Sessions retain their own policy; models cannot set this field.
  const access = value.access ?? (value.recordScope?.companionId && !value.resume && value.task?.session?.mode !== 'resume'
    ? { mode: 'danger-full-access' as const } : undefined);
  return { ...value, toolkit: value.toolkit === true || !!value.task, interactive: value.interactive === true || !!value.task,
    ...(access ? { access: Object.freeze({ ...access }) } : {}) };
}
