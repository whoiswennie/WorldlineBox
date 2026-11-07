import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

function run(kind: 'interrupted' | 'bad-hash' | 'fallback') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wlb-download-resume-'));
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('wlb-download-resume-')) throw Error('Unexpected fixture root');
  const destination = path.join(root, 'download.bin');
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const expected = createHash('sha256').update('part-rest').digest('hex');
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
      $ErrorActionPreference = 'Stop'
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve('scripts/windows.ps1'))}, [ref]$null, [ref]$null)
      foreach ($name in @('Download-File', 'File-Sha256')) {
        $definition = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
        . ([scriptblock]::Create($definition.Extent.Text))
      }
      $script:calls = @(); $script:count = 0
      function curl.exe {
        $taskArguments = @($args)
        $script:count++
        $outputIndex = [array]::IndexOf($taskArguments, '--output')
        $target = $taskArguments[$outputIndex + 1]
        $source = $taskArguments[-1]
        $hasResume = $taskArguments -contains '--continue-at'
        $before = if (Test-Path -LiteralPath $target) { [IO.File]::ReadAllText($target) } else { '' }
        $script:calls += @{source=$source; resume=$hasResume; before=$before}
        if ('${kind}' -eq 'fallback' -and $source -eq 'https://first.invalid/file') { [IO.File]::WriteAllText($target, 'foreign'); $global:LASTEXITCODE=18; return }
        if ($script:count -eq 1) {
          if ('${kind}' -eq 'bad-hash') { [IO.File]::WriteAllText($target, 'corrupt'); $global:LASTEXITCODE=0 }
          else { [IO.File]::WriteAllText($target, 'part-'); $global:LASTEXITCODE=18 }
          return
        }
        if ('${kind}' -eq 'interrupted') { [IO.File]::AppendAllText($target, 'rest') }
        else { [IO.File]::WriteAllText($target, 'part-rest') }
        $global:LASTEXITCODE=0
      }
      Download-File -Url 'https://first.invalid/file' -Destination ${quote(destination)} -ExpectedSha256 '${expected}' -FallbackUrls @('https://second.invalid/file')
      Write-Output ('TRACE:' + (ConvertTo-Json -InputObject @($script:calls) -Compress))
    `], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const trace = result.stdout.split(/\r?\n/).find(line => line.startsWith('TRACE:'))?.slice(6);
    return { ...result, calls: trace ? JSON.parse(trace) as {source: string; resume: boolean; before: string}[] : [], content: readFileSync(destination, 'utf8') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
it.skipIf(process.platform !== 'win32')('resumes interrupted bytes from the same source and verifies the final checksum', () => {
  const result = run('interrupted'); expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.content).toBe('part-rest'); expect(result.calls).toHaveLength(2);
  expect(result.calls[1]).toMatchObject({ resume: true, before: 'part-' });
});
it.skipIf(process.platform !== 'win32')('discards a checksum mismatch before retrying', () => {
  const result = run('bad-hash'); expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.content).toBe('part-rest'); expect(result.calls[1]).toMatchObject({ resume: false, before: '' });
});
it.skipIf(process.platform !== 'win32')('never mixes partial bytes across fallback sources', () => {
  const result = run('fallback'); expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.content).toBe('part-rest'); expect(result.calls).toHaveLength(5);
  expect(result.calls[4]).toMatchObject({ source: 'https://second.invalid/file', resume: false, before: '' });
});
