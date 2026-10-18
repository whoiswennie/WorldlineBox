#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import {
  collectMakeArtifacts,
  currentVersion,
  releasePlatformKey,
  repoRoot,
  resolvePackagedExecutable,
  runNpmScript,
  writeChecksumManifest,
} from './lib.mjs';
import { currentPlatformKey } from '../media-binaries-lib.mjs';

const PHASES = ['verify', 'media', 'package', 'e2e', 'make', 'checksums', 'all'];

/** @type {Record<string, string>} */
const pipelineEnv = {};

function printUsage() {
  process.stdout.write(
    [
      'Usage: npm run release:<phase>',
      '',
      'Phases:',
      '  verify     rebuild:native + verify:mainline (same gates as CI)',
      '  media      media:acquire + media:verify (or local build with --build-media-locally)',
      '  package    package + verify:package',
      '  e2e        test:e2e:packaged against the packaged app',
      '  make       electron-forge make (macOS/Windows) or AppImage (Linux)',
      '  checksums  SHA-256 manifests for out/make artifacts',
      '  all        run every phase in order (release:local)',
      '',
      'Flags (release:local only):',
      '  --skip-verify           skip rebuild + mainline verification',
      '  --skip-media            skip media acquire/build',
      '  --skip-e2e              skip packaged startup E2E',
      '  --build-media-locally   build media via scripts/media-build/* on this machine',
      '                          (dev trial only; skips HTTPS bundle-lock provenance)',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith('--')) {
      flags.add(arg);
      continue;
    }
    positional.push(arg);
  }

  return { flags, phase: positional[0] ?? 'all' };
}

function runReleaseScript(scriptName, extraEnv = {}) {
  runNpmScript(scriptName, extraEnv, pipelineEnv);
}

function assertMediaBundleReady() {
  const lockPath = path.join(repoRoot, 'resources/media-binaries/bundle-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const platform = currentPlatformKey();
  const entry = lock.bundles?.[platform];

  if (!entry || entry.status === 'build-required') {
    const reason = entry?.reason ?? 'bundle-lock has no ready entry for this platform.';
    const buildScript = platform === 'darwin-arm64'
      ? 'scripts/media-build/darwin-arm64.sh'
      : platform === 'linux-x64'
        ? 'scripts/media-build/linux-x64.sh'
        : 'scripts/media-build/win32-x64.ps1';

    console.error(
      [
        '',
        `[release:media] Blocked: ${platform} is still build-required.`,
        reason,
        '',
        'What "晋升" means:',
        '- bundle-lock.json still says build-required: no trusted HTTPS download URL exists yet.',
        '- "晋升" promotes the built ZIP + manifest hashes into bundle-lock as status=ready.',
        '- After promotion, release:media downloads that immutable bundle (media:acquire).',
        '',
        'For a local end-to-end trial without promotion, re-run with:',
        '  npm run release:local -- --skip-verify --build-media-locally',
        '',
        'Production release steps:',
        `1. Build locally: ${buildScript}`,
        '   or trigger the "Media binary bundles" GitHub workflow.',
        '2. Promote the immutable bundle URL and checksums into',
        '   resources/media-binaries/bundle-lock.json.',
        '3. Re-run: npm run release:media',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

function phaseMediaBuildLocally() {
  const platform = currentPlatformKey();
  const buildCommand = platform === 'darwin-arm64'
    ? { command: 'bash', args: ['scripts/media-build/darwin-arm64.sh'] }
    : platform === 'linux-x64'
      ? { command: 'bash', args: ['scripts/media-build/linux-x64.sh'] }
      : { command: 'pwsh', args: ['-File', 'scripts/media-build/win32-x64.ps1'] };

  process.stdout.write(
    `\n[release:media] Building ${platform} media bundle locally (this can take 1-3+ hours)...\n`,
  );
  const result = spawnSync(buildCommand.command, buildCommand.args, {
    cwd: repoRoot,
    env: { ...process.env, ...pipelineEnv },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  pipelineEnv.WORLDLINEBOX_MEDIA_SKIP_PROVENANCE = '1';
  process.env.WORLDLINEBOX_MEDIA_SKIP_PROVENANCE = '1';
  runReleaseScript('media:verify');
}

function phaseVerify() {
  runReleaseScript('rebuild:native');
  runReleaseScript('verify:mainline');
}

function phaseMedia({ buildMediaLocally }) {
  // linux-arm64 has no pinned bundle. linux-x64 acquires the same release as
  // macOS/Windows (or builds it with --build-media-locally).
  if (process.platform === 'linux' && process.arch !== 'x64') {
    console.warn(
      '[release:media] Skipping media acquire/verify on linux-arm64 (no pinned media bundle).',
    );
    return;
  }

  if (buildMediaLocally) {
    phaseMediaBuildLocally();
    return;
  }

  assertMediaBundleReady();
  runReleaseScript('media:acquire');
  runReleaseScript('media:verify');
}

function phasePackage() {
  runReleaseScript('package');
  // linux-x64 verifies the pinned media bundle; linux-arm64 still skips it.
  runReleaseScript('verify:package');
}

function phaseE2E() {
  const executable = resolvePackagedExecutable();
  runReleaseScript('test:e2e:packaged', {
    WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE: executable,
  });
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], {
    cwd: repoRoot,
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

/**
 * AppImage maker writes WorldlineBox-<ver>-x86_64.AppImage; release uploads use the
 * same naming contract as macOS/Windows: WorldlineBox-linux-x86-64-<ver>.AppImage.
 */
function finalizeLinuxAppImageArtifact() {
  const version = currentVersion();
  const archLabel = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const releaseArch = process.arch === 'arm64' ? 'arm64' : 'x86-64';
  const appimageDir = path.join(repoRoot, 'out', 'make', 'appimage');
  const produced = path.join(appimageDir, `WorldlineBox-${version}-${archLabel}.AppImage`);
  const canonical = path.join(appimageDir, `WorldlineBox-linux-${releaseArch}-${version}.AppImage`);
  if (!existsSync(produced)) {
    console.error(`[release:make] Expected AppImage at ${produced}`);
    process.exit(1);
  }
  if (produced !== canonical) {
    renameSync(produced, canonical);
    console.log(`[release:make] Renamed AppImage → ${path.relative(repoRoot, canonical)}`);
  }
  return canonical;
}

function phaseMake() {
  if (process.platform === 'linux') {
    // Prefer the Ubuntu 22.04 / glibc 2.35 docker baseline for release builds.
    if (dockerAvailable()) {
      runReleaseScript('make:appimage:docker');
    } else {
      console.warn(
        '[release:make] docker unavailable; building AppImage on the host (make:appimage).',
      );
      runReleaseScript('make:appimage');
    }
    finalizeLinuxAppImageArtifact();
    return;
  }

  runReleaseScript('make');
  // Windows 安装器（Inno Setup）在 Windows 原生环境构建；
  // macOS 不产安装器（dmg 已由 make 产出）。
  if (process.platform === 'win32') {
    runReleaseScript('make:inno');
  }
}

function phaseChecksums() {
  const artifacts = collectMakeArtifacts();
  if (artifacts.length === 0) {
    console.error('[release:checksums] No artifacts found under out/make/. Did make succeed?');
    process.exit(1);
  }

  const manifestPath = path.join(
    repoRoot,
    'out',
    'make',
    `SHA256SUMS-${releasePlatformKey()}.txt`,
  );
  writeChecksumManifest(artifacts, manifestPath);

  for (const artifact of artifacts) {
    writeChecksumManifest([artifact], `${artifact}.sha256`);
  }
}

function main() {
  const { flags, phase } = parseArgs(process.argv.slice(2));

  if (!PHASES.includes(phase)) {
    console.error(`Unknown phase ${JSON.stringify(phase)}. Expected one of: ${PHASES.join(', ')}`);
    printUsage();
    process.exit(2);
  }

  // Every release phase runs against an explicit semver from package.json;
  // bump with `npm version patch|minor|major` before releasing.
  console.log(`[release] WorldlineBox v${currentVersion()} on ${releasePlatformKey()}`);

  const options = {
    skipVerify: flags.has('--skip-verify'),
    skipMedia: flags.has('--skip-media'),
    skipE2E: flags.has('--skip-e2e'),
    buildMediaLocally: flags.has('--build-media-locally'),
  };

  const sequence = phase === 'all'
    ? ['verify', 'media', 'package', 'e2e', 'make', 'checksums']
    : [phase];

  for (const step of sequence) {
    if (options.skipVerify && step === 'verify') {
      console.warn('[release] Skipping verify (--skip-verify).');
      continue;
    }
    if (options.skipMedia && step === 'media') {
      console.warn(
        '[release] Skipping media (--skip-media). package/make will still require verified media.',
      );
      continue;
    }
    if (options.skipE2E && step === 'e2e') {
      console.warn('[release] Skipping packaged E2E (--skip-e2e).');
      continue;
    }

    process.stdout.write(`\n========== release:${step} ==========\n`);
    if (step === 'media') {
      phaseMedia(options);
      continue;
    }

    const runners = {
      verify: phaseVerify,
      package: phasePackage,
      e2e: phaseE2E,
      make: phaseMake,
      checksums: phaseChecksums,
    };
    runners[step]();
  }

  console.log(`\n[release] Phase ${phase} completed successfully.`);
}

main();
