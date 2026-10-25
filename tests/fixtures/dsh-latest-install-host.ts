import { app } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { DshLauncher } from '../../src/main/dsh/launcher';
import type { DshLauncherRequest, DshLauncherResponse } from '../../src/shared/dsh-launcher';

app.disableHardwareAcceleration(); app.getAppPath = () => process.cwd();
const reportRoot = path.resolve(process.env.WORLDLINEBOX_INSTALL_REPORT ?? 'artifacts/dsh-latest-install');
app.setPath('userData', path.join(reportRoot, 'electron'));
app.setPath('sessionData', path.join(reportRoot, 'electron'));
void app.whenReady().then(async () => {
  await mkdir(reportRoot, { recursive: true });
  const original = app.getPath;
  app.getPath = name => name === 'userData' ? path.join(process.env.APPDATA!, 'WorldlineBox') : original.call(app, name);
  const launcher = new DshLauncher(() => undefined, error => process.stderr.write(String(error) + '\n'));
  app.getPath = original;
  const internal = launcher as unknown as { initialization: Promise<void>; handle(request: DshLauncherRequest): Promise<DshLauncherResponse> };
  const started = performance.now();
  const version = process.env.WORLDLINEBOX_INSTALL_VERSION;
  if (!version) throw new Error('Set WORLDLINEBOX_INSTALL_VERSION to an exact published DSH version.');
  try {
    await internal.initialization;
    const refresh = await internal.handle({ type: 'versions.refresh' });
    if (!refresh.ok) throw new Error(refresh.error);
    while (launcher.state().operations.find(value => value.id === refresh.operationId)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 50));
    const catalogue = launcher.state().versions;
    if (catalogue?.source !== 'github-npm' || catalogue.stale || !catalogue.entries.some(entry => entry.version === version)) throw new Error('Selected version is not in the verified GitHub/Web release catalogue.');
    await writeFile(path.join(reportRoot, 'release-catalogue.json'), JSON.stringify(catalogue, null, 2));
    let runtime = launcher.state().runtimes.find(value => value.version === version);
    if (!runtime || process.env.WORLDLINEBOX_FORCE_INSTALL_VERIFY === '1') {
      const response = await internal.handle({ type: 'runtime.install', version: version });
      if (!response.ok) throw new Error(response.error);
      let lastPhase = '';
      while (true) {
        const operation = launcher.state().operations.find(value => value.id === response.operationId);
        if (!operation) throw new Error('Missing native install operation.');
        if (operation.phase !== lastPhase) { lastPhase = operation.phase; process.stdout.write(lastPhase + '\n'); }
        if (operation.status === 'succeeded') break;
        if (operation.status !== 'running') throw new Error(operation.error ?? operation.status);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      runtime = launcher.state().runtimes.find(value => value.version === version);
      if (!runtime) throw new Error('Official release not registered.');
      await writeFile(path.join(reportRoot, 'install.json'), JSON.stringify({ runtime, elapsedMs: performance.now() - started,
        operation: launcher.state().operations.find(value => value.id === response.operationId) }, null, 2));
    }
    if (!launcher.state().instances.length) {
      const created = await internal.handle({ type: 'instance.create', name: '我的 DSH', runtimeId: runtime.id });
      if (!created.ok) throw new Error(created.error);
      while (launcher.state().operations.find(value => value.id === created.operationId)?.status === 'running') await new Promise(resolve => setTimeout(resolve, 25));
      const instance = launcher.state().instances[0]; if (!instance) throw new Error('Native instance creation failed.');
      const selected = await internal.handle({ type: 'cli.select', instanceId: instance.id }); if (!selected.ok) throw new Error(selected.error);
    }
    const capabilities = await launcher.taskCapabilities();
    await writeFile(path.join(reportRoot, 'native-capabilities.json'), JSON.stringify(capabilities, null, 2));
    process.stdout.write('LATEST_INSTALL_OK ' + runtime.id + '\n');
  } finally { await launcher.shutdown(); }
}).then(() => app.exit(0), error => { process.stderr.write(String(error.stack ?? error) + '\n'); app.exit(1); });
