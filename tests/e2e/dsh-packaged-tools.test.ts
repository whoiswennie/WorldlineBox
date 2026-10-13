import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { DshLauncherRequest, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { electronLaunchEnv } from './electron-test-helpers';

async function request(page: Page, input: DshLauncherRequest) {
  return page.evaluate(value => (window as unknown as {
    worldlinebox: { dshLauncher: WorldlineBoxDshLauncherApi };
  }).worldlinebox.dshLauncher.request(value), input);
}

async function state(page: Page): Promise<DshLauncherState> {
  const result = await request(page, { type: 'state' });
  if (!result.ok || !result.state) throw new Error(result.ok ? 'No launcher state.' : result.error);
  return result.state;
}

async function complete(page: Page, input: DshLauncherRequest) {
  const result = await request(page, input);
  if (!result.ok) throw new Error(result.error);
  if (result.operationId) {
    await expect.poll(async () => (await state(page)).operations.find(value => value.id === result.operationId)?.status, {
      timeout: 300_000,
    }).not.toBe('running');
    const operation = (await state(page)).operations.find(value => value.id === result.operationId);
    expect(operation?.status, operation?.error).toBe('succeeded');
  }
  return result;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** ConPTY can coalesce an SGR transition with the preceding newline. */
function foregroundAtLastMarker(output: string, marker: string): number | undefined {
  const markerOffset = output.lastIndexOf(marker);
  if (markerOffset < 0) return undefined;
  let foreground: number | undefined;
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[([0-9;]*)m`, 'g');
  for (const match of output.slice(0, markerOffset).matchAll(sgr)) {
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!;
      if (code === 0 || code === 39) foreground = undefined;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = code;
      else if (code === 38 || code === 48) {
        // Do not mistake an extended-color parameter for an ordinary SGR code.
        if (code === 38) foreground = undefined;
        index += codes[index + 1] === 2 ? 4 : codes[index + 1] === 5 ? 2 : 0;
      }
    }
  }
  return foreground;
}

async function removeAcceptanceDirectory(root: string): Promise<void> {
  const resolved = path.resolve(root);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(tmpdir()).toLowerCase()
    || !path.basename(resolved).startsWith('worldlinebox-packaged-dsh-tools-')) {
    throw new Error('Refusing to remove an unexpected packaged acceptance directory.');
  }
  await rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function ownedPtyWorkers(application: ElectronApplication, rootPath: string): Promise<number[]> {
  return application.evaluate((_electron, root) => {
    const childProcess = process.getBuiltinModule('node:child_process');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const escaped = `${root}\\cli\\pty-worker.cjs`.replaceAll("'", "''");
    const script = `$needle='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase) -ge 0 -and $_.Name -eq 'WorldlineBox.exe' } | ForEach-Object { [Console]::WriteLine($_.ProcessId) }`;
    const output = childProcess.execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      env: { ...process.env, PSModulePath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules` },
    });
    return output.trim().split(/\s+/).filter(Boolean).map(Number);
  }, rootPath);
}

test('the packaged launcher supplies its complete toolchain and native ConPTY without installed developer tools', async () => {
  test.setTimeout(600_000);
  test.skip(process.platform !== 'win32', 'Windows installer acceptance.');
  const executablePath = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE
    ?? process.env.WORLDLINEBOX_E2E_ELECTRON_EXECUTABLE;
  if (!executablePath || !existsSync(executablePath)) {
    throw new Error('Set WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE or WORLDLINEBOX_E2E_ELECTRON_EXECUTABLE to the freshly packaged WorldlineBox.exe.');
  }
  const fixtureFile = process.env.WORLDLINEBOX_DSH_NODE_FIXTURE ?? path.resolve('.tools/dsh-native-node/result.json');
  if (!existsSync(fixtureFile)) throw new Error('The official npm runtime probe fixture is required for packaged acceptance.');
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8')) as {
    root: string; runtimes: Array<{ id: string; version: string }>;
  };
  const source = fixture.runtimes.find(value => value.version === '0.2.0-rc.2');
  if (!source) throw new Error('The sealed official 0.2.0-rc.2 Node runtime fixture is required.');

  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-packaged-dsh-tools-'));
  const userData = path.join(root, 'profile');
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const env = electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1',
    WORLDLINEBOX_E2E_USER_DATA_PATH: userData,
    WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root,
    WORLDLINEBOX_E2E_DSH_DIRECTORY: path.join(fixture.root, 'manager', 'runtimes', source.id, 'program'),
    // A user or build-machine Python, Node, Git, FFmpeg or pnpm cannot satisfy this gate.
    PATH: `${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`,
    PYTHONHOME: undefined, PYTHONPATH: undefined, PYTHONUSERBASE: undefined,
    GIT_EXEC_PATH: undefined, GIT_SSL_CAINFO: undefined,
    PSModulePath: `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
  });
  // Windows treats environment names case-insensitively; drop an inherited Path alias.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key];
  let application = await electron.launch({ executablePath, args: [], env });
  try {
    let page = await application.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const toolProbe = await application.evaluate(async ({ app }, temporaryRoot) => {
      const childProcess = process.getBuiltinModule('node:child_process');
      const fs = process.getBuiltinModule('node:fs');
      const pathModule = process.getBuiltinModule('node:path');
      const portableRoot = pathModule.join(process.resourcesPath, 'resources', 'portable-tools', 'win32-x64');
      const toolPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
      const environment = {
        ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
        GIT_TERMINAL_PROMPT: '0', PYTHONDONTWRITEBYTECODE: '1',
        FORCE_COLOR: undefined, NO_COLOR: '1',
      };
      const invoke = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
        childProcess.execFile(file, args, {
          cwd: temporaryRoot, env: environment, windowsHide: true, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error) reject(new Error(`Bundled tool ${pathModule.basename(file)} failed: ${error.message}\n${stderr}`));
          else resolve(`${stdout}${stderr}`.trim());
        });
      });
      const whereExecutable = pathModule.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe');
      const names = ['node', 'python', 'git', 'ffmpeg', 'ffplay', 'ffprobe'];
      const locations: Record<string, string> = {};
      for (const name of names) locations[name] = (await invoke(whereExecutable, [name])).split(/\r?\n/)[0]!;
      const npmCli = pathModule.join(portableRoot, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js');
      const pnpmCli = pathModule.join(portableRoot, 'pnpm', 'bin', 'pnpm.cjs');
      const gitSource = pathModule.join(temporaryRoot, 'git-source');
      const gitClone = pathModule.join(temporaryRoot, 'git-clone');
      fs.mkdirSync(gitSource);
      const versionOutput: Record<string, string> = {};
      for (const name of names) versionOutput[name] = await invoke(name, [name.startsWith('ff') ? '-version' : '--version']);
      versionOutput.npm = await invoke('node', [npmCli, '--version']);
      versionOutput.pnpm = await invoke('node', [pnpmCli, '--version']);
      const venv = pathModule.join(temporaryRoot, 'python-venv');
      await invoke('python', ['-B', '-I', '-m', 'venv', venv]);
      versionOutput.venvPip = await invoke(pathModule.join(venv, 'Scripts', 'python.exe'), ['-B', '-I', '-m', 'pip', '--version']);
      versionOutput.venvExecutable = await invoke(pathModule.join(venv, 'Scripts', 'python.exe'), ['-B', '-I', '-c', 'import sys; print(sys.executable); print(sys.version_info[:2])']);
      await invoke('git', ['init', '--quiet', gitSource]);
      fs.writeFileSync(pathModule.join(gitSource, 'payload.txt'), 'Packaged Git local round trip.');
      await invoke('git', ['-C', gitSource, 'add', 'payload.txt']);
      await invoke('git', ['-C', gitSource, '-c', 'user.name=Packaged Acceptance', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
      await invoke('git', ['-c', 'protocol.file.allow=always', 'clone', '--quiet', gitSource, gitClone]);
      return {
        isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
        portableRoot, toolPath, locations, versionOutput, npmExists: fs.existsSync(npmCli), pnpmExists: fs.existsSync(pnpmCli),
        gitRoundTrip: fs.readFileSync(pathModule.join(gitClone, 'payload.txt'), 'utf8'),
        nativePtyUnpacked: fs.existsSync(pathModule.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node')),
      };
    }, root);
    expect(toolProbe.isPackaged).toBe(true);
    expect(path.resolve(toolProbe.userData).toLowerCase()).toBe(path.resolve(userData).toLowerCase());
    expect(toolProbe.appPath).toContain('app.asar');
    expect(toolProbe.toolPath.split(';')[0]?.toLowerCase()).toBe(path.join(toolProbe.portableRoot, 'node').toLowerCase());
    for (const [name, location] of Object.entries(toolProbe.locations)) {
      expect(path.relative(toolProbe.portableRoot, location), `${name} must resolve inside the installed package`).not.toMatch(/^\.\./);
      expect(path.isAbsolute(path.relative(toolProbe.portableRoot, location))).toBe(false);
    }
    expect(toolProbe.npmExists).toBe(true); expect(toolProbe.pnpmExists).toBe(true);
    expect(toolProbe.versionOutput.node).toMatch(/^v24\./);
    expect(toolProbe.versionOutput.python).toBe('Python 3.13.12');
    expect(toolProbe.versionOutput.git).toMatch(/^git version 2\.48\.1\.windows\.1/);
    for (const name of ['ffmpeg', 'ffplay', 'ffprobe']) expect(toolProbe.versionOutput[name]).toMatch(new RegExp(`^${name} version 8\\.0\\.1`));
    expect(toolProbe.versionOutput.npm).toBe('11.12.1'); expect(toolProbe.versionOutput.pnpm).toBe('11.7.0');
    expect(toolProbe.versionOutput.venvPip).toContain('pip 25.3');
    expect(toolProbe.versionOutput.venvExecutable).toContain('(3, 13)');
    expect(toolProbe.gitRoundTrip).toBe('Packaged Git local round trip.');
    expect(toolProbe.nativePtyUnpacked, 'ConPTY native binding must ship outside app.asar.').toBe(true);
    await test.info().attach('packaged-toolchain', { body: JSON.stringify(toolProbe, null, 2), contentType: 'application/json' });

    await complete(page, { type: 'runtime.import', sourceKind: 'directory' });
    const runtime = (await state(page)).runtimes[0]!;
    expect(runtime.version).toBe('0.2.0-rc.2'); expect(runtime.adapter).toBe('node-cli-web-v1');
    await complete(page, { type: 'instance.create', runtimeId: runtime.id, name: 'Packaged native DSH' });
    const instance = (await state(page)).instances[0]!;
    await complete(page, { type: 'instance.default', instanceId: instance.id });
    await complete(page, { type: 'cli.select', instanceId: instance.id });
    expect((await state(page)).instances.every(value => value.status === 'stopped')).toBe(true);
    await complete(page, { type: 'terminal.open' });
    const opened = await state(page);
    const terminalId = opened.cli!.activeTerminalId!;
    const terminal = opened.cli!.terminals!.find(value => value.id === terminalId)!;
    expect(terminal.transport).toBe('conpty'); expect(terminal.pid).toBeGreaterThan(0);
    const workers = await ownedPtyWorkers(application, opened.rootPath);
    expect(workers).toHaveLength(1);
    await complete(page, { type: 'terminal.resize', terminalId, cols: 91, rows: 29 });
    const commands = [
      "[Console]::WriteLine('PACKAGED_TTY='+[Console]::IsOutputRedirected)",
      "[Console]::WriteLine('PACKAGED_WIDTH='+[Console]::WindowWidth)",
      "[Console]::WriteLine('PACKAGED_DSH='+(dsh --version))",
      "[Console]::WriteLine('PACKAGED_UTF8='+[char]0x4E2D+[char]0x6587+[char]::ConvertFromUtf32(0x1F680))",
      "[Console]::Write(([char]27)+'[32mPACKAGED_COLOR_GREEN'+([char]27)+'[0m'+[Environment]::NewLine)",
    ].join('; ') + '\r';
    await complete(page, { type: 'terminal.input', terminalId, text: commands });
    const output = async () => (await state(page)).cli!.terminals!.find(value => value.id === terminalId)!.output;
    await expect.poll(output, { timeout: 60_000 }).toContain('PACKAGED_DSH=0.2.0-rc.2');
    await expect.poll(output).toContain('PACKAGED_TTY=False');
    await expect.poll(output).toContain('PACKAGED_WIDTH=91');
    await expect.poll(output).toContain('PACKAGED_UTF8=中文🚀');
    await expect.poll(async () => foregroundAtLastMarker(await output(), 'PACKAGED_COLOR_GREEN')).toBe(32);
    const colorOutput = await output();
    const markerOffset = colorOutput.lastIndexOf('PACKAGED_COLOR_GREEN');
    expect(colorOutput.slice(markerOffset + 'PACKAGED_COLOR_GREEN'.length)).toMatch(new RegExp(`${String.fromCharCode(27)}\\[(?:0)?m`));
    await test.info().attach('packaged-conpty-ansi', {
      body: JSON.stringify({ foregroundAtMarker: foregroundAtLastMarker(colorOutput, 'PACKAGED_COLOR_GREEN'),
        rawAroundMarker: colorOutput.slice(Math.max(0, markerOffset - 50), markerOffset + 50) }, null, 2),
      contentType: 'application/json',
    });
    const heldScript = path.join(root, 'held-node.cjs');
    await writeFile(heldScript, "console.log('PACKAGED_HELD_PID='+process.pid);setInterval(()=>{},1000);\n");
    await complete(page, { type: 'terminal.input', terminalId, text: `node '${heldScript.replaceAll("'", "''")}'\r` });
    await expect.poll(output).toMatch(/PACKAGED_HELD_PID=\d+/);
    const heldPid = Number((await output()).match(/PACKAGED_HELD_PID=(\d+)/)![1]);
    expect(processIsAlive(heldPid)).toBe(true);
    await complete(page, { type: 'terminal.close', terminalId });
    expect((await state(page)).cli!.terminals!.find(value => value.id === terminalId)?.status).toBe('stopped');
    for (const pid of [terminal.pid!, ...workers, heldPid]) await expect.poll(() => processIsAlive(pid)).toBe(false);
    expect(await ownedPtyWorkers(application, opened.rootPath)).toEqual([]);

    await complete(page, { type: 'instance.start', instanceId: instance.id });
    expect((await state(page)).instances.filter(value => value.status === 'running')).toHaveLength(1);
    const workbench = application.windows().find(candidate => candidate !== page)!;
    await expect(workbench.getByRole('button', { name: '继续', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await workbench.evaluate(() => 'worldlinebox' in window)).toBe(false);
    await workbench.getByRole('button', { name: '继续', exact: true }).click();
    await expect(workbench.getByText('预览版说明', { exact: true })).toHaveCount(0);
    await complete(page, { type: 'instance.stop', instanceId: instance.id });

    await application.close();
    application = await electron.launch({ executablePath, args: [], env });
    page = await application.firstWindow(); await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const restored = await state(page);
    expect(restored.instances).toHaveLength(1);
    expect(restored.instances[0]?.id).toBe(instance.id); expect(restored.instances[0]?.isDefault).toBe(true);
    expect(restored.cli?.selectedInstanceId).toBe(instance.id);
    expect(restored.cli?.terminals?.filter(value => value.status === 'running')).toEqual([]);
    expect(path.resolve(restored.rootPath).toLowerCase()).toBe(path.join(userData, 'dsh-launcher').toLowerCase());
    expect(await ownedPtyWorkers(application, restored.rootPath)).toEqual([]);
    await test.info().attach('packaged-dsh-restart', {
      body: JSON.stringify({ runtime: runtime.version, adapter: runtime.adapter, instanceId: instance.id,
        defaultInstance: restored.instances[0]?.isDefault, selectedInstance: restored.cli?.selectedInstanceId,
        realTty: true, utf8: true, resize: 91, ownedProcessesStopped: true, packagedUserData: restored.rootPath }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await application.close();
    await removeAcceptanceDirectory(root);
  }
});
