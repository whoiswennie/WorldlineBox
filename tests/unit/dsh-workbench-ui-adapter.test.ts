import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareWorkbenchUiAdapter } from '../../src/main/dsh/workbench-ui-adapter';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-ui-adapter-')) throw Error('Unexpected test directory.'); await rm(root, { recursive: true, force: true }); } });
async function setup(source = 'const explicit = false; const finishCredential = (changed) => { if (!changed) { complete(); return; } controller.load(); }') {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-ui-adapter-')); roots.push(root);
  const program = path.join(root, 'program'); const instance = path.join(root, 'instance'); await mkdir(instance);
  const file = path.join(program, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(path.join(program, 'node-runtime.json'), '{}'); await writeFile(file, source);
  return { root, program, instance, file };
}
it('uses the native slot extension only for the observed incomplete flow, without changing sealed SDK files', async () => {
  const { program, instance, file } = await setup(); const before = await readFile(file);
  const routing = await prepareWorkbenchUiAdapter(instance, program); expect(routing).toBeTruthy(); expect(await readFile(file)).toEqual(before);
  expect(JSON.parse(await readFile(routing!, 'utf8'))).toEqual([{ insert: [{ id: 'worldlinebox-auth-completion', name: '@worldlinebox/dsh-auth-completion' }] }]);
  await expect(prepareWorkbenchUiAdapter(instance, program)).resolves.toBe(routing);
});
it('does not install an adapter for implementations whose completion is already fixed', async () => {
  const { program, instance } = await setup('const explicit = false; const finishCredential = () => complete();');
  await expect(prepareWorkbenchUiAdapter(instance, program)).resolves.toBeUndefined();
});
it('preserves a colliding private plugin and refuses linked ancestor directories', async () => {
  const { root, program, instance } = await setup();
  const plugin = path.join(instance, 'home/profiles/web/node_modules/@worldlinebox/dsh-auth-completion'); await mkdir(plugin, { recursive: true });
  await writeFile(path.join(plugin, 'package.json'), '{"name":"a-private-plugin"}');
  await expect(prepareWorkbenchUiAdapter(instance, program)).rejects.toThrow('preserved'); expect(await readFile(path.join(plugin, 'package.json'), 'utf8')).toContain('a-private-plugin');
  const other = path.join(root, 'other'); await mkdir(other); const linkedInstance = path.join(root, 'linked'); await mkdir(linkedInstance);
  await symlink(other, path.join(linkedInstance, 'home'), 'junction');
  await expect(prepareWorkbenchUiAdapter(linkedInstance, program)).rejects.toThrow();
  await expect(readFile(path.join(other, 'profiles/web/node_modules/@worldlinebox/dsh-auth-completion/package.json'))).rejects.toThrow();
});
