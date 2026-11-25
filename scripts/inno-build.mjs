#!/usr/bin/env node
/**
 * WorldlineBox Windows 安装器（Inno Setup）构建脚本。
 *
 * 使用 Inno Setup 生成单文件离线安装 EXE 与 SHA-256。
 *
 * 前置：
 *   - 已执行 npm run package（Inno 从 out/WorldlineBox-win32-x64 打包）
 *   - Inno Setup 工具：WORLDLINEBOX_INNO_TOOLS 指向含 ISCC.exe 的目录，否则
 *     默认 %LOCALAPPDATA%\WorldlineBoxTools\inno\tools（NuGet Tools.InnoSetup
 *     解压即用，见 docs/developer/build-packaging.md）
 *
 * 用法：node scripts/inno-build.mjs [--out <dir>] [--package <dir>]
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync, mkdirSync, readFileSync, mkdtempSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 从 package.json 读版本（npm version 提升后自动跟随）。 */
function packageVersion() {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    if (typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim();
    }
  } catch {
    // fall through to default
  }
  return '0.1.0';
}

const defaultIscc = process.env.WORLDLINEBOX_INNO_TOOLS
  ? path.resolve(process.env.WORLDLINEBOX_INNO_TOOLS, 'ISCC.exe')
  : path.join(process.env.LOCALAPPDATA || '', 'WorldlineBoxTools', 'inno', 'tools', 'ISCC.exe');

const defaultOut = path.join(repoRoot, 'out', 'make', 'inno');
const installerAssets = path.join(repoRoot, 'assets', 'inno');

function fail(message) {
  console.error(`[inno-build] FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  const outDir = process.argv.includes('--out')
    ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
    : defaultOut;

  if (!existsSync(defaultIscc)) {
    fail(`ISCC.exe not found at ${defaultIscc} (set WORLDLINEBOX_INNO_TOOLS or run 01-Setup-Environment.bat)`);
  }
  const packageDir = process.argv.includes('--package')
    ? path.resolve(process.argv[process.argv.indexOf('--package') + 1])
    : path.join(repoRoot, 'out', 'WorldlineBox-win32-x64');
  if (!existsSync(path.join(packageDir, 'WorldlineBox.exe'))) {
    fail(`Packaged app not found: ${packageDir} (run npm run package first)`);
  }
  const packageResources = path.join(packageDir, 'resources');
  for (const [script, args] of [
    ['stage-bundled-dsh.mjs', [path.join(packageResources, 'dsh-runtime')]],
    ['stage-cabin-world.mjs', ['--verify', path.join(packageResources, 'cabin-world')]],
  ]) {
    const check = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], { stdio: 'inherit' });
    if (check.error || check.status !== 0) fail(`${script} could not verify the packaged installer input. Run npm run package first.`);
  }

  mkdirSync(outDir, { recursive: true });
  const version = packageVersion();
  // Compile to a fresh owned directory. A scanner holding the published EXE
  // must not make ISCC delete the last good installer before compilation.
  let staging;
  for (let attempt = 0; attempt < 3; attempt++) {
    staging = mkdtempSync(path.join(outDir, '.build-'));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(defaultIscc, [`/DAppVersion=${version}`, `/DAppSourceDir=${packageDir}`, `/O${staging}`, path.join(installerAssets, 'worldlineboxsetup.iss')], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
      let tail = '';
      const append = (stream, bytes) => { stream.write(bytes); tail = (tail + bytes.toString()).slice(-16000); };
      child.stdout.on('data', bytes => append(process.stdout, bytes)); child.stderr.on('data', bytes => append(process.stderr, bytes));
      child.once('error', reject); child.once('close', status => resolve({ status, tail }));
    });
    if (result.status === 0) break;
    if (attempt === 2 || !/EndUpdateResource failed[\s\S]*\(110\)/i.test(result.tail)) fail(`ISCC exited with ${String(result.status)} (see output above; failed stage retained at ${staging})`);
    console.warn('[inno-build] Resource update was temporarily blocked; retrying in a fresh build directory.');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  const filename = 'WorldlineBoxSetup.exe';
  const stagedExe = path.join(staging, filename);
  if (!existsSync(stagedExe) || statSync(stagedExe).size < 100 * 1024 * 1024) {
    fail(`Missing or incomplete offline installer: ${stagedExe}`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(stagedExe)) hash.update(chunk);
  const stagedChecksum = stagedExe + '.sha256';
  writeFileSync(stagedChecksum, `${hash.digest('hex')}  ${filename}\n`);
  const setupExe = path.join(outDir, filename);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(stagedExe, setupExe); break; }
    catch (error) {
      if (attempt === 9 || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) fail(`Installer was built successfully but could not be published: ${stagedExe} (${error.message})`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  renameSync(stagedChecksum, setupExe + '.sha256');
  rmdirSync(staging); // Empty directory only; failed build evidence is preserved.
  console.log(`[inno-build] Windows installer written to ${setupExe} (${(statSync(setupExe).size / 1024 / 1024).toFixed(1)} MiB)`);
}

main().catch(error => fail(error.message));
