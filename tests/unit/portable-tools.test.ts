import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getAppPath: () => path.resolve(import.meta.dirname, '../..') } }));
import { portableToolEnvironment, resolvePortableTools } from '../../src/main/portable-tools';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}worldlinebox-tools-test-`)) throw new Error('Unexpected temporary test path.');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('application-owned portable tools', () => {
  it('keeps the complete reproducible tool inventory in Git with its pinned hash', () => {
    const bytes = readFileSync(path.join(projectRoot, 'resources/portable-tools/manifests/win32-x64.json'));
    const lock = JSON.parse(readFileSync(path.join(projectRoot, 'resources/portable-tools/tool-lock.json'), 'utf8'));
    const manifest = JSON.parse(bytes.toString('utf8'));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(lock.manifestSha256);
    expect(manifest.versions).toEqual(lock.versions);
    expect(manifest.files.length).toBeGreaterThan(1000);
    for (const executable of ['node/node.exe', 'python/python.exe', 'pnpm/bin/pnpm.cjs', 'git/cmd/git.exe', 'ffmpeg/bin/ffmpeg.exe']) {
      expect(manifest.files).toContainEqual(expect.objectContaining({ path: executable, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    }
  });

  it('refuses an absent application payload even if unrelated commands exist on PATH', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-tools-test-'));
    roots.push(root);
    await expect(resolvePortableTools({ resourcesPath: root, appPath: root, platform: 'win32-x64' })).rejects.toThrow('PORTABLE_TOOLS_REQUIRED');
  });

  it('rejects a replaced manifest before trusting its executable names or checksums', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-tools-test-'));
    roots.push(root);
    const resources = path.join(root, 'resources/portable-tools/win32-x64');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'manifest.json'), '{"format":"worldlinebox-portable-tools-v1","files":[]}');
    await expect(resolvePortableTools({ resourcesPath: root, appPath: root, platform: 'win32-x64' })).rejects.toThrow('PORTABLE_TOOLS_INTEGRITY_FAILED');
  });

  it.skipIf(process.platform !== 'win32' || !existsSync(path.join(projectRoot, 'resources/portable-tools/win32-x64/manifest.json')))('runs bundled Node/Python/Git/media from a minimal environment and creates a relocatable Python venv', async () => {
    const tools = await resolvePortableTools({ resourcesPath: projectRoot, appPath: projectRoot });
    const temp = mkdtempSync(path.join(tmpdir(), 'worldlinebox-tools-test-'));
    roots.push(temp);
    const env = portableToolEnvironment(tools, {
      SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp,
      Path: path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32'),
      PATH: 'C:/foreign-node', PYTHONHOME: 'C:/foreign-python', PythonPath: 'C:/foreign-modules',
      GIT_EXEC_PATH: 'C:/foreign-git',
    });
    env.PYTHONDONTWRITEBYTECODE = '1';
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    expect(env.PYTHONHOME).toBeUndefined();
    expect(env.PythonPath).toBeUndefined();
    const run = (exe: string, args: string[]) => {
      const result = spawnSync(exe, args, { env, cwd: temp, windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000 });
      expect(result.error, String(result.stderr)).toBeUndefined();
      expect(result.status, String(result.stderr)).toBe(0);
      return `${result.stdout ?? ''}${result.stderr ?? ''}`;
    };
    expect(run(tools.nodeExecutable, ['--version'])).toContain('v24.15.0');
    expect(run(tools.pythonExecutable, ['-B', '-I', '-m', 'pip', '--version'])).toContain('pip 25.3');
    run(tools.pythonExecutable, ['-B', '-I', '-m', 'venv', path.join(temp, 'venv')]);
    expect(run(path.join(temp, 'venv/Scripts/python.exe'), ['-c', 'import sys; print(sys.prefix); print(sys.base_prefix)'])).toContain(tools.pythonHome);
    expect(run(tools.gitExecutable, ['--version'])).toContain('2.48.1.windows.1');
    run(tools.gitExecutable, ['init', '--quiet', path.join(temp, 'source')]);
    run(tools.gitExecutable, ['clone', '--quiet', path.join(temp, 'source'), path.join(temp, 'clone')]);
    expect(run(tools.ffmpegExecutable, ['-version'])).toContain('8.0.1-essentials_build');
    expect(run(tools.ffplayExecutable, ['-version'])).toContain('8.0.1-essentials_build');
    expect(run(tools.ffprobeExecutable, ['-version'])).toContain('8.0.1-essentials_build');
  }, 60_000);
});
