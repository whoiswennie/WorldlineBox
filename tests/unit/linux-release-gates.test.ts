import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import forgeConfig from '../../forge.config';

const projectRoot = path.resolve(import.meta.dirname, '../..');

it.each(['acquire', 'ensure'])('keeps unpromoted Linux arm64 media blocked during %s even in a local trial', (command) => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linux-media-gate-'));
  try {
    const mediaRoot = path.join(root, 'media-binaries');
    mkdirSync(mediaRoot);
    const sourceLock = readFileSync(path.join(projectRoot, 'resources/media-binaries/source-lock.json'), 'utf8');
    writeFileSync(path.join(mediaRoot, 'source-lock.json'), sourceLock);
    writeFileSync(path.join(mediaRoot, 'bundle-lock.json'), JSON.stringify({
      schemaVersion: 1,
      bundles: { 'linux-arm64': { status: 'build-required', reason: 'Native arm64 bundle not promoted.' } },
    }));
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, 'scripts/media-binaries.mjs'), command,
      '--platform', 'linux-arm64', '--root', root,
      '--archive', path.join(root, 'must-not-read-untrusted.zip'),
    ], {
      cwd: projectRoot, encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, WORLDLINEBOX_MEDIA_AUTO_ACQUIRE: '1', WORLDLINEBOX_MEDIA_SKIP_PROVENANCE: '1' },
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Media bundle linux-arm64 is blocked: Native arm64 bundle not promoted.');
    expect(result.stderr).not.toContain('must-not-read-untrusted.zip');
    expect(readdirSync(mediaRoot).sort()).toEqual(['bundle-lock.json', 'source-lock.json']);
    expect(readdirSync(root)).toEqual(['media-binaries']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects cross-architecture Linux packaging before starting native media tools', async () => {
  const targetArch = process.platform === 'linux' && process.arch === 'arm64' ? 'x64' : 'arm64';
  const prePackage = forgeConfig.hooks?.prePackage as unknown as
    (config: unknown, platform: string, arch: string) => Promise<void>;
  expect(prePackage).toBeTypeOf('function');
  await expect(prePackage({}, 'linux', targetArch)).rejects.toThrow(
    `WorldlineBox release packages must be built and media-verified natively; host=${process.platform}-${process.arch}, target=linux-${targetArch}.`,
  );
});
