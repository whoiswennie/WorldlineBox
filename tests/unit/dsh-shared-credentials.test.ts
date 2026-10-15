import { access, mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import { instanceEnvironment } from '../../src/main/dsh/instance-process';
import { credentialRoutingPatches, migrateSharedCredentials, writeTechnicalRoutingPatch } from '../../src/main/dsh/shared-credentials';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-shared-credentials-')); roots.push(root); return root; }

describe('explicit shared storage routing', () => {
  it('routes only credentials and technical storage paths while preserving the writable private profile', async () => {
    const root = await setup(); const privateRoot = path.join(root, 'private'); const shared = path.join(root, 'shared');
    await mkdir(path.join(privateRoot, 'home/profiles/web'), { recursive: true });
    const original = '[{"id":"ui-settings-general","config":{"welcomeNoticeVersion":"original"}}]\n';
    await writeFile(path.join(privateRoot, 'home/profiles/web/cordis.patch.yml'), original);
    const patch = await writeTechnicalRoutingPatch({ instanceRoot: privateRoot, sharedRoot: shared, runtimeVersion: '0.2.0-rc.2',
      patches: [{ id: 'session-persistence-jsonl', config: { root: path.join(shared, 'sessions'), compression: 'zstd' } }] });
    expect(parse(await readFile(patch, 'utf8'))).toEqual([...credentialRoutingPatches(shared), { id: 'session-persistence-jsonl', config: { root: path.join(shared, 'sessions'), compression: 'zstd' } }]);
    expect(await readFile(path.join(privateRoot, 'home/profiles/web/cordis.patch.yml'), 'utf8')).toBe(original);
    await expect(writeTechnicalRoutingPatch({ instanceRoot: privateRoot, sharedRoot: shared, runtimeVersion: '0.2.0-rc.2', patches: [{ id: 'ui-settings-general', config: {} }] })).rejects.toThrow('Unsupported');
    await expect(writeTechnicalRoutingPatch({ instanceRoot: privateRoot, sharedRoot: shared, runtimeVersion: 'unlisted-release' })).resolves.toBe(patch);
  });
  it('refuses a linked metadata directory before writing into its external target', async () => {
    const root = await setup(); const privateRoot = path.join(root, 'private'); const external = path.join(root, 'external');
    await mkdir(privateRoot); await mkdir(external);
    await symlink(external, path.join(privateRoot, 'launcher'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeTechnicalRoutingPatch({ instanceRoot: privateRoot, sharedRoot: path.join(root, 'shared'), runtimeVersion: '0.2.0-rc.2' })).rejects.toThrow('owned regular');
    expect(await readdir(external)).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('native shared credentials migration', () => {
  it('merges only missing credential references and account grants under the native writer lock, preserving conflicts and source bytes', async () => {
    const root = await setup(); const privateRoot = path.join(root, 'instance'); const sharedRoot = path.join(root, 'shared');
    const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: path.join(program, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), env: { ELECTRON_RUN_AS_NODE: '1' } };
    const instance: DshInstance = { id: 'source-instance', name: 'Fixture', runtimeId: 'official-fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      profile: 'web', status: 'stopped', homePath: path.join(privateRoot, 'home'), agentsPath: path.join(privateRoot, 'agents'), workspacePath: path.join(privateRoot, 'workspace'), browserPartition: 'persist:source-instance', isDefault: false };
    const env = await instanceEnvironment(privateRoot, instance, plan); await mkdir(sharedRoot);
    const source = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: source-conflict-placeholder\n  CUSTOM_API_KEY: migrated-placeholder\nrecords:\n  deepseek-account/default:\n    kind: grant\n    payload: {version: 1, accessToken: fixture-token-placeholder}\n';
    const target = '# Keep the shared author comment\nversion: 1\nrefs:\n  DEEPSEEK_API_KEY: shared-placeholder # keep spelling\nrecords:\n  llm-pi-ai/openai:\n    kind: api-key\n    key: unrelated-placeholder\n';
    await writeFile(path.join(instance.homePath, '.credentials.yaml'), source);
    await writeFile(path.join(sharedRoot, '.credentials.yaml'), target);
    const before = await inventoryTree(instance.homePath);
    const preview = await migrateSharedCredentials({ instanceRoot: privateRoot, sourceInstanceId: instance.id, sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.importedRefs).toEqual(['CUSTOM_API_KEY']); expect(preview.importedRecords).toEqual(['deepseek-account/default']);
    expect(preview.conflicts).toEqual([{ section: 'refs', key: 'DEEPSEEK_API_KEY' }]);
    expect(await readFile(path.join(sharedRoot, '.credentials.yaml'), 'utf8')).toBe(target);
    expect((await inventoryTree(instance.homePath)).contentSha256).toBe(before.contentSha256);
    expect(JSON.stringify(preview)).not.toContain('placeholder');
    const report = await migrateSharedCredentials({ instanceRoot: privateRoot, sourceInstanceId: instance.id, sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env });
    expect(report.dryRun).toBe(false);
    expect(report.importedRefs).toEqual(['CUSTOM_API_KEY']); expect(report.importedRecords).toEqual(['deepseek-account/default']);
    expect(report.conflicts).toEqual([{ section: 'refs', key: 'DEEPSEEK_API_KEY' }]);
    const after = await readFile(path.join(sharedRoot, '.credentials.yaml'), 'utf8');
    expect(after).toContain('# Keep the shared author comment'); expect(after).toContain('# keep spelling');
    expect(parse(after).refs.DEEPSEEK_API_KEY).toBe('shared-placeholder');
    expect(parse(after).refs.CUSTOM_API_KEY).toBe('migrated-placeholder');
    expect((await inventoryTree(instance.homePath)).contentSha256).toBe(before.contentSha256);
    expect(JSON.stringify(report)).not.toContain('placeholder');
    const again = await migrateSharedCredentials({ instanceRoot: privateRoot, sourceInstanceId: instance.id, sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env });
    expect(again.importedRefs).toEqual([]); expect(again.importedRecords).toEqual([]);
    expect(again.identicalRefs).toEqual(['CUSTOM_API_KEY']);
    expect(again.conflicts).toEqual(report.conflicts);
    // A sealed backup can supply its included shared document without touching an active home.
    await mkdir(path.join(privateRoot, 'shared')); await writeFile(path.join(privateRoot, 'shared/.credentials.yaml'), source);
    const backup = await migrateSharedCredentials({ instanceRoot: privateRoot, sourceRelativePath: 'shared/.credentials.yaml', sourceInstanceId: instance.id,
      sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env });
    expect(backup.sourcePath).toBe(path.join(privateRoot, 'shared/.credentials.yaml'));
    await expect(migrateSharedCredentials({ instanceRoot: privateRoot, sourceRelativePath: '../outside', sourceInstanceId: instance.id, sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env })).rejects.toThrow('Unsafe');
  }, 60_000);
  it('preflights missing or unsupported native documents without creating or changing shared credentials or source bytes', async () => {
    const root = await setup(); const privateRoot = path.join(root, 'instance'); const sharedRoot = path.join(root, 'shared');
    const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: path.join(program, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), env: { ELECTRON_RUN_AS_NODE: '1' } };
    const instance: DshInstance = { id: 'preflight-instance', name: 'Fixture', runtimeId: 'official-fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      profile: 'web', status: 'stopped', homePath: path.join(privateRoot, 'home'), agentsPath: path.join(privateRoot, 'agents'), workspacePath: path.join(privateRoot, 'workspace'), browserPartition: 'persist:preflight-instance', isDefault: false };
    const env = await instanceEnvironment(privateRoot, instance, plan); await mkdir(sharedRoot);
    const sourceFile = path.join(instance.homePath, '.credentials.yaml'); const targetFile = path.join(sharedRoot, '.credentials.yaml');
    const source = 'version: 1\nrefs:\n  CUSTOM_API_KEY: source-value-must-stay-private\n';
    await writeFile(sourceFile, source);
    const before = await inventoryTree(instance.homePath);
    const options = { instanceRoot: privateRoot, sourceInstanceId: instance.id, sharedRoot, runtimeVersion: '0.2.0-rc.2', plan, env, dryRun: true };
    const missing = await migrateSharedCredentials(options);
    expect(missing.dryRun).toBe(true); expect(missing.importedRefs).toEqual(['CUSTOM_API_KEY']);
    await expect(access(targetFile)).rejects.toMatchObject({ code: 'ENOENT' });
    const future = 'version: 999\nrefs:\n  FUTURE_API_KEY: future-value-must-stay-private\n';
    await writeFile(targetFile, future);
    await expect(migrateSharedCredentials(options)).rejects.toThrow('Native credential migration was refused');
    expect(await readFile(targetFile, 'utf8')).toBe(future);
    expect((await inventoryTree(instance.homePath)).contentSha256).toBe(before.contentSha256);
    const target = 'version: 1\nrefs:\n  TARGET_API_KEY: target-value-must-stay-private\n';
    await writeFile(targetFile, target); await writeFile(sourceFile, future);
    await expect(migrateSharedCredentials(options)).rejects.toThrow('Native credential migration was refused');
    expect(await readFile(targetFile, 'utf8')).toBe(target); expect(await readFile(sourceFile, 'utf8')).toBe(future);
    expect(await readdir(path.join(sharedRoot, '.migration-tools'))).toEqual([]);
  }, 60_000);
});
