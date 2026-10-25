import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dependencyLockSha256 } from '../../src/main/dsh/node-runtime-service';

/** Inspectable Node/Web package fixture. Its executable is never executed. */
export async function writeNativeRuntimeFixture(program: string, version = '0.2.1-rc.2') {
  const put = async (relative: string, value: string) => { const file = path.join(program, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const integrity = 'sha512-' + createHash('sha512').update(version).digest('base64');
  await put('bin/node.exe', 'fixture executable');
  for (const name of ['dsh', 'dsh-base', 'dsh-web-app', 'dsh-headless']) {
    const manifest = { name: '@deepseek-ai/' + name, version, ...(name === 'dsh' ? { bin: { dsh: 'lib/bin.js' }, repository: { url: 'git+https://github.com/deepseek-ai/deepseek-harness.git' },
      dependencies: Object.fromEntries(['dsh-base', 'dsh-web-app', 'dsh-headless'].map(name => ['@deepseek-ai/' + name, version])) } : {}) };
    await put(`dsh/node_modules/@deepseek-ai/${name}/package.json`, JSON.stringify(manifest));
  }
  await put('dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '// fixture');
  await put('dsh/package.json', JSON.stringify({ dependencies: { '@deepseek-ai/dsh': version } }));
  const tarball = `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`;
  await put('dsh/package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@deepseek-ai/dsh': version } },
    'node_modules/@deepseek-ai/dsh': { version, integrity, resolved: tarball } } }));
  const receipt = { format: 'worldlinebox-dsh-node-runtime-v1', version, nodeVersion: '24.15.0', npmVersion: '11.12.1',
    package: '@deepseek-ai/dsh', repository: 'https://github.com/deepseek-ai/deepseek-harness', tarball, integrity, npmIntegrity: integrity,
    dependencyLockSha256: await dependencyLockSha256(path.join(program, 'dsh')), nodeExecutableSha256: hash('fixture executable'),
    sourceSha256: hash(version), executable: 'bin/node.exe', cli: 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' };
  await put('node-runtime.json', JSON.stringify(receipt)); return receipt;
}
