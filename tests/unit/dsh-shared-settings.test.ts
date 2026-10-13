import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { parse } from 'yaml';
import { SharedSettingsCoordinator, mergeSharedModels, readSharedModels, writeSharedModels, foldHomeModelOverrides, sanitizeSharedModels, type SharedModelSnapshot, type SharedSettingsIssue } from '../../src/main/dsh/shared-settings';
import { connectNativeSettings, SharedSettingsRpcError, type NativeSettingsTransport, type NativeSettingsView, type SettingsMutation } from '../../src/main/dsh/shared-settings-rpc';
import { instanceEnvironment, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import { realpath } from '../../src/main/dsh/disk';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
const coordinators: SharedSettingsCoordinator[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.dispose();
  for (const root of roots.splice(0)) if (path.dirname(path.resolve(root)) === path.resolve(tmpdir()) && path.basename(root).startsWith('worldlinebox-model-sync-')) await rm(root, { force: true, recursive: true });
});

it.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('shares native model edits between two official canonical Hosts without changing profile ownership', async () => {
  const f = await fixture();
  const program = await realpath(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
  const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: path.join(program, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'), env: { ELECTRON_RUN_AS_NODE: '1' } };
  const hosts: ChildProcess[] = [];
  const transports: NativeSettingsTransport[] = [];
  const coordinator = new SharedSettingsCoordinator({ storePath: path.join(f.root, 'native-shared', 'model-settings.json'), onIssue: issue => f.issues.push(issue) });
  coordinators.push(coordinator);
  try {
    for (const id of ['a', 'b']) {
      const root = path.join(f.root, `native-${id}`);
      const instance: DshInstance = { id, name: 'Private native model fixture', runtimeId: 'fixture', profile: 'web', status: 'stopped', homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'), workspacePath: path.join(root, 'workspace'), browserPartition: `persist:private-native-${id}`, isDefault: false, createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
      const env = await instanceEnvironment(root, instance, plan); env.DSH_TELEMETRY_DISABLED = '1';
      await coordinator.prepareStopped(id, instance.homePath);
      const child = await launchCli(plan, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], env, instance.workspacePath);
      child.stderr.resume();
      hosts.push(child);
      const ready = await new Promise<string>((resolve, reject) => {
        let output = ''; const timer = setTimeout(() => reject(new Error('Private native model fixture timed out.')), 30_000);
        child.stdout!.on('data', value => { output += String(value); const match = /^dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?[^\s]+)\s*$/m.exec(output); if (match) { clearTimeout(timer); resolve(match[1]!); } });
        child.once('error', () => { clearTimeout(timer); reject(new Error('Private native model fixture did not start.')); });
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Private native model fixture exited.')); });
      });
      await coordinator.attach(id, ready, instance.homePath);
      transports.push(await connectNativeSettings(ready));
    }
    const editable = (await transports[0]!.describe()).find(view => view.ns === 'llm-pi-ai')!;
    await transports[0]!.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'worldline-fixture'], value: { api: 'openai-completions', baseURL: 'https://model-fixture.invalid/v1', apiKeyEnv: 'WORLDLINE_FIXTURE_API_KEY', models: [{ id: 'fixture-model' }] } }], editable.revision);
    await expect.poll(async () => Boolean(((await transports[1]!.describe()).find(view => view.ns === 'llm-pi-ai')?.user?.providers as Record<string, unknown> | undefined)?.['worldline-fixture']), { timeout: 15_000 }).toBe(true);
    expect(f.issues).toHaveLength(0);
    expect((await transports[1]!.describe()).some(view => view.ns === 'ui-settings-general')).toBe(true);
    expect((await coordinator.exportSnapshot())['llm-pi-ai'] !== undefined).toBe(true);
  } finally {
    await coordinator.dispose(); for (const transport of transports) transport.close();
    for (const child of hosts) await terminateOwnedProcess(child as Parameters<typeof terminateOwnedProcess>[0]);
  }
}, 90_000);
const model = (baseURL: string): SharedModelSnapshot => ({ 'llm-pi-ai': { providers: { openai: { baseURL, apiKeyEnv: 'OPENAI_API_KEY' } } } });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-model-sync-')); roots.push(root);
  const issues: SharedSettingsIssue[] = [];
  const transports: NativeSettingsTransport[] = [];
  const coordinator = new SharedSettingsCoordinator({ storePath: path.join(root, 'shared', 'model-settings.json'), onIssue: issue => issues.push(issue), connect: async () => transports.shift()! });
  coordinators.push(coordinator);
  return { root, issues, transports, coordinator };
}
function peer(snapshot: SharedModelSnapshot) {
  const views: NativeSettingsView[] = Object.entries(readSharedModels(writeSharedModels('[]\n', snapshot))).map(([ns, user]) => ({ ns, user, revision: 0, secrets: [] }));
  const calls: Array<{ ns: string; expectedRevision: number }> = [];
  let fail = false;
  const transport: NativeSettingsTransport = {
    async describe() { return structuredClone(views); },
    async mutate(ns: string, ops: SettingsMutation[], expectedRevision: number) {
      const view = views.find(entry => entry.ns === ns)!; calls.push({ ns, expectedRevision });
      if (fail || view.revision !== expectedRevision) throw new SharedSettingsRpcError('settings/conflict');
      for (const op of ops) { const key = op.path[0]!; if (op.op === 'unset') delete view.user![key]; else view.user![key] = structuredClone(op.value); }
      view.revision++; return structuredClone(view);
    },
    onChanged() { return () => undefined; }, close() {},
  };
  return { transport, views, calls, failCas() { fail = true; } };
}

describe('shared model configuration with private plugin profiles', () => {
  it('refuses literal SDK expression markers in common model JSON and profile mappings', () => {
    const value = { 'llm-pi-ai': { providers: { unsafe: { __jsExpr: 'process.exit()' } } } };
    expect(() => sanitizeSharedModels(value)).toThrow('Unsafe model settings');
    expect(() => readSharedModels('- id: llm-pi-ai\n  config:\n    providers:\n      unsafe: {__jsExpr: process.exit()}\n')).toThrow('Unsafe model settings');
  });
  it('honors native replacement semantics for repeated model config rows', () => {
    const patch = '- id: agent-default-model\n  config: {provider: old, model: old-model, reasoningEffort: high}\n- id: agent-default-model\n  config: {model: new-model}\n';
    expect(readSharedModels(patch)['agent-default-model']).toEqual({ model: 'new-model' });
  });
  it('captures later Home model overrides, keeps unrelated and private options, and lets common settings remain editable in the profile', async () => {
    const f = await fixture(); const home = path.join(f.root, 'home'); await mkdir(path.join(home, 'profiles', 'web'), { recursive: true });
    const profile = '- id: llm-pi-ai\n  config:\n    profileOnly: old-effective-option\n    providers:\n      old: {baseURL: https://old.invalid}\n';
    const homeText = '# later native Home overlay\n- id: llm-pi-ai\n  disabled: false\n  config:\n    privateOption: kept\n    providers:\n      fixture: {baseURL: https://current.invalid, apiKeyEnv: FIXTURE_KEY}\n- id: private-only-plugin\n  config: {value: private}\n';
    const folded = foldHomeModelOverrides(profile, homeText);
    expect(readSharedModels(folded.profile)['llm-pi-ai']?.providers).toEqual({ fixture: { baseURL: 'https://current.invalid', apiKeyEnv: 'FIXTURE_KEY' } });
    expect(folded.profile).toContain('privateOption: kept'); expect(folded.profile).not.toContain('profileOnly');
    expect(folded.home).toContain('private-only-plugin'); expect(folded.home).toContain('disabled: false'); expect(folded.home).not.toContain('providers');
    await writeFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), profile); await writeFile(path.join(home, 'cordis.patch.yml'), homeText);
    await f.coordinator.prepareStopped('home-override', home);
    expect(await readFile(path.join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain('privateOption: kept');
    expect(await readFile(path.join(home, 'cordis.patch.yml'), 'utf8')).not.toContain('providers');
    expect((await f.coordinator.exportSnapshot())['llm-pi-ai']?.providers).toEqual({ fixture: { baseURL: 'https://current.invalid', apiKeyEnv: 'FIXTURE_KEY' } });
  });
  it('updates only model fields and preserves plugin composition, comments and private options', () => {
    const privatePatch = '# private plugin arrangement\n- id: private-mod\n  name: example-mod\n  disabled: true\n  config:\n    apiKey: fixture-private-value\n- id: llm-pi-ai\n  config:\n    instanceOption: only-a\n    providers:\n      openai:\n        apiKeyEnv: OPENAI_API_KEY\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: own-instance\n';
    const next = writeSharedModels(privatePatch, model('https://gateway.example/v1'));
    const rows = parse(next) as Array<{ id: string; config?: Record<string, unknown>; disabled?: boolean }>;
    expect(next.includes('# private plugin arrangement')).toBe(true);
    expect(next.includes('fixture-private-value')).toBe(true);
    expect(rows.find(row => row.id === 'private-mod')?.disabled).toBe(true);
    expect(rows.find(row => row.id === 'ui-settings-general')?.config?.welcomeNoticeVersion).toBe('own-instance');
    expect(rows.find(row => row.id === 'llm-pi-ai')?.config?.instanceOption).toBe('only-a');
    expect(readSharedModels(next)['llm-pi-ai']).toEqual(model('https://gateway.example/v1')['llm-pi-ai']);
  });
  it('merges disjoint providers and refuses conflicting changes without exposing configured values', () => {
    const base = model('https://base.example');
    const a = structuredClone(base); a['llm-pi-ai']!.providers = { ...(a['llm-pi-ai']!.providers as object), anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } };
    const b = structuredClone(base); b['llm-pi-ai']!.providers = { ...(b['llm-pi-ai']!.providers as object), kimi: { apiKeyEnv: 'KIMI_API_KEY' } };
    const merged = mergeSharedModels(base, a, b);
    expect(merged.conflicts).toHaveLength(0);
    expect(Object.keys(merged.values['llm-pi-ai']!.providers as object)).toEqual(['openai', 'anthropic', 'kimi']);
    const conflict = mergeSharedModels(base, model('https://a.example'), model('https://b.example'));
    expect(conflict.conflicts).toEqual([{ namespace: 'llm-pi-ai', path: ['providers', 'openai', 'baseURL'] }]);
    expect(JSON.stringify(conflict.conflicts).includes('https://')).toBe(false);
    expect(() => readSharedModels('- id: llm-pi-ai\n  config: !<tag:yaml.org,2002:js> process.env\n')).toThrow('Dynamic');
    expect(() => writeSharedModels('- id: llm-pi-ai\n  name: private-custom-mod\n', model('https://a.example'))).toThrow('Ambiguous');
  });
  it('seeds stopped private profiles while retaining per-instance mods and welcome settings', async () => {
    const f = await fixture();
    const homeA = path.join(f.root, 'a', 'home'), homeB = path.join(f.root, 'b', 'home');
    for (const home of [homeA, homeB]) await mkdir(path.join(home, 'profiles', 'web'), { recursive: true });
    const first = writeSharedModels('- id: private-mod\n  config: {owner: A}\n', model('https://a.example'));
    await writeFile(path.join(homeA, 'profiles', 'web', 'cordis.patch.yml'), first);
    await writeFile(path.join(homeB, 'profiles', 'web', 'cordis.patch.yml'), '- id: private-mod\n  config: {owner: B}\n');
    await f.coordinator.prepareStopped('a', homeA); await f.coordinator.prepareStopped('b', homeB);
    const copied = await readFile(path.join(homeB, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    expect(copied.includes('owner: B')).toBe(true);
    expect(readSharedModels(copied)['llm-pi-ai']).toEqual(model('https://a.example')['llm-pi-ai']);
    expect(f.issues).toHaveLength(0);
  });
  it('coordinates live edits through native namespace CAS and reports conflicts without blind retry', async () => {
    const f = await fixture();
    await f.coordinator.importSnapshot(model('https://base.example'));
    const homeA = path.join(f.root, 'a'), homeB = path.join(f.root, 'b');
    await f.coordinator.prepareStopped('a', homeA); await f.coordinator.prepareStopped('b', homeB);
    const a = peer(model('https://base.example')), b = peer(model('https://base.example'));
    f.transports.push(a.transport, b.transport);
    await f.coordinator.attach('a', 'private-ready-a', homeA); await f.coordinator.attach('b', 'private-ready-b', homeB);
    a.views.find(view => view.ns === 'llm-pi-ai')!.user = model('https://changed.example')['llm-pi-ai'];
    a.views.find(view => view.ns === 'llm-pi-ai')!.revision = 3;
    b.failCas(); await f.coordinator.syncNow();
    expect(b.calls).toEqual([{ ns: 'llm-pi-ai', expectedRevision: 0 }]);
    expect(f.issues.at(-1)?.code).toBe('settings/conflict');
    expect(JSON.stringify(f.issues).includes('https://')).toBe(false);
    expect((await f.coordinator.exportSnapshot())['llm-pi-ai']).toEqual(model('https://changed.example')['llm-pi-ai']);
  });
  it('refuses replacement of redacted secret paths, and imports disjoint backup values safely', async () => {
    const f = await fixture();
    await f.coordinator.importSnapshot(model('https://base.example'));
    const home = path.join(f.root, 'a'); await f.coordinator.prepareStopped('a', home);
    const a = peer(model('https://base.example')); f.transports.push(a.transport);
    await f.coordinator.attach('a', 'private-ready', home);
    const view = a.views.find(view => view.ns === 'llm-pi-ai')!;
    view.secrets = [{ path: ['providers', 'openai', 'privateKey'], set: true }];
    await f.coordinator.importSnapshot({ 'llm-pi-ai': { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } } });
    expect(f.issues.at(-1)?.code).toBe('settings/secret-path-conflict');
    expect(a.calls.filter(call => call.ns === 'llm-pi-ai')).toHaveLength(0);
    await f.coordinator.importSnapshot({ 'agent-default-model': { provider: 'openai', model: 'fixture-model' } });
    expect((await f.coordinator.exportSnapshot())['agent-default-model']?.model).toBe('fixture-model');
    const backup = path.join(f.root, 'backup.json');
    await writeFile(backup, JSON.stringify({ version: 1, values: model('https://conflicting.example'), clients: {} }));
    const canonicalBefore = await readFile(path.join(f.root, 'shared', 'model-settings.json'), 'utf8');
    await expect(f.coordinator.assertImportableFrom(backup)).rejects.toThrow('conflict');
    expect((await readFile(path.join(f.root, 'shared', 'model-settings.json'), 'utf8')) === canonicalBefore).toBe(true);
    await expect(f.coordinator.importFrom(backup)).rejects.toThrow('conflict');
    const preserved = (await f.coordinator.exportSnapshot())['llm-pi-ai']?.providers as Record<string, { baseURL?: string }>;
    expect(preserved.openai?.baseURL).toBe('https://base.example');
    expect(Object.hasOwn(preserved, 'anthropic')).toBe(true);
    expect(f.issues.at(-1)?.instanceId).toBe('backup-import');
    await writeFile(backup, JSON.stringify({ version: 1, values: { 'llm-deepseek': { baseURL: 'https://disjoint-backup.example' } }, clients: {} }));
    await f.coordinator.assertImportableFrom(backup);
    const afterPreflight = await f.coordinator.exportSnapshot();
    expect(afterPreflight['llm-pi-ai']?.providers !== undefined).toBe(true);
    expect(afterPreflight['llm-deepseek']?.baseURL).toBeUndefined();
    expect((await readFile(path.join(f.root, 'shared', 'model-settings.json'), 'utf8')) === canonicalBefore).toBe(true);
  });
});
