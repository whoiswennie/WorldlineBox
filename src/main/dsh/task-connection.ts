import { z } from 'zod';
import type { DshExecutionAccessSettings } from '../../shared/dsh-access';
import { dshTaskAccessPatch, snapshotDshTaskAccess } from './task-access';
import { dshTaskRecordSchema, type DshTaskRecord } from '../../shared/dsh-tasks';

/** Main-only input. This is deliberately absent from renderer IPC and task metadata. */
export interface DshTaskExecutionConnection {
  provider: 'deepseek-official';
  model: string;
  baseURL: string;
  apiKey: string;
}

export interface DshTaskExecutionOptions {
  connection?: DshTaskExecutionConnection;
  toolkit?: boolean;
  interactive?: boolean;
  access?: DshTaskAccessSnapshot;
  /** Trusted Main checkpoint only; never accepted as renderer launch options. */
  resume?: DshTaskRecord;
  inputs?: Array<{ id: string; content: string; mode: 'steer' | 'queue' }>;
}
export type DshTaskAccessSnapshot = Readonly<DshExecutionAccessSettings>;

/** Legacy Main callers may pass just a connection; no option enters public IPC. */
export function snapshotDshTaskExecution(input?: DshTaskExecutionConnection | DshTaskExecutionOptions): DshTaskExecutionOptions {
  if (!input) return {};
  if ('provider' in input) return { connection: snapshotDshTaskConnection(input) };
  return { ...(input.connection ? { connection: snapshotDshTaskConnection(input.connection) } : {}), toolkit: input.toolkit === true, interactive: input.interactive === true,
    ...(input.resume ? { resume: dshTaskRecordSchema.parse(input.resume) } : {}),
    ...(input.inputs ? { inputs: z.array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), content: z.string().min(1).max(16000), mode: z.enum(['steer', 'queue']) })).max(100).parse(input.inputs) } : {}),
    ...(input.access ? { access: snapshotDshTaskAccess(input.access) } : {}) };
}

// Web disables these existing base rows because browser Agents mount a preset.
// Headless Agents do not mount that preset. Re-enable only first-party rows for
// one companion task; keep the user's profile, plugins and shell sandbox intact.
export const DSH_COMPANION_TASK_TOOL_IDS = ['tool-fs', 'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'agent-instructions', 'tool-web'] as const;
export function dshCompanionTaskToolPatch(platform: NodeJS.Platform = process.platform) {
  return [...DSH_COMPANION_TASK_TOOL_IDS, platform === 'win32' ? 'tool-pwsh' : 'tool-bash'].map(id => ({ id, disabled: false }));
}

export function dshTaskExecutionPatch(execution: DshTaskExecutionOptions, workspaceRoot?: string) {
  return [...(execution.toolkit ? [...(execution.interactive ? [] : dshCompanionTaskToolPatch()), { id: 'tools', config: { mode: 'native' } }] : []), ...(execution.connection ? dshTaskConnectionPatch(execution.connection) : []),
    ...(execution.access ? dshTaskAccessPatch(execution.access, workspaceRoot ?? '') : [])];
}

export const DSH_TASK_API_KEY_REF = 'WORLDLINEBOX_TASK_DEEPSEEK_API_KEY';
const connectionSchema = z.strictObject({
  provider: z.literal('deepseek-official'),
  model: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/),
  baseURL: z.string().trim().min(1).max(4096),
  apiKey: z.string().trim().min(1).max(8192).refine(value => [...value].every(character => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126;
  })),
});

/** Capture one connection before awaiting a runtime or operation reservation. */
export function snapshotDshTaskConnection(input: DshTaskExecutionConnection): DshTaskExecutionConnection {
  const parsed = connectionSchema.safeParse(input);
  if (!parsed.success) throw new Error('The task execution connection is invalid.');
  const connection = parsed.data;
  let url: URL;
  try { url = new URL(connection.baseURL); } catch { throw new Error('The task execution endpoint is invalid.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The task execution endpoint is invalid.');
  }
  // Only non-secret routing facts are ever allowed into a temporary patch.
  if (connection.model.includes(connection.apiKey) || connection.baseURL.includes(connection.apiKey)) {
    throw new Error('The task execution connection mixes secret and public routing fields.');
  }
  return { ...connection };
}

/**
 * rc.2 and alpha.2 already catalog deepseek-flash and deepseek-v4-pro. Their
 * modelInfo also permits an unknown model with advisory text-only defaults.
 * Omit `models` so this task preserves the complete native catalog and limits.
 * The native provider uses Messages API; the caller supplies its Messages root.
 */
export function dshTaskConnectionPatch(input: DshTaskExecutionConnection) {
  const connection = snapshotDshTaskConnection(input);
  return [
    { id: 'llm-deepseek', config: { baseURL: connection.baseURL, apiKeyEnv: DSH_TASK_API_KEY_REF } },
    { id: 'web-search-deepseek', config: { apiKeyEnv: DSH_TASK_API_KEY_REF } },
    { id: 'agent-default-model', config: { provider: connection.provider, model: connection.model } },
  ];
}

/** Spawn-local environment only; neither selection/pin nor process.env is modified. */
export function dshTaskConnectionEnvironment(base: NodeJS.ProcessEnv, connection?: DshTaskExecutionConnection): NodeJS.ProcessEnv {
  const env = { ...base };
  clearDshTaskConnectionEnvironment(env);
  if (connection) env[DSH_TASK_API_KEY_REF] = connection.apiKey;
  return env;
}

export function clearDshTaskConnectionEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (name.toUpperCase() === DSH_TASK_API_KEY_REF) delete env[name];
}

/** Exact replacement also covers keys with no recognizable `sk-` prefix. */
export function redactDshTaskConnection(value: string, connection?: DshTaskExecutionConnection): string {
  return connection?.apiKey ? value.replaceAll(connection.apiKey, '[redacted]') : value;
}

export function containsDshTaskSecret(value: string, connection?: DshTaskExecutionConnection): boolean {
  return !!connection?.apiKey && value.includes(connection.apiKey);
}
