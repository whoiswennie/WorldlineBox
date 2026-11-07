import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

async function run(mode: 'valid' | 'wrong-range' | 'oversize') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-pinned-range-'));
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('wlb-pinned-range-')) throw Error('Unexpected fixture root');
  const destination = path.join(root, 'range.bin');
  const body = Buffer.alloc(mode === 'oversize' ? 4097 : 4096, 97);
  const requests: { url?: string; range?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, range: request.headers.range });
    response.writeHead(206, { 'Content-Range': mode === 'wrong-range' ? 'bytes 1-4096/8192' : 'bytes 0-4095/8192',
      'Content-Length': String(body.length), Connection: 'close' });
    response.end(body);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No fixture proxy port');
    // Force the system PowerShell 5, even on build machines with pwsh installed.
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.resolve('scripts/download-pinned-range.ps1'), '-Url', 'http://worldlinebox-range.invalid/fixture',
      '-Destination', destination, '-Start', '0', '-End', '4095', '-Total', '8192'], {
      windowsHide: true, env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${address.port}` },
      signal: AbortSignal.timeout(15_000), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const status = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { status, output, requests, bytes: await readFile(destination).catch(() => undefined), body };
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
it.skipIf(process.platform !== 'win32')('downloads an exact range through an explicit proxy on Windows PowerShell 5', async () => {
  const result = await run('valid'); expect(result.status, result.output).toBe(0);
  expect(result.bytes).toEqual(result.body);
  expect(result.requests).toEqual([{ url: 'http://worldlinebox-range.invalid/fixture', range: 'bytes=0-4095' }]);
}, 20_000);
it.skipIf(process.platform !== 'win32')('rejects a wrong range before publishing bytes', async () => {
  const result = await run('wrong-range'); expect(result.status).toBe(1);
  expect(result.output).toContain('Invalid pinned download range response'); expect(result.bytes).toBeUndefined();
}, 20_000);
it.skipIf(process.platform !== 'win32')('bounds an oversized response to the pinned range', async () => {
  const result = await run('oversize'); expect(result.status).toBe(1);
  expect(result.output).toContain('exceeded its expected size'); expect(result.bytes?.length ?? 0).toBeLessThanOrEqual(4096);
}, 20_000);
