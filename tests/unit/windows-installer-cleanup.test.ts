import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createWindowsInstallerCleanupInvocation } from '../../src/main/windows-installer-cleanup';

describe('Windows installer cleanup', () => {
  it('uses a hidden encoded worker and validates owned paths before scheduling deletion', () => {
    const invocation = createWindowsInstallerCleanupInvocation({ installerPath: 'C:\\Temp\\worldlinebox-installer-aB1234\\WorldlineBoxSetup.exe', tempDirectory: 'C:\\Temp', installerPid: 1234, environment: { SystemRoot: 'C:\\Windows' } });
    const script = Buffer.from(invocation.env.WORLDLINEBOX_UPDATE_CLEANUP_SCRIPT!, 'base64').toString('utf16le');
    const bootstrap = Buffer.from(invocation.args.at(-1)!, 'base64').toString('utf16le');
    expect(invocation.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(bootstrap).toContain('Start-Process -FilePath $env:WORLDLINEBOX_UPDATE_CLEANUP_POWERSHELL');
    expect(bootstrap).toContain('-WindowStyle Hidden -PassThru');
    expect(bootstrap).not.toContain('process.execPath');
    expect(invocation.args).toEqual(expect.arrayContaining(['-WindowStyle', 'Hidden', '-NonInteractive', '-EncodedCommand']));
    expect(script).toContain('Get-Process -Name $installerProcessName');
    expect(script).toContain('ReparsePoint');
    expect(script).toContain('GetFullPath');
    expect(script).not.toMatch(/\bping\b|cmd\.exe|-Recurse/iu);
    expect(script).not.toContain('C:\\Temp');
    expect(invocation.env.WORLDLINEBOX_UPDATE_CLEANUP_PID).toBe('1234');
    expect(invocation.env.WORLDLINEBOX_UPDATE_CLEANUP_POWERSHELL).toBe(invocation.executable);
  });

  it.each([
    'C:\\Temp\\WorldlineBoxSetup.exe',
    'C:\\Other\\worldlinebox-installer-aB1234\\WorldlineBoxSetup.exe',
    'C:\\Temp\\worldlinebox-installer-aB1234\\unrelated.exe',
    'C:\\Temp\\other-application-aB1234\\WorldlineBoxSetup.exe',
    'worldlinebox-installer-aB1234\\WorldlineBoxSetup.exe',
  ])('refuses an unowned cleanup target %s', installerPath => {
    expect(() => createWindowsInstallerCleanupInvocation({ installerPath, tempDirectory: 'C:\\Temp' })).toThrow('owned temporary');
  });

  it.skipIf(process.platform !== 'win32').each([undefined, 730241])('runs the real hidden native launcher with installer PID %s and removes only its empty extracted installer directory', async (installerPid) => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-cleanup-test-'));
    const directory = path.join(root, 'worldlinebox-installer-aB1234');
    const installerPath = path.join(directory, 'WorldlineBoxSetup.exe');
    const assertFixtureRoot = () => {
      const absolute = path.resolve(root);
      if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-cleanup-test-')) throw Error('Unexpected cleanup fixture root');
      return absolute;
    };
    try {
      await mkdir(directory);
      await writeFile(installerPath, 'inert owned fixture');
      const invocation = createWindowsInstallerCleanupInvocation({ installerPath, tempDirectory: root, installerPid });
      const child = spawn(invocation.executable, invocation.args, { env: invocation.env, detached: false, windowsHide: true, stdio: 'ignore' });
      const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? -1)); });
      expect(code).toBe(0);
      await expect.poll(() => existsSync(directory), { timeout: 10_000 }).toBe(false);
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      await rm(assertFixtureRoot(), { recursive: true, force: true });
    }
  }, 15000);

  it.skipIf(process.platform !== 'win32')('keeps the hidden worker alive after its actual launching process exits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-cleanup-parent-test-'));
    const assertFixtureRoot = () => {
      const absolute = path.resolve(root);
      if (path.dirname(absolute) !== path.resolve(tmpdir())
        || !path.basename(absolute).startsWith('worldlinebox-cleanup-parent-test-')) throw Error('Unexpected cleanup fixture root');
      return absolute;
    };
    const directory = path.join(root, 'worldlinebox-installer-aB1234');
    const installerPath = path.join(directory, 'WorldlineBoxSetup.exe');
    let cleanupCompleted = false;
    try {
      await mkdir(directory);
      await writeFile(installerPath, 'inert owned fixture');
      const invocation = createWindowsInstallerCleanupInvocation({ installerPath, tempDirectory: root, installerPid: 730241 });
      const workerEnvironment = Object.fromEntries(Object.entries(invocation.env)
        .filter(([key]) => key.startsWith('WORLDLINEBOX_UPDATE_CLEANUP_')));
      const sentinel = path.join(root, 'parent-alive');
      await writeFile(sentinel, 'The test releases this after the launcher parent has exited.');
      const workerScript = Buffer.from(workerEnvironment.WORLDLINEBOX_UPDATE_CLEANUP_SCRIPT!, 'base64').toString('utf16le');
      workerEnvironment.WORLDLINEBOX_UPDATE_CLEANUP_SCRIPT = Buffer.from(`
        for ($i = 0; $i -lt 100 -and (Test-Path -LiteralPath $env:WORLDLINEBOX_CLEANUP_WAIT_SENTINEL); $i++) {
          Start-Sleep -Milliseconds 50
        }
        ${workerScript}
      `, 'utf16le').toString('base64');
      const fixtureInvocation = { executable: invocation.executable, args: invocation.args,
        env: { ...workerEnvironment, WORLDLINEBOX_CLEANUP_WAIT_SENTINEL: sentinel } };
      const parentScript = `
        const { spawn } = require('node:child_process');
        const invocation = JSON.parse(process.env.WORLDLINEBOX_CLEANUP_LIFETIME_FIXTURE);
        const launcher = spawn(invocation.executable, invocation.args, {
          env: { ...process.env, ...invocation.env }, detached: false, windowsHide: true, stdio: 'ignore',
        });
        launcher.once('error', () => process.exit(1));
        launcher.once('exit', code => process.exit(code ?? 1));
      `;
      const parent = spawn(process.execPath, ['-e', parentScript], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WORLDLINEBOX_CLEANUP_LIFETIME_FIXTURE: JSON.stringify(fixtureInvocation) },
        windowsHide: true, stdio: 'ignore',
      });
      const code = await new Promise<number>((resolve, reject) => {
        parent.once('error', reject); parent.once('exit', code => resolve(code ?? -1));
      });
      expect(code).toBe(0);
      expect(existsSync(installerPath)).toBe(true);
      await rm(sentinel);
      // The parent waited only for native process creation, not cleanup. The
      // hidden system worker must remain alive independently of that parent.
      await expect.poll(() => existsSync(directory), { timeout: 10_000 }).toBe(false);
      expect(existsSync(root)).toBe(true);
      cleanupCompleted = true;
    } finally {
      // On failure keep the fixture instead of making a false cleanup proof.
      if (cleanupCompleted) await rm(assertFixtureRoot(), { recursive: true, force: true });
    }
  }, 15_000);
});
