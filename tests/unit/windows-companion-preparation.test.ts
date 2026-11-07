import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { TEST_NODE_EXECUTABLE } from '../helpers/node-executable';

const scripts = ['build-companion-call-sdk.mjs', 'stage-bot-memory.mjs', 'verify-bot-memory.mjs',
  'prepare-source-lfs.mjs', 'stage-bundled-embedding.mjs', 'stage-local-speech.mjs'];
function run(failedScript = '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-companion-setup-'));
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('wlb-companion-setup-')) throw Error('Unexpected fixture root');
  const trace = path.join(root, 'trace.jsonl');
  try {
    mkdirSync(path.join(root, 'scripts'));
    for (const name of scripts) writeFileSync(path.join(root, 'scripts', name), `
      import {appendFileSync} from 'node:fs';
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify({name:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');
      process.exit(${name === failedScript ? 1 : 0});
    `);
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const process = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      $ErrorActionPreference = 'Stop'
      $projectRoot = ${quote(root)}
      $toolsRoot = Join-Path $projectRoot '.tools'
      $nodeExe = ${quote(TEST_NODE_EXECUTABLE)}
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve('scripts/windows.ps1'))}, [ref]$null, [ref]$null)
      $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Prepare-CompanionRuntime'}, $true)
      . ([scriptblock]::Create($definition.Extent.Text))
      try { Prepare-CompanionRuntime } catch { Write-Output $_.Exception.Message; exit 1 }
    `], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    return { ...process, calls: readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), root };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
it.skipIf(process.platform !== 'win32')('prepares the SDK, isolated memory, LFS and models explicitly before development', () => {
  const result = run(); expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.calls.map(call => call.name)).toEqual(scripts);
  expect(result.calls[4].args).toEqual(['--acquire', '--cache-dir', path.join(result.root, '.tools', 'embedding-downloads')]);
});
it.skipIf(process.platform !== 'win32').each(scripts)('fails setup promptly when %s fails', name => {
  const result = run(name); expect(result.status).toBe(1);
  expect(result.stdout).toContain('01-Setup-Environment.bat');
  expect(result.calls.map(call => call.name)).toEqual(scripts.slice(0, scripts.indexOf(name) + 1));
});
