import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

describe.skipIf(process.platform !== 'win32')('portable tool acquisition', () => {
  let root: string;
  const approved = '{"manifestSha256":"existing-reviewed-lock"}\n';
  const sourceLock = (unsafe = false) => {
    const archives = Object.fromEntries(['node', 'python', 'pnpm', 'git', 'ffmpeg'].map(name => {
      const zip = new AdmZip();
      zip.addFile(unsafe && name === 'node' ? 'payload/C:escaped.txt' : `payload/${name}.txt`, Buffer.from(name));
      const buffer = zip.toBuffer();
      writeFileSync(path.join(root, `.tools/portable-downloads/${name}.archive`), buffer);
      return [name, { url: `https://invalid.example/${name}.zip`, sha256: createHash('sha256').update(buffer).digest('hex'), type: 'zip', directory: 'payload' }];
    }));
    writeFileSync(path.join(root, 'resources/portable-tools/download-lock.json'), JSON.stringify({ format: 'worldlinebox-portable-downloads-v1', platform: 'win32-x64', archives }));
  };
  const stage = (exitCode = 0) => writeFileSync(path.join(root, 'scripts/portable-tools.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync('stage-arguments.json', JSON.stringify(process.argv.slice(2)));
    process.exit(${exitCode});
  `);
  const run = (preload = false, args: string[] = []) => spawnSync(process.execPath, [
    ...(preload ? ['--import', pathToFileURL(path.join(root, 'fetch-preload.mjs')).href] : []),
    'scripts/acquire-portable-tools.mjs', ...args,
  ], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  const prepareDownload = (retry = false, tampered = false) => {
    const archive = path.join(root, '.tools/portable-downloads/node.archive');
    const payload = tampered ? Buffer.from('tampered download') : readFileSync(archive);
    unlinkSync(archive);
    writeFileSync(path.join(root, 'fetch-preload.mjs'), `
      import { writeFileSync } from 'node:fs';
      let attempts = 0;
      globalThis.fetch = async () => {
        writeFileSync('fetch-attempts.txt', String(++attempts));
        if (${retry} && attempts === 1) throw new Error('fixture connection reset');
        const payload = Buffer.from('${payload.toString('base64')}', 'base64');
        return new Response(payload, { headers: { 'content-length': String(payload.length) } });
      };
    `);
  };
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'worldlinebox-portable-acquisition-'));
    for (const directory of ['scripts', '.tools/portable-downloads', 'resources/portable-tools']) mkdirSync(path.join(root, directory), { recursive: true });
    copyFileSync('scripts/acquire-portable-tools.mjs', path.join(root, 'scripts/acquire-portable-tools.mjs'));
    // This script has exactly one package dependency. Copy it into the fixture
    // so no test cleanup can ever point at the checkout's dependency tree.
    cpSync(path.resolve('node_modules/adm-zip'), path.join(root, 'node_modules/adm-zip'), { recursive: true, dereference: true });
    writeFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), approved);
    sourceLock();
    stage();
  });
  afterEach(() => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative.startsWith('worldlinebox-portable-acquisition-') || path.isAbsolute(relative) || relative.includes(path.sep)) throw new Error('Unexpected cleanup target');
    removeOwnedDirectorySync(root);
  });

  it('uses verified cached archives and requests staging against the existing lock', () => {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const args: string[] = JSON.parse(readFileSync(path.join(root, 'stage-arguments.json'), 'utf8'));
    expect(args.slice(-2)).toEqual(['--locked', 'true']);
    for (const name of ['node', 'python', 'pnpm', 'git', 'ffmpeg']) expect(args).toContain(`--${name}`);
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
    expect(readdirSync(path.join(root, '.tools/portable-acquisition'))).toEqual([]);
  });

  it('requires explicit repair to replace an existing payload', () => {
    mkdirSync(path.join(root, 'resources/portable-tools/win32-x64'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--repair');
    expect(existsSync(path.join(root, 'stage-arguments.json'))).toBe(false);
  });

  it('requests locked repair and leaves the old payload untouched until verified staging finishes', () => {
    const target = path.join(root, 'resources/portable-tools/win32-x64');
    mkdirSync(target); writeFileSync(path.join(target, 'old.txt'), 'preserve old tools');
    const result = run(false, ['--repair']);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const args: string[] = JSON.parse(readFileSync(path.join(root, 'stage-arguments.json'), 'utf8'));
    expect(args.slice(-4)).toEqual(['--locked', 'true', '--replace-existing', 'true']);
    expect(readFileSync(path.join(target, 'old.txt'), 'utf8')).toBe('preserve old tools');
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
  });

  it('preserves the previous payload and lock when repair staging fails', () => {
    const target = path.join(root, 'resources/portable-tools/win32-x64');
    mkdirSync(target); writeFileSync(path.join(target, 'old.txt'), 'preserve old tools');
    stage(42);
    const result = run(false, ['--repair']);
    expect(result.status).toBe(1);
    expect(readFileSync(path.join(target, 'old.txt'), 'utf8')).toBe('preserve old tools');
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
  });

  it('never promotes a new lock during repair', () => {
    const result = run(false, ['--repair', '--promote-reviewed-sources']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Repair must use the committed manifest lock');
    expect(existsSync(path.join(root, 'stage-arguments.json'))).toBe(false);
  });

  it('rejects an unsafe ZIP before staging and preserves the reviewed lock', () => {
    sourceLock(true);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsafe portable ZIP entry');
    expect(existsSync(path.join(root, 'stage-arguments.json'))).toBe(false);
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
    expect(readdirSync(path.join(root, '.tools/portable-acquisition'))).toEqual([]);
  });

  it('downloads a missing archive and publishes it only after checksum verification', () => {
    prepareDownload();
    const result = run(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(existsSync(path.join(root, '.tools/portable-downloads/node.archive'))).toBe(true);
    expect(existsSync(path.join(root, 'stage-arguments.json'))).toBe(true);
  });

  it('retries an interrupted download before staging', () => {
    prepareDownload(true);
    const result = run(true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(path.join(root, 'fetch-attempts.txt'), 'utf8')).toBe('2');
    expect(result.stderr).toContain('retrying (1/3)');
  });

  it('rejects a downloaded checksum mismatch without publishing or staging it', () => {
    prepareDownload(false, true);
    const result = run(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archive SHA-256 mismatch');
    expect(existsSync(path.join(root, '.tools/portable-downloads/node.archive'))).toBe(false);
    expect(existsSync(path.join(root, 'stage-arguments.json'))).toBe(false);
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
  });

  it('propagates staging failure without changing the lock or leaving source staging', () => {
    stage(42);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed (42)');
    expect(readFileSync(path.join(root, 'resources/portable-tools/tool-lock.json'), 'utf8')).toBe(approved);
    expect(readdirSync(path.join(root, '.tools/portable-acquisition'))).toEqual([]);
  });
});
