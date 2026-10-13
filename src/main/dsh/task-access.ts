import path from 'node:path';
import { z } from 'zod';

import { dshExecutionAccessModeSchema, dshExecutionAccessSettingsSchema,
  type DshExecutionAccessMode, type DshExecutionAccessSettings } from '../../shared/dsh-access';
import { lstat, mkdir } from './disk';
import { atomicJson, readJson } from './files';

const storedSettingsSchema = z.strictObject({ format: z.literal('worldlinebox-dsh-task-access-v1'), mode: dshExecutionAccessModeSchema });

/** Launcher-owned preference, separate from the DSH user's profile and presets. */
export class DshTaskAccessStore {
  private settings: DshExecutionAccessSettings = { mode: 'danger-full-access' };
  private loaded = false;
  private loadTask?: Promise<void>;
  private writes = Promise.resolve();
  private readonly file: string;

  constructor(private readonly rootPath: string) {
    if (!path.isAbsolute(rootPath)) throw new Error('The DSH task access storage directory must be absolute.');
    this.file = path.join(rootPath, 'execution-access.json');
  }

  state(): DshExecutionAccessSettings { return { ...this.settings }; }

  private async checkStorage(): Promise<void> {
    await mkdir(this.rootPath, { recursive: true });
    const root = await lstat(this.rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The DSH task access storage directory cannot be linked.');
    const file = await lstat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (file && (!file.isFile() || file.isSymbolicLink() || file.size > 8192)) {
      throw new Error('Saved DSH task access settings are linked or exceed the size limit; the original file was preserved.');
    }
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loadTask ??= (async () => {
      await this.checkStorage();
      const stored = await readJson<unknown>(this.file).catch(() => {
        throw new Error('Saved DSH task access settings could not be read; the original file was preserved.');
      });
      if (stored !== undefined) {
        const parsed = storedSettingsSchema.safeParse(stored);
        if (!parsed.success) throw new Error('Saved DSH task access settings are unsupported; the original file was preserved.');
        this.settings = { mode: parsed.data.mode };
      }
      this.loaded = true;
    })();
    return this.loadTask;
  }

  save(modeValue: DshExecutionAccessMode): Promise<DshExecutionAccessSettings> {
    const parsed = dshExecutionAccessModeSchema.safeParse(modeValue);
    if (!parsed.success) return Promise.reject(new Error('The DSH task access policy is invalid.'));
    const mode = parsed.data;
    const write = this.writes.then(async () => {
      await this.load();
      await this.checkStorage();
      await atomicJson(this.file, { format: 'worldlinebox-dsh-task-access-v1', mode });
      this.settings = { mode };
    });
    this.writes = write.catch(() => undefined);
    return write.then(() => ({ mode }));
  }
}

/** Main captures this before any async reservation or runtime selection. */
export function snapshotDshTaskAccess(input?: DshExecutionAccessSettings): Readonly<DshExecutionAccessSettings> {
  const parsed = dshExecutionAccessSettingsSchema.safeParse(input ?? {});
  if (!parsed.success) throw new Error('The DSH task access policy is invalid.');
  return Object.freeze({ mode: parsed.data.mode });
}

/**
 * Inspected native 0.2.0-rc.2 / 0.2.1-alpha.2 base-row IDs. This invocation
 * overlay changes real enforcing providers rather than claiming access in a
 * prompt. The selected preset is pinned as sandbox/mode and approval/policy
 * events when DSH creates the execution session. Existing sessions retain
 * their logged policy; callers must not reuse a session under a new snapshot.
 *
 * Restricted presets use `never` too: the headless broker does not offer an
 * approval UI, so denied operations cannot silently escalate to wider access.
 * DSH modes govern file effects, not network/process isolation or Windows UAC.
 */
export function dshTaskAccessPatch(input: DshExecutionAccessSettings, workspaceRoot: string,
  platform: NodeJS.Platform = process.platform) {
  const access = snapshotDshTaskAccess(input);
  if (typeof workspaceRoot !== 'string' || !workspaceRoot || workspaceRoot.length > 32767 ||
    workspaceRoot.includes('\0') || !path.isAbsolute(workspaceRoot)) {
    throw new Error('The DSH task access workspace must be an absolute path.');
  }
  return [
    { id: 'sandbox', disabled: false },
    { id: 'sandbox-policy', disabled: false, config: { mode: access.mode, workspaceRoot } },
    { id: 'fs-sandbox', disabled: false },
    { id: platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox', disabled: false },
    { id: 'approval', disabled: false, config: { policy: 'never' } },
    { id: 'permission', disabled: false, config: {
      defaultPreset: access.mode,
      presets: {
        'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
        'workspace-write': { sandbox: 'workspace-write', approval: 'never' },
        'read-only': { sandbox: 'read-only', approval: 'never' },
      },
    } },
  ];
}

export function taskAccessPatch(mode: DshExecutionAccessMode, workspaceRoot: string,
  platform: NodeJS.Platform = process.platform) {
  return dshTaskAccessPatch({ mode }, workspaceRoot, platform);
}
