import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows setup dependency installation', () => {
  // Exercise the PowerShell function without downloading or compiling packages.
  const run = (failCommand = '') => spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      $ErrorActionPreference = 'Stop'
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${path.resolve('scripts/windows.ps1').replaceAll("'", "''")}', [ref]$null, [ref]$null)
      $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Install-Dependencies' }, $true)
      . ([scriptblock]::Create($definition.Extent.Text))
      $script:calls = @()
      $failure = $null
      function Run-Npm([string[]]$Arguments) {
        $script:calls += ,$Arguments
        if ($Arguments[0] -eq '${failCommand}') { throw 'npm fixture failure' }
      }
      try { Install-Dependencies } catch { $failure = $_.Exception.Message }
      @{ calls = $script:calls; failure = $failure; skipElectronDownload = $env:ELECTRON_SKIP_BINARY_DOWNLOAD } | ConvertTo-Json -Compress -Depth 5
      if ($failure) { exit 1 }
    `,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });

  it('avoids host SQLite compilation while preparing the other native packages', () => {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      calls: [
        ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'],
        ['rebuild', 'koffi', 'node-pty', '--ignore-scripts=false'],
      ],
      failure: null,
      skipElectronDownload: '1',
    });
  });

  it('stops before running native package hooks when dependency installation fails', () => {
    const result = run('ci');
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.calls).toHaveLength(1);
    expect(output.failure).toBe('npm fixture failure');
  });

  it('propagates a failed native package hook', () => {
    const result = run('rebuild');
    expect(result.status).toBe(1);
    const output = JSON.parse(result.stdout);
    expect(output.calls).toHaveLength(2);
    expect(output.failure).toBe('npm fixture failure');
  });

  it('forwards a proxy URL through the actual setup batch entrypoint', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-setup-proxy-'));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('worldlinebox-setup-proxy-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
    try {
      mkdirSync(path.join(root, 'scripts'));
      copyFileSync('01-Setup-Environment.bat', path.join(root, '01-Setup-Environment.bat'));
      writeFileSync(path.join(root, 'scripts/windows.ps1'), 'param($Action, $Proxy)\nWrite-Output "$Action|$Proxy"\n');
      const result = spawnSync('cmd.exe', ['/d', '/c', '01-Setup-Environment.bat -Proxy http://127.0.0.1:7897'], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
        env: { ...process.env, WORLDLINEBOX_BATCH_NO_PAUSE: '1' },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Setup|http://127.0.0.1:7897');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
