import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import AdmZip from 'adm-zip';
import { brandWindowsDiagnosticPaths } from './media-branding.mjs';

import {
  assertPlatform,
  currentPlatformKey,
  generateManifest,
  readJson,
  sourceLockForPlatform,
  sha256File,
  verifyBundle,
  verifyReleaseProvenance,
  writeAcquisitionReceipt,
} from './media-binaries-lib.mjs';

function argumentsMap(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    result.set(key.slice(2), value);
    index += 1;
  }
  return result;
}

function option(options, name, fallback) {
  return options.get(name) ?? fallback;
}

function safeZipPath(entryName) {
  const normalizedInput = entryName.replaceAll('\\', '/');
  const normalized = path.posix.normalize(normalizedInput);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`Media bundle contains unsafe ZIP path: ${entryName}`);
  }
  return normalized;
}

function extractZipSafely(archiveBuffer, destination) {
  const zip = new AdmZip(archiveBuffer);
  const entries = zip.getEntries();
  if (entries.length > 10_000) throw new Error('Media bundle has too many ZIP entries.');
  let totalSize = 0;
  for (const entry of entries) {
    const relativePath = safeZipPath(entry.entryName);
    const unixMode = (entry.header.attr >>> 16) & 0xffff;
    if ((unixMode & 0o170000) === 0o120000) {
      throw new Error(`Media bundle contains forbidden symbolic link: ${entry.entryName}`);
    }
    if (entry.isDirectory) {
      mkdirSync(path.join(destination, relativePath), { recursive: true });
      continue;
    }
    totalSize += entry.header.size;
    if (totalSize > 1024 * 1024 * 1024) {
      throw new Error('Media bundle expands beyond the 1 GiB safety limit.');
    }
    const outputPath = path.join(destination, relativePath);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, entry.getData(), { mode: unixMode || 0o644 });
    if (process.platform !== 'win32' && unixMode) chmodSync(outputPath, unixMode & 0o777);
  }
}

async function acquire({ platform, root, lockPath, archivePath }) {
  const lock = readJson(lockPath);
  const bundle = lock.bundles?.[platform];
  if (!bundle) throw new Error(`bundle-lock.json has no ${platform} entry.`);
  if (
    bundle.status !== 'ready' ||
    !bundle.url ||
    !/^[a-f0-9]{64}$/.test(bundle.sha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(bundle.manifestSha256 ?? '')
  ) {
    throw new Error(
      `Media bundle ${platform} is blocked: ${bundle.reason ?? 'trusted URL/SHA-256 is not available'}`,
    );
  }
  if (!bundle.url.startsWith('https://')) {
    throw new Error(`Media bundle ${platform} URL must use HTTPS.`);
  }

  let downloadUrl = bundle.url;
  // A numeric upstream release identity survives repository/product renames.
  // Keep the archive and manifest hashes pinned independently of its name.
  if (!archivePath && /^https:\/\/api\.github\.com\/repositories\/\d+\/releases\/\d+$/.test(downloadUrl)) {
    const releaseResponse = await fetch(downloadUrl, { headers: { Accept: 'application/vnd.github+json' } });
    if (!releaseResponse.ok) throw new Error(`Media release lookup failed with HTTP ${releaseResponse.status}; use --archive with the checksum-pinned ZIP for offline acquisition.`);
    const release = await releaseResponse.json();
    const asset = release.assets?.find((item) => typeof item.name === 'string' && item.name.endsWith(`media-${platform}.zip`));
    if (!asset?.browser_download_url?.startsWith('https://github.com/')) throw new Error(`Media release has no trusted ${platform} ZIP asset.`);
    downloadUrl = asset.browser_download_url;
  }
  const response = archivePath ? null : await fetch(downloadUrl, { redirect: 'follow' });
  if (response) {
    if (!response.ok) {
      throw new Error(`Media bundle download failed with HTTP ${response.status}.`);
    }
    if (!response.url.startsWith('https://')) {
      throw new Error(`Media bundle ${platform} download redirected away from HTTPS.`);
    }
    const declaredSize = Number(response.headers.get('content-length') ?? 0);
    if (declaredSize > 1024 * 1024 * 1024) {
      throw new Error('Media bundle download exceeds the 1 GiB safety limit.');
    }
  }
  const archiveBuffer = archivePath ? readFileSync(archivePath) : Buffer.from(await response.arrayBuffer());
  if (archiveBuffer.length > 1024 * 1024 * 1024) {
    throw new Error('Media bundle download exceeds the 1 GiB safety limit.');
  }
  const actualHash = createHash('sha256').update(archiveBuffer).digest('hex');
  if (actualHash !== bundle.sha256) {
    throw new Error(`Media bundle ${platform} archive SHA-256 mismatch.`);
  }

  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-media-'));
  try {
    extractZipSafely(archiveBuffer, temporaryRoot);
    verifyBundle({ root: temporaryRoot, platform });
    const localSourceLock = JSON.stringify(
      sourceLockForPlatform(readJson(path.join(root, 'media-binaries', 'source-lock.json')), platform),
    );
    const archiveSourceLock = JSON.stringify(
      sourceLockForPlatform(readJson(path.join(temporaryRoot, 'media-binaries', 'source-lock.json')), platform),
    );
    if (archiveSourceLock !== localSourceLock) {
      throw new Error(
        'Media bundle source-lock.json does not match this checkout; update trust metadata separately.',
      );
    }
    const archiveManifestPath = path.join(
      temporaryRoot,
      'media-binaries',
      platform,
      'manifest.json',
    );
    const archiveManifestSha256 = sha256File(archiveManifestPath);
    if (archiveManifestSha256 !== (bundle.upstreamManifestSha256 ?? bundle.manifestSha256)) {
      throw new Error(
        `Media bundle ${platform} manifest SHA-256 does not match bundle-lock.json.`,
      );
    }

    if (['worldlinebox-v1', 'worldlinebox-v2'].includes(bundle.brandingTransform)) {
      const noticeRelativePath = `media-binaries/${platform}/licenses/Build-Dependency-NOTICES.txt`;
      const noticePath = path.join(temporaryRoot, noticeRelativePath);
      const originalNotice = readFileSync(noticePath, 'utf8');
      const brandedNotice = originalNotice
        .replace(/^.+ media runtime dependency notices/m, 'WorldlineBox media runtime dependency notices')
        .replace(/^target triplet: .+-(x64-windows-static|arm64-osx-static)(\r?)$/m, 'target triplet: worldlinebox-$1$2');
      writeFileSync(noticePath, brandedNotice, 'utf8');
      const manifest = readJson(archiveManifestPath);
      const noticeEntry = manifest.files.find((file) => file.path === noticeRelativePath);
      if (!noticeEntry) throw new Error('Media manifest is missing build dependency notices.');
      noticeEntry.sha256 = sha256File(noticePath);
      if (bundle.brandingTransform === 'worldlinebox-v2' && platform === 'win32-x64') {
        const toolPath = path.join(temporaryRoot, 'oiio', platform, 'oiiotool.exe');
        writeFileSync(toolPath, brandWindowsDiagnosticPaths(readFileSync(toolPath)));
        const toolEntry = manifest.files.find((file) => file.path === `oiio/${platform}/oiiotool.exe`);
        if (!toolEntry) throw new Error('Media manifest is missing the image tool.');
        toolEntry.sha256 = sha256File(toolPath);
      }
      writeFileSync(archiveManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    if (sha256File(archiveManifestPath) !== bundle.manifestSha256) {
      throw new Error('Branded media manifest SHA-256 does not match bundle-lock.json.');
    }

    const names = [
      path.join('ffmpeg', platform),
      path.join('oiio', platform),
      path.join('media-binaries', platform),
    ];
    for (const relativePath of names) {
      const destination = path.join(root, relativePath);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(temporaryRoot, relativePath), destination, {
        recursive: true,
        dereference: false,
      });
    }
    writeAcquisitionReceipt({
      root,
      platform,
      archiveSha256: bundle.sha256,
      manifestSha256: bundle.manifestSha256,
      url: bundle.url,
    });
    verifyBundle({ root, platform });
    verifyReleaseProvenance({ root, platform, lockPath });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function ensure({ platform, root, lockPath, archivePath }) {
  try {
    const { manifestPath } = verifyBundle({ root, platform });
    if (process.env.WORLDLINEBOX_MEDIA_SKIP_PROVENANCE === '1') {
      console.warn(
        'Skipping release provenance check (WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1). ' +
          'This is only valid for local build trials, not production release.',
      );
      console.log(`Verified media bundle: ${manifestPath}`);
      return;
    }
    verifyReleaseProvenance({ root, platform, lockPath });
    console.log(`Verified media bundle: ${manifestPath}`);
    return;
  } catch (error) {
    if (process.env.WORLDLINEBOX_MEDIA_AUTO_ACQUIRE === '0') {
      throw error;
    }
    console.warn(
      `[media-binaries] Local ${platform} bundle is missing or invalid; ` +
      'acquiring the pinned WorldlineBox-Build release before packaging.\n' +
      `  ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  await acquire({ platform, root, lockPath, archivePath });
  console.log(`Acquired and verified media bundle for ${platform} into ${root}`);
}

async function main() {
  const [command, ...rawOptions] = process.argv.slice(2);
  if (!['acquire', 'manifest', 'verify', 'ensure'].includes(command)) {
    throw new Error('Usage: media-binaries.mjs <acquire|manifest|verify|ensure> [--platform key] [--root path]');
  }
  const options = argumentsMap(rawOptions);
  // Resolve the host platform only when --platform is omitted. Evaluating
  // currentPlatformKey() as a default argument throws on Linux before the
  // explicit fixture platform is read.
  const platform = option(options, 'platform', undefined) ?? currentPlatformKey();
  assertPlatform(platform);
  const root = path.resolve(option(options, 'root', 'resources'));
  const archivePath = options.has('archive') ? path.resolve(options.get('archive')) : undefined;
  const lockPath = path.resolve(
    option(options, 'lock', path.join(root, 'media-binaries', 'bundle-lock.json')),
  );

  if (command === 'manifest') {
    const { manifestPath } = generateManifest({ root, platform });
    console.log(`Generated verified media manifest: ${manifestPath}`);
    return;
  }
  if (command === 'verify') {
    const { manifestPath } = verifyBundle({ root, platform });
    if (process.env.WORLDLINEBOX_MEDIA_SKIP_PROVENANCE === '1') {
      console.warn(
        'Skipping release provenance check (WORLDLINEBOX_MEDIA_SKIP_PROVENANCE=1). ' +
          'This is only valid for local build trials, not production release.',
      );
    } else {
      verifyReleaseProvenance({ root, platform, lockPath });
    }
    console.log(`Verified media bundle: ${manifestPath}`);
    return;
  }

  if (command === 'ensure') {
    await ensure({ platform, root, lockPath, archivePath });
    return;
  }

  await acquire({ platform, root, lockPath, archivePath });
  console.log(`Acquired and verified media bundle for ${platform} into ${root}`);
}

main().catch((error) => {
  const cause = error.cause instanceof Error ? `\nCaused by: ${error.cause.message}` : '';
  console.error(`Media binary operation failed: ${error.message}${cause}`);
  process.exitCode = 1;
});
