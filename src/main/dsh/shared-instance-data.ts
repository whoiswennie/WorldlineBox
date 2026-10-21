import path from 'node:path';
import { lstat, mkdir, realpath } from './disk';
import type { DshInstance, DshSharedData } from '../../shared/dsh-launcher';
import { atomicJson, copyTree, inventoryTree, readJson } from './files';
import { instanceEnvironment, type RuntimeLaunchPlan } from './instance-process';
import type { OperationContext } from './operations';
import { migrateSharedCredentials, writeTechnicalRoutingPatch } from './shared-credentials';
import { assertSharedSessionCompatibility, hasPrivateSaveData, migrateInstanceData, sharedDataPaths, sharedSessionRoutingPatches } from './shared-session-data';
import { SharedSettingsCoordinator } from './shared-settings';
import { withDshCliExclusive } from './cli-terminal';
import { runtimeProgramDirectory } from './runtime-sdk';

/** The public save layer is explicitly routed; profile packages and GUI state stay private. */
export class SharedInstanceData {
  readonly paths: ReturnType<typeof sharedDataPaths>;
  private readonly settings: SharedSettingsCoordinator;
  private preparations: Promise<void> = Promise.resolve();
  constructor(private readonly options: {
    rootPath: string; plan: (runtimeId: string) => RuntimeLaunchPlan;
    assertCompatible?: (runtimeId: string, signal?: AbortSignal) => Promise<void>;
    onIssue?: (instanceId: string, message: string) => void;
  }) {
    this.paths = sharedDataPaths(path.join(options.rootPath, 'shared'));
    this.settings = new SharedSettingsCoordinator({ storePath: this.paths.settingsPath,
      onIssue: issue => options.onIssue?.(issue.instanceId, `Shared model settings need attention (${issue.code}; ${issue.namespaces.join(', ')}). Existing settings were retained.`),
    });
  }
  state(): DshSharedData { return { ...this.paths }; }
  exclusive<T>(work: () => Promise<T>, instanceId?: string): Promise<T> { return withDshCliExclusive(this.options.rootPath, work, instanceId); }
  async init(): Promise<void> {
    const root = await realpath(this.options.rootPath);
    for (const directory of [this.paths.rootPath, this.paths.sessionsPath, this.paths.documentsPath, this.paths.workspacePath, this.paths.attachmentsPath]) {
      const relative = path.relative(root, directory);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Shared DSH data is outside managed user storage.');
      let current = root;
      for (const component of relative.split(path.sep)) {
        current = path.join(current, component);
        const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('Shared DSH data directories must be owned regular directories.');
        if (!stat) await mkdir(current, { mode: 0o700 });
      }
    }
    // Project keys encode the cwd text. Use the same physical Windows spelling
    // for Web workspaces, CLI cwd and migrated Session headers.
    Object.assign(this.paths, sharedDataPaths(await realpath(this.paths.rootPath)));
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.preparations.then(work, work);
    this.preparations = task.then(() => undefined, () => undefined);
    return task;
  }
  async isPrepared(instance: DshInstance): Promise<boolean> {
    const marker = await readJson<{ format?: string; instanceId?: string; sharedRootPath?: string }>(path.join(path.dirname(instance.homePath), 'launcher', 'shared-data-ready.json'));
    const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return marker?.format === 'worldlinebox-shared-data-v1' && marker.instanceId === instance.id
      && typeof marker.sharedRootPath === 'string' && normalized(marker.sharedRootPath) === normalized(this.paths.rootPath);
  }
  async prepare(instance: DshInstance, runtimeVersion: string, operation?: OperationContext, allowLegacyMigration = true): Promise<{ args: string[]; workspacePath: string }> {
    return this.serial(async () => {
      operation?.signal.throwIfAborted();
      await this.options.assertCompatible?.(instance.runtimeId, operation?.signal);
      await this.init(); operation?.signal.throwIfAborted();
      const prepared = await this.isPrepared(instance);
      const legacySaves = !prepared && (await hasPrivateSaveData(instance.homePath, instance.workspacePath)
        || !!await lstat(path.join(instance.homePath, '.credentials.yaml')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; }));
      const prepare = async () => {
      const root = path.dirname(instance.homePath);
      const plan = this.options.plan(instance.runtimeId);
      const env = await instanceEnvironment(root, instance, plan);
      if (legacySaves) {
        if (!allowLegacyMigration) throw new Error('Stop the DSH WebUI before migrating this instance’s existing private saves into shared storage.');
        const migrated = await migrateInstanceData({ instanceId: instance.id, homePath: instance.homePath,
          workspacePath: instance.workspacePath, sharedRoot: this.paths.rootPath, runtimeVersion, signal: operation?.signal });
        const credentials = await migrateSharedCredentials({ instanceRoot: root, sourceInstanceId: instance.id,
          sharedRoot: this.paths.rootPath, runtimeVersion, plan, env, signal: operation?.signal, preferSource: instance.isDefault });
        await operation?.log(`Shared save migration: ${migrated.copiedSessions} sessions and ${migrated.copiedWorkspaceFiles} workspace files added. Conflicts retained: ${migrated.conflictingSessions + migrated.conflictingWorkspaceFiles + migrated.conflictingAttachments}; credential conflicts: ${credentials.conflicts.length}. Private originals retained.`);
      } else await assertSharedSessionCompatibility(this.paths.rootPath, runtimeVersion, operation?.signal);
      await this.settings.syncNow();
      await this.settings.prepareStopped(instance.id, instance.homePath, !prepared ? instance.isDefault ? 'prefer-source' : 'prefer-shared' : undefined);
      const patch = await writeTechnicalRoutingPatch({ instanceRoot: root, sharedRoot: this.paths.rootPath,
        runtimeVersion, programDirectory: runtimeProgramDirectory(plan.executable), workspacePath: this.paths.workspacePath, patches: sharedSessionRoutingPatches(this.paths.rootPath), signal: operation?.signal });
      await atomicJson(path.join(root, 'launcher', 'shared-data-ready.json'), { format: 'worldlinebox-shared-data-v1', instanceId: instance.id, sharedRootPath: this.paths.rootPath, runtimeVersion });
      return { args: ['--patch', patch], workspacePath: this.paths.workspacePath };
      };
      // Switching a prepared CLI context only updates this private composition.
      // Existing tasks retain their version; only shared-data migration needs the global barrier.
      return legacySaves ? this.exclusive(prepare) : prepare();
    });
  }
  async attach(instance: DshInstance, readyUrl: string): Promise<void> { await this.settings.attach(instance.id, readyUrl, instance.homePath); }
  async routingForRunning(instance: DshInstance, runtimeVersion: string): Promise<string> {
    await this.options.assertCompatible?.(instance.runtimeId);
    if (!await this.isPrepared(instance)) throw new Error('Restart this DSH instance after migrating its data before using the shared CLI environment.');
    await assertSharedSessionCompatibility(this.paths.rootPath, runtimeVersion);
    await this.settings.syncNow();
    return writeTechnicalRoutingPatch({ instanceRoot: path.dirname(instance.homePath), sharedRoot: this.paths.rootPath,
      runtimeVersion, programDirectory: runtimeProgramDirectory(this.options.plan(instance.runtimeId).executable), workspacePath: this.paths.workspacePath, patches: sharedSessionRoutingPatches(this.paths.rootPath) });
  }
  async detach(instanceId: string, flush = false): Promise<void> {
    if (flush) await this.settings.syncNow();
    this.settings.detach(instanceId);
  }
  async dispose(): Promise<void> { await this.preparations; await this.settings.dispose(); }
  async exportTo(destination: string, signal?: AbortSignal): Promise<void> {
    await this.preparations;
    await this.settings.exportSnapshot();
    // Inventory rejects links before copying credentials or conversations into an archive.
    await inventoryTree(this.paths.rootPath, signal);
    await copyTree(this.paths.rootPath, destination, { signal,
      skip: relative => /(?:^|\/)[^/]*\.(?:lock|tmp)$/.test(relative.replaceAll('\\', '/')) || relative.replaceAll('\\', '/').startsWith('.cli-users'),
    });
  }
  async restoreFrom(source: string, original: DshSharedData, instance: DshInstance, runtimeVersion: string, operation?: OperationContext): Promise<void> {
    await this.serial(async () => {
      operation?.signal.throwIfAborted();
      await this.options.assertCompatible?.(instance.runtimeId, operation?.signal);
      await this.init();
      const plan = this.options.plan(instance.runtimeId);
      const env = await instanceEnvironment(path.dirname(instance.homePath), instance, plan);
      await this.settings.assertImportableFrom(path.join(source, 'shared', 'model-settings.json'));
      await migrateSharedCredentials({ instanceRoot: source, sourceRelativePath: 'shared/.credentials.yaml', sourceInstanceId: instance.id,
        sharedRoot: this.paths.rootPath, runtimeVersion, plan, env, signal: operation?.signal, dryRun: true });
      await migrateInstanceData({ instanceId: instance.id, homePath: path.join(source, 'shared'),
        workspacePath: path.join(source, 'shared', 'documents', 'deepseek-harness', 'default-workspace'),
        oldWorkspacePath: original.workspacePath, sharedRoot: this.paths.rootPath, runtimeVersion, signal: operation?.signal });
      // Imported private Workspace registrations must follow the new public
      // save directory, without reading the original computer's workspace.
      await migrateInstanceData({ instanceId: instance.id, homePath: instance.homePath,
        workspacePath: instance.workspacePath, oldWorkspacePath: original.workspacePath,
        sharedRoot: this.paths.rootPath, runtimeVersion, signal: operation?.signal });
      await migrateSharedCredentials({ instanceRoot: source, sourceRelativePath: 'shared/.credentials.yaml', sourceInstanceId: instance.id,
        sharedRoot: this.paths.rootPath, runtimeVersion, plan, env, signal: operation?.signal });
      await this.settings.importFrom(path.join(source, 'shared', 'model-settings.json'));
      await operation?.log('Shared backup merged without replacing existing conversations, workspace files or credentials. Conflicting originals retained.');
    });
  }
}
