import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { buildPrivateSkillRouting, composeSkillRoutingEntries, privateSkillPatchesFromEntries } from '../../src/main/dsh/private-skills-routing';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { runtimeSdkRoot } from '../../src/main/dsh/runtime-sdk';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function temporaryRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-private-skill-test-')); roots.push(root); return root; }
const provider = { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { watch: false } };
describe('Private skill routes preserve the effective Cordis composition', () => {
  it('preserves full preset config and unrelated plugins while replacing provider roots and retaining inert expressions', () => {
    const plugins = [{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'Persona fixture' } }, provider,
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: { __jsExpr: "process.platform !== 'win32'" } }];
    const entries = composeSkillRoutingEntries([[{ insert: [{ id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', order: 1, plugins } }] }]]);
    const patches = privateSkillPatchesFromEntries(entries, ['C:/private/home/skills', 'C:/private/agents/skills'], 'C:/runtime/builtins');
    const composed = composeSkillRoutingEntries([[{ insert: entries }], patches]);
    const config = composed[0]!.config as { id: string; order: number; plugins: typeof plugins };
    expect(config.id).toBe('standard'); expect(config.order).toBe(1); expect(config.plugins).toHaveLength(3);
    expect(config.plugins[0]).toEqual(plugins[0]); expect(config.plugins[2]).toEqual(plugins[2]);
    expect(config.plugins[1]!.config).toMatchObject({ includeDefaultRoots: false, customSkillDirs: ['C:/private/home/skills', 'C:/private/agents/skills'], watch: false, watchFollowSymlinks: false, bundledSkillDir: 'C:/runtime/builtins' });
    expect(provider.config).toEqual({ watch: false });
  });
  it('uses native replacement semantics instead of an unsafe partial config merge', () => {
    const before = { insert: [{ id: 'fixture', config: { untouched: true } }] };
    expect(composeSkillRoutingEntries([[before], [{ id: 'fixture', config: { replacement: true } }]])).toEqual([{ id: 'fixture', config: { replacement: true } }]);
  });
});
describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('Official SDK private skill provider', () => {
  it('shows A-private skills only to A, B-private only to B, and ignores shared workspace skills using the real provider', async () => {
    const root = await temporaryRoot(); const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const nodeReceipt = await readFile(path.join(program, 'node-runtime.json'), 'utf8').then(value => JSON.parse(value) as { version: string }).catch(() => undefined);
    const version = nodeReceipt?.version ?? '0.2.0-rc.2';
    const a = path.join(root, 'instance-a'); const b = path.join(root, 'instance-b'); const workspace = path.join(root, 'shared', 'workspace');
    const skill = async (directory: string, name: string) => { const target = path.join(directory, name); await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: Native provider fixture\n---\nFixture content\n`); };
    await mkdir(a); await mkdir(b); await mkdir(workspace, { recursive: true }); await writeFile(path.join(workspace, 'package.json'), '{}');
    await skill(path.join(a, 'agents', 'skills'), 'only-a'); await skill(path.join(b, 'agents', 'skills'), 'only-b');
    await skill(path.join(workspace, '.agents', 'skills'), 'public-leak-agents'); await skill(path.join(workspace, '.dsh', 'skills'), 'public-leak-dsh');
    await skill(path.join(a, 'home', 'skills-disabled'), 'disabled-a');
    const patchesA = await buildPrivateSkillRouting(a, program, version); const patchesB = await buildPrivateSkillRouting(b, program, version);
    expect(patchesA.filter(patch => patch.name === '@deepseek-ai/dsh-agent-preset')).toHaveLength(3);
    const standard = (patches: typeof patchesA) => ((patches.find(patch => patch.id === 'preset-standard')!.config.plugins as Array<{ id: string; config: unknown }>).find(row => row.id === 'skill-filesystem')!.config);
    const input = path.join(root, 'input.json'); await writeFile(input, JSON.stringify({ configs: [standard(patchesA), standard(patchesB)], workspace, sdk: await runtimeSdkRoot(program) }));
    const script = path.join(root, 'provider-test.cjs'); await writeFile(script, `
const fs = require('node:fs/promises'); const path = require('node:path'); const { pathToFileURL } = require('node:url');
(async () => { const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
 const sdk = await import(pathToFileURL(path.join(input.sdk, '@deepseek-ai/dsh-skill-filesystem/lib/index.js')).href);
 const catalogs = []; for (const config of input.configs) { let provider; const abort = new AbortController();
  const ctx = { skills: { registerProvider: factory => { provider = factory({ signal: abort.signal, invalidate() {} }); } }, effect() {}, on() {}, get() {} };
  sdk.apply(ctx, { ...config, watch: false }); try { const result = await provider.list({ cwd: input.workspace });
   catalogs.push((Array.isArray(result) ? result : result.candidates).map(item => item.name)); } finally { await provider.dispose(); } }
 process.stdout.write(JSON.stringify(catalogs));
})().catch(() => { process.stderr.write('Native fixture failed'); process.exitCode = 1; });
`);
    const plan = canonicalRuntimeEntryPaths(program, nodeReceipt ? 'node-cli-web-v1' : 'desktop-cli-web-v1'); const child = spawn(plan.executable, ['--expose-internals', script, input], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' }, cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill(), 20_000);
    try { const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(stderr).toBe(''); expect(code).toBe(0); const result = JSON.parse(stdout) as string[][];
      expect(result[0]).toContain('only-a'); expect(result[0]).not.toContain('only-b'); expect(result[1]).toContain('only-b'); expect(result[1]).not.toContain('only-a');
      expect(result[0]).toContain('cordis-plugin-development'); expect(result[1]).toContain('cordis-plugin-development');
      expect(result.flat()).not.toContain('public-leak-agents'); expect(result.flat()).not.toContain('public-leak-dsh'); expect(result.flat()).not.toContain('disabled-a');
      expect(JSON.stringify(await readFile(input, 'utf8'))).not.toContain('public-leak');
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill(); }
  }, 30_000);
});
