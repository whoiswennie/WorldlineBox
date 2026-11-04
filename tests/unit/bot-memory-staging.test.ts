import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { verifyBotMemoryDependencyClosure, verifyBotMemory } = await import(pathToFileURL(path.resolve('scripts/bot-memory-runtime-lib.mjs')).href) as {
  verifyBotMemoryDependencyClosure(input: { packageRoot: string; platform?: string; arch?: string }): Promise<{ packages: number; skipped: number }>;
  verifyBotMemory(input: { packageRoot: string; projectRoot: string; nodePath: string; compareSource?: boolean }): Promise<unknown>;
};
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-memory-stage-')); roots.push(root);
  const json = async (file: string, value: object) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), JSON.stringify(value)); };
  await json('package.json', { name: 'stage-fixture', dependencies: { fixture: '1.0.0' } });
  await json('package-lock.json', { lockfileVersion: 3, packages: {
    '': { dependencies: { fixture: '1.0.0' } },
    'node_modules/fixture': { version: '1.0.0', dependencies: { child: '^2.0.0' } },
    'node_modules/child': { version: '2.0.1' },
    'node_modules/other-platform': { version: '1.0.0', optional: true, os: ['!win32'] },
    'node_modules/dev-only': { version: '1.0.0', dev: true },
  } });
  await json('node_modules/fixture/package.json', { name: 'fixture', version: '1.0.0', main: 'index.cjs', dependencies: { child: '^2.0.0' } });
  await writeFile(path.join(root, 'node_modules/fixture/index.cjs'), 'module.exports = {};');
  await json('node_modules/child/package.json', { name: 'child', version: '2.0.1' });
  return { root, json, verify: () => verifyBotMemoryDependencyClosure({ packageRoot: root, platform: 'win32', arch: 'x64' }) };
}
it('checks exact production closure and skips other-platform optional binaries and dev-only entries', async () => {
  const f = await fixture(); await expect(f.verify()).resolves.toMatchObject({ packages: 2, skipped: 2 });
});
it('rejects a missing transitive dependency instead of reusing an incomplete release', async () => {
  const f = await fixture(); await rm(path.join(f.root, 'node_modules/child'), { recursive: true });
  await expect(f.verify()).rejects.toThrow('dependency missing or unsafe: node_modules/child');
});
it('rejects an installed version that differs from the immutable lock', async () => {
  const f = await fixture(); await f.json('node_modules/child/package.json', { name: 'child', version: '2.0.2' });
  await expect(f.verify()).rejects.toThrow('differs from lock: node_modules/child');
});
it('rejects changed dependency edges and a missing declared runtime entry point', async () => {
  const f = await fixture(); await f.json('node_modules/fixture/package.json', { name: 'fixture', version: '1.0.0', main: 'missing.cjs', dependencies: { child: '^3.0.0' } });
  await expect(f.verify()).rejects.toThrow('dependency edges differ from lock');
  await f.json('node_modules/fixture/package.json', { name: 'fixture', version: '1.0.0', main: 'missing.cjs', dependencies: { child: '^2.0.0' } });
  await rm(path.join(f.root, 'node_modules/fixture/index.cjs'));
  await expect(f.verify()).rejects.toThrow('dependency entry point is missing: fixture');
});
it('rejects Node25 integration metadata before attempting any native runtime', async () => {
  const f = await fixture();
  await f.json('worldlinebox-integration-manifest.json', { schema: 1, module: 'vcp-memory', files: [], runtime: { version: 'v25.0.0', abi: '141' } });
  await expect(verifyBotMemory({ packageRoot: f.root, projectRoot: process.cwd(), nodePath: process.execPath, compareSource: false })).rejects.toThrow('managed Node 24 runtime');
});
