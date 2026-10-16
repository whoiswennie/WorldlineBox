import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { prepareNativeCliMode, DSH_NATIVE_CLI_DISABLED_IDS, DSH_NATIVE_CLI_ENABLED_IDS } from '../../src/main/dsh/cli-profile-mode';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { instanceEnvironment, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import { removeManaged } from '../../src/main/dsh/files';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('official CLI mode over the selected web plugin profile', () => {
  it('loads the pinned headless driver without a second plugin profile or HTTP Host and prints real native help/version', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-cli-profile-')); roots.push(root);
    const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const instance: DshInstance = { id: 'cli-native', name: 'CLI fixture', runtimeId: 'official', profile: 'web', status: 'stopped',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), homePath: path.join(root, 'home'),
      agentsPath: path.join(root, 'agents'), workspacePath: path.join(root, 'workspace'), browserPartition: 'persist:cli-native', isDefault: false };
    const plan = { ...canonicalRuntimeEntryPaths(program.toUpperCase()), env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
    const env = await instanceEnvironment(root, instance, plan);
    const prefix = await prepareNativeCliMode(root, program.toUpperCase());
    const mode = parse(await readFile(prefix[4]!, 'utf8'));
    expect(mode).toEqual([...DSH_NATIVE_CLI_DISABLED_IDS.map(id => ({ id, disabled: true })), ...DSH_NATIVE_CLI_ENABLED_IDS.map(id => ({ id, disabled: false }))]);
    const invoke = async (flag: string) => {
      const child = await launchCli(plan, [...prefix, flag], env, instance.workspacePath);
      try {
        return await new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
          let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.resume();
          child.once('error', reject); child.once('close', code => resolve({ code, stdout }));
        });
      } finally { await terminateOwnedProcess(child); }
    };
    const help = await invoke('--help'); expect(help.code).toBe(0); expect(help.stdout).toContain('Answer one task and exit');
    expect(help.stdout).toContain('--session-id'); expect(help.stdout).not.toMatch(/^dsh web:/m);
    expect(await readdir(path.join(instance.homePath, 'profiles'))).toEqual(['web']);
    const manifest = JSON.parse(await readFile(path.join(instance.homePath, 'profiles/web/package.json'), 'utf8'));
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    const version = await invoke('--version'); expect(version.code).toBe(0); expect(version.stdout.trim()).toBe('0.2.0-rc.2');
    await expect(prepareNativeCliMode(root, program, 'future-version')).rejects.toThrow('missing the inspected native headless bundle');
  }, 60_000);
});
