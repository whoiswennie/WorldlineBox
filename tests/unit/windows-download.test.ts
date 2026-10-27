import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(process.platform !== 'win32')('Windows verified download recovery', () => {
  let root: string, origin: string, server: Server, payload: Buffer;
  let requests: string[];
  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-download-'));
    const zip = new AdmZip();
    zip.addFile('electron.exe', Buffer.from('isolated distribution fixture'));
    zip.addFile('version', Buffer.from('1.0.0'));
    payload = zip.toBuffer(); requests = [];
    server = createServer((request, response) => {
      const url = request.url!; requests.push(url);
      if (url === '/reset' || url === '/retry' && requests.filter(value => value === url).length === 1) {
        response.writeHead(200, { 'Content-Length': payload.length + 100 });
        response.write('partial');
        setTimeout(() => response.destroy(), 10);
      } else response.end(url === '/corrupt' ? 'untrusted archive' : payload);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('worldlinebox-download-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw Error('Unexpected fixture cleanup target');
    rmSync(root, { recursive: true, force: true });
  });
  const run = async (body: string, mirror = '') => {
    const script = path.join(root, 'download.ps1');
    writeFileSync(script, `
      $ErrorActionPreference = 'Stop'
      $Proxy = ''
      $projectRoot = ${quote(root)}
      $toolsRoot = Join-Path $projectRoot '.tools'
      New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(path.resolve('scripts/windows.ps1'))}, [ref]$null, [ref]$null)
      foreach ($name in @('Download-File', 'File-Sha256', 'Expand-Zip', 'Prepare-Electron')) {
        $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
        . ([scriptblock]::Create($definition.Extent.Text))
      }
      ${body}
    `);
    return execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      cwd: root, windowsHide: true, timeout: 20_000,
      env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost',
        ELECTRON_MIRROR: mirror, ELECTRON_CUSTOM_DIR: '{{ version }}' },
    });
  };

  it('retries interrupted response bodies instead of accepting partial downloads', async () => {
    await run(`Download-File -Url ${quote(origin + '/retry')} -Destination (Join-Path $projectRoot 'payload.zip') -ExpectedSha256 '${sha(payload)}'`);
    expect(requests).toEqual(['/retry', '/retry']);
    expect(readFileSync(path.join(root, 'payload.zip'))).toEqual(payload);
    expect(readdirSync(root).filter(name => name.includes('.download-'))).toEqual([]);
  });

  it('uses the fallback after repeated connection failures', async () => {
    await run(`Download-File -Url ${quote(origin + '/reset')} -FallbackUrls @(${quote(origin + '/good')}) -Destination (Join-Path $projectRoot 'payload.zip') -ExpectedSha256 '${sha(payload)}'`);
    expect(requests).toEqual(['/reset', '/reset', '/good']);
    expect(readFileSync(path.join(root, 'payload.zip'))).toEqual(payload);
  });

  it('rejects corrupt mirror bytes and still verifies the fallback', async () => {
    await run(`Download-File -Url ${quote(origin + '/corrupt')} -FallbackUrls @(${quote(origin + '/good')}) -Destination (Join-Path $projectRoot 'payload.zip') -ExpectedSha256 '${sha(payload)}'`);
    expect(requests).toEqual(['/corrupt', '/corrupt', '/good']);
    expect(sha(readFileSync(path.join(root, 'payload.zip')))).toBe(sha(payload));
  });

  it('preserves an existing archive when all attempts fail integrity checks', async () => {
    writeFileSync(path.join(root, 'payload.zip'), 'previous verified download');
    await expect(run(`Download-File -Url ${quote(origin + '/corrupt')} -Destination (Join-Path $projectRoot 'payload.zip') -ExpectedSha256 '${sha(payload)}'`)).rejects.toThrow('all sources');
    expect(readFileSync(path.join(root, 'payload.zip'), 'utf8')).toBe('previous verified download');
    expect(readdirSync(root).filter(name => name.includes('.download-'))).toEqual([]);
  });

  it('repairs a corrupt cached ZIP through the configured mirror and reuses only verified bytes', async () => {
    const electron = path.join(root, 'node_modules/electron');
    mkdirSync(electron, { recursive: true }); mkdirSync(path.join(root, '.tools'));
    const name = 'electron-v1.0.0-win32-x64.zip';
    writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    writeFileSync(path.join(electron, 'checksums.json'), JSON.stringify({ [name]: sha(payload) }));
    writeFileSync(path.join(root, '.tools', name), 'previous interrupted ZIP');
    await run('Prepare-Electron -RequireArchive\nPrepare-Electron -RequireArchive', origin + '/electron/');
    expect(requests).toEqual(['/electron/1.0.0/' + name]);
    expect(existsSync(path.join(electron, 'dist/electron.exe'))).toBe(true);
    expect(readFileSync(path.join(electron, 'path.txt'), 'utf8')).toBe('electron.exe');
    expect(sha(readFileSync(path.join(root, '.tools', name)))).toBe(sha(payload));
  });
});
