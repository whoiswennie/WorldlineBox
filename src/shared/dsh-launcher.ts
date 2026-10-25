import { z } from 'zod';
import { dshRecordQuerySchema, dshRecordPageSchema } from './dsh-task-record';
import { dshMarketplaceStateSchema, dshMarketPageSchema, dshSkillInspectionSchema, dshSkillTargetSchema, dshInstalledSkillSchema, dshRepositorySchema, dshSkillNameSchema } from './dsh-marketplace';
import { dshPackDistributionSchema, dshPackPublicationSchema } from './dsh-pack-distribution';
import { dshInstalledPluginSchema } from './dsh-plugins';
import { dshTaskInputSchema, dshTaskRecordSchema, dshTaskResultSchema, dshTaskEventSchema, type DshTaskEvent } from './dsh-tasks';

export const DSH_LAUNCHER_CHANNEL = 'worldlinebox:dsh-launcher';
export const DSH_LAUNCHER_CHANGED_CHANNEL = 'worldlinebox:dsh-launcher:changed';
export const DSH_TERMINAL_OUTPUT_CHANNEL = 'worldlinebox:dsh-launcher:terminal-output';
export const DSH_TASK_EVENT_CHANNEL = 'worldlinebox:dsh-launcher:task-event';

const id = z.string().regex(/^[a-z0-9-]{1,80}$/);
const name = z.string().trim().min(1).max(100);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const dshPackPublicationRecordSchema = dshPackPublicationSchema.extend({ packId: id, createdAt: z.string() });
export const dshRuntimeSchema = z.object({
  id, version: z.string().min(1).max(128), nodeVersion: z.string().max(128), npmVersion: z.string().max(128).optional(),
  platform: z.literal('win32-x64'), adapter: z.literal('node-cli-web-v1'),
  source: z.string().max(4096), sourceSha256: sha256, contentSha256: sha256,
  npmIntegrity:z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/).optional(),dependencyLockSha256:sha256.optional(),
  installedAt: z.string(), fileCount: z.number(), byteLength: z.number(),
});
export type DshRuntime = z.infer<typeof dshRuntimeSchema>;
export const dshInstanceStatusSchema = z.enum(['stopped', 'starting', 'running', 'stopping', 'failed']);
export const dshInstanceSchema = z.object({
  id, name, runtimeId: id, createdAt: z.string(), updatedAt: z.string(),
  profile: z.literal('web'), status: dshInstanceStatusSchema,
  homePath: z.string(), agentsPath: z.string(), workspacePath: z.string(),
  browserPartition: z.string(), pid: z.number().optional(), port: z.number().optional(),
  lastError: z.string().optional(), lastExitCode: z.number().nullable().optional(),
  parentInstanceId: id.optional(), isDefault: z.boolean(),
  restartRequired: z.boolean().optional(),
});
export type DshInstance = z.infer<typeof dshInstanceSchema>;
export const dshSnapshotSchema = z.object({
  id, instanceId: id, name, runtimeId: id, createdAt: z.string(),
  contentSha256: sha256, fileCount: z.number(), byteLength: z.number(),
});
export type DshSnapshot = z.infer<typeof dshSnapshotSchema>;
export const dshPackSchema = z.object({
  id, name, version: z.string(), runtimeId: id, runtimeVersion: z.string(),
  contentSha256: sha256, createdAt: z.string(), fileCount: z.number(), byteLength: z.number(),
});
export type DshPack = z.infer<typeof dshPackSchema>;
export const dshOperationTerminalStatuses = ['succeeded', 'failed', 'interrupted', 'cancelled'] as const;
export const dshOperationSchema = z.object({
  id, kind: z.string(), label: z.string(), instanceId: id.optional(),
  status: z.enum(['running', ...dshOperationTerminalStatuses]),
  phase: z.string(), progress: z.number().min(0).max(100).optional(),
  startedAt: z.string(), finishedAt: z.string().optional(), error: z.string().optional(),
  download: z.object({ transferredBytes: z.number().int().nonnegative(), totalBytes: z.number().int().positive().optional(),
    speedBytesPerSecond: z.number().nonnegative(), paused: z.boolean(), canPause: z.boolean() }).optional(),
  retryRequest: z.discriminatedUnion('type', [
    z.object({ type: z.literal('runtime.install'), version: z.string().max(128) }),
    z.object({ type: z.literal('pack.import-url'), manifestUrl: z.string().max(4096) }),
  ]).optional(),
});
export type DshOperation = z.infer<typeof dshOperationSchema>;
export function isDshOperationTerminal(operation: DshOperation): boolean {
  return (dshOperationTerminalStatuses as readonly string[]).includes(operation.status);
}
export const dshTerminalSchema = z.object({
  id: z.string(), instanceId: id, runtimeVersion: z.string(), status: z.enum(['running', 'stopped']), cwd: z.string(),
  pid: z.number().optional(), lastExitCode: z.number().nullable().optional(), output: z.string(),
  outputOffset: z.number().int().min(0), outputRevision: z.number().int().min(0), cols: z.number().int(), rows: z.number().int(),
  transport: z.enum(['conpty', 'pipe']),
});
export type DshTerminal = z.infer<typeof dshTerminalSchema>;
export const dshTerminalOutputSchema = z.object({ terminalId: z.string(), text: z.string(), stream: z.enum(['stdout', 'stderr', 'system']),
  outputOffset: z.number().int().min(0), outputRevision: z.number().int().min(0), endOffset: z.number().int().min(0) });
export type DshTerminalOutput = z.infer<typeof dshTerminalOutputSchema>;
export const dshCliStateSchema = z.object({
  selectedInstanceId: id.optional(), commandPath: z.string(), binPath: z.string(), pathEnabled: z.boolean(), output: z.string(),
  terminals: z.array(dshTerminalSchema).optional(), activeTerminalId: z.string().optional(),
  terminal: z.object({ id: z.string(), instanceId: id, runtimeVersion: z.string(), status: z.enum(['running', 'stopped']),
    cwd: z.string(), pid: z.number().optional(), lastExitCode: z.number().nullable().optional() }).optional(),
});
export type DshCliState = z.infer<typeof dshCliStateSchema>;
export const dshNetworkSettingsSchema = z.object({
  proxyMode: z.enum(['system', 'direct', 'custom']), proxyUrl: z.string().trim().max(2048),
  proxyRouting: z.enum(['smart', 'global']).optional(),
  proxyResumeMode: z.enum(['system', 'custom']).optional(),
  proxyPresetsVersion: z.number().int().min(0).optional(),
  proxyProfiles: z.array(z.object({ id, name, url: z.string().trim().max(2048) })).max(30),
  npmRegistry: z.string().trim().max(2048), pythonIndex: z.string().trim().max(2048),
  npmDownloadRoute: z.enum(['auto', 'registry']).default('auto'),
  githubMirror: z.enum(['auto', 'direct', 'gh-proxy', 'ghfast', 'ghproxy', 'custom']), githubMirrorUrl: z.string().trim().max(2048),
  sourceProfiles: z.array(z.object({ id, name, kind: z.enum(['npm', 'python', 'github']), url: z.string().trim().max(2048) })).max(30).optional(),
});
export type DshNetworkSettings = z.infer<typeof dshNetworkSettingsSchema>;
export const dshNetworkPatchSchema = dshNetworkSettingsSchema.pick({ proxyMode: true, proxyUrl: true, proxyRouting: true, npmRegistry: true,
  npmDownloadRoute: true, pythonIndex: true, githubMirror: true, githubMirrorUrl: true }).partial()
  // Zod defaults still run inside optional fields: a proxy-only patch must not reset this policy.
  .extend({ npmDownloadRoute: z.enum(['auto', 'registry']).optional() }).strict();
export type DshNetworkPatch = z.infer<typeof dshNetworkPatchSchema>;
export const dshNetworkSourceKindSchema = z.enum(['npm', 'python', 'github']);
export type DshNetworkSourceKind = z.infer<typeof dshNetworkSourceKindSchema>;
const networkRouteSchema = z.object({ kind: dshNetworkSourceKindSchema, url: z.string(), proxy: z.string(), error: z.string().optional() });
const networkAttemptSchema = z.object({ url: z.string(), proxy: z.string(), elapsedMs: z.number(), ok: z.boolean(), status: z.number().optional(), error: z.string().optional() });
export const dshNetworkStateSchema = z.object({
  settings: dshNetworkSettingsSchema, revision: z.number().int().min(0), error: z.string().optional(),
  smartDirectHosts: z.array(z.string().max(253)).max(10).optional(),
  inspection: z.object({ revision: z.number().int(), inspectedAt: z.string(), routes: z.array(networkRouteSchema),
    npmSelection: z.object({ registry: z.string(), checkedAt: z.string(), elapsedMs: z.number(), probed: z.boolean() }).optional(),
    githubSelection: z.object({ url: z.string(), checkedAt: z.string() }).optional(),
  }).optional(),
  checks: z.object({ revision: z.number().int(), checkedAt: z.string(), results: z.array(z.object({
    kind: dshNetworkSourceKindSchema, ok: z.boolean(), attempts: z.array(networkAttemptSchema),
  })) }).optional(),
});
export type DshNetworkState = z.infer<typeof dshNetworkStateSchema>;
export const dshOfficialVersionSchema = z.object({
  version: z.string().max(128), channel: z.enum(['stable', 'rc', 'alpha', 'beta', 'preview']), recommended: z.boolean(),
  publishedAt: z.string().optional(), releaseUrl: z.string().max(4096), notes: z.string().max(30000).optional(),
  nodeRange: z.string().max(128), integrity: z.string().max(1024),
});
export type DshOfficialVersion = z.infer<typeof dshOfficialVersionSchema>;
export const dshVersionsStateSchema = z.object({ entries: z.array(dshOfficialVersionSchema), fetchedAt: z.string().optional(),
  source: z.enum(['github-npm', 'cache']), stale: z.boolean(), error: z.string().optional() });
export type DshVersionsState = z.infer<typeof dshVersionsStateSchema>;
export const dshLauncherStateSchema = z.object({
  supported: z.boolean(), rootPath: z.string(), runtimes: z.array(dshRuntimeSchema),
  instances: z.array(dshInstanceSchema), snapshots: z.array(dshSnapshotSchema),
  packs: z.array(dshPackSchema),
  operations: z.array(dshOperationSchema),
  cli: dshCliStateSchema.optional(),
  network: dshNetworkStateSchema.optional(), versions: dshVersionsStateSchema.optional(),
  marketplace: dshMarketplaceStateSchema.optional(),
  packPublications: z.array(dshPackPublicationRecordSchema).optional(),
  tasks: z.array(dshTaskRecordSchema).optional(),
  executionReadiness: z.object({ instanceId: id, status: z.enum(['warming', 'ready', 'cold', 'failed']), updatedAt: z.string() }).optional(),
});
export type DshLauncherState = z.infer<typeof dshLauncherStateSchema>;

export const dshLauncherRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('versions.refresh') }),
  z.strictObject({ type: z.literal('runtime.install'), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/) }),
  z.strictObject({ type: z.literal('network.save'), settings: dshNetworkSettingsSchema }),
  z.strictObject({ type: z.literal('network.patch'), patch: dshNetworkPatchSchema }),
  z.strictObject({ type: z.literal('network.proxy.toggle'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('network.test') }),
  z.strictObject({ type: z.literal('network.inspect') }),
  z.strictObject({ type: z.literal('runtime.import'), sourceKind: z.literal('directory') }),
  z.strictObject({ type: z.literal('runtime.verify'), runtimeId: id }),
  z.strictObject({ type: z.literal('runtime.cleanup') }),
  z.strictObject({ type: z.literal('runtime.delete'), runtimeId: id }),
  z.strictObject({ type: z.literal('operation.cancel'), operationId: id }),
  z.strictObject({ type: z.literal('operation.clear-finished') }),
  dshTaskInputSchema.extend({ type: z.literal('task.run') }),
  z.strictObject({ type: z.literal('task.cancel'), taskId: id }),
  z.strictObject({ type: z.literal('task.terminate'), taskId: id }),
  z.strictObject({ type: z.literal('task.result'), taskId: id }),
  z.strictObject({ type: z.literal('task.record'), query: dshRecordQuerySchema }),
  z.strictObject({ type: z.literal('task.events'), taskId: id, after: z.number().int().min(-1).optional() }),
  z.strictObject({ type: z.literal('task.message'), taskId: id, content: z.string().trim().min(1).max(16000), mode: z.enum(['steer', 'queue']), messageId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }),
  z.strictObject({ type: z.literal('instance.create'), name, runtimeId: id }),
  z.strictObject({ type: z.literal('instance.rename'), instanceId: id, name }),
  z.strictObject({ type: z.literal('instance.default'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.clone'), instanceId: id, name, runtimeId: id.optional() }),
  z.strictObject({ type: z.literal('instance.start'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.stop'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.open'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.delete'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.folder'), instanceId: id, scope: z.enum(['home', 'agents', 'workspace', 'logs', 'root']) }),
  z.strictObject({ type: z.literal('cli.select'), instanceId: id }),
  z.strictObject({ type: z.literal('cli.install-command') }),
  z.strictObject({ type: z.literal('terminal.open'), instanceId: id.optional() }),
  z.strictObject({ type: z.literal('terminal.input'), terminalId: z.string().optional(), text: z.string().min(1).max(65536) }),
  z.strictObject({ type: z.literal('terminal.close'), terminalId: z.string().optional() }),
  z.strictObject({ type: z.literal('terminal.clear'), terminalId: z.string().optional() }),
  z.strictObject({ type: z.literal('terminal.resize'), terminalId: z.string(), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
  z.strictObject({ type: z.literal('terminal.select'), terminalId: z.string() }),
  z.strictObject({ type: z.literal('terminal.export'), terminalId: z.string() }),
  z.strictObject({ type: z.literal('terminal.remove'), terminalId: z.string() }),
  z.strictObject({ type: z.literal('operation.pause'), operationId: id }),
  z.strictObject({ type: z.literal('operation.resume'), operationId: id }),
  z.strictObject({ type: z.literal('operation.retry'), operationId: id }),
  z.strictObject({ type: z.literal('market.search'), kind: z.enum(['plugin', 'skill']), query: z.string().max(200), page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(100).optional(), refresh: z.boolean().optional() }),
  z.strictObject({ type: z.literal('market.plugin.install'), instanceId: id, entryId: z.string().max(512) }),
  z.strictObject({ type: z.literal('skill.inspect'), repository: dshRepositorySchema, revision: z.string().max(128).optional() }),
  z.strictObject({ type: z.literal('skill.install'), instanceId: id, target: dshSkillTargetSchema }),
  z.strictObject({ type: z.literal('skill.list'), instanceId: id }),
  z.strictObject({ type: z.literal('skill.toggle'), instanceId: id, name: dshSkillNameSchema, enabled: z.boolean() }),
  z.strictObject({ type: z.literal('skill.remove'), instanceId: id, name: dshSkillNameSchema }),
  z.strictObject({ type: z.literal('instance.logs'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.check'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.plugin'), instanceId: id, action: z.enum(['list', 'add', 'remove']), spec: z.string().trim().max(512).optional() }),
  z.strictObject({ type: z.literal('instance.plugins'), instanceId: id }),
  z.strictObject({ type: z.literal('instance.plugin-toggle'), instanceId: id, name: z.string().min(1).max(256), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('snapshot.create'), instanceId: id, name }),
  z.strictObject({ type: z.literal('snapshot.restore'), snapshotId: id, name }),
  z.strictObject({ type: z.literal('snapshot.delete'), snapshotId: id }),
  z.strictObject({ type: z.literal('backup.export'), instanceId: id }),
  z.strictObject({ type: z.literal('backup.import'), name }),
  z.strictObject({ type: z.literal('pack.create'), instanceId: id, name, version: name }),
  z.strictObject({ type: z.literal('pack.install'), packId: id, name }),
  z.strictObject({ type: z.literal('pack.import') }),
  z.strictObject({ type: z.literal('pack.export'), packId: id }),
  z.strictObject({ type: z.literal('pack.distribute'), packId: id, downloadUrl: z.string().max(4096).optional() }),
  z.strictObject({ type: z.literal('pack.inspect-url'), manifestUrl: z.string().max(4096) }),
  z.strictObject({ type: z.literal('pack.import-url'), manifestUrl: z.string().max(4096) }),
  z.strictObject({ type: z.literal('pack.publish'), packId: id, repository: dshRepositorySchema, tag: z.string().min(1).max(100),
    token: z.string().min(1).max(1024), title: z.string().max(200).optional(), notes: z.string().max(30000).optional(), draft: z.boolean().default(true) }),
  z.strictObject({ type: z.literal('pack.delete'), packId: id }),
]);
export type DshLauncherRequest = z.infer<typeof dshLauncherRequestSchema>;
export const dshLauncherResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: dshLauncherStateSchema.optional(),
    marketPage: dshMarketPageSchema.optional(), skillInspection: dshSkillInspectionSchema.optional(), installedSkills: z.array(dshInstalledSkillSchema).optional(),
    packDistribution: dshPackDistributionSchema.optional(),
    installedPlugins: z.array(dshInstalledPluginSchema).optional(),
    taskResult: dshTaskResultSchema.optional(), taskEvents: z.array(dshTaskEventSchema).optional(), taskRecord: dshRecordPageSchema.optional(),
    instanceId: id.optional(), operationId: id.optional(), text: z.string().optional(), cancelled: z.boolean().optional(), removedOperations: z.number().int().min(0).optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type DshLauncherResponse = z.infer<typeof dshLauncherResponseSchema>;
export interface WorldlineBoxDshLauncherApi {
  request(input: DshLauncherRequest): Promise<DshLauncherResponse>;
  onChanged(listener: (state: DshLauncherState) => void): () => void;
  onTerminalOutput?(listener: (output: DshTerminalOutput) => void): () => void;
  onTaskEvent?(listener: (event: DshTaskEvent) => void): () => void;
}
