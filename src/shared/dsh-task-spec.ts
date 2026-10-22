import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/);
/** Per-invocation choices. Plugin installation, credentials and models remain host-owned. */
export const dshTaskSpecSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(16000).optional(),
  context: z.strictObject({ text: z.string().max(16000).optional(), files: z.array(z.string().min(1).max(4096)).max(20).optional() }).optional(),
  mode: z.enum(['native', 'ptc']).optional(),
  tools: z.array(name).max(100).refine(values => new Set(values).size === values.length, 'Duplicate tools are invalid.').optional(),
  skills: z.array(z.string().min(1).max(200)).max(30).refine(values => new Set(values).size === values.length, 'Duplicate skills are invalid.').optional(),
  session: z.strictObject({ mode: z.enum(['new', 'resume']), taskId: z.uuid().optional() }).superRefine((value, ctx) => {
    if ((value.mode === 'resume') !== !!value.taskId) ctx.addIssue({ code: 'custom', message: 'Only resume requires a taskId.' });
  }).optional(),
  workspace: z.strictObject({ mode: z.enum(['managed', 'existing']), path: z.string().min(1).max(4096).optional() }).superRefine((value, ctx) => {
    if ((value.mode === 'existing') !== !!value.path) ctx.addIssue({ code: 'custom', message: 'Only existing workspace requires a path.' });
  }).optional(),
  delivery: z.strictObject({ format: z.enum(['text', 'json']), requirements: z.array(z.string().trim().min(1).max(1000)).max(20).optional() }).optional(),
});
export type DshTaskSpec = z.infer<typeof dshTaskSpecSchema>;
/** Read only the reference material needed for the current task. Skill text can be continued without truncation loss. */
export const dshTaskCapabilityQuerySchema = z.strictObject({ kind: z.enum(['overview', 'tool', 'skill', 'commands']),
  name: z.string().trim().min(1).max(200).optional(), textOffset: z.number().int().min(0).max(2 * 1024 * 1024).optional(),
  maxChars: z.number().int().min(100).max(64000).optional(),
}).superRefine((query, ctx) => {
  if (['tool', 'skill'].includes(query.kind) && !query.name) ctx.addIssue({ code: 'custom', message: 'A tool or skill query requires its exact native name.' });
  if (query.kind !== 'skill' && (query.textOffset !== undefined || query.maxChars !== undefined)) ctx.addIssue({ code: 'custom', message: 'Text ranges apply only to skill instructions.' });
});
export type DshTaskCapabilityQuery = z.infer<typeof dshTaskCapabilityQuerySchema>;
export const dshTaskCapabilityDetailSchema = z.object({ kind: z.enum(['tool', 'skill', 'commands']), name: z.string().optional(), available: z.boolean(),
  source: z.literal('native-agent-scope'), trust: z.literal('capability_reference_data'),
  tool: z.unknown().optional(),
  skill: z.object({ name: z.string(), description: z.string(), provider: z.string().optional(), source: z.string().optional(), path: z.string().optional(),
    resourceBase: z.unknown().optional(), content: z.string().max(64000), textOffset: z.number().int().nonnegative(), totalChars: z.number().int().nonnegative(),
    truncated: z.boolean(), nextTextOffset: z.number().int().nonnegative().optional() }).optional(),
  commands: z.array(z.object({ name: z.string(), description: z.string(), definitionId: z.string().optional(), input: z.unknown().optional() })).max(100).optional(),
  totalCommands: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(),
  commandsExecutable: z.literal(false).optional(),
  cli: z.object({ help: z.string().max(128 * 1024), source: z.literal('native-cli --help'), modes: z.array(z.enum(['native', 'ptc'])) }).optional(),
});
export type DshTaskCapabilityDetail = z.infer<typeof dshTaskCapabilityDetailSchema>;
export const dshTaskCapabilitiesSchema = z.object({ instanceId: z.string(), runtimeId: z.string(), runtimeVersion: z.string(),
  capturedAt: z.string(), modes: z.array(z.enum(['native', 'ptc'])), preset: z.string(),
  tools: z.array(z.object({ name, description: z.string().max(2000) })).max(500),
  skills: z.array(z.object({ name: z.string().max(200), description: z.string().max(2000) })).max(500),
  toolRestrictions: z.boolean(), skillSelection: z.boolean(), workspacePath: z.string(),
  toolsTotal: z.number().int().nonnegative().optional(), skillsTotal: z.number().int().nonnegative().optional(), truncated: z.boolean().optional(),
  detail: dshTaskCapabilityDetailSchema.optional(),
});
export type DshTaskCapabilities = z.infer<typeof dshTaskCapabilitiesSchema>;
export const dshTaskArtifactSchema = z.object({ path: z.string().max(4096), description: z.string().max(1000).optional() });
