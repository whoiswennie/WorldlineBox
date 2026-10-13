import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { dependencyLockSha256 } from '../../src/main/dsh/node-runtime-service';
import { prepareNodeRuntimeLockInstall, validatePortableNodeRuntimeLock } from '../../src/main/dsh/node-runtime-lock';
import { removeManaged } from '../../src/main/dsh/files';
import type { DshNodePackRuntimeLock } from '../../src/shared/dsh-pack-runtime';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-node-lock-test-')); roots.push(root);
  const nodeExecutable = path.join(root, 'node.exe'); const tarball = path.join(root, 'official-dsh.tgz'); await writeFile(nodeExecutable, 'fixture-node'); await writeFile(tarball, 'fixture-tarball');
  const sourceSha256 = createHash('sha256').update('fixture-tarball').digest('hex'); const nodeExecutableSha256 = createHash('sha256').update('fixture-node').digest('hex');
  const sri = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  const raw = { name: 'worldlinebox-dsh-runtime', lockfileVersion: 3, packages: {
    '': { version: '1.0.0', dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } },
    'node_modules/@deepseek-ai/dsh': { version: '0.2.0-rc.2', integrity: sri, resolved: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz' },
    'node_modules/example': { version: '1.2.3', integrity: sri, resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz' },
  } };
  const lockFile = path.join(root, 'package-lock.json'); await writeFile(lockFile, JSON.stringify(raw));
  const lock: DshNodePackRuntimeLock = { version: '0.2.0-rc.2', platform: 'win32-x64', adapter: 'node-cli-web-v1', contentSha256: 'a'.repeat(64),
    sourceSha256, npmIntegrity: sri, dependencyLockSha256: await dependencyLockSha256(root), nodeVersion: '22.19.0', npmVersion: '10.9.3', nodeExecutableSha256, payloadSha256: 'f'.repeat(64) };
  const tools = { nodeExecutable, npmCli: path.join(root, 'npm-cli.js'), nodeVersion: lock.nodeVersion, npmVersion: lock.npmVersion };
  const release = { version: lock.version, integrity: lock.npmIntegrity, tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz' };
  return { root, lock, raw, lockFile, tools, release, tarball, sourceSha256 };
}
describe('Portable official runtime lock replay', () => {
  it('retains exact dependency versions and integrities, redirects registry bytes through the selected mirror and uses the verified primary tarball', async () => {
    const test = await fixture(); const installationDirectory = path.join(test.root, 'install');
    const args = await prepareNodeRuntimeLockInstall({ ...test, installationDirectory, registry: 'https://registry.npmmirror.com' });
    expect(args[0]).toBe('ci'); expect(args).not.toContain('install');
    const raw = JSON.parse(await readFile(path.join(installationDirectory, 'package-lock.json'), 'utf8')) as typeof test.raw;
    expect(raw.packages['node_modules/example']).toEqual({ ...test.raw.packages['node_modules/example'], resolved: 'https://registry.npmmirror.com/example/-/example-1.2.3.tgz' });
    expect(raw.packages['node_modules/@deepseek-ai/dsh'].resolved).toBe('file:../official-dsh.tgz');
    expect(raw.packages[''].dependencies['@deepseek-ai/dsh']).toBe('file:../official-dsh.tgz');
    // The existing installation finisher restores the primary registry coordinate before sealing.
    raw.packages[''].dependencies['@deepseek-ai/dsh'] = test.lock.version; await writeFile(path.join(installationDirectory, 'package-lock.json'), JSON.stringify(raw));
    expect(await dependencyLockSha256(installationDirectory)).toBe(test.lock.dependencyLockSha256);
  });
  it('refuses version-only matching, incompatible interpreter bytes and changed transitive graph', async () => {
    const test = await fixture(); const input = { ...test, installationDirectory: path.join(test.root, 'install'), registry: 'https://registry.npmjs.org' };
    await expect(prepareNodeRuntimeLockInstall({ ...input, tools: { ...test.tools, nodeVersion: '24.15.0' } })).rejects.toThrow('Node and npm versions');
    await writeFile(test.tools.nodeExecutable, 'changed-node'); await expect(prepareNodeRuntimeLockInstall(input)).rejects.toThrow('SHA-256');
    test.raw.packages['node_modules/example'].version = '1.2.4'; test.raw.packages['node_modules/example'].resolved = 'https://registry.npmjs.org/example/-/example-1.2.4.tgz';
    await writeFile(test.lockFile, JSON.stringify(test.raw)); await expect(validatePortableNodeRuntimeLock(test.lock, test.lockFile)).rejects.toThrow('graph differs');
  });
  it('refuses linked/local dependency resolutions and URLs with credentials before writing installation files', async () => {
    for (const resolved of ['file:../../foreign', 'git+https://github.com/acme/repo', 'https://user:secret@registry.npmjs.org/example/-/example-1.2.3.tgz']) {
      const test = await fixture(); test.raw.packages['node_modules/example'].resolved = resolved; await writeFile(test.lockFile, JSON.stringify(test.raw));
      await expect(validatePortableNodeRuntimeLock(test.lock, test.lockFile)).rejects.toThrow();
    }
    const test = await fixture(); const installationDirectory = path.join(test.root, 'install'); await mkdir(installationDirectory); await writeFile(path.join(installationDirectory, 'package.json'), 'retained');
    await expect(prepareNodeRuntimeLockInstall({ ...test, installationDirectory, registry: 'https://registry.npmjs.org' })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(installationDirectory, 'package.json'), 'utf8')).toBe('retained');
  });
});
