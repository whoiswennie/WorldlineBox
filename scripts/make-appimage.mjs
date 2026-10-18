#!/usr/bin/env node
/**
 * Build a Linux AppImage from the Forge package.
 *
 *   npm run make:appimage                 # package + AppImage
 *   npm run make:appimage -- --skip-package
 *
 * Output: out/make/appimage/WorldlineBox-<version>-<arch>.AppImage
 *
 * The AppImage bundles Electron, native modules, and the pinned linux-x64
 * media binaries (`resources/ffmpeg` and `resources/oiio`) that `npm run package`
 * acquires via `media:ensure`. Build it on the oldest glibc you want to support
 * (scripts/appimage-docker.sh builds in Ubuntu 22.04, glibc 2.35). ffmpeg may
 * still be overridden with `WORLDLINEBOX_FFMPEG_PATH` / system PATH; oiiotool resolves
 * the bundled binary first.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'linux') {
  console.error('[make-appimage] AppImage can only be built on Linux.');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const packageDir = path.join(root, 'out', `${pkg.productName}-linux-${process.arch}`);
const outDir = path.join(root, 'out', 'make', 'appimage');
const appDir = path.join(root, 'out', 'appimage', `${pkg.productName}.AppDir`);
const toolDir = path.join(root, 'out', 'appimage', 'tools');
const appimagetool = path.join(toolDir, `appimagetool-${arch}.AppImage`);
const toolUrl = `https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${arch}.AppImage`;

function run(cmd, args, opts = {}) {
  console.log(`[make-appimage] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`);
}

if (!process.argv.includes('--skip-package')) {
  run(path.join(root, 'node_modules', '.bin', 'electron-forge'), ['package']);
}
if (!existsSync(path.join(packageDir, pkg.name)) && !existsSync(path.join(packageDir, pkg.productName))) {
  throw new Error(`Forge package not found at ${packageDir}`);
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(path.join(appDir, 'usr', 'lib'), { recursive: true });
const libDir = path.join(appDir, 'usr', 'lib', 'worldlinebox');
cpSync(packageDir, libDir, { recursive: true, verbatimSymlinks: true });
// chrome-sandbox cannot be setuid inside a FUSE-mounted AppImage; without it
// Chromium uses the user-namespace sandbox. AppRun falls back to
// --no-sandbox only when user namespaces are unavailable (e.g. restricted by
// AppArmor on Ubuntu 24.04 or inside containers).
rmSync(path.join(libDir, 'chrome-sandbox'), { force: true });
const exe = existsSync(path.join(libDir, pkg.productName)) ? pkg.productName : pkg.name;

writeFileSync(
  path.join(appDir, 'AppRun'),
  `#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
EXTRA=""
if [ -z "$WORLDLINEBOX_FORCE_SANDBOX" ] && ! unshare -Ur true >/dev/null 2>&1; then
  EXTRA="--no-sandbox"
fi
exec "$HERE/usr/lib/worldlinebox/${exe}" $EXTRA "$@"
`,
);
chmodSync(path.join(appDir, 'AppRun'), 0o755);
writeFileSync(
  path.join(appDir, 'worldlinebox.desktop'),
  `[Desktop Entry]
Type=Application
Name=${pkg.productName}
Comment=${pkg.description}
Exec=AppRun %U
Icon=worldlinebox
Categories=Graphics;Utility;
StartupWMClass=${pkg.productName}
Terminal=false
`,
);
copyFileSync(path.join(root, 'assets', 'icons', 'app.png'), path.join(appDir, 'worldlinebox.png'));
copyFileSync(path.join(root, 'assets', 'icons', 'app.png'), path.join(appDir, '.DirIcon'));

mkdirSync(toolDir, { recursive: true });
if (!existsSync(appimagetool)) {
  run('curl', ['-fL', '-o', appimagetool, toolUrl]);
  chmodSync(appimagetool, 0o755);
}
mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, `${pkg.productName}-${pkg.version}-${arch}.AppImage`);
// APPIMAGE_EXTRACT_AND_RUN: appimagetool itself works without FUSE (CI/docker).
run(appimagetool, ['--no-appstream', appDir, target], {
  env: { ...process.env, ARCH: arch, APPIMAGE_EXTRACT_AND_RUN: '1' },
});
console.log(`[make-appimage] wrote ${target}`);
