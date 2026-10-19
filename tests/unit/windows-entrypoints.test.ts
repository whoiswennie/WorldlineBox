import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows entrypoint responsibilities', () => {
  let root: string;
  let trace: string;
  let state: string;
  let lockHash: string;
  const nodeVersion = process.versions.node;
  const write = (name: string, value: string) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
    return file;
  };
  const receipt = (hash = lockHash) => writeFileSync(state, JSON.stringify({ nodeVersion, lockHash: hash }));
  const run = (action: 'Dev' | 'Installer') => spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/windows.ps1'), '-Action', action,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
    env: { ...process.env, WORLDLINEBOX_WINDOWS_FLOW_TRACE: trace } });

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-windows-flow-'));
    trace = path.join(root, 'npm-trace.txt');
    write('scripts/windows.ps1', readFileSync('scripts/windows.ps1', 'utf8'));
    write('.nvmrc', nodeVersion);
    const lock = '{}';
    write('package-lock.json', lock);
    lockHash = createHash('sha256').update(lock).digest('hex');
    state = write('.tools/setup-state.json', '{}');
    receipt();
    const nodeDirectory = path.join('.tools', `node-v${nodeVersion}-win-x64`);
    write(path.join(nodeDirectory, 'npm.cmd'), '@echo off\r\necho %*>>"%WORLDLINEBOX_WINDOWS_FLOW_TRACE%"\r\nexit /b 0\r\n');
    copyFileSync(process.execPath, path.join(root, nodeDirectory, 'node.exe'));
    write('node_modules/electron/dist/electron.exe', 'fixture');
    write('node_modules/.bin/electron-forge.cmd', 'fixture');
    write('.tools/inno/ISCC.exe', 'fixture');
    const archive = 'fixture electron archive';
    const archiveName = 'electron-v1.0.0-win32-x64.zip';
    write(`.tools/${archiveName}`, archive);
    write('node_modules/electron/package.json', JSON.stringify({ version: '1.0.0' }));
    write('node_modules/electron/checksums.json', JSON.stringify({ [archiveName]: createHash('sha256').update(archive).digest('hex') }));
  });
  afterAll(() => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('worldlinebox-windows-flow-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
    rmSync(root, { recursive: true, force: true });
  });

  it('starts with npm start only, without downloading or compiling dependencies', () => {
    const result = run('Dev');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim()).toBe('start');
    rmSync(trace);
  });
  it('builds the installer without running npm ci or setup', () => {
    const result = run('Installer');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split(/\r?\n/)).toEqual(['run typecheck', 'run package', 'run make:inno']);
    rmSync(trace);
  });
  it('stops with a useful setup instruction when the lock changes', () => {
    receipt('old-lock');
    const result = run('Dev');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('01-Setup-Environment.bat');
    expect(existsSync(trace)).toBe(false);
    receipt();
  });
  it('never auto-installs when the setup receipt is missing', () => {
    rmSync(state);
    for (const action of ['Dev', 'Installer'] as const) {
      const result = run(action);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('setup is incomplete');
      expect(existsSync(trace)).toBe(false);
    }
    receipt();
  });
  it('fails without downloading Node when the portable Node is missing', () => {
    rmSync(path.join(root, '.tools', `node-v${nodeVersion}-win-x64`, 'node.exe'));
    const result = run('Dev');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Local Node.js is missing');
    expect(existsSync(trace)).toBe(false);
  });
});

it.skipIf(process.platform !== 'win32')('reports a failed portable download and removes a stale setup receipt', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-setup-missing-tools-'));
  const relative = path.relative(os.tmpdir(), root);
  if (!relative.startsWith('worldlinebox-setup-missing-tools-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, '.tools'));
    const state = path.join(root, '.tools/setup-state.json');
    writeFileSync(state, '{}');
    writeFileSync(path.join(root, 'scripts/ensure-native.mjs'), 'process.exit(0);');
    writeFileSync(path.join(root, 'scripts/acquire-portable-tools.mjs'), 'process.exit(1);');
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      $ErrorActionPreference = 'Stop'
      $projectRoot = ${quote(root)}
      $toolsRoot = Join-Path $projectRoot '.tools'
      $setupState = Join-Path $toolsRoot 'setup-state.json'
      $nodeExe = ${quote(process.execPath)}
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve('scripts/windows.ps1'))}, [ref]$null, [ref]$null)
      $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Setup-Environment' }, $true)
      . ([scriptblock]::Create($definition.Extent.Text))
      function Prepare-NativeBuildTools {}
      function Install-Dependencies {}
      function Prepare-Electron {}
      function Run-Npm {}
      try { Setup-Environment } catch { Write-Output $_.Exception.Message; exit 1 }
    `], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('Portable tool acquisition failed.');
    expect(result.stdout).toContain('docs\\developer\\portable-tools.md');
    expect(existsSync(state)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('check-only native readiness never invokes a repair on a failed probe', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-native-check-'));
  const relative = path.relative(os.tmpdir(), root);
  if (!relative.startsWith('worldlinebox-native-check-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'node_modules/electron'), { recursive: true });
    copyFileSync('scripts/ensure-native.mjs', path.join(root, 'scripts/ensure-native.mjs'));
    // Host Node runs the probe without better-sqlite3; the probe must fail.
    writeFileSync(path.join(root, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
    writeFileSync(path.join(root, 'scripts/rebuild-native.mjs'), "import fs from 'node:fs'; fs.writeFileSync('repair-ran.txt', 'unexpected');");
    const result = spawnSync(process.execPath, ['scripts/ensure-native.mjs', '--check-only'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Development startup will not rebuild');
    expect(existsSync(path.join(root, 'repair-ran.txt'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
