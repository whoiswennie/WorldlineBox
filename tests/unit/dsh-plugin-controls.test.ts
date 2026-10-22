import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import { PluginControls } from '../../src/main/dsh/plugin-controls';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-plugin-controls-')); roots.push(rootPath);
  const program = path.join(rootPath, 'program'); const directory = path.join(rootPath, 'instances', 'instance-a'); const homePath = path.join(directory, 'home');
  await mkdir(program); await writeFile(path.join(program, 'node-runtime.json'), '{}');
  const put = async (file: string, value: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  for (const name of ['dsh-base', 'dsh-web-app']) await put(path.join(program, 'dsh', 'node_modules', '@deepseek-ai', name, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version: '0.2.0-rc.2', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  const manifest = { name: 'private-profile', private: true, privateFixture: { retained: true }, dependencies: { '@acme/fixture': '1.2.3', ordinary: '2.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@acme/fixture'], extra: 'retained' }, privateOther: true } };
  const file = path.join(homePath, 'profiles', 'web', 'package.json'); await put(file, JSON.stringify(manifest));
  const patch = path.join(homePath, 'profiles', 'web', 'cordis.patch.yml'); await put(patch, '- id: fixture\n  config:\n    privateOption: retained\n');
  await put(path.join(homePath, 'profiles', 'web', 'node_modules', '@acme/fixture', 'package.json'), JSON.stringify({ name: '@acme/fixture', version: '1.2.3', description: 'Fixture bundle', repository: { url: 'git+https://github.com/acme/fixture.git' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await put(path.join(homePath, 'profiles', 'web', 'node_modules', '@acme/fixture', 'cordis.patch.yml'), '- insert: []\n');
  await put(path.join(homePath, 'profiles', 'web', 'node_modules', 'ordinary', 'package.json'), JSON.stringify({ name: 'ordinary', version: '2.0.0' }));
  const instance: DshInstance = { id: 'instance-a', name: 'Fixture', runtimeId: 'runtime-a', profile: 'web', status: 'stopped', createdAt: '', updatedAt: '',
    homePath, agentsPath: path.join(directory, 'agents'), workspacePath: path.join(directory, 'workspace'), browserPartition: 'persist:fixture', isDefault: false };
  const controls = new PluginControls({ rootPath, runtimeDirectory: () => program });
  return { rootPath, program, controls, instance, file, patch, manifest };
}
describe('Native private plugin bundle controls', () => {
  it('distinguishes instance installations from immutable runtime bundles and exposes their exact locations', async () => {
    const test = await fixture(); const plugins = await test.controls.listPlugins(test.instance);
    expect(plugins.find(item => item.name === '@acme/fixture')).toMatchObject({ scope: 'instance', version: '1.2.3',
      installPath: path.join(test.instance.homePath, 'profiles', 'web', 'node_modules', '@acme', 'fixture'), sourceUrl: 'https://github.com/acme/fixture' });
    expect(plugins.find(item => item.name === '@deepseek-ai/dsh-base')).toMatchObject({ scope: 'runtime', version: '0.2.0-rc.2',
      installPath: path.join(test.program, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-base') });
  });
  it('reports the native installation-first bundle version when a private package has the same name', async () => {
    const test = await fixture(); const duplicate = path.join(test.instance.homePath, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-base');
    await mkdir(duplicate, { recursive: true }); await writeFile(path.join(duplicate, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '99.0.0' }));
    expect((await test.controls.listPlugins(test.instance)).find(item => item.name === '@deepseek-ai/dsh-base')).toMatchObject({ scope: 'runtime', version: '0.2.0-rc.2' });
  });
  it('lists native activation and toggles only the selected bundle without rewriting its settings', async () => {
    const test = await fixture(); expect(await test.controls.listPlugins(test.instance)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '@acme/fixture', enabled: true, core: false, bundle: true, sourceUrl: 'https://github.com/acme/fixture' }),
      expect.objectContaining({ name: '@deepseek-ai/dsh-base', enabled: true, core: true }),
      expect.objectContaining({ name: 'ordinary', enabled: false, bundle: false }),
    ]));
    const before = await readFile(test.patch, 'utf8'); await test.controls.setPluginEnabled(test.instance, '@acme/fixture', false);
    const disabled = JSON.parse(await readFile(test.file, 'utf8')) as typeof test.manifest;
    expect(disabled).toEqual({ ...test.manifest, dsh: { ...test.manifest.dsh, profile: { ...test.manifest.dsh.profile, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } });
    expect(await readFile(test.patch, 'utf8')).toBe(before); await test.controls.setPluginEnabled(test.instance, '@acme/fixture', true);
    expect(JSON.parse(await readFile(test.file, 'utf8'))).toEqual(test.manifest);
  });
  it('protects required bundles, rejects non-bundle activation and renderer paths outside the private profile', async () => {
    const test = await fixture(); await expect(test.controls.setPluginEnabled(test.instance, '@deepseek-ai/dsh-base', false)).rejects.toThrow('required official');
    await expect(test.controls.setPluginEnabled(test.instance, 'ordinary', true)).rejects.toThrow('does not declare');
    await expect(test.controls.listPlugins({ ...test.instance, homePath: path.join(test.rootPath, 'foreign') })).rejects.toThrow('private profile');
    await expect(test.controls.setPluginEnabled({ ...test.instance, status: 'running' }, '@acme/fixture', false)).rejects.toThrow('Stop this DSH');
    expect(JSON.parse(await readFile(test.file, 'utf8'))).toEqual(test.manifest);
  });
});
